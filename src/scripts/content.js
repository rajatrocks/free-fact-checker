// ******************************************************************
// Free Fact Checker - Content Script
// ******************************************************************

import { MSG, PORT_NAME, STORAGE_KEY, DEFAULT_PROMPT } from './constants.js';

// ==================== GLOBALS ====================

let SHADOW_ROOT = null;
let IS_MODAL_RESIZING = false;
let SAVED_MODAL_WIDTH = null;
let LAST_RUN = null;
let STREAMING_PORT = null;
let mouseDownInsideContent = false;

// Cached DOM references (set once in setupModal)
let modalEl = null;
let modalTitleEl = null;
let modalTextEl = null;
let modalMessageEl = null;
let resizeHandleEl = null;

// Streaming
let streamThrottleTimer = null;
let pendingChunks = "";
let streamingStarted = false;
const STREAM_THROTTLE_MS = 80;


// ==================== INITIALIZATION ====================

(function init() {
    // Guard against double-initialization (script may be injected multiple times)
    if (document.querySelector('factchecker-ui')) return;

    // Load saved settings
    chrome.storage.local.get([STORAGE_KEY.MODAL_WIDTH], function(result) {
        if (result[STORAGE_KEY.MODAL_WIDTH]) {
            SAVED_MODAL_WIDTH = result[STORAGE_KEY.MODAL_WIDTH];
        }
    });

    setupShadowRoot();

    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') {
            hideModal();
        }
    });

    // Listen for messages from service worker
    chrome.runtime.onMessage.addListener(function(request) {
        if (request.type === MSG.FACT_CHECK_SELECTION) {
            const selectedText = getSelectedText();
            if (selectedText && selectedText.trim().length > 0) {
                runFactCheck(selectedText.trim());
            } else if (document.contentType === "application/pdf") {
                showPDFMessage();
            } else {
                showNoSelectionMessage();
            }
        } else if (request.type === MSG.FACT_CHECK_WITH_TEXT) {
            // Context menu provides the selected text directly
            if (request.selectedText && request.selectedText.trim().length > 0) {
                runFactCheck(request.selectedText.trim());
            }
        } else if (request.type === MSG.SHOW_PDF_MESSAGE) {
            showPDFMessage();
        }
    });
})();


// ==================== TEXT SELECTION ====================

function getSelectedText() {
    let selection = window.getSelection().toString();

    // Check our own shadow host for selections from other shadow roots on the page
    // (skip our own UI element)
    try {
        const shadowHost = document.querySelector('factchecker-ui');
        if (shadowHost) {
            const allElems = document.getElementsByTagName('*');
            for (let i = 0; i < allElems.length; i++) {
                if (allElems[i].shadowRoot && allElems[i] !== shadowHost) {
                    try {
                        const shadowSelection = allElems[i].shadowRoot.getSelection();
                        if (shadowSelection) {
                            const shadowText = shadowSelection.toString();
                            if (shadowText) selection = shadowText;
                        }
                    } catch(e) {
                        // some shadow roots don't support getSelection
                    }
                }
            }
        }
    } catch(e) {
        // ignore errors
    }

    // Google Docs: uses a special iframe for text events
    if (!selection) {
        try {
            const docsFrame = document.querySelector('.docs-texteventtarget-iframe');
            if (docsFrame) {
                const contentDoc = docsFrame.contentDocument;
                const contentDiv = contentDoc.querySelector('div[aria-label="Document content"]');
                if (contentDiv) {
                    contentDiv.dispatchEvent(new Event('copy'));
                    const nodes = contentDiv.firstChild?.children || [];
                    selection = Array.from(nodes, c => c.innerText).join('\n');
                    // Remove control characters
                    selection = selection.replace(/[\x00-\x09\x0B\x0C\x0E-\x1F\x7F\u0080-\u009F\u200B-\u200D\uFEFF]/g, '');
                }
            }
        } catch(e) {
            // ignore errors (cross-origin, etc.)
        }
    }

    return selection;
}

// ==================== FACT CHECK EXECUTION ====================

async function runFactCheck(selectedText) {
    // Check for API key and load custom prompt
    const result = await chrome.storage.local.get([STORAGE_KEY.API_KEY, STORAGE_KEY.CUSTOM_PROMPT]);
    const apiKey = result[STORAGE_KEY.API_KEY];

    if (!apiKey) {
        chrome.runtime.sendMessage({ type: MSG.OPEN_OPTIONS });
        return;
    }

    // Build the prompt (use custom prompt if set, otherwise default)
    const template = result[STORAGE_KEY.CUSTOM_PROMPT] || DEFAULT_PROMPT;
    const prompt = template.replace("[[text]]", selectedText);

    // Save for rerun
    LAST_RUN = { apiKey, prompt };

    // Open modal in loading state
    openModal("Fact Check");

    // Start streaming
    startStreaming(apiKey, prompt);
}

