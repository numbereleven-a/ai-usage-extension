import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadTypeScript, deferred, flush, event } from './helpers/load-typescript.js';

const sample = (percentage) => ({
  session: { percentage, resetsAt: null },
  weekly: { percentage: 0, resetsAt: null },
  models: [],
  status: 'ok',
  lastUpdated: 123,
});
const providers = ['Claude', 'Codex', 'MiniMax', 'Kimi', 'Cursor', 'MiMo', 'Qwen'];

function serviceHarness(
  initial = {},
  globals = {},
  enabled = ['claude', 'codex', 'minimax', 'kimi', 'cursor', 'mimo', 'glm', 'qwen'],
) {
  let stored = structuredClone(initial);
  const writes = [];
  const chrome = {
    storage: {
      local: {
        get: async () => ({ ai_usage_state: structuredClone(stored) }),
        set: async (value) => {
          stored = structuredClone(value.ai_usage_state);
          writes.push(stored);
        },
      },
    },
  };
  const { UsageService } = loadTypeScript('src/background/services/UsageService.ts', {
    globals: { chrome, ...globals },
    mocks: {
      '../../shared/settings': {
        readExtensionSettings: async () => ({
          providers: Object.fromEntries(
            ['claude', 'codex', 'minimax', 'kimi', 'cursor', 'mimo', 'glm', 'qwen'].map((id) => [
              id,
              { visible: enabled.includes(id) },
            ]),
          ),
        }),
      },
    },
  });
  return { UsageService, writes, read: () => stored, chrome };
}

function stubProviders(service) {
  for (const name of providers) service[`fetch${name}Usage`] = async () => null;
  service.fetchGlmUsage = async () => ({ usage: null, rejected: false });
}

