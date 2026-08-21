// ******************************************************************
// Free Fact Checker - Options / Settings Page
// ******************************************************************

import { MSG, STORAGE_KEY } from './constants.js';
import { getConfig, refreshConfig, resolveModel } from './config.js';

document.addEventListener('DOMContentLoaded', async function() {
    const apiKeyInput = document.getElementById('apiKey');
    const saveButton = document.getElementById('saveButton');
    const statusDiv = document.getElementById('status');
    const modelSelect = document.getElementById('modelSelect');

    // Populate the model dropdown from a config (remote, cached, or bundled).
    // Called again if a background refresh brings back a different list.
    function renderModels(config, savedId) {
        modelSelect.innerHTML = '';
        config.models.forEach(model => {
            const option = document.createElement('option');
            option.value = model.id;
            option.textContent = model.name;
            modelSelect.appendChild(option);
        });

        const resolved = resolveModel(config, savedId).id;
        modelSelect.value = resolved;

        // The saved model is no longer offered — persist the fallback so the
        // dropdown and storage agree.
        if (savedId && savedId !== resolved) {
            chrome.storage.local.set({ [STORAGE_KEY.MODEL]: resolved });
        }
    }

    // Prompt editor
    const promptTextarea = document.getElementById('promptTextarea');
    const resetPromptButton = document.getElementById('resetPromptButton');
    let promptSaveTimer = null;

    // Keyboard shortcut display — query Chrome for the actual configured shortcut
    const hotkeyDisplay = document.getElementById('hotkeyDisplay');
    const hotkeyInstructions = document.getElementById('hotkeyInstructions');
    const shortcutLink = document.getElementById('shortcutLink');

    // Detect OS for display formatting
    const platform = navigator.userAgentData
        ? navigator.userAgentData.platform
        : navigator.platform;
    const isMac = /mac/i.test(platform);

    function formatShortcut(shortcut) {
        if (!shortcut) return 'Not set';
        if (isMac) {
            return shortcut.replace('Alt', 'Option').replace('MacCtrl', 'Control').replace('Command', 'Cmd');
        }
        return shortcut;
    }

    try {
        const commands = await chrome.commands.getAll();
        const cmd = commands.find(c => c.name === 'fact-check-selection');
        const display = cmd && cmd.shortcut ? formatShortcut(cmd.shortcut) : 'Alt+F';
        hotkeyDisplay.textContent = display;
        hotkeyInstructions.textContent = display;
    } catch (e) {
        hotkeyDisplay.textContent = isMac ? 'Option+F' : 'Alt+F';
        hotkeyInstructions.textContent = isMac ? 'Option+F' : 'Alt+F';
    }

    shortcutLink.addEventListener('click', function(e) {
        e.preventDefault();
        chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
    });

    // Load existing settings
    const stored = await chrome.storage.local.get([STORAGE_KEY.API_KEY, STORAGE_KEY.MODEL, STORAGE_KEY.CUSTOM_PROMPT]);
    if (stored[STORAGE_KEY.API_KEY]) {
        apiKeyInput.value = stored[STORAGE_KEY.API_KEY];
    }
    const config = await getConfig();
    // The default prompt comes from the config too, so its wording can be tuned
    // remotely. Tracked in a variable because a background refresh can change it.
    let activeDefaultPrompt = config.defaultPrompt;

    renderModels(config, stored[STORAGE_KEY.MODEL]);
    promptTextarea.value = stored[STORAGE_KEY.CUSTOM_PROMPT] || activeDefaultPrompt;

    // Re-check the remote config behind the rendered page so the settings page
    // always ends up showing the current model list and prompt.
    refreshConfig().then(fresh => {
        renderModels(fresh, modelSelect.value);
        // Only replace the textarea if it is still showing the old default —
        // never clobber a prompt the user has customised.
        const showingDefault = promptTextarea.value === activeDefaultPrompt;
        activeDefaultPrompt = fresh.defaultPrompt;
        if (showingDefault) promptTextarea.value = activeDefaultPrompt;
    });

    // Auto-save prompt on edit (debounced)
    promptTextarea.addEventListener('input', function() {
        clearTimeout(promptSaveTimer);
        promptSaveTimer = setTimeout(function() {
            const value = promptTextarea.value;
            if (value === activeDefaultPrompt || value.trim() === '') {
                chrome.storage.local.remove(STORAGE_KEY.CUSTOM_PROMPT);
            } else {
                chrome.storage.local.set({ [STORAGE_KEY.CUSTOM_PROMPT]: value });
            }
        }, 500);
    });

    // Reset prompt to default
    resetPromptButton.addEventListener('click', function() {
        promptTextarea.value = activeDefaultPrompt;
        chrome.storage.local.remove(STORAGE_KEY.CUSTOM_PROMPT);
    });

    // Save model selection immediately on change, then re-test the saved key
    // against it so the user knows right away whether the new model works.
    modelSelect.addEventListener('change', async function() {
        await chrome.storage.local.set({ [STORAGE_KEY.MODEL]: modelSelect.value });

        const key = apiKeyInput.value.trim();
        if (!key) return;   // nothing to test with yet

        const label = modelSelect.options[modelSelect.selectedIndex].textContent.trim();
        await verifyKey(key, `Testing ${label}...`, `${label} works with your API key.`);
    });

    // Check for message parameter (redirected from content script)
    const params = new URLSearchParams(window.location.search);
    if (params.get('message') === 'needkey') {
        showStatus('Please enter your Gemini API Key to use the Fact Checker.', 'warning');
    }

    // Save and test
    // Rapid model switching can leave slower replies in flight; only the newest
    // test is allowed to write to the status line.
    let testSeq = 0;

    // Test the key against the currently selected model, and save it if it works.
    // The service worker reads the model from storage, so the caller must have
    // persisted the selection before calling this.
    async function verifyKey(key, testingMessage, successMessage) {
        const seq = ++testSeq;
        showStatus(testingMessage, 'info');
        saveButton.disabled = true;
        modelSelect.disabled = true;

        try {
            const result = await chrome.runtime.sendMessage({ type: MSG.TEST_API_KEY, apiKey: key });
            if (seq !== testSeq) return;   // superseded by a newer test

            if (result && result.success) {
                await chrome.storage.local.set({ [STORAGE_KEY.API_KEY]: key });
                showStatus(successMessage, 'success');
            } else {
                const errorMessage = (result && result.error) || 'Invalid API key';
                // Avoid "Error: Error 400:..." double-prefix — SDK errors already include "Error"
                const prefix = errorMessage.startsWith('Error') ? '' : 'Error: ';
                showStatus(prefix + errorMessage, 'error');
            }
        } catch (e) {
            if (seq === testSeq) showStatus('Error testing key: ' + e.message, 'error');
        } finally {
            if (seq === testSeq) {
                saveButton.disabled = false;
                modelSelect.disabled = false;
            }
        }
    }

    saveButton.addEventListener('click', async function() {
        const key = apiKeyInput.value.trim();
        if (!key) {
            showStatus('Please enter an API key.', 'error');
            return;
        }
        await verifyKey(key, 'Testing API key...',
            'API key saved and verified! You can now close this tab and start fact-checking.');
    });

    // Allow Enter key to save
    apiKeyInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            saveButton.click();
        }
    });

    function showStatus(message, type) {
        statusDiv.textContent = message;
        statusDiv.className = 'status status-' + type;
        statusDiv.style.display = 'block';
    }
});
