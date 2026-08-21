import { Converter } from 'showdown';
import { GoogleGenAI } from '@google/genai';
import { MSG, PORT_NAME, STORAGE_KEY, CHROME_PDF_VIEWER_ID } from './constants.js';
import { getActiveModel, refreshConfig } from './config.js';

// ******************************************************************
// Showdown markdown converter
// ******************************************************************
const converter = new Converter({
    omitExtraWLInCodeBlocks: true,
    parseImgDimensions: true,
    simplifiedAutoLink: true,
    literalMidWordUnderscores: true,
    strikethrough: true,
    tables: true,
    tasklists: true,
    smoothLivePreview: true,
    smartIndentationFix: true,
    disableForced4SpacesIndentedSublists: true,
    simpleLineBreaks: true,
    requireSpaceBeforeHeadingText: true,
    openLinksInNewWindow: true,
    emoji: true,
    backslashEscapesHTMLTags: true,
    splitAdjacentBlockquotes: true,
    encodeEmails: false,
});

// ******************************************************************
// Gemini model configuration
// ******************************************************************
// The model list and default come from the remote config (see config.js);
// the user's choice among them comes from storage.

// Minimize thinking for the given model, or return null to send no thinking
// config at all. https://ai.google.dev/gemini-api/docs/thinking
// The remote config can state this per model; the rules below are the
// fallback for entries that don't.
function thinkingConfigFor(model) {
    if (model.thinkingConfig) return model.thinkingConfig;
    // Explicit null means "send nothing" — Gemma models reject both
    // thinkingBudget and thinkingLevel with a 400.
    if (model.thinkingConfig === null) return null;
    if (model.id.startsWith('gemini-3')) {
        // Gemini 3.x uses thinkingLevel; can't disable, "low" is minimum
        return { thinkingLevel: "low" };
    }
    if (model.id.includes('-pro')) {
        // Gemini 2.5 Pro: minimum is 128
        return { thinkingBudget: 128 };
    }
    // Flash/Lite: disable thinking entirely
    return { thinkingBudget: 0 };
}

// The request config used for a fact check. Shared with the API key test so
// that saving a key exercises the same request the extension actually makes —
// grounding included, since that is where quota limits bite.
function buildRequestConfig(model) {
    const config = {
        temperature: 0,
        safetySettings: SAFETY_SETTINGS,
        tools: [{ googleSearch: {} }]
    };
    const thinking = thinkingConfigFor(model);
    if (thinking) config.thinkingConfig = thinking;
    return config;
}

const SAFETY_SETTINGS = [
    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "OFF" },
    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "OFF" },
    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "OFF" },
    { category: "HARM_CATEGORY_HARASSMENT", threshold: "OFF" },
];

// ******************************************************************
// On install: open options page if no API key is saved
// ******************************************************************
chrome.runtime.onInstalled.addListener(async (details) => {
    // Pick up any model changes published since this build shipped
    refreshConfig();

    if (details.reason === "install") {
        const stored = await chrome.storage.local.get(STORAGE_KEY.API_KEY);
        if (!stored[STORAGE_KEY.API_KEY]) {
            chrome.runtime.openOptionsPage();
        }
    }

    // Create context menu item for fact-checking selected text
    // Use removeAll first to prevent duplicate ID errors on extension update
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: "factCheckSelection",
            title: "Fact Check This",
            contexts: ["selection"]
        });
    });
});

// ******************************************************************
// On browser startup: refresh the remote model configuration
// ******************************************************************
chrome.runtime.onStartup.addListener(() => {
    refreshConfig();
});

// ******************************************************************
// Inject content script into a tab (idempotent — content.js guards against double-init)
// ******************************************************************
async function injectContentScript(tabId) {
    await chrome.scripting.executeScript({
        target: { tabId },
        files: ['scripts/content.js']
    });
}

