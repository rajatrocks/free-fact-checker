/**
 * Tests for the remote model/prompt configuration loader.
 *
 * The loader's whole job is to degrade gracefully: remote file → last good
 * cached copy → bundled fallback. Most of these cases are failure paths that
 * are awkward to reach by hand, which is exactly why they are pinned here.
 */

import fs from 'fs';
import path from 'path';
import {
    getConfig,
    refreshConfig,
    getCachedConfig,
    resolveModel,
} from '../src/scripts/config.js';
import { FALLBACK_CONFIG, DEFAULT_PROMPT, STORAGE_KEY } from '../src/scripts/constants.js';

describe('remote config', () => {

    let store;          // stands in for chrome.storage.local
    let fetchImpl;      // stands in for the network
    let fetchCount;
    let realFetch;

    /** A successful JSON response. */
    const ok = body => async () => ({ ok: true, status: 200, json: async () => body });
    /** A network-level failure (offline, DNS, abort). */
    const dead = msg => async () => { throw new Error(msg || 'offline'); };
    /** A non-2xx response. */
    const httpError = status => async () => ({ ok: false, status, json: async () => ({}) });

    const REMOTE = {
        defaultModel: 'remote-b',
        models: [
            { id: 'remote-a', name: 'Remote A' },
            { id: 'remote-b', name: 'Remote B', thinkingConfig: { thinkingLevel: 'HIGH' } },
        ],
    };

    /** Seed the cache as though a previous fetch had stored it. */
    const seedCache = (config, fetchedAt = Date.now()) => {
        store[STORAGE_KEY.CONFIG] = { fetchedAt, config };
    };
    const cached = () => store[STORAGE_KEY.CONFIG];

    beforeEach(() => {
        store = {};
        fetchCount = 0;
        fetchImpl = dead();

        // sinon-chrome's storage stubs are callback-style; the loader uses the
        // promise API, so swap in a promise-based fake for these tests.
        global.chrome.storage = {
            local: {
                get: async key => (key in store ? { [key]: store[key] } : {}),
                set: async obj => { Object.assign(store, obj); },
            },
        };

        realFetch = global.fetch;
        global.fetch = (...args) => { fetchCount++; return fetchImpl(...args); };
    });

    afterEach(() => {
        global.fetch = realFetch;
    });

    describe('resolution order', () => {

        it('uses the bundled fallback on a first run with no network', async () => {
            const config = await getConfig();
            expect(config.defaultModel).to.equal(FALLBACK_CONFIG.defaultModel);
            expect(config.models).to.have.lengthOf(FALLBACK_CONFIG.models.length);
        });

        it('does not cache a failed fetch', async () => {
            await getConfig();
            expect(cached()).to.be.undefined;
        });

        it('prefers the remote file when it loads, and caches it', async () => {
            fetchImpl = ok(REMOTE);
            const config = await getConfig();
            expect(config.defaultModel).to.equal('remote-b');
            expect(cached().config.defaultModel).to.equal('remote-b');
        });

        it('falls back to the cached copy when the network dies', async () => {
            fetchImpl = ok(REMOTE);
            await refreshConfig();
            fetchImpl = dead();
            const config = await refreshConfig();
            expect(config.defaultModel).to.equal('remote-b');
        });

        it('keeps the cached copy intact after a failed refresh', async () => {
            fetchImpl = ok(REMOTE);
            await refreshConfig();
            fetchImpl = dead();
            await refreshConfig();
            expect(cached().config.defaultModel).to.equal('remote-b');
        });

        it('falls back to the cached copy on an HTTP error', async () => {
            fetchImpl = ok(REMOTE);
            await refreshConfig();
            fetchImpl = httpError(500);
            const config = await refreshConfig();
            expect(config.defaultModel).to.equal('remote-b');
        });

        it('serves a fresh cache without touching the network', async () => {
            seedCache(REMOTE);
            fetchImpl = ok(REMOTE);
            const config = await getConfig();
            expect(fetchCount).to.equal(0);
            expect(config.defaultModel).to.equal('remote-b');
        });

        it('ignores an unusable cached entry and refetches', async () => {
            seedCache({ models: 'garbage' });
            fetchImpl = ok(REMOTE);
            const config = await getConfig();
            expect(config.defaultModel).to.equal('remote-b');
        });

        it('falls all the way back to bundled when cache and network both fail', async () => {
            seedCache(null);
            const config = await getConfig();
            expect(config.defaultModel).to.equal(FALLBACK_CONFIG.defaultModel);
        });

        it('dedupes concurrent refreshes into a single fetch', async () => {
            fetchImpl = ok(REMOTE);
            await Promise.all([refreshConfig(), refreshConfig(), refreshConfig()]);
            expect(fetchCount).to.equal(1);
        });
    });

    describe('validation', () => {

        // A bad deploy must never be able to replace a working cached copy.
        const MALFORMED = {
            'not an object': 'nope',
            'no models key': { defaultModel: 'x' },
            'an empty models array': { defaultModel: 'x', models: [] },
            'only invalid entries': { models: [{ id: 5 }, { name: 'no id' }, null] },
        };

        Object.keys(MALFORMED).forEach(label => {
            it(`rejects a config with ${label}, keeping the cached copy`, async () => {
                fetchImpl = ok(REMOTE);
                await refreshConfig();
                fetchImpl = ok(MALFORMED[label]);
                const config = await refreshConfig();
                expect(config.defaultModel).to.equal('remote-b');
            });
        });

        it('drops bad model entries but keeps the good ones', async () => {
            fetchImpl = ok({ defaultModel: 'good', models: [
                { id: 'good', name: 'Good' }, { id: '', name: 'blank id' }, 'junk',
            ]});
            const config = await refreshConfig();
            expect(config.models).to.have.lengthOf(1);
            expect(config.models[0].id).to.equal('good');
        });

        it('falls back to the first model when defaultModel is not in the list', async () => {
            fetchImpl = ok({ defaultModel: 'ghost', models: [{ id: 'first', name: 'First' }] });
            const config = await refreshConfig();
            expect(config.defaultModel).to.equal('first');
        });

        it('strips unknown keys such as _comment', async () => {
            fetchImpl = ok({ ...REMOTE, _comment: 'docs' });
            const config = await refreshConfig();
            expect(Object.keys(config).sort())
                .to.deep.equal(['defaultModel', 'defaultPrompt', 'models']);
        });
    });

    describe('thinkingConfig', () => {

        // Three distinct outcomes, and the difference matters: Gemma rejects
        // every thinking config, so "omit" has to survive as its own state
        // rather than decaying into "infer from the model id".
        const withThinking = () => ok({ defaultModel: 'a', models: [
            { id: 'a', name: 'A', thinkingConfig: { thinkingLevel: 'HIGH' } },
            { id: 'b', name: 'B', thinkingConfig: null },
            { id: 'c', name: 'C' },
        ]});

        const byId = config => config.models.reduce((acc, m) => ({ ...acc, [m.id]: m }), {});

        it('preserves an object thinkingConfig', async () => {
            fetchImpl = withThinking();
            const models = byId(await refreshConfig());
            expect(models.a.thinkingConfig).to.deep.equal({ thinkingLevel: 'HIGH' });
        });

        it('preserves an explicit null as null', async () => {
            fetchImpl = withThinking();
            const models = byId(await refreshConfig());
            expect(models.b.thinkingConfig).to.be.null;
            expect(models.b).to.have.property('thinkingConfig');
        });

        it('leaves an omitted thinkingConfig absent', async () => {
            fetchImpl = withThinking();
            const models = byId(await refreshConfig());
            expect(models.c).to.not.have.property('thinkingConfig');
        });

        it('keeps null distinct from absent across the cache round-trip', async () => {
            fetchImpl = withThinking();
            await refreshConfig();
            fetchImpl = dead();
            seedCache(cached().config);
            const models = byId(await getConfig());
            expect(models.b.thinkingConfig).to.be.null;
            expect(models.b).to.have.property('thinkingConfig');
            expect(models.c).to.not.have.property('thinkingConfig');
        });

        it('drops a non-object thinkingConfig rather than forwarding it', async () => {
            fetchImpl = ok({ defaultModel: 'a', models: [{ id: 'a', name: 'A', thinkingConfig: 'garbage' }] });
            const config = await refreshConfig();
            expect(config.models[0].thinkingConfig).to.be.undefined;
        });
    });

    describe('defaultPrompt', () => {

        const GOOD = 'Check this: [[text]] — thanks';

        it('uses a valid remote prompt', async () => {
            fetchImpl = ok({ ...REMOTE, defaultPrompt: GOOD });
            expect((await refreshConfig()).defaultPrompt).to.equal(GOOD);
        });

        // Without the placeholder the extension would fact-check an empty
        // template, so a prompt missing it is worse than no prompt at all.
        [
            ['is missing the [[text]] placeholder', 'no placeholder here'],
            ['is not a string', { a: 1 }],
            ['is empty', ''],
        ].forEach(([label, bad]) => {
            it(`falls back to the bundled prompt when the remote prompt ${label}`, async () => {
                fetchImpl = ok({ ...REMOTE, defaultPrompt: bad });
                expect((await refreshConfig()).defaultPrompt).to.equal(DEFAULT_PROMPT);
            });
        });

        it('falls back to the bundled prompt when the key is absent', async () => {
            fetchImpl = ok(REMOTE);
            expect((await refreshConfig()).defaultPrompt).to.equal(DEFAULT_PROMPT);
        });

        it('survives the cache round-trip', async () => {
            fetchImpl = ok({ ...REMOTE, defaultPrompt: GOOD });
            await refreshConfig();
            fetchImpl = dead();
            seedCache(cached().config);
            expect((await getConfig()).defaultPrompt).to.equal(GOOD);
        });

        it('is usable in the bundled fallback', () => {
            expect(DEFAULT_PROMPT).to.include('[[text]]');
        });
    });

    describe('getCachedConfig', () => {

        // The content script runs on every page load and must never fetch.
        it('returns the bundled config without fetching when there is no cache', async () => {
            fetchImpl = ok(REMOTE);
            const config = await getCachedConfig();
            expect(fetchCount).to.equal(0);
            expect(config.defaultModel).to.equal(FALLBACK_CONFIG.defaultModel);
        });

        it('serves even a stale cache without fetching', async () => {
            seedCache(REMOTE, 0);
            fetchImpl = ok(REMOTE);
            const config = await getCachedConfig();
            expect(fetchCount).to.equal(0);
            expect(config.defaultModel).to.equal('remote-b');
        });
    });

    describe('resolveModel', () => {

        it('honours a saved choice that is still offered', () => {
            expect(resolveModel(REMOTE, 'remote-a').id).to.equal('remote-a');
        });

        it('falls back to the default when the saved model was removed', () => {
            expect(resolveModel(REMOTE, 'deleted-model').id).to.equal('remote-b');
        });

        it('falls back to the default when nothing is saved', () => {
            expect(resolveModel(REMOTE, undefined).id).to.equal('remote-b');
        });
    });

    describe('bundled fallback mirrors the deployed file', () => {

        // FALLBACK_CONFIG is only reachable before the first successful fetch,
        // which makes drift from site/config.json easy to miss by hand.
        // xt-test runs from the project root; __dirname is absent under ESM.
        const deployed = JSON.parse(
            fs.readFileSync(path.resolve(process.cwd(), 'site/config.json'), 'utf8'));

        it('site/config.json is valid and self-consistent', () => {
            expect(deployed.defaultPrompt).to.include('[[text]]');
            expect(deployed.models.map(m => m.id)).to.include(deployed.defaultModel);
        });

        it('has the same models, in the same order, with the same thinking config', () => {
            const shape = models => models.map(m => [m.id, m.name, m.thinkingConfig || null]);
            expect(shape(FALLBACK_CONFIG.models)).to.deep.equal(shape(deployed.models));
        });

        it('has the same default model', () => {
            expect(FALLBACK_CONFIG.defaultModel).to.equal(deployed.defaultModel);
        });

        it('has the same default prompt', () => {
            expect(FALLBACK_CONFIG.defaultPrompt).to.equal(deployed.defaultPrompt);
        });
    });
});
