# CLAUDE.md

Guidance for Claude Code when working in this repository. The project's actual history — the
reasoning behind most decisions — lives in git commit messages and in two docs, not in any
conversation transcript. A conversation isn't preserved forever; this file, the commit log, and
those docs are.

- **`README.md`** — what the app does and why it's split into a core app / plugin SDK / reference
  plugin, and what actually runs today.
- **`docs/architecture-design.md`** — the *why/what was decided* for the plugin architecture:
  Session (§6), the HTTP client (§7), UI extensibility (§8), the trust/install model (§9), etc.
  Read the relevant section before touching code in that area — most non-obvious design calls are
  explained there, not in code comments.
- **`docs/implementation-plan.md`** — *in what order it's being built*: a phase table with a status
  column (⬜/✅) and, per completed phase, a paragraph on what was actually decided/found while
  building it (real gaps discovered, live-verification scope/limits, deferred edge cases). Read the
  entry for a phase before extending it — it usually says what was deliberately left out and why.

## Working conventions

- **Only commit when explicitly asked.** Don't commit proactively after finishing a change.
- **The commit message explains *why*, not just what** — same reasoning as `docs/implementation-plan.md`
  itself: this repo treats the git log as real decision history, not a changelog.
- **Before considering a phase done**: `npm run typecheck`, `npm run build`, `npm test`, `npm run
  lint` from the repo root (each already fans out across all three workspaces — `typecheck`/`build`
  build the SDK first since `ic-core`/`ic-email-to-downloads` both depend on its compiled output,
  not its source, via the npm workspace link). Then update `docs/implementation-plan.md`'s row for
  that phase (✅ + a paragraph on what was actually decided/found — see above) before moving on.