describe('provider refresh', () => {
  for (const enabled of [['codex'], ['glm'], []]) {
    it(`only refreshes selected providers: ${enabled.join(', ') || 'none'}`, async () => {
      const cached = { claude: sample(12), issues: { claude: 'auth' } };
      const { UsageService } = serviceHarness(cached, {}, enabled);
      const calls = [];
      for (const name of providers) {
        UsageService[`fetch${name}Usage`] = async () => {
          calls.push(name.toLowerCase());
          return sample(34);
        };
      }
      UsageService.fetchGlmUsage = async () => {
        calls.push('glm');
        return { usage: sample(34), rejected: false };
      };
      const result = await UsageService.refreshAllUsage();
      assert.deepEqual(calls, enabled);
      assert.deepEqual(structuredClone(result.claude), cached.claude);
      assert.equal(result.issues.claude, 'auth');
      for (const id of enabled) assert.equal(result[id].session.percentage, 34);
    });
  }

  it('follows the active Claude organization and falls back to the cache when its cookie is absent', async () => {
    let organization = 'synthetic-org-a';
    let cached = {};
    const requests = [];
    const chrome = {
      cookies: { get: async () => (organization ? { value: organization } : null) },
      storage: {
        local: {
          get: async () => cached,
          set: async (value) => {
            cached = { ...cached, ...value };
          },
        },
      },
    };
    const { UsageService } = loadTypeScript('src/background/services/UsageService.ts', {
      globals: {
        chrome,
        fetch: async (url) => {
          requests.push(url);
          return { ok: true, json: async () => ({ five_hour: { utilization: 15 } }) };
        },
      },
    });
    await UsageService.fetchClaudeUsage();
    organization = 'synthetic-org-b';
    await UsageService.fetchClaudeUsage();
    organization = null;
    await UsageService.fetchClaudeUsage();
    assert.deepEqual(
      requests.map((url) => url.split('/').at(-2)),
      ['synthetic-org-a', 'synthetic-org-b', 'synthetic-org-b'],
    );
    assert.equal(cached.claude_org_id, 'synthetic-org-b');
  });

  for (const failedEndpoint of ['detail', 'usage']) {
    it(`retains available MiMo data when the optional ${failedEndpoint} request fails`, async () => {
      const { UsageService } = serviceHarness(
        {},
        {
          fetch: async (url) => {
            if (url.endsWith(`/tokenPlan/${failedEndpoint}`)) throw new TypeError('offline');
            const payload = url.endsWith('/balance')
              ? { code: 0, data: { balance: '42', currency: 'USD' } }
              : url.endsWith('/detail')
                ? { data: { planCode: 'synthetic-plan' } }
                : { data: { monthUsage: { percent: 40 } } };
            return { ok: true, json: async () => payload };
          },
        },
      );
      const usage = await UsageService.fetchMiMoUsage();
      assert.equal(usage.summary, 'Balance · 42 USD');
      if (failedEndpoint === 'detail') assert.equal(usage.session.percentage, 40);
      else {
        assert.equal(usage.session.available, false);
        assert.equal(usage.plan, 'synthetic-plan');
      }
    });
  }

  it('publishes every ready provider while another is pending, without losing cached data', async () => {
    const cached = sample(12);
    const { UsageService, read } = serviceHarness({ kimi: cached });
    stubProviders(UsageService);
    const slow = deferred();
    UsageService.fetchQwenUsage = () => slow.promise;
    for (const name of providers.filter((name) => !['Qwen', 'Kimi'].includes(name))) {
      UsageService[`fetch${name}Usage`] = async () => sample(34);
    }
    UsageService.fetchGlmUsage = async () => ({ usage: sample(34), rejected: false });
    UsageService.fetchKimiUsage = async () => {
      throw new Error('offline');
    };
    let complete = false;
    const refresh = UsageService.refreshAllUsage().then((state) => {
      complete = true;
      return state;
    });
    await flush();
    assert.equal(complete, false);
    for (const id of ['claude', 'codex', 'minimax', 'cursor', 'mimo', 'glm']) {
      assert.equal(read()[id].session.percentage, 34, id);
    }
    assert.deepEqual(read().kimi, cached);
    slow.resolve(sample(56));
    const result = await refresh;
    assert.deepEqual(structuredClone(result), read());
    assert.equal(read().qwen.session.percentage, 56);
  });

  it('serializes storage writes even when providers finish together', async () => {
    const { UsageService, chrome, read } = serviceHarness();
    stubProviders(UsageService);
    UsageService.fetchClaudeUsage = async () => sample(10);
    UsageService.fetchMiMoUsage = async () => sample(20);
    const firstWrite = deferred();
    const save = chrome.storage.local.set;
    let concurrent = 0;
    let peak = 0;
    chrome.storage.local.set = async (value) => {
      concurrent++;
      peak = Math.max(peak, concurrent);
      const snapshot = structuredClone(value);
      await firstWrite.promise;
      await save(snapshot);
      concurrent--;
    };
    const refresh = UsageService.refreshAllUsage();
    await flush();
    assert.equal(peak, 1);
    firstWrite.resolve();
    await refresh;
    assert.equal(peak, 1);
    assert.equal(read().claude.session.percentage, 10);
    assert.equal(read().mimo.session.percentage, 20);
  });

  it('waits for pending providers after a storage error and allows later writes', async () => {
    const { UsageService, chrome, read } = serviceHarness();
    stubProviders(UsageService);
    const slow = deferred();
    UsageService.fetchQwenUsage = () => slow.promise;
    UsageService.fetchMiMoUsage = async () => sample(15);
    const save = chrome.storage.local.set;
    let failed = false;
    chrome.storage.local.set = async (value) => {
      if (!failed) {
        failed = true;
        throw new Error('storage unavailable');
      }
      return save(value);
    };
    let settled = false;
    const refresh = UsageService.refreshAllUsage().finally(() => {
      settled = true;
    });
    const rejection = assert.rejects(refresh, /storage unavailable/);
    await flush();
    assert.equal(settled, false);
    slow.resolve(sample(25));
    await rejection;
    assert.equal(read().qwen.session.percentage, 25);
    assert.equal(read().mimo.session.percentage, 15);
  });

  it('updates GLM authentication issues without discarding other providers', async () => {
    const { UsageService, read } = serviceHarness({ mimo: sample(5), issues: { kimi: 'auth' } });
    stubProviders(UsageService);
    UsageService.fetchGlmUsage = async () => ({ usage: null, rejected: true });
    await UsageService.refreshAllUsage();
    assert.deepEqual(read().issues, { kimi: 'auth', glm: 'auth' });
    UsageService.fetchGlmUsage = async () => ({ usage: sample(6), rejected: false });
    await UsageService.refreshAllUsage();
    assert.deepEqual(read().issues, { kimi: 'auth' });
    assert.equal(read().mimo.session.percentage, 5);
    assert.equal(read().glm.session.percentage, 6);
  });

  it('bounds both JSON and session requests and recovers on the next attempt', async () => {
    const signals = [];
    const controllers = [];
    const { UsageService } = serviceHarness(
      {},
      {
        AbortSignal: {
          timeout: (ms) => {
            assert.equal(ms, 10_000);
            const controller = new AbortController();
            controllers.push(controller);
            return controller.signal;
          },
        },
        fetch: async (_url, init) => {
          signals.push(init.signal);
          assert.equal(init.credentials, 'include');
          return new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('timeout')));
          });
        },
      },
    );
    const cursor = assert.rejects(UsageService.fetchCursorUsage(), /timeout/);
    const codex = assert.rejects(UsageService.fetchCodexUsage(), /timeout/);
    assert.equal(signals.length, 2);
    controllers.forEach((controller) => controller.abort());
    await Promise.all([cursor, codex]);
    const retry = assert.rejects(UsageService.fetchCursorUsage(), /timeout/);
    assert.equal(signals[2].aborted, false);
    controllers[2].abort();
    await retry;
  });

  it('fetches fresh usage and session credentials even when HTTP responses were cached', async () => {
    let current = 12;
    const cached = new Map();
    const tokens = [];
    const { UsageService } = serviceHarness(
      {},
      {
        fetch: async (url, init) => {
          const isSession = url.endsWith('/api/auth/session');
          if (!isSession) tokens.push(init.headers.Authorization);
          const fresh = isSession
            ? { accessToken: `token-${current}` }
            : {
                rate_limit: {
                  primary_window: { used_percent: current, limit_window_seconds: 18000 },
                },
              };
          const payload = init.cache === 'no-store' ? fresh : (cached.get(url) ?? fresh);
          cached.set(url, payload);
          return { ok: true, json: async () => payload };
        },
      },
    );

    assert.equal((await UsageService.fetchCodexUsage()).session.percentage, 12);
    current = 63;
    assert.equal((await UsageService.fetchCodexUsage()).session.percentage, 63);
    assert.deepEqual(tokens, ['Bearer token-12', 'Bearer token-63']);
  });
});

