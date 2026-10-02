import { it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript, event, flush } from './helpers/load-typescript.js';

it('keeps popup changes when the open options page saves and serializes rapid edits', async () => {
  let stored = {};
  const changes = event();
  const chrome = {
    storage: {
      onChanged: changes,
      local: {
        get: async () => structuredClone(stored),
        set: async (values) => {
          const updates = Object.fromEntries(
            Object.entries(values).map(([key, newValue]) => [
              key,
              { oldValue: stored[key], newValue },
            ]),
          );
          stored = { ...stored, ...structuredClone(values) };
          changes.emit(updates, 'local');
        },
      },
    },
  };
  const states = [];
  let cleanup;
  const { useOptionsSettings } = loadTypeScript('src/options/hooks/useOptionsSettings.ts', {
    globals: { chrome },
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
        useRef: (current) => ({ current }),
        useCallback: (callback) => callback,
        useEffect: (effect) => {
          cleanup = effect();
        },
      },
    },
  });
  const options = useOptionsSettings();
  await flush();
  const { useUsageData } = loadTypeScript('src/sidepanel/hooks/useUsageData.ts', {
    globals: { chrome },
    mocks: {
      react: {
        useState: (value) => [value, () => {}],
        useCallback: (callback) => callback,
        useEffect: (effect) => effect(),
      },
      '../../shared/messaging': {
        readUsageState: async () => ({}),
        requestUsageRefresh: async () => ({}),
      },
    },
  });
  const popup = useUsageData();
  await flush();
  await popup.toggleRefreshMode();
  assert.equal(states[0].refresh.mode, 'manual');
  options.updateSettings((current) => ({ ...current, percentageDisplay: 'remaining' }));
  options.updateSettings((current) => ({ ...current, popupLayout: 'grid' }));
  await flush();
  assert.equal(stored.ai_usage_settings.refresh.mode, 'manual');
  assert.equal(stored.ai_usage_settings.percentageDisplay, 'remaining');
  assert.equal(stored.ai_usage_settings.popupLayout, 'grid');
  assert.equal(states[0].popupLayout, 'grid');
  cleanup();
});

it('preserves automatic defaults and normalizes stored refresh preferences', () => {
  const { normalizeSettings } = loadTypeScript('src/shared/settings.ts');
  const legacy = normalizeSettings({ popupLayout: 'grid' });
  assert.equal(legacy.refresh.mode, 'auto');
  assert.equal(legacy.refresh.intervalMinutes, 5);
  const custom = normalizeSettings({ refresh: { mode: 'manual', intervalMinutes: 12.5 } });
  assert.equal(custom.refresh.mode, 'manual');
  assert.equal(custom.refresh.intervalMinutes, 12.5);
  for (const intervalMinutes of [0, '10', Infinity]) {
    assert.equal(normalizeSettings({ refresh: { intervalMinutes } }).refresh.intervalMinutes, 5);
  }
});