function rerunFactCheck() {
    if (!LAST_RUN) return;
    openModal("Fact Check");
    startStreaming(LAST_RUN.apiKey, LAST_RUN.prompt);
}

function startStreaming(apiKey, prompt) {
    // Disconnect any existing port
    if (STREAMING_PORT) {
        try { STREAMING_PORT.disconnect(); } catch(e) {}
    }

    // Clear any pending throttled update
    if (streamThrottleTimer) {
        clearTimeout(streamThrottleTimer);
        streamThrottleTimer = null;
    }
    pendingChunks = "";
    streamingStarted = false;

    STREAMING_PORT = chrome.runtime.connect({ name: PORT_NAME });

    STREAMING_PORT.postMessage({
        type: "start",
        apiKey,
        prompt,
    });

    STREAMING_PORT.onMessage.addListener(async function(msg) {
        switch (msg.type) {
            case "error":
                STREAMING_PORT.disconnect();
                finalizeModal("<div style='color:red;'>" + msg.error + "</div>");
                break;

            case "chunk":
                if (msg.text) {
                    appendStreamingText(msg.text);
                }
                break;

            case "done":
                STREAMING_PORT.disconnect();
                // Flush any pending chunks
                if (streamThrottleTimer) {
                    clearTimeout(streamThrottleTimer);
                    streamThrottleTimer = null;
                }
                if (pendingChunks && modalTextEl) {
                    modalTextEl.appendChild(document.createTextNode(pendingChunks));
                    pendingChunks = "";
                }
                // Process grounding data for citations
                const groundingText = processGrounding(msg.groundingMetadata, msg.runningText);
                finalizeModal(groundingText || msg.runningText);
                break;
        }
    });
}

// Throttled append — batches incoming chunks and appends as a text node
function appendStreamingText(text) {
    pendingChunks += text;

    if (streamThrottleTimer) return;

    streamThrottleTimer = setTimeout(function() {
        streamThrottleTimer = null;
        if (pendingChunks && modalTextEl) {
            // Clear loading bar on first chunk
            if (!streamingStarted) {
                modalTextEl.textContent = "";
                streamingStarted = true;
            }
            modalTextEl.appendChild(document.createTextNode(pendingChunks));
            pendingChunks = "";
        }
    }, STREAM_THROTTLE_MS);
}


// ==================== GROUNDING / CITATIONS ====================

