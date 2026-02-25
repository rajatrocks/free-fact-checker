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
};

// Port name for streaming connection
export const PORT_NAME = "streaming";

// Chrome storage keys
export const STORAGE_KEY = {
    API_KEY: "geminiApiKey",
    MODAL_WIDTH: "modalWidth",
    MODEL: "geminiModel",
    CUSTOM_PROMPT: "customPrompt",
};

// Available Gemini models (must support grounding with Google Search)
export const GEMINI_MODELS = [
    { id: "gemini-2.5-flash", name: "Gemini 2.5 Flash (Free)" },
    { id: "gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite (Free)" },
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
    { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
    { id: "gemini-3-pro-preview", name: "Gemini 3 Pro Preview" },
    { id: "gemini-3.1-pro-preview", name: "Gemini 3.1 Pro Preview" },
];

export const DEFAULT_MODEL = "gemini-2.5-flash";

// Chrome's built-in PDF viewer extension ID
export const CHROME_PDF_VIEWER_ID = "mhjfbmdgcfjbbpaeojofohoefgiehjai";

// Default fact-check prompt. The [[text]] placeholder is replaced with the user's selected text.
export const DEFAULT_PROMPT = `I am reading some content online and I need to know whether I can trust it or not. Please evaluate it and tell me if the statement(s) are true or not.

Here is the text that I'm reading:
----------------------------------
[[text]]
----------------------------------

You can use Markdown and HTML in your answer.

At the very bottom of your response, put one of the following verdicts (copy exactly as shown):

If the statement is true:
<div class="verdict verdict-true">TRUE</div>

If the statement is false:
<div class="verdict verdict-false">FALSE</div>

If the statement is not totally true or false:
<div class="verdict verdict-mixed">MIXED</div>

If you don't know, then don't put anything at the bottom.`;
