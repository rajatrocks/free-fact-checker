// ******************************************************************
// Shared constants used across content script, service worker, and options
// ******************************************************************

// Message types for chrome.runtime messaging
export const MSG = {
    FACT_CHECK_SELECTION: "factCheckSelection",
    FACT_CHECK_WITH_TEXT: "factCheckWithText",
    SHOW_PDF_MESSAGE: "showPDFMessage",
    CONVERT_MARKDOWN: "convertMarkdownToHTML",
    OPEN_OPTIONS: "openOptionsWithMessage",
    TEST_API_KEY: "testApiKey",
    GET_SHORTCUT: "getShortcut",
};

// Port name for streaming connection
export const PORT_NAME = "streaming";

// Chrome storage keys
export const STORAGE_KEY = {
    API_KEY: "geminiApiKey",
    MODAL_WIDTH: "modalWidth",
    MODEL: "geminiModel",
    CUSTOM_PROMPT: "customPrompt",
    CONFIG: "remoteConfig",
};

// ******************************************************************
// Remote model configuration
// ******************************************************************
// The model list and default model live in a JSON file on the website so they
// can be changed without shipping a new extension build. See config.js.
//
// Fetched cross-origin WITHOUT a host permission, which works only because the
// host serves "access-control-allow-origin: *". Keep it that way — declaring a
// host permission instead would disable the extension for existing users until
// they re-approve it. If the site ever moves to a host that doesn't send that
// header, the fetch fails and every user quietly falls back to their cached or
// bundled copy, so verify CORS after any hosting change.
export const CONFIG_URL = "https://www.freefactchecker.com/config.json";

// How long a cached copy is used before we try the network again
export const CONFIG_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Give up on a slow fetch rather than stall a fact check
export const CONFIG_FETCH_TIMEOUT_MS = 6000;

// Default fact-check prompt. The [[text]] placeholder is replaced with the user's
// selected text. This is the fallback — the live copy is `defaultPrompt` in the
// remote config, so the wording can be tuned without shipping a build.
export const DEFAULT_PROMPT = `I am reading some content online and I need to know whether I can trust it or not. Please evaluate it and tell me if the statement(s) are true or not.

Here is the text that I'm reading:
----------------------------------
[[text]]
----------------------------------

Always search the web to check the claim(s) before answering — even if you are confident you already know the answer — and cite the sources you used.

You can use Markdown and HTML in your answer.

At the very bottom of your response, put one of the following verdicts (copy exactly as shown):

If the statement is true:
<div class="verdict verdict-true">TRUE</div>

If the statement is false:
<div class="verdict verdict-false">FALSE</div>

If the statement is not totally true or false:
<div class="verdict verdict-mixed">MIXED</div>

If you don't know, then don't put anything at the bottom.`;

// Baked-in configuration. Used only when the remote file has never been
// fetched successfully (first run while offline) or is unusable — a cached
// copy always wins over this. Same shape as config.json.
// Models must support grounding with Google Search.
export const FALLBACK_CONFIG = {
    defaultPrompt: DEFAULT_PROMPT,
    defaultModel: "gemma-4-26b-a4b-it",
    models: [
        { id: "gemma-4-26b-a4b-it", name: "Gemma 4 26B  (Free)", thinkingConfig: { thinkingLevel: "MINIMAL" } },
        { id: "gemini-flash-latest", name: "Gemini Flash Latest  ($)", thinkingConfig: { thinkingLevel: "low" } },
        { id: "gemini-flash-lite-latest", name: "Gemini Flash Lite Latest  ($)", thinkingConfig: { thinkingLevel: "low" } },
        { id: "gemini-pro-latest", name: "Gemini Pro Latest  ($)", thinkingConfig: { thinkingLevel: "low" } },
    ],
};

// Chrome's built-in PDF viewer extension ID
export const CHROME_PDF_VIEWER_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