- **`npm audit`** is part of the same pre-done checklist but is known to be flaky in some sandboxed
  environments (a network timeout to the registry's advisory endpoint) — note that explicitly if it
  can't complete rather than silently skipping it.
- **A plugin's `sessionRequirements` must list at least one real entry — don't reach for an empty
  array as a "this doesn't really need a session" shortcut.** Even a purely local resource (e.g.
  the local-folder destination's folder access) goes through a real `Session`/`SessionPlugin` if
  the OS gates access to it or it can go stale later (permissions revoked, the resource deleted) —
  that's exactly the lifecycle `Session` exists to model, not something to route around. See
  `docs/architecture-design.md` §6.1 and `packages/ic-email-to-downloads/src/local-folder-session.ts`
  for the precedent.
- **A plugin bringing its own custom (`confirmsBuiltIn: false`) session type sets `sessionPlugin`**
  on itself (`SourcePlugin`/`DestinationPlugin`) so the install pipeline can actually register it —
  don't add a new session type without checking it gets wired into every real caller of
  `installPlugin()` (currently `packages/ic-core/electron/main/index.ts`'s `PluginsInstall` handler
  passes `sessionsRegistry` for exactly this) — it's an easy step to add to the SDK/pipeline and
  forget to actually thread through at the one real call site.

## Restarting the dev app

Kill by exact PID — matching by process name alone is unreliable across platforms/Electron
versions:

```bash
ps aux | grep -i "invoice-collector-app" | grep -iE "electron|npm run" | grep -v grep | awk '{print $2}' | xargs -r kill -9
nohup npm run electron:dev --workspace ic-core > /tmp/electron-app-dev-<label>.log 2>&1 & disown
# confirm exactly one instance is running before considering the restart done:
ps aux | grep -i "invoice-collector-app" | grep -iE "electron|npm run" | grep -v grep
```

`electron:dev` (unpackaged) runs under a separate `app.setName('Invoice Collector App Dev')`
identity, gated on `!app.isPackaged`, set in `packages/ic-core/electron/main/index.ts` **before**
`app.whenReady()`/any `app.getPath()`/`safeStorage` call. This is deliberately a *different* name
from the private predecessor repo's own dev identity (`Invoice Collector Dev`) — sharing one would
mean two unrelated codebases reading/writing the same `userData` dir and keychain entry, a real
data-corruption risk (confirmed live once already, while building this). There's no packaged build
yet (phase 1.16, not built) — packaging its own dev-vs-release identity split is a decision for
that phase, not this one.

## Live-testing without the full GUI

No Level-1/E2E test suite exists yet (`docs/implementation-plan.md`'s phases 1.16–1.18 aren't
built) — until then, verifying UI/main-process behavior against the real running app means:

1. `npm run electron:dev --workspace ic-core -- --remote-debugging-port=9222`.
2. `playwright-core`, installed in an isolated scratch directory (its own throwaway
   `package.json`, not this repo's own `node_modules`), connecting via
   `chromium.connectOverCDP('http://127.0.0.1:9222')` — **not** `_electron.launch()`, which would
   spin up a second Electron instance sharing the same `userData` dir as the one already running.
3. For state assertions, call `window.api.*` directly via `page.evaluate()` rather than racing UI
   clicks.

**Gotcha confirmed live: the app's pickers (Plugin/Destination in `CollectPage.tsx`'s Add dialog)
are Radix UI `<Select>`, not a native `<select>`.** `page.selectOption('select', ...)` times out
silently. Click the `SelectTrigger` by id (e.g. `#add-record-plugin`), wait for the option text,
then click `[role="option"]:has-text("...")`.

**A real OS-native dialog (`dialog.showOpenDialog`, used by the local-folder destination's session
`create()`) blocks on human interaction and cannot be scripted through reliably in an automated/
headless session** — don't try to drive it end-to-end; verify the call's options/shape with a
mocked `electron` module in a unit test instead (see `local-folder-session.test.ts`'s
`vi.mock('electron', ...)`), and note in the phase's own `docs/implementation-plan.md` entry that
the live picker itself wasn't exercised, the same way real device-code sign-in deliberately isn't
either (below).

**Never fire a real request against a real external provider's production endpoint** (Microsoft's
device-code endpoint, a real mailbox, etc.) from this sandbox — out of scope the same way the
private predecessor repo's Level 1 (live API, real credentials) testing is, project-wide, until
there's an actual test-tenant story. Verify what that code does with a unit test against a mocked
`HttpApi`/`SessionPlugin` instead.

**`pdf-parse`'s own native-binding dependencies (`@napi-rs/canvas`, `pdfjs-dist`) need normal Node
module resolution from wherever the compiled code actually runs** — bundling (`esbuild --bundle`)
breaks this (`DOMMatrix is not defined` at import time; bundling changes how `@napi-rs/canvas`'s own
conditional native-binding load path behaves). A real `npm install`-produced `node_modules`
alongside the compiled plugin code works; a hand `cp -R` of `node_modules` entries does not (fails
differently — `Failed to load native binding` — since a blind copy doesn't replicate npm's
platform-specific optional-dependency resolution). Not yet resolved for real packaging — phase
1.16's own strategy needs to account for it; this is just the finding, not the fix.

## Hard constraints

- **Session secrets (tokens, refresh tokens, and anything else a `SessionPlugin.create()`/
  `refresh()` returns) are only ever stored encrypted** — `packages/ic-core/src/encryptor.ts`'s
  `Encryptor` interface, backed for real by `packages/ic-core/electron/main/safeStorageEncryptor.ts`
  (OS keychain-backed, via Electron's `safeStorage`). Never stored plain, never sent to the
  renderer decrypted except as part of an explicit `SessionsApi.get()` call a plugin itself makes
  from the main process.
- **A plugin runs in-process, with the same access to the running app as core's own code** (§2/§9.3
  of the architecture doc) — the install-time trust tiers (open-source w/ verified GitHub Artifact
  Attestation, vs. unverified w/ an explicit user acknowledgment) are the *only* gate. There is no
  runtime sandboxing to fall back on, so don't treat "it's just a plugin" as lower-stakes than core
  code when reviewing a plugin's own logic (including the reference plugin in this repo).
- **This repo and everything in it is MIT-licensed and meant to stay dependency-clean under that
  license** — a new dependency (anywhere in the workspace, including a plugin's own) must check
  against `invoice-collector-plugin-sdk/src/sbom.ts`'s `MIT_COMPATIBLE_LICENSE_IDS` allowlist before
  being added, and the relevant package's `sbom.cdx.json` regenerated (see root `package.json`'s
  `generate-sbom:*` scripts — **currently broken**: they invoke a `generate-sbom` binary that isn't
  actually installed/aliased anywhere in this repo; regenerate by running `cyclonedx-npm --workspace
  <name> --omit dev --output-file packages/<name>/sbom.cdx.json` directly until that's fixed).
  `--omit dev` matters: a `devDependency` (types-only, like `electron` in a plugin package) should
  not show up in a shipped plugin's own SBOM.

## Architecture quick-reference

(Full detail in `docs/architecture-design.md` — this is just enough to orient a fresh session.)

- **npm workspaces monorepo**, three packages: `invoice-collector-plugin-sdk` (the plugin interface
  — types, `Session`/`SessionPlugin`, the one built-in session type, install-time validation),
  `ic-core` (the Electron app shell — no integrations of its own: config/session storage, the job
  runner, plugin install/trust, the renderer that draws any plugin's declarative wizard/settings
  UI), `ic-email-to-downloads` (the reference plugin — a Graph Mail source + a local-folder
  destination, bundled with the packaged app and meant to double as a complete real example for
  anyone writing their own plugin).
- **`SourcePlugin`/`DestinationPlugin`** (`invoice-collector-plugin-sdk/src/plugin.ts`) is the
  contract every integration implements: `manifest`, `sessionRequirements` (non-empty, validated at
  install time), `wizard`, optionally `sessionPlugin` (a custom session type this plugin brings
  itself) and `settingsPanel`, plus `discover()`/`fetchContent()` (source) or `upload()`
  (destination).
- **Session** (`invoice-collector-plugin-sdk/src/session.ts`, §6) is the shared, reusable
  "established connection" concept — deliberately NOT siloed per source/destination the way the
  private predecessor repo's own per-record connection state was. A plugin either declares
  `confirmsBuiltIn: true` against one of the SDK's own built-ins (currently just
  `microsoft-entra-delegated-device-code`, registered once at boot in `ic-core`'s electron main) or
  brings its own `SessionPlugin` via the `sessionPlugin` field above, registered by the install
  pipeline instead.
- **Install pipeline** (`packages/ic-core/src/plugin-install.ts`, §9.1): resolve → download →
  extract → validate (manifest shape, `pluginApiVersion` window, `sbom` presence) → GitHub Artifact
  Attestation (open-source tier only) → trust-tier decision → dynamic import → `sessionRequirements`
  validation → register (the plugin itself into `PluginRegistry`, then its own `sessionPlugin`, if
  any, into `SessionsRegistry`).
- **Collect pipeline** (`packages/ic-core/src/collect-pipeline.ts`, §14): `discover()` → per-item
  dedup check → `fetchContent()` → `upload()`, grouped by destination. A whole source failing is
  logged and skipped ("log and continue"); only cancellation aborts the whole run.
- **Renderer** (`packages/ic-core/renderer/src`): currently four tabs (`Collect`, `Sessions`,
  `Plugins`, `Settings`) in `App.tsx` — `Collect` is the daily-use view (source/destination records,
  Add wizard with inline session creation, run Collect, export a report); `Sessions`/`Plugins` are
  each a single management page; `Settings` already mixes multiple concerns as sections of one page
  (Advanced Settings + SBOM/licenses) rather than separate tabs. This 4-tab shape mirrors the new
  Session/Plugin backend concepts fairly mechanically rather than being a deliberately designed
  end-user IA — if you're asked to work on navigation/IA, don't assume the current tab split is the
  intended final shape; check `docs/implementation-plan.md` for whether a UX pass has landed yet.

## Known gaps / roadmap

Kept in `docs/implementation-plan.md`'s phase table (⬜ rows) and, for anything not yet a planned
phase at all, `docs/architecture-design.md`'s own "known gap, not yet closed" callouts scattered
through the relevant sections — don't duplicate a list here, it will drift. Two worth knowing about
by name because they're easy to trip over silently: the `generate-sbom:*` npm scripts are currently
broken (see Hard constraints above), and there's no packaged build / E2E suite / live-API test tier
yet (phases 1.16–1.18).