function workerHarness(alarm, refresh = { mode: 'auto', intervalMinutes: 5 }) {
  const calls = { refresh: 0, create: [], clear: [], badges: [] };
  const pending = deferred();
  const chrome = {
    runtime: {
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
      getURL: (path) => path,
    },
    alarms: {
      onAlarm: event(),
      get: async () => alarm,
      create: async (...args) => calls.create.push(args),
      clear: async (name) => calls.clear.push(name),
    },
    storage: { onChanged: event(), local: { get: async () => ({}), set: async () => {} } },
    tabs: { create: async () => {} },
  };
  loadTypeScript('src/background/index.ts', {
    globals: { chrome },
    mocks: {
      '../shared/language': { applyStoredLanguage: async () => {} },
      '../shared/locales': { loadLocaleMessages: async () => ({}) },
      '../shared/settings': { readExtensionSettings: async () => ({ language: 'auto', refresh }) },
      './badge': { updateBadge: async (state) => calls.badges.push(state) },
      './services/analytics': { track: async () => true },
      './services/UsageService': {
        UsageService: {
          getUsageState: async () => ({}),
          refreshAllUsage: () => {
            calls.refresh++;
            return pending.promise;
          },
        },
      },
    },
  });
  return {
    chrome,
    calls,
    pending,
    setRefresh: (next) => {
      refresh = next;
    },
  };
}

