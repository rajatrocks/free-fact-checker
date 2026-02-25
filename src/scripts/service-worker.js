import { Converter } from 'showdown';
import { GoogleGenAI } from '@google/genai';
import { MSG, PORT_NAME, STORAGE_KEY, CHROME_PDF_VIEWER_ID, DEFAULT_MODEL } from './constants.js';

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
// Model is now read from storage; this helper fetches it.
async function getModel() {
    const stored = await chrome.storage.local.get(STORAGE_KEY.MODEL);
    return stored[STORAGE_KEY.MODEL] || DEFAULT_MODEL;
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
            testApiKey(request.apiKey).then(sendResponse);
            return true;

    }
});

// ******************************************************************
// Test API key (used by options page)
// ******************************************************************
async function testApiKey(apiKey) {
    try {
        const ai = new GoogleGenAI({ apiKey });
        const model = await getModel();
        await ai.models.generateContent({
            model,
            contents: 'Say "hello"',
            config: {
                maxOutputTokens: 10,
                temperature: 0
            }
        });
        return { success: true };
    } catch (e) {
        return { success: false, error: e.message || "Invalid API key" };
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

        try {
            const ai = new GoogleGenAI({ apiKey: msg.apiKey });
            const model = await getModel();
            const config = {
                temperature: 0,
                safetySettings: SAFETY_SETTINGS,
                tools: [{ googleSearch: {} }]
            };
            // Minimize thinking for each model family
            // https://ai.google.dev/gemini-api/docs/thinking
            if (model.startsWith('gemini-3')) {
                // Gemini 3.x uses thinkingLevel; can't disable, "low" is minimum
                config.thinkingConfig = { thinkingLevel: "low" };
            } else if (model.includes('-pro')) {
                // Gemini 2.5 Pro: minimum is 128
                config.thinkingConfig = { thinkingBudget: 128 };
            } else {
                // Flash/Lite: disable thinking entirely
                config.thinkingConfig = { thinkingBudget: 0 };
            }
            const response = await ai.models.generateContentStream({
                model,
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
            safePostMessage(port, { type: "error", error: formatGeminiError(error) });
        }
    });
});

// ******************************************************************
// Extract a clean error message from Gemini API errors
// ******************************************************************
function cleanMessage(str) {
    return str.replace(/\\n/g, ' ').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function formatGeminiError(error) {
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
        return code ? `Error ${code}: ${msg}` : msg;
    } catch(e) {
        // Not JSON — just clean up the raw message
        return cleanMessage(error.message);
    }
}
