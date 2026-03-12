// ******************************************************************
// Free Fact Checker - Options / Settings Page
// ******************************************************************

import { MSG, STORAGE_KEY, GEMINI_MODELS, DEFAULT_MODEL, DEFAULT_PROMPT } from './constants.js';

document.addEventListener('DOMContentLoaded', async function() {
    const apiKeyInput = document.getElementById('apiKey');
    const saveButton = document.getElementById('saveButton');
    const statusDiv = document.getElementById('status');
    const modelSelect = document.getElementById('modelSelect');
    // Populate model dropdown
    GEMINI_MODELS.forEach(model => {
        const option = document.createElement('option');
        option.value = model.id;
        option.textContent = model.name;
        modelSelect.appendChild(option);
    });

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
    modelSelect.value = stored[STORAGE_KEY.MODEL] || DEFAULT_MODEL;
    promptTextarea.value = stored[STORAGE_KEY.CUSTOM_PROMPT] || DEFAULT_PROMPT;

    // Auto-save prompt on edit (debounced)
    promptTextarea.addEventListener('input', function() {
        clearTimeout(promptSaveTimer);
        promptSaveTimer = setTimeout(function() {
            const value = promptTextarea.value;
            if (value === DEFAULT_PROMPT || value.trim() === '') {
                chrome.storage.local.remove(STORAGE_KEY.CUSTOM_PROMPT);
            } else {
                chrome.storage.local.set({ [STORAGE_KEY.CUSTOM_PROMPT]: value });
            }
        }, 500);
    });

    // Reset prompt to default
    resetPromptButton.addEventListener('click', function() {
        promptTextarea.value = DEFAULT_PROMPT;
        chrome.storage.local.remove(STORAGE_KEY.CUSTOM_PROMPT);
    });

    // Save model selection immediately on change
    modelSelect.addEventListener('change', function() {
        chrome.storage.local.set({ [STORAGE_KEY.MODEL]: modelSelect.value });
    });

    // Check for message parameter (redirected from content script)
    const params = new URLSearchParams(window.location.search);
    if (params.get('message') === 'needkey') {
        showStatus('Please enter your Gemini API Key to use the Fact Checker.', 'warning');
    }

    // Save and test
    saveButton.addEventListener('click', async function() {
        const key = apiKeyInput.value.trim();
        if (!key) {
            showStatus('Please enter an API key.', 'error');
            return;
        }

        showStatus('Testing API key...', 'info');
        saveButton.disabled = true;

        try {
            const result = await chrome.runtime.sendMessage({ type: MSG.TEST_API_KEY, apiKey: key });

            if (result && result.success) {
                await chrome.storage.local.set({ [STORAGE_KEY.API_KEY]: key });
                showStatus('API key saved and verified! You can now close this tab and start fact-checking.', 'success');
            } else {
                const errorMessage = (result && result.error) || 'Invalid API key';
                // Avoid "Error: Error 400:..." double-prefix — SDK errors already include "Error"
                const prefix = errorMessage.startsWith('Error') ? '' : 'Error: ';
                showStatus(prefix + errorMessage, 'error');
            }
        } catch (e) {
            showStatus('Error testing key: ' + e.message, 'error');
        } finally {
            saveButton.disabled = false;
        }
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