describe('worker startup and refresh scheduling', () => {
  it('refreshes and restores a missing alarm without install/startup events (re-enable)', async () => {
    const { calls, pending } = workerHarness(undefined);
    await flush();
    assert.equal(calls.refresh, 1);
    assert.equal(calls.create.length, 1);
    assert.equal(calls.create[0][0], 'refreshUsage');
    assert.equal(calls.create[0][1].periodInMinutes, 5);
    pending.resolve({});
    await flush();
  });

  it('preserves an existing alarm and shares a running refresh across all triggers', async () => {
    const { chrome, calls, pending } = workerHarness({ name: 'refreshUsage', periodInMinutes: 5 });
    await flush();
    chrome.runtime.onStartup.emit();
    chrome.runtime.onInstalled.emit({ reason: 'update' });
    chrome.alarms.onAlarm.emit({ name: 'refreshUsage' });
    const response = deferred();
    chrome.runtime.onMessage.emit({ type: 'REFRESH_USAGE' }, {}, response.resolve);
    assert.equal(calls.refresh, 1);
    assert.equal(calls.create.length, 0);
    pending.resolve({ mimo: sample(7) });
    assert.equal((await response.promise).data.mimo.session.percentage, 7);
  });

  it('updates the badge from partial snapshots before the refresh completes', async () => {
    const { chrome, calls, pending } = workerHarness({ name: 'refreshUsage', periodInMinutes: 5 });
    await flush();
    chrome.storage.onChanged.emit({ ai_usage_state: { newValue: { mimo: sample(8) } } }, 'local');
    await flush();
    assert.equal(calls.badges.at(-1).mimo.session.percentage, 8);
    pending.resolve({});
    await flush();
  });

  for (const periodInMinutes of [undefined, 180]) {
    it(`repairs an alarm with period ${periodInMinutes}`, async () => {
      const { calls, pending } = workerHarness({ name: 'refreshUsage', periodInMinutes });
      await flush();
      assert.equal(calls.create.length, 1);
      assert.equal(calls.create[0][0], 'refreshUsage');
      assert.equal(calls.create[0][1].periodInMinutes, 5);
      pending.resolve({});
      await flush();
    });
  }

  it('allows the next alarm to retry after a failed refresh', async () => {
    const { chrome, calls, pending } = workerHarness({ name: 'refreshUsage', periodInMinutes: 5 });
    await flush();
    pending.reject(new Error('offline'));
    await flush();
    chrome.alarms.onAlarm.emit({ name: 'unrelated' });
    assert.equal(calls.refresh, 1);
    chrome.alarms.onAlarm.emit({ name: 'refreshUsage' });
    await flush();
    assert.equal(calls.refresh, 2);
    await flush();
  });

  it('removes the alarm and skips every automatic trigger in manual mode, but permits Refresh', async () => {
    const { chrome, calls, pending } = workerHarness(
      { name: 'refreshUsage', periodInMinutes: 5 },
      { mode: 'manual', intervalMinutes: 5 },
    );
    await flush();
    assert.deepEqual(calls.clear, ['refreshUsage']);
    assert.equal(calls.create.length, 0);
    assert.equal(calls.refresh, 0);
    chrome.runtime.onStartup.emit();
    chrome.runtime.onInstalled.emit({ reason: 'update' });
    chrome.alarms.onAlarm.emit({ name: 'refreshUsage' });
    chrome.storage.onChanged.emit({ glm_api_key: { newValue: 'synthetic-key' } }, 'local');
    chrome.runtime.onMessage.emit(
      { type: 'SET_GLM_TOKEN', token: 'synthetic-token' },
      {},
      () => {},
    );
    const automatic = deferred();
    chrome.runtime.onMessage.emit(
      { type: 'REFRESH_USAGE', automatic: true },
      {},
      automatic.resolve,
    );
    assert.equal((await automatic.promise).success, true);
    await flush();
    assert.equal(calls.refresh, 0);
    const manual = deferred();
    chrome.runtime.onMessage.emit({ type: 'REFRESH_USAGE' }, {}, manual.resolve);
    assert.equal(calls.refresh, 1);
    pending.resolve({ mimo: sample(13) });
    assert.equal((await manual.promise).data.mimo.session.percentage, 13);
  });

  it('reschedules custom intervals and applies manual/automatic changes immediately', async () => {
    const { chrome, calls, pending, setRefresh } = workerHarness(undefined, {
      mode: 'auto',
      intervalMinutes: 12.5,
    });
    await flush();
    assert.equal(calls.create[0][1].periodInMinutes, 12.5);
    pending.resolve({});
    await flush();
    setRefresh({ mode: 'manual', intervalMinutes: 12.5 });
    chrome.storage.onChanged.emit({ ai_usage_settings: { newValue: {} } }, 'local');
    await flush();
    assert.deepEqual(calls.clear, ['refreshUsage']);
    chrome.alarms.onAlarm.emit({ name: 'refreshUsage' });
    await flush();
    assert.equal(calls.refresh, 1);
    setRefresh({ mode: 'auto', intervalMinutes: 30 });
    chrome.storage.onChanged.emit({ ai_usage_settings: { newValue: {} } }, 'local');
    await flush();
    assert.equal(calls.create.at(-1)[1].periodInMinutes, 30);
  });
});

