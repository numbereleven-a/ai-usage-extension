import { it } from 'node:test';
import assert from 'node:assert/strict';
import { loadTypeScript } from './helpers/load-typescript.js';

it('requests Firefox consent before sending a report and stops when it is denied', async () => {
  const calls = [];
  let granted = false;
  const { trackFrom } = loadTypeScript('src/shared/analytics/track.ts', {
    globals: {
      browser: {
        permissions: {
          request: async ({ data_collection }) => {
            calls.push(data_collection);
            return granted;
          },
        },
        runtime: {
          sendMessage: async (message) => {
            calls.push(message.type);
            return { success: true };
          },
        },
      },
    },
  });
  const send = trackFrom('popup');
  assert.equal(await send('problem_reported', { message: 'Example report' }), false);
  assert.deepEqual(structuredClone(calls), [
    ['technicalAndInteraction', 'personallyIdentifyingInfo'],
  ]);
  granted = true;
  assert.equal(await send('problem_reported', { message: 'Example report' }), true);
  assert.equal(calls.at(-1), 'TRACK');
});

it('checks consent again in the background before initializing reporting', async () => {
  let granted = false;
  let initialized = 0;
  const captures = [];
  const registered = [];
  class PostHog {
    init() { initialized++; }
    register(properties) { registered.push(properties); }
    capture(event, properties) { captures.push({ event, properties }); }
  }
  const { track } = loadTypeScript('src/background/services/analytics.ts', {
    globals: {
      navigator: { userAgent: 'Mozilla/5.0 Firefox/157.0' },
      browser: {
        permissions: { contains: async () => granted },
        runtime: { getManifest: () => ({ version: '0.1.27' }) },
        i18n: { getUILanguage: () => 'en-US' },
      },
    },
    mocks: {
      'posthog-js/dist/module.no-external': { PostHog },
      '../../shared/constants': {
        POSTHOG_PROJECT_TOKEN: 'test-token',
        POSTHOG_HOST: 'https://example.invalid',
        REPORT_DATA_PERMISSIONS: {
          data_collection: ['technicalAndInteraction', 'personallyIdentifyingInfo'],
        },
      },
      '../../shared/analytics/distinctId': { sharedDistinctId: async () => 'test-id' },
      '../../shared/settings': { readExtensionSettings: async () => ({ providers: {} }) },
      './UsageService': { UsageService: { getUsageState: async () => ({}) } },
    },
  });
  assert.equal(await track('problem_reported', { message: 'Example report' }, 'popup'), false);
  assert.equal(initialized, 0);
  granted = true;
  assert.equal(await track('problem_reported', { message: 'Example report' }, 'popup'), true);
  assert.equal(registered[0].browser_version, '157.0');
  assert.equal(captures.length, 1);
  granted = false;
  assert.equal(await track('problem_reported', { message: 'Example report' }, 'popup'), false);
  assert.equal(captures.length, 1);
});
