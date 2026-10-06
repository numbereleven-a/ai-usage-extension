# AI Usage Tracker: Claude, Codex, Kimi, Cursor, GLM, Qwen

Fork of [cupcakedev/ai-usage-extension](https://github.com/cupcakedev/ai-usage-extension),
with Chrome and Firefox builds.

[![CI](https://github.com/numbereleven-a/ai-usage-extension/actions/workflows/ci.yml/badge.svg)](https://github.com/numbereleven-a/ai-usage-extension/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

A Chrome and Firefox extension (Manifest V3) that tracks usage limits from **Claude**, **Codex**,
**MiniMax**, **Kimi Code**, **Cursor**, **Xiaomi MiMo**, the **GLM Coding Plan**
(z.ai), and the **Qwen Coding Plan** (Qwen Cloud), using your existing browser
sessions. It surfaces the data in a popup, an on-page overlay, and the toolbar
badge.

## Features

- **Live limits** for Claude, Codex, MiniMax, Kimi Code, Cursor, Xiaomi MiMo, and the
  GLM and Qwen Coding Plans: percentage used, raw counts, and time to reset when
  exposed by the provider.
- **Toolbar badge** showing your highest current usage at a glance.
- **On-page overlay** on `claude.ai` — a collapsible capsule rendered in a Shadow DOM,
  so it never clashes with the host page's styles.
- **Configurable refresh**: automatic updates every 5 minutes by default, with a
  custom interval of at least 1 minute, or manual updates only via **Refresh**.
- **Limit display**: show the used percentage (13% used) or remaining percentage
  (87% left) across all providers, including the popup, overlays, and badge tooltip.
- **Private by design**: usage is read from your own authenticated browser sessions.
  No extension accounts, no background telemetry.
- **Problem reports**: an optional "Report a problem" button in the popup footer sends
  the message you type — and nothing else until you press Send — to PostHog.

## Install

Download the browser-specific package from
[GitHub Releases](https://github.com/numbereleven-a/ai-usage-extension/releases).
The extension is not distributed through npm.

### Chrome and Chromium browsers

1. Download the [Chrome 0.1.30 ZIP](https://github.com/numbereleven-a/ai-usage-extension/releases/download/v0.1.30/ai-usage-tracker-0.1.30.zip) and extract it to a folder.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Click **Load unpacked** and select the extracted folder containing `manifest.json`.

To build from source, use the `main` branch:

```bash
git switch main
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Load the generated `dist/` folder through **Load unpacked**.

### Firefox

Firefox 140 or newer is required. The [Firefox 0.1.30 ZIP](https://github.com/numbereleven-a/ai-usage-extension/releases/download/v0.1.30/ai-usage-tracker-0.1.30-firefox.zip) contains an unsigned extension for temporary installation:

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Extract the downloaded ZIP and select its `manifest.json`.

Temporary add-ons are removed when Firefox restarts. Permanent installation in
standard Firefox requires an XPI signed by Mozilla through addons.mozilla.org.

To build from source, use the
[`v0.1.30` tag](https://github.com/numbereleven-a/ai-usage-extension/tree/v0.1.30):

```bash
git switch --detach v0.1.30
corepack enable
pnpm install --frozen-lockfile
pnpm build
```

Select `dist/manifest.json` through **Load Temporary Add-on**. Allow access to the
provider sites in the extension's permissions if Firefox asks for it.

### Usage settings

Sign in to the providers you want to track, then open the popup. It refreshes
automatically by default; in manual mode, press **Refresh**.

Only providers selected in **Settings** are refreshed. Hidden providers keep their last saved snapshot.

Open **Settings** to select **Usage refresh** and set a custom interval in minutes
(fractional values are supported). The interval is saved when you leave the field
or press Enter. **Only on Refresh** removes the background alarm and suppresses
automatic usage requests on worker startup, popup/overlay opening, and credential
changes. Cached data remains visible until you press Refresh. A request already
in progress when you switch modes is allowed to finish.

The popup header also has a mode button next to Refresh: **M** means manual and
**A** means automatic. Click it to switch modes without opening Settings; the
configured automatic interval is preserved.

Under **Popup layout**, **Limit display** switches between **Used** and **Remaining**.
Percentage labels and progress-bar fill follow the selected mode. Warning colors,
badge icon ranges, raw counts, and stored usage calculations still use the consumed
amount.

## Architecture

The extension is split into isolated contexts that communicate through a typed
messaging layer:

```text
src/
  background/   # Chrome service worker / Firefox event page: fetching, scheduling, badge
    services/   # UsageService — fetches & parses provider APIs
  content/      # claude.ai overlay (React in Shadow DOM) + z.ai token bridge
  welcome/      # First-run onboarding page opened on install
  sidepanel/    # Popup UI (React)
    components/ # Presentational components
    hooks/      # useUsageData — owns the popup's data lifecycle
  shared/       # Cross-context layer — no context-specific imports
    constants  # Storage keys, alarm name, thresholds
    hooks      # Framework hooks shared by popup & overlay (useNow)
    analytics  # Manual problem reports: distinct id, event map, popup -> worker bridge
    messaging  # Typed message helpers (readUsageState, requestUsageRefresh)
    types      # Domain & messaging types
    utils      # clampPercent, getUsageTone, formatReset, formatRelativeTime
```

**Data flow:** the background worker fetches usage, writes a `UsageState` snapshot to
`browser.storage.local`, and updates the badge. The popup and overlay read that
snapshot and subscribe to `browser.storage.onChanged`, so every surface stays in sync.
Each provider is saved as soon as its request completes, without waiting for slower
providers. Requests bypass the HTTP cache and time out after 10 seconds; failed
requests retain the last successful snapshot and its original update time.
The worker checks the configured refresh mode whenever it starts and when settings
change: it restores the recurring alarm in automatic mode and clears it in manual
mode. Browsers may delay alarms while the device is asleep.

Chrome sources are maintained in `main`; Firefox 0.1.30 sources are preserved in the `v0.1.30` tag.
Chrome uses `chrome.*` APIs and a service worker; Firefox uses `browser.*` APIs
and a background event page. Both builds expose the same usage and display settings.

**Localization:** every user-visible string goes through `msg()`
(`src/shared/i18n.ts`), which reads `public/_locales/<locale>/messages.json`.
All 53 supported languages are translated and the release tests enforce
that they expose the same keys. The one exception is the overlay's "LIMITS"
side tab, which stays in English everywhere by design.

Settings carry a `language` preference: `auto` follows the browser, anything
else loads that `_locales` bundle at startup and feeds it to `msg()` through
`setLocaleMessages`. Because several modules build label tables with `msg()` at
import time, the popup and options entry points apply the language *before*
importing their app; the content script gets the same bundle from the service
worker (`GET_LOCALE_MESSAGES`), which cannot be fetched from a page context.

## Problem reports

The popup footer carries a **Report a problem** button. It opens a dialog, and pressing
Send hands the message to the service worker, which forwards it to PostHog as a single
`problem_reported` event. Nothing is captured automatically: no pageviews, no
autocapture, no exception tracking, no session recording. Alongside the message the
event carries the extension version, browser version, UI language, and which provider
cards are enabled or failing — the context needed to act on the report. The reporter is
identified only by a random UUID generated locally on first use
(`ai_usage_distinct_id` in `browser.storage.local`).

Firefox asks for optional data collection consent when Send is pressed. Reports
are sent only while that consent is granted; it can be revoked in `about:addons`.
Session authentication is sent only to the corresponding providers to read usage.

Reporting is configured through the build environment (see `.env.example`):

```bash
VITE_POSTHOG_PROJECT_TOKEN=phc_...
VITE_POSTHOG_HOST=https://eu.i.posthog.com
```

Without a project token the feature stays off and the footer button becomes a plain
link to GitHub issues instead.

In CI the same variables come from the repository settings: add the token as the
`VITE_POSTHOG_PROJECT_TOKEN` **secret**, and — only if you are not on the EU cloud —
`VITE_POSTHOG_HOST` as a repository **variable**. Both workflows pass them to the build.
Without a token, the release workflow reports a warning and builds with the GitHub
issues link instead of the problem-report dialog.

## Getting Started

### Requirements

- Node.js 20 or newer
- pnpm 9.15.0 via Corepack
- Chrome or another Chromium browser with Manifest V3 support, or Firefox 140 or newer

### Install dependencies

```bash
corepack enable
pnpm install
```

### Develop

```bash
pnpm dev
```

Builds to `dist/` and watches for changes.

### Verify

```bash
pnpm lint
pnpm format:check
pnpm test
pnpm build
```

For the Firefox sources, also run `pnpm lint:firefox` after building.

## Scripts

| Command              | Description                                   |
| -------------------- | --------------------------------------------- |
| `pnpm dev`           | Build and watch for development.              |
| `pnpm bump`          | Bump `package.json` and `manifest.json` patch versions. |
| `pnpm build`         | Type-check, then produce a production build.  |
| `pnpm release`       | Test, build, and package a Chrome ZIP (`main`) or unsigned Firefox XPI (Firefox sources). |
| `pnpm lint:firefox`  | Validate the Firefox build with Mozilla's extension linter (Firefox sources). |
| `pnpm typecheck`     | Run `tsc` with no emit.                       |
| `pnpm test`          | Run usage-refresh regression tests and store release-gate checks. |
| `pnpm lint`          | Lint `src/` with ESLint.                      |
| `pnpm format`        | Format `src/` with Prettier.                  |
| `pnpm promo`         | Render the store artwork into `store/<locale>/promo/`. |
| `pnpm promo:dev`     | Preview the store artwork in the browser.     |

## Contributing

Issues and pull requests are welcome. Please read [CONTRIBUTING.md](./CONTRIBUTING.md)
before opening a larger change.

## Security

Please do not open public issues for suspected vulnerabilities. Follow
[SECURITY.md](./SECURITY.md) instead.

## License

MIT