function popupHarness(initial = {}, mode = 'auto', saveFailure = false) {
  const states = [];
  let cleanup;
  let refreshCalls = 0;
  const pending = deferred();
  const changes = event();
  let preferences = {
    providers: {},
    popupLayout: 'grid',
    percentageDisplay: 'remaining',
    refresh: { mode, intervalMinutes: 12.5 },
  };
  const saves = [];
  const { useUsageData } = loadTypeScript('src/sidepanel/hooks/useUsageData.ts', {
    globals: { chrome: { storage: { onChanged: changes } } },
    mocks: {
      react: {
        useState: (value) => {
          const index = states.length;
          states.push(value);
          return [
            value,
            (next) => {
              states[index] = next;
            },
          ];
        },
        useEffect: (effect) => {
          cleanup = effect();
        },
        useCallback: (callback) => callback,
      },
      '../../shared/i18n': { msg: (key) => key },
      '../../shared/settings': {
        readExtensionSettings: async () => preferences,
        saveExtensionSettings: async (next) => {
          if (saveFailure) throw new Error('storage unavailable');
          preferences = next;
          saves.push(next);
          changes.emit({ ai_usage_settings: { newValue: next } }, 'local');
        },
      },
      '../../shared/messaging': {
        readUsageState: async () => initial,
        requestUsageRefresh: () => {
          refreshCalls++;
          return pending.promise;
        },
      },
    },
  });
  const data = useUsageData();
  return {
    states,
    pending,
    changes,
    refresh: data.refresh,
    toggleRefreshMode: data.toggleRefreshMode,
    saves,
    cleanup: () => cleanup(),
    calls: () => refreshCalls,
  };
}