// ******************************************************************
// Context menu click -> fact-check the selected text
// ******************************************************************
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    if (info.menuItemId === "factCheckSelection" && info.selectionText) {
        try {
            await injectContentScript(tab.id);
            await chrome.tabs.sendMessage(tab.id, {
                type: MSG.FACT_CHECK_WITH_TEXT,
                selectedText: info.selectionText
            });
        } catch (e) {
            chrome.runtime.openOptionsPage();
        }
    }
});

// ******************************************************************
// Toolbar icon click -> fact-check selected text in active tab
// ******************************************************************
chrome.action.onClicked.addListener(async (tab) => {
    try {
        // Check if the tab is a PDF — toolbar icon can't access PDF selections
        const isPDF = tab.url && (
            tab.url.toLowerCase().endsWith(".pdf") ||
            tab.url.startsWith(`chrome-extension://${CHROME_PDF_VIEWER_ID}`)
        );
        if (isPDF) {
            await injectContentScript(tab.id);
            await chrome.tabs.sendMessage(tab.id, { type: MSG.SHOW_PDF_MESSAGE });
            return;
        }
        await injectContentScript(tab.id);
        await chrome.tabs.sendMessage(tab.id, { type: MSG.FACT_CHECK_SELECTION });
    } catch (e) {
        // Content script not loaded — open options page as fallback
        chrome.runtime.openOptionsPage();
    }
});

// ******************************************************************
// Keyboard shortcut (chrome.commands) -> fact-check selected text
// ******************************************************************
chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command === "fact-check-selection" && tab) {
        try {
            const isPDF = tab.url && (
                tab.url.toLowerCase().endsWith(".pdf") ||
                tab.url.startsWith(`chrome-extension://${CHROME_PDF_VIEWER_ID}`)
            );
            if (isPDF) {
                await injectContentScript(tab.id);
                await chrome.tabs.sendMessage(tab.id, { type: MSG.SHOW_PDF_MESSAGE });
                return;
            }
            await injectContentScript(tab.id);
            await chrome.tabs.sendMessage(tab.id, { type: MSG.FACT_CHECK_SELECTION });
        } catch (e) {
            chrome.runtime.openOptionsPage();
        }
    }
});

// ******************************************************************
// Message listener
// ******************************************************************
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.type) {
        case MSG.CONVERT_MARKDOWN:
            sendResponse(converter.makeHtml(request.text));
            return true;

        case MSG.OPEN_OPTIONS:
            chrome.storage.local.get(STORAGE_KEY.API_KEY, (result) => {
                const hasKey = !!result[STORAGE_KEY.API_KEY];
                const url = hasKey
                    ? chrome.runtime.getURL("options.html")
                    : chrome.runtime.getURL("options.html?message=needkey");
                chrome.tabs.create({ url });
            });
            return true;

        case MSG.TEST_API_KEY:
            testApiKey(request.apiKey)
                .then(sendResponse)
                .catch(e => sendResponse({ success: false, error: cleanMessage(String(e && e.message || e)) }));
            return true;

        case MSG.GET_SHORTCUT:
            chrome.commands.getAll().then(commands => {
                const cmd = commands.find(c => c.name === 'fact-check-selection');
                sendResponse(cmd && cmd.shortcut ? cmd.shortcut : '');
            });
            return true;

    }
});

// ******************************************************************
// Test API key (used by options page)
// ******************************************************************
async function testApiKey(apiKey) {
    // Declared out here so the catch below can name the model in its error
    let modelName = null;

    try {
        const ai = new GoogleGenAI({ apiKey });
        const model = await getActiveModel();
        modelName = model.name;
        // Same request shape as a real fact check, just capped short. The API
        // validates the tools and thinking config before generating, so a model
        // that can't ground (or has no grounding quota) fails here rather than
        // silently at the user's first fact check.
        await ai.models.generateContent({
            model: model.id,
            contents: 'Say "hello"',
            config: { ...buildRequestConfig(model), maxOutputTokens: 10 }
        });
        return { success: true };
    } catch (e) {
        return { success: false, error: formatGeminiError(e, modelName) };
    }
}

