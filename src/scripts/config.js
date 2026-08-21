// ******************************************************************
// Free Fact Checker - Remote model configuration
// ******************************************************************
// The model list and default model are hosted as JSON on the website so they
// can be changed without shipping a new extension build.
//
// Resolution order, best to worst:
//   1. the remote file, when it fetches and parses cleanly
//   2. the last good copy cached in chrome.storage.local
//   3. FALLBACK_CONFIG bundled into the build
//
// A cached copy is served immediately even when it is past its TTL; the
// refresh then happens in the background, so a fact check never waits on the
// network once the extension has fetched the file at least once.
//
// Note the fetch relies on the host's CORS header rather than a host
// permission — see CONFIG_URL in constants.js.
// ******************************************************************

import {
    CONFIG_URL,
    CONFIG_TTL_MS,
    CONFIG_FETCH_TIMEOUT_MS,
    STORAGE_KEY,
    FALLBACK_CONFIG,
    DEFAULT_PROMPT,
} from './constants.js';

// Dedupes concurrent fetches within a single JS context
let inFlight = null;

// ******************************************************************
// Public API
// ******************************************************************

// Get the active configuration. Only waits on the network when there is no
// cached copy at all; a stale cache is returned as-is and refreshed behind it.
export async function getConfig() {
    const cached = await readCache();
    if (cached) {
        if (isStale(cached)) {
            // Fire and forget — the fresh copy is picked up on the next call
            refreshConfig();
        }
        return cached.config;
    }
    return refreshConfig();
}

// Force a fetch. Always resolves — falls back to the cache, then to the
// bundled config, if the network or the file itself lets us down.
export function refreshConfig() {
    if (!inFlight) {
        inFlight = fetchConfig().finally(() => { inFlight = null; });
    }
    return inFlight;
}

// Config without any chance of a network call. For the content script, which
// runs on every page and must not fetch — the service worker keeps the cache
// warm, and the bundled config covers the gap before it does.
export async function getCachedConfig() {
    const cached = await readCache();
    return cached ? cached.config : FALLBACK_CONFIG;
}

// Resolve the model to use: the user's saved choice while it is still offered,
// otherwise the configured default. Returns the whole model entry so callers
// can read optional per-model fields such as thinkingConfig.
export async function getActiveModel() {
    const config = await getConfig();
    let saved = null;
    try {
        const stored = await chrome.storage.local.get(STORAGE_KEY.MODEL);
        saved = stored[STORAGE_KEY.MODEL];
    } catch (e) {
        // Storage unavailable — fall through to the default
    }
    return resolveModel(config, saved);
}

// Pick a model entry out of a config, given the user's saved model id.
export function resolveModel(config, savedId) {
    return config.models.find(m => m.id === savedId)
        || config.models.find(m => m.id === config.defaultModel)
        || config.models[0];
}

// ******************************************************************
// Fetching and caching
// ******************************************************************

async function fetchConfig() {
    try {
        const raw = await fetchJSON(CONFIG_URL);
        const config = normalizeConfig(raw); // throws when unusable
        await writeCache(config);
        return config;
    } catch (e) {
        console.log("REMOTE CONFIG UNAVAILABLE, USING LOCAL COPY", e);
        const cached = await readCache();
        return cached ? cached.config : FALLBACK_CONFIG;
    }
}

async function fetchJSON(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS);
    try {
        const response = await fetch(url, { cache: "no-cache", signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.json();
    } finally {
        clearTimeout(timer);
    }
}

async function readCache() {
    try {
        const stored = await chrome.storage.local.get(STORAGE_KEY.CONFIG);
        const entry = stored[STORAGE_KEY.CONFIG];
        if (entry && typeof entry.fetchedAt === "number" && entry.config) {
            // Re-validate: a copy cached by an older build may not match the
            // shape this build expects.
            return { fetchedAt: entry.fetchedAt, config: normalizeConfig(entry.config) };
        }
    } catch (e) {
        // Unreadable or unusable cache — treat it as absent
    }
    return null;
}

async function writeCache(config) {
    try {
        await chrome.storage.local.set({
            [STORAGE_KEY.CONFIG]: { fetchedAt: Date.now(), config }
        });
    } catch (e) {
        // Cache write failures are not fatal — the config is still returned
        console.log("CONFIG CACHE WRITE FAILED", e);
    }
}

function isStale(entry) {
    const age = Date.now() - entry.fetchedAt;
    // A negative age means the clock moved backwards — refetch rather than
    // trust a timestamp from the future.
    return age < 0 || age > CONFIG_TTL_MS;
}

// ******************************************************************
// Validation
// ******************************************************************

// Returns a clean config or throws. Never lets a malformed remote file
// replace a working one — bad model entries are dropped, and a file with no
// usable entries left is rejected outright.
function normalizeConfig(raw) {
    if (!raw || typeof raw !== "object") throw new Error("config is not an object");

    const models = (Array.isArray(raw.models) ? raw.models : [])
        .filter(m => m && typeof m.id === "string" && m.id && typeof m.name === "string" && m.name)
        .map(m => {
            const model = { id: m.id, name: m.name };
            // Per-model thinking config, passed straight to the SDK. Three cases,
            // and the difference between the last two matters:
            //   object  -> send exactly this
            //   null    -> send no thinking config at all (Gemma rejects every form)
            //   omitted -> let the service worker infer it from the model id
            if (m.thinkingConfig && typeof m.thinkingConfig === "object") {
                model.thinkingConfig = m.thinkingConfig;
            } else if ("thinkingConfig" in m && m.thinkingConfig === null) {
                model.thinkingConfig = null;
            }
            return model;
        });

    if (!models.length) throw new Error("config has no usable models");

    const defaultModel = models.some(m => m.id === raw.defaultModel)
        ? raw.defaultModel
        : models[0].id;

    // A prompt without the placeholder would fact-check an empty template, so
    // fall back to the bundled one rather than ship a silently broken prompt.
    const defaultPrompt = (typeof raw.defaultPrompt === "string" && raw.defaultPrompt.includes("[[text]]"))
        ? raw.defaultPrompt
        : DEFAULT_PROMPT;

    return { defaultModel, defaultPrompt, models };
}