function escapeRegExp(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isSafeUrl(url) {
    try {
        const parsed = new URL(url);
        return parsed.protocol === 'http:' || parsed.protocol === 'https:';
    } catch {
        return false;
    }
}

function processGrounding(groundingMetadata, textData) {
    try {
        // If groundingMetadata is empty, show a message
        if (!groundingMetadata || Object.keys(groundingMetadata).length === 0) {
            return "<div class='no-grounding'>Unable to find enough sources to fact check this statement. Try your own search!</div>";
        }

        let renderedContent = "";
        if (groundingMetadata.searchEntryPoint && groundingMetadata.searchEntryPoint.renderedContent) {
            renderedContent = groundingMetadata.searchEntryPoint.renderedContent;
            // Fix naming conflicts
            renderedContent = renderedContent.replace(/container/g, "google-search-container");
            // Add target=_blank to links
            renderedContent = renderedContent.replace(/<a /g, '<a target="_blank" ');
        }

        const groundingChunks = groundingMetadata.groundingChunks;
        const groundingSupports = groundingMetadata.groundingSupports;

        // Build source list
        let groundingText = "";
        if (groundingChunks) {
            groundingText = "<br>**Search Sources:**<br>" +
                groundingChunks.map((chunk, i) => {
                    const url = isSafeUrl(chunk.web.uri) ? chunk.web.uri : '#';
                    return `${i + 1}. <a href="${url}" target="_blank" class="citation">${chunk.web.title}</a><br>`;
                }).join('') + "<br>";
        }

        // Add inline citations
        let citedText = textData;
        if (groundingSupports && groundingChunks) {
            groundingSupports.forEach(support => {
                const indices = support.groundingChunkIndices;

                if (indices && support.segment && support.segment.text) {
                    const indexText = indices.map(idx => {
                        const url = isSafeUrl(groundingChunks[idx].web.uri) ? groundingChunks[idx].web.uri : '#';
                        return `[<a href="${url}" target="_blank" class="citation">${idx + 1}</a>]`;
                    }).join('');

                    // Escape regex metacharacters in segment text for safe replacement.
                    // Place citation after trailing punctuation (e.g. period) if present.
                    const escaped = escapeRegExp(support.segment.text);
                    citedText = citedText.replace(new RegExp(escaped + '([.!?]?)'), support.segment.text + '$1' + indexText);
                }
            });
        }

        return citedText + groundingText + renderedContent;
    } catch (e) {
        console.log("Error parsing grounding data", e);
        return "";
    }
}


// ==================== SHADOW DOM ====================

function setupShadowRoot() {
    const shadowHost = document.createElement("factchecker-ui");
    document.body.insertAdjacentElement("afterend", shadowHost);

    try {
        SHADOW_ROOT = shadowHost.attachShadow({ mode: 'open' });
    } catch (e) {
        console.log("Error attaching shadow root, using normal DIV", e);
        SHADOW_ROOT = shadowHost;
    }

    // Load stylesheet
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = chrome.runtime.getURL("css/shadow.css");
    SHADOW_ROOT.appendChild(link);
}


// ==================== MODAL ====================

function ensureModal() {
    if (!SHADOW_ROOT) setupShadowRoot();
    if (!modalEl) setupModal();
}

function createModalDOM() {
    const modal = document.createElement("div");
    modal.id = "modal";

    modal.innerHTML = `
        <div id="modal-resize-handle"></div>
        <div id="modal-content">
            <div id="modal-message"></div>
            <div id="modal-title">Fact Check</div>
            <div class="u-cf"></div>
            <div id="modal-actions">
                <img src="${chrome.runtime.getURL('images/refresh.svg')}" alt="Rerun" id="modal-rerun" title="Rerun fact check">
                <img src="${chrome.runtime.getURL('images/copy-link.svg')}" alt="Copy to clipboard" id="modal-copy" title="Copy to clipboard">
                <img src="${chrome.runtime.getURL('images/cogwheel.svg')}" alt="Settings" id="modal-settings" title="Settings">
            </div>
            <div class="u-cf"></div>
            <div id="modal-text"></div>
            <br>
            <div class="u-cf"></div>
            <div id="modal-actions-bottom" class="u-pull-left">
                <img src="${chrome.runtime.getURL('images/refresh.svg')}" alt="Rerun" id="modal-rerun-bottom" title="Rerun fact check">
                <img src="${chrome.runtime.getURL('images/copy-link.svg')}" alt="Copy to clipboard" id="modal-copy-bottom" title="Copy to clipboard">
                <img src="${chrome.runtime.getURL('images/cogwheel.svg')}" alt="Settings" id="modal-settings-bottom" title="Settings">
            </div>
            <button id="modal-close" class="button-primary u-pull-right">Close&nbsp;&nbsp;(ESC)</button>
            <div class="u-cf"></div>
        </div>
    `;

    return modal;
}

function cacheModalRefs(modal) {
    modalEl = modal;
    modalTitleEl = modal.querySelector('#modal-title');
    modalTextEl = modal.querySelector('#modal-text');
    modalMessageEl = modal.querySelector('#modal-message');
    resizeHandleEl = modal.querySelector('#modal-resize-handle');
}

function setupResizeHandle() {
    let startX, startWidth;

    resizeHandleEl.addEventListener('mousedown', function(e) {
        IS_MODAL_RESIZING = true;
        startX = e.clientX;
        startWidth = modalEl.offsetWidth;
        document.body.style.cursor = 'ew-resize';
        e.preventDefault();
        e.stopPropagation();
    });

    document.addEventListener('mousemove', function(e) {
        if (!IS_MODAL_RESIZING) return;
        const width = startWidth + (startX - e.clientX);
        const maxWidth = window.innerWidth - 20;
        if (width >= 400 && width <= maxWidth) {
            modalEl.style.width = `${width}px`;
        } else if (width > maxWidth) {
            modalEl.style.width = `${maxWidth}px`;
        } else {
            modalEl.style.width = "400px";
        }
        moveResizeHandle();
    });

    document.addEventListener('mouseup', function() {
        if (IS_MODAL_RESIZING) {
            // Save width only once when drag ends (not on every mousemove)
            const finalWidth = parseInt(modalEl.style.width, 10);
            if (finalWidth) {
                chrome.storage.local.set({ [STORAGE_KEY.MODAL_WIDTH]: finalWidth });
                SAVED_MODAL_WIDTH = finalWidth;
            }
        }
        IS_MODAL_RESIZING = false;
        document.body.style.cursor = '';
    });
}

function setupModalEvents() {
    // Close on clicking outside modal content
    modalEl.addEventListener("mouseup", function(event) {
        if (IS_MODAL_RESIZING) return;
        const mouseUpInsideContent = event.target.closest("#modal-content") !== null;
        if (!mouseDownInsideContent && !mouseUpInsideContent) {
            hideModal();
        }
    });

    // Close button
    modalEl.querySelector("#modal-close").addEventListener("click", hideModal);

    // Bind action buttons (top and bottom)
    for (const suffix of ["", "-bottom"]) {
        modalEl.querySelector(`#modal-rerun${suffix}`).addEventListener("click", rerunFactCheck);
        modalEl.querySelector(`#modal-copy${suffix}`).addEventListener("click", copyModalText);
        modalEl.querySelector(`#modal-settings${suffix}`).addEventListener("click", function() {
            chrome.runtime.sendMessage({ type: MSG.OPEN_OPTIONS });
        });
    }

    // Make links open in new tabs
    modalTextEl.addEventListener("click", function(event) {
        if (event.target.tagName === 'A' && event.target.href) {
            event.preventDefault();
            window.open(event.target.href, '_blank');
        }
    });
}

function setupModal() {
    const modal = createModalDOM();
    cacheModalRefs(modal);
    setupResizeHandle();
    setupModalEvents();
    SHADOW_ROOT.appendChild(modal);
}

function moveResizeHandle() {
    if (resizeHandleEl && modalEl) {
        resizeHandleEl.style.right = `${modalEl.offsetWidth - 5}px`;
    }
}

// Opens the modal in loading state — called once at start of fact check
function openModal(title) {
    ensureModal();

    // Adjust width
    if (SAVED_MODAL_WIDTH) {
        const maxWidth = window.innerWidth - 20;
        modalEl.style.width = (SAVED_MODAL_WIDTH > maxWidth) ? `${maxWidth}px` : `${SAVED_MODAL_WIDTH}px`;
    }

    // Set title and loading state
    modalTitleEl.innerHTML = title;
    modalTextEl.innerHTML = "<div class='loading-bar-container'><div class='loading-bar-indicator'></div></div>";
    modalEl.style.display = 'block';
    moveResizeHandle();
}

// Final render with full markdown conversion — called once when streaming is done
async function finalizeModal(text) {
    if (!modalEl) return;

    // Code blocks
    let message = text.replace(/```(.*?)\n([\s\S]*?)(```|$)/g, function(match, lang, code) {
        code = code.replace(/\n$/, '');
        if (!lang || lang.toLowerCase() === 'html') {
            return code;
        }
        return `<pre><code class="${lang}">${code}</code></pre>`;
    });

    // Convert markdown to HTML (single IPC call at the end)
    try {
        message = await chrome.runtime.sendMessage({ type: MSG.CONVERT_MARKDOWN, text: message });
    } catch (e) {
        console.log("Error converting markdown to HTML", e);
    }

    // Fix any malformed verdict divs (LLM sometimes puts the verdict text as a style value)
    message = message.replace(
        /<div[^>]*>\s*(TRUE|FALSE|MIXED)\s*<\/div>/gi,
        function(match, verdict) {
            const v = verdict.toUpperCase();
            const cls = v === "TRUE" ? "verdict-true" : v === "FALSE" ? "verdict-false" : "verdict-mixed";
            return `<div class="verdict ${cls}">${v}</div>`;
        }
    );

    modalTextEl.innerHTML = message;
}

function showInfoMessage(html) {
    ensureModal();
    modalTitleEl.innerHTML = "Fact Check";
    modalTextEl.innerHTML = html;
    modalEl.style.display = "block";
}

function showNoSelectionMessage() {
    showInfoMessage("<p style='text-align:center; color:#555; margin-top:20px;'>Highlight some text on the page, then click the toolbar icon or right-click and choose \"Fact Check This\" to fact-check it.</p>");
}

function showPDFMessage() {
    showInfoMessage("<p style='text-align:center; color:red; margin-top:20px;'>To fact check text in a PDF, select it then <b>right-click</b> and choose <b>\"Fact Check This\"</b> from the context menu.</p>");
}

function hideModal() {
    if (modalEl) {
        modalEl.style.display = 'none';
    }
}

function copyModalText() {
    if (!modalTextEl) return;

    const text = modalTextEl.innerText;
    navigator.clipboard.writeText(text).then(function() {
        if (modalMessageEl) {
            modalMessageEl.textContent = "Copied to clipboard!";
            modalMessageEl.style.display = "block";
            setTimeout(function() {
                modalMessageEl.style.display = "none";
            }, 1000);
        }
    }, function(err) {
        console.error('Could not copy text:', err);
    });
}