describe('popup hydration', () => {
  it('toggles the saved refresh mode in both directions without changing the interval or fetching usage', async () => {
    const { states, toggleRefreshMode, saves, calls, cleanup } = popupHarness({}, 'manual');
    await flush();
    await toggleRefreshMode();
    assert.equal(states[1].refresh.mode, 'auto');
    await toggleRefreshMode();
    assert.equal(states[1].refresh.mode, 'manual');
    assert.deepEqual(
      saves.map((settings) => settings.refresh.mode),
      ['auto', 'manual'],
    );
    for (const saved of saves) {
      assert.equal(saved.refresh.intervalMinutes, 12.5);
      assert.equal(saved.popupLayout, 'grid');
      assert.equal(saved.percentageDisplay, 'remaining');
    }
    assert.equal(calls(), 0);
    cleanup();
  });

  it('keeps the current mode and reports a failed mode save', async () => {
    const { states, toggleRefreshMode, cleanup } = popupHarness({}, 'manual', true);
    await flush();
    await toggleRefreshMode();
    assert.equal(states[1].refresh.mode, 'manual');
    assert.equal(states[4], 'optionsSaveError');
    cleanup();
  });

  it('shows A or M with the current mode and switching action in the popup header', () => {
    const { createDefaultSettings } = loadTypeScript('src/shared/settings.ts');
    let settings = createDefaultSettings();
    const assets = [
      'claude-anthropic.jpg',
      'codex-openai.jpg',
      'cursor.webp',
      'kimi.webp',
      'minimax.webp',
      'xiaomimimo.webp',
      'qwen.webp',
      'zai.webp',
    ];
    const { App } = loadTypeScript('src/sidepanel/App.tsx', {
      globals: { chrome: { runtime: { getManifest: () => ({ version: '0.1.30' }) } } },
      mocks: {
        ...Object.fromEntries(assets.map((asset) => [`../assets/brands/${asset}`, 'brand.png'])),
        './styles/global.css': {},
        '../shared/analytics/track': { trackFrom: () => async () => true },
        '../shared/hooks/useNow': { useNow: () => 123 },
        './hooks/useUsageData': {
          useUsageData: () => ({
            usage: {},
            settings,
            loading: false,
            refreshing: false,
            error: null,
            changingRefreshMode: false,
            refresh: async () => {},
            toggleRefreshMode: async () => {},
          }),
        },
      },
    });
    const automatic = renderToStaticMarkup(createElement(App));
    assert.match(automatic, /class="au-version">v0\.1\.30<\/span>/);
    assert.match(automatic, /title="Usage refresh: Automatic → Only on Refresh"/);
    assert.match(automatic, /aria-pressed="true"[^>]*><span aria-hidden="true">A<\/span>/);
    settings.refresh.mode = 'manual';
    const manual = renderToStaticMarkup(createElement(App));
    assert.match(manual, /title="Usage refresh: Only on Refresh → Automatic"/);
    assert.match(manual, /aria-pressed="false"[^>]*><span aria-hidden="true">M<\/span>/);
  });

  it('shows cached data without fetching in manual mode and refreshes on demand', async () => {
    const cache = { mimo: sample(13) };
    const { states, pending, refresh, calls, cleanup } = popupHarness(cache, 'manual');
    await flush();
    assert.equal(calls(), 0);
    assert.equal(states[0], cache);
    assert.equal(states[2], false);
    assert.equal(states[3], false);
    const refreshing = refresh();
    assert.equal(calls(), 1);
    pending.resolve({ mimo: sample(25) });
    await refreshing;
    assert.equal(states[0].mimo.session.percentage, 25);
    cleanup();
  });

  it('automatically refreshes, shows cache immediately, and receives partial snapshots', async () => {
    const cache = { mimo: sample(1) };
    const { states, pending, changes, calls, cleanup } = popupHarness(cache);
    await flush();
    assert.equal(calls(), 1);
    assert.equal(states[0], cache);
    assert.equal(states[2], true); // initial fetch still loading
    assert.equal(states[3], true); // refresh button spinning
    const partial = { ...cache, cursor: sample(2) };
    changes.emit({ ai_usage_state: { newValue: partial } }, 'local');
    assert.equal(states[0], partial);
    pending.resolve(partial);
    await flush();
    assert.equal(states[2], false);
    assert.equal(states[3], false);
    cleanup();
  });

  it('leaves loading and retains cached data when the refresh fails', async () => {
    const cache = { mimo: sample(1) };
    const { states, pending, cleanup } = popupHarness(cache);
    await flush();
    pending.reject('offline');
    await flush();
    assert.equal(states[0], cache);
    assert.equal(states[2], false);
    assert.equal(states[3], false);
    assert.equal(states[4], 'refreshFailed');
    cleanup();
  });

  it('ignores responses after the popup closes', async () => {
    const { states, pending, cleanup } = popupHarness();
    await flush();
    cleanup();
    const before = [...states];
    pending.resolve({ mimo: sample(9) });
    await flush();
    assert.deepEqual(states, before);
  });
});