// ******************************************************************
// Safely post a message to a port, catching disconnection errors
// ******************************************************************
function safePostMessage(port, msg) {
    try {
        port.postMessage(msg);
        return true;
    } catch (e) {
        console.log("PORT POST MESSAGE ERROR", e);
        return false;
    }
}

// ******************************************************************
// Port-based streaming for Gemini API
// ******************************************************************
chrome.runtime.onConnect.addListener(function (port) {
    if (port.name !== PORT_NAME) return;

    port.onMessage.addListener(async function (msg) {
        if (msg.type !== "start") return;

        let runningText = "";
        // Declared out here so the catch below can name the model in its error
        let modelName = null;

        try {
            const ai = new GoogleGenAI({ apiKey: msg.apiKey });
            const model = await getActiveModel();
            modelName = model.name;
            const config = buildRequestConfig(model);
            const response = await ai.models.generateContentStream({
                model: model.id,
                contents: msg.prompt,
                config
            });

            let lastChunk = null;
            for await (const chunk of response) {
                lastChunk = chunk;
                const text = chunk.text;
                if (text) {
                    runningText += text;
                    if (!safePostMessage(port, { type: "chunk", text })) return;
                }
            }

            // Extract grounding metadata from the last chunk
            let groundingMetadata = null;
            try {
                groundingMetadata = lastChunk.candidates[0].groundingMetadata || null;
            } catch (e) {
                // No grounding metadata available
            }

            safePostMessage(port, {
                type: "done",
                runningText,
                groundingMetadata,
            });

        } catch (error) {
            safePostMessage(port, { type: "error", error: formatGeminiError(error, modelName) });
        }
    });
});

// ******************************************************************
// Extract a clean error message from Gemini API errors
// ******************************************************************
function cleanMessage(str) {
    return str.replace(/\\n/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

// Rewrite the errors users actually hit into something they can act on.
// Returns null when we have nothing better to say than the raw message.
function friendlyMessage(code, msg, modelName) {
    const model = modelName ? `"${modelName}"` : 'this model';
    if (code === 429) {
        // Free-tier keys have little or no grounded-search quota. This also
        // covers a paid key that has genuinely run out for the day.
        return `Out of quota for ${model}. Models marked ($) need a paid API key — `
            + `choose a model marked (Free), or add billing to your Google account. `
            + `If you are already on a paid key, you may have reached today's limit.`;
    }
    if (code === 400 && /API[_ ]?key not valid|API key expired/i.test(msg)) {
        return 'That API key is not valid. Copy it again from Google AI Studio.';
    }
    if (code === 403) {
        return `This API key is not permitted to use ${model}. Check that the key is enabled for the Gemini API.`;
    }
    if (code === 404) {
        return `${model} is not available to this API key. Pick a different model.`;
    }
    return null;
}

function formatGeminiError(error, modelName) {
    try {
        // The SDK error message is often a nested JSON string
        const parsed = JSON.parse(error.message);
        const inner = parsed.error || parsed;

        // Try to get the inner-most message
        let msg = inner.message || error.message;

        // The message itself may be a JSON string (double-encoded)
        try {
            const innerParsed = JSON.parse(msg);
            msg = innerParsed.error?.message || innerParsed.message || msg;
        } catch(e) {
            // Not double-encoded, that's fine
        }

        msg = cleanMessage(msg);

        const code = inner.code || parsed.code || '';
        const friendly = friendlyMessage(code, msg, modelName);
        if (friendly) return friendly;
        return code ? `Error ${code}: ${msg}` : msg;
    } catch(e) {
        // Not JSON — the SDK sometimes throws a plain Error whose message still
        // carries the status code, so try to recover one before giving up.
        const raw = cleanMessage(error.message || String(error));
        const code = Number((raw.match(/\b(429|403|404|400)\b/) || [])[1]) || 0;
        return friendlyMessage(code, raw, modelName) || raw;
    }
}
