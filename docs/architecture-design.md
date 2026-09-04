# Architecture design: core app, plugin SDK, and reference plugin

Status: **plan, implementation in progress**. This document records the architecture decisions
behind this project and the reasoning for each — a core desktop app with no source or destination
integrations built in, a plugin interface/SDK third-party integrations build against, and one
reference plugin (email source + local-folder destination) that ships bundled so the app is useful
with zero installs beyond itself.

Decisions recorded below are decisions, not open questions — don't re-litigate them without a
reason. Anything still genuinely undecided is tracked in §15, not marked inline.

## 1. Goals

- A desktop app (Windows/macOS) with **no source or destination integrations built into it at
  all** — a plugin interface/SDK, and one reference plugin (email source + local "Downloads"
  folder destination) bundled by default.
- A plugin system third-party developers can build against, installing new sources/destinations
  without an app update: a manifest/contract (§5), a trust model with exactly two states —
  verifiably open source, or unverified (§9) — and **no built-in concept of licensing or
  activation** at the core-app level; whatever a plugin needs beyond what the SDK provides
  generically is entirely that plugin's own concern (§9.3).
- Plugins do their business logic **on top of core-provided infrastructure**, not by reinventing
  it: a shared, reusable **Session** concept for connections (§6), a core-provided HTTP client (so
  logging/sanitization is enforced in one place, not per plugin, §7), and a core-provided
  UI-consistency mechanism — declarative descriptors that only core itself ever renders, no
  plugin-provided UI components at all (§8) — so third-party UI can't look bolted on because
  there's no third-party rendering code in the first place.
- Development done test-first, one feature per branch, merged only via reviewed pull request (§10).

## 2. Decisions (don't re-ask these)

- **Plugin execution model: in-process, dynamic `import()`** into the Electron main process, not a
  child process or `node:vm` sandbox. Trust is therefore established *before* a plugin is allowed
  to load, not enforced *at runtime* — see §9.3 for what this does and doesn't protect against.
- **OSS plugin trust = a declared public git repository URL**, not a cryptographic signature. A
  plugin manifest that names a public repo is treated as open source and installs without a scary
  warning. Anything without one gets a generic untrusted-developer warning — there is no other
  tier at the core-app level.
- **Sessions are a first-class, plugin-provided concept** (§6): a Session represents one
  established connection (a sign-in, a captured browser session, an API key/token), stored
  securely by core, and reusable across multiple Source/Destination records — even across
  different plugins, if they agree on the same session type.
- **Core provides the HTTP client and its logging, not each plugin.** Plugins make outbound calls
  through a core-provided API (§7) specifically so request/response logging and secret redaction
  are enforced centrally, not left to each plugin author to remember.
- **Core provides the UI-consistency mechanism, and it's declarative-only — no plugin-provided UI
  components.** Plugin-contributed UI (wizard steps, settings panels) is described as data and
  rendered entirely by core's own React components; no plugin ever ships or executes its own
  renderer-side code. The most secure option, chosen deliberately, and a closed decision — not a
  v1-only restriction (§8).
- **Distribution: no in-app marketplace.** Discovery and download happen on the project's own
  website — pages with donation links, linking to a download for each package.
- **License: MIT** for all three packages (`ic-core`, `invoice-collector-plugin-sdk`,
  `ic-email-to-downloads`). Each package gets its own `LICENSE` file (or the monorepo root's
  applies to all three).
- **Every package must collect and disclose its third-party dependency licenses, and the app must
  show them.** Applies uniformly to `ic-core` and its bundled `ic-email-to-downloads`, and to any
  third-party plugin: providing this disclosure is a **mandatory** part of being a plugin
  developer. See §13 for the mechanism.

## 3. Identity & signing

- **App identity: `tech.easygroup.invoicecollector`** (`.dev` variant for local development
  builds). `safeStorage`'s OS-keychain identity is tied to this signed identity, so changing it
  later means a fresh keychain identity for users — a real, if one-time, transition cost worth
  weighing before ever changing it.
- **macOS signing**: the maintainer's personal Apple Developer Program membership — the signed
  identity reads as the maintainer's personal name in Gatekeeper, not a company name. Revisit
  moving to an org-owned membership later, only if/when the project grows enough to justify the
  switch (and the keychain-identity transition cost above).
- **Windows signing: SignPath Foundation**, under an account created specifically for this
  project. **Provider comparison (researched):**

  | Option | Cost | Notes |
  |---|---|---|
  | **SignPath Foundation** | Free for qualifying OSS | The most established free option; OV-level cert, HSM-backed, CI-integrated (GitHub Actions). Application/vetting takes days to weeks. The certificate is issued to "SignPath Foundation" as publisher, not to this project — Windows shows "SignPath Foundation" in SmartScreen/install dialogs. |
  | **OSSign** | Free for qualifying OSS | Newer, less proven, but notable for a different reason: it's signing *tooling* (a CLI + GitHub Action) that's backend-agnostic — it can point at a local certificate, Azure Key Vault, or Azure (Trusted/Artifact) Signing interchangeably via config, not tied to one CA/platform. |
  | **SignPath.io (paid tiers)** | Priced per project/seat, contact-sales | The commercial platform behind SignPath Foundation — upgrading keeps the same CI/API integration, but still means a genuinely new certificate under this project's own identity, not a continuation of the Foundation-issued one. |
  | **Azure Trusted Signing** (renamed **Azure Artifact Signing**) | $9.99/mo Basic (5,000 signatures, 1 cert profile/type), $99.99/mo Premium, $0.005/signature overage | Microsoft's own first-party cloud signing service — no free-for-OSS tier, but far cheaper than a traditional paid OV/EV cert and fully API/CI-driven. Caveat worth re-checking at implementation time: community reports (Microsoft Q&A, March 2026) describe new intermediate CAs causing SmartScreen to flag every signed binary as "unrecognized" — may or may not still be an issue by the time this is actually set up. |
  | Traditional OV/EV cert (DigiCert/Sectigo/GlobalSign, etc.) | Several hundred USD/year | No free OSS tier from any mainstream public CA exists today. Since June 2023, CA/Browser Forum rules require the private key live on an HSM or hardware token regardless of provider — there's no "just get a `.pfx` file" option anymore from anyone. |

  **The migration-ease question, answered plainly: there is no path that avoids restarting
  SmartScreen reputation from zero.** As of a 2024 policy change, **EV certificates no longer
  bypass SmartScreen on first download either**; every certificate, free or paid, OV or EV, builds
  reputation the same organic way (by download volume, no manual review/escalation path exists),
  and changing the signing certificate or publisher identity resets that reputation even when the
  underlying organization stays the same. So "how easy is it to move from free to paid" isn't
  really a reputation question — it's purely a **tooling-integration** question: staying on the
  same platform (SignPath Foundation → SignPath.io paid) keeps the same CI/API integration;
  switching platforms entirely (SignPath Foundation → Azure Trusted Signing) means redoing the
  actual signing step in CI. **This is the concrete reason to prefer OSSign as the CI-facing
  signing tool from day one**, even while using a free backend now: since OSSign already
  abstracts local-cert/Azure-Key-Vault/Azure-Trusted-Signing behind one config, a later move to a
  paid backend (once volume/budget justifies it) is a config change, not a re-integration — the
  reputation reset happens either way, but the engineering cost of switching doesn't have to.
  Setup instructions and account-management notes for the signing account itself are kept outside
  this repo, since they involve account-specific and credential-adjacent detail that doesn't
  belong in a public repo — this repo's release CI only ever consumes the secrets/credentials that
  setup produces.

## 4. Target package layout

```
invoice-collector-app/
  packages/
    ic-core/                              electron app shell — core, no built-in source/destination
                                          integrations at all
    invoice-collector-plugin-sdk/        the plugin interface/contract package (types, session
                                          contracts, declarative UI descriptor types — no UI
                                          component kit, §8) — plus real runtime code, not just
                                          types: the `microsoft-entra-delegated-device-code` built-in
                                          `SessionPlugin` implementation (§6.1), imported directly
                                          by `ic-core` — published to npm under this exact name
    ic-email-to-downloads/               reference plugin: graph-mail source + local-folder
                                          destination — bundled into ic-core's packaged app by
                                          default (see §11)
```

**Only `invoice-collector-plugin-sdk` is published to npm.** The only legitimate reason to publish
something to the npm registry is that someone else's build tooling needs to `npm install` it as a
dependency to compile against — true for `invoice-collector-plugin-sdk` (every plugin author needs
it at build time), not true for the other two. `ic-core` is never imported as a library — it's a
top-level Electron app users get as a signed installer, not via `npm install ic-core`.
`ic-email-to-downloads` is never imported as a library either — it's installed into `ic-core` at
*runtime* as a plugin bundle, fetched from a GitHub Releases artifact link the same way any plugin
installs (§9.1); npm is never required for its distribution.

## 5. Plugin interface (SDK) — first-pass contract

Session handling (§6), HTTP (§7), and UI extensibility (§8) are each broken out into their own
section below since they're substantial enough to design on their own — this section just gives
the outer shape.

```ts
export interface PluginManifest {
  id: string;              // reverse-DNS-style unique id, e.g. "app.easygroup.source.email-mail"
  name: string;
  version: string;         // semver, this plugin's own version
  pluginApiVersion: string; // semver range this plugin was built against — core refuses to load
                            // a plugin whose range doesn't satisfy the core's own SDK version
  kind: 'source' | 'destination';
  repository?: string;     // public git URL — presence is what makes this an OSS-trusted plugin (§9)
  sbom: string;             // required — path within the plugin package to its CycloneDX SBOM
                              // (JSON) describing its third-party dependencies and their licenses
                              // (§13); core refuses to load a plugin that omits this, the same way
                              // it refuses one whose pluginApiVersion range doesn't satisfy the
                              // core's own SDK version
  main: string;             // required — path within the plugin package to the compiled entry
                              // module core dynamically imports; its default export is this
                              // plugin's SourcePlugin/DestinationPlugin object (matching `kind`)
}
```

**`pluginApiVersion` compatibility policy — classic semver.** `invoice-collector-plugin-sdk` itself
is versioned `MAJOR.MINOR.PATCH`: **MAJOR** for a breaking change to the plugin contract, **MINOR**
for new functionality that's fully backward compatible (an existing plugin keeps working
unmodified), **PATCH** for bug fixes and security fixes to the SDK with no interface change at
all.

**Core supports the last two major versions** of the SDK — the current major and the one before
it — always matched against core's own latest minor/patch release of each. A plugin declares
`pluginApiVersion` as a range (e.g. `^2.0.0`), and core's load-time check — the same style of
hard-gate §13 uses for its own `sbom` check — is simply: does that range admit either of the two
currently-supported majors? If not, core refuses to load it, the same as a missing `sbom` or an
invalid manifest. The window rolls forward each time a new major ships: releasing major `N+1` drops
support for major `N-1`, not major `N` — a plugin author always has one full major version's worth
of runway to publish an update before their existing build stops loading on current core releases.
When a core upgrade pushes a previously-installed plugin outside the supported window, that plugin
fails to load; its records/history/sessions stay put, surfaced as "this plugin needs updating"
rather than silently dropped.

```ts
export interface SourcePlugin extends PluginLifecycle { // PluginLifecycle's migrate() hook — below
  manifest: PluginManifest;
  sessionRequirements: SessionRequirement[]; // which session type(s) this plugin can use, and what
                                              // it needs from each — required, see §6
  wizard: WizardStepDescriptor[];          // declarative Add-Source wizard steps (§8)
  settingsPanel?: SettingsPanelDescriptor; // optional extra plugin-owned settings UI (§8)
  // Lightweight enumeration only — metadata, never content. `discovered.id` is what core's own
  // invoice-history database dedups against; anything else in `discovered` is whatever this
  // plugin needs later to actually fetch it (a pre-resolved URL, an opaque API reference, …).
  discover(
    ctx: PluginContext,
    record: PluginSourceRecord,
    period: { start: string; end: string }, // explicit argument, never a process-global — see below
    signal: AbortSignal,
  ): AsyncGenerator<DiscoveredInvoice>;
  // Called by core once per discovered invoice, but only for the ones core's own dedup check
  // (below) says aren't already downloaded — never called speculatively for invoices core is
  // about to skip anyway.
  fetchContent(
    ctx: PluginContext,
    record: PluginSourceRecord,
    discovered: DiscoveredInvoice,
    signal: AbortSignal,
  ): Promise<InvoiceContent>;
}

export interface DestinationPlugin extends PluginLifecycle {
  manifest: PluginManifest;
  sessionRequirements: SessionRequirement[];
  wizard: WizardStepDescriptor[];
  settingsPanel?: SettingsPanelDescriptor;
  upload(
    ctx: PluginContext,
    record: PluginDestinationRecord,
    invoice: DiscoveredInvoice & InvoiceContent,
    signal: AbortSignal,
  ): Promise<UploadResult>;
}
```

**Discovery and fetch are two separate plugin methods, not one — and it's core's database that
decides which invoices actually get fetched, not the plugin.** The flow: core calls `discover()`
and iterates the metadata it yields *as it streams in* (not after draining the whole generator —
same reasoning as the job-progress streaming pattern elsewhere in this plan); for each discovered
item, core checks its own invoice-history database by `discovered.id`, and only calls
`fetchContent()` for the ones that check comes back negative for. An invoice core already has
recorded never has `fetchContent()` called on it at all — no wasted network calls, and no plugin
ever has to implement its own "have I already got this one" logic, since it's never asked to
decide. `discover()`/`fetchContent()` gives every plugin author a two-step shape whether their
underlying API needs it or not, rather than forcing a list call to always also fetch content up
front — some real APIs genuinely need the split (an asynchronous poll-based document generation
step, a presigned-URL resolution step), and every plugin gets the same shape regardless.
`DestinationPlugin.upload()` still takes one combined value (`DiscoveredInvoice` merged with the
fetched `InvoiceContent`) since core has always already fetched content for anything it's about to
upload by the time `upload()` is called.

```ts
interface DiscoveredInvoice {
  id: string;          // core's dedup key, scoped per-source — never guessed at, always plugin-supplied
  issuedDate: string;
  amount?: { value: number; currency: string };
  pluginRef?: unknown;  // opaque to core — whatever this plugin's own fetchContent() needs to
                        // resolve the actual document later (a pre-signed URL, an API-specific id, …)
}

interface InvoiceContent {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}

interface UploadResult {
  status: 'uploaded' | 'already-existed' | 'overwritten';
}
```

**No separate "does this exist at the destination" method.** Core doesn't pre-check at all — it
always calls `upload()`, even for an invoice its own history thinks is new but that might already
sit at the destination (history got reset, a prior run partially failed, etc.). **The destination
plugin's own `upload()` is responsible for implementing whatever override behavior makes sense
when asked to upload something that turns out to already exist there** — skip and report back,
overwrite, version it, whatever fits that destination — and reports which actually happened via
`UploadResult.status` so core's invoice-history and reporting layers (§14.1 US13/US20) reflect what
really occurred rather than assuming every call was a fresh upload. Only the destination plugin
actually has the API access to check its own storage, so folding that check into the one call it
already makes avoids a redundant round-trip method that would just be doing half of `upload()`'s
own job a second time.

Note what's *not* here: `signIn`/`reconnect`/`connect` aren't part of `SourcePlugin`/
`DestinationPlugin` themselves — establishing/refreshing a connection is the Session concept's job
(§6), not something each source/destination implements redundantly.

**Config record shape**:

```ts
interface PluginBackedRecord {
  id: string;
  name: string;
  pluginId: string;
  pluginVersion: string;
  sessionId?: string;            // which Session (§6) this record authenticates through, if any
  destinationId?: string | null; // sources only
  collectFromDate?: string;      // destinations only — ISO date, a per-destination backfill-cutoff
                                  // guardrail (§14.1 US11): the job runner never calls discover()
                                  // with a period starting earlier than this for sources routed to
                                  // this destination, guarding against a brand-new destination
                                  // accidentally backfilling years of history on its first run.
                                  // Not a hard filter: a collect run explicitly requesting an
                                  // earlier period is treated as an intentional backfill and lowers
                                  // this value to match, remembered for next time
  config: unknown;               // plugin-owned JSON, non-secret, non-session config only
  createdAt: string;
  updatedAt: string;
}
// PluginSourceRecord/PluginDestinationRecord (used below and in §6/§9.1) are this same shape,
// just narrowed to `destinationId: string | null` present vs. absent respectively — not a
// separately-defined interface, called out by name only where it matters whether a record is a
// source's or a destination's.
```

**Plugin lifecycle: update migration and uninstall.**

- **Update**: a plugin can declare an optional lifecycle hook to migrate its own data forward when
  its installed version changes:

  ```ts
  export interface PluginLifecycle {
    // Called once, automatically, when core detects this plugin's version increased from
    // fromVersion to manifest.version — before the new version's discover()/fetchContent()/
    // upload() ever runs.
    // Responsible for migrating anything this plugin owns: its own PluginContext.storage entries
    // and the `config` field of every existing PluginBackedRecord referencing this plugin.
    migrate?(
      ctx: PluginContext,
      fromVersion: string,
      records: PluginBackedRecord[],
    ): Promise<{ records: PluginBackedRecord[] }>;
  }
  ```

  `SourcePlugin`/`DestinationPlugin` both extend this — optional, since not every version bump
  needs a data migration, but the mechanism exists so a plugin's config/metadata format can evolve
  release to release instead of being frozen the moment it's first installed.

- **Update rollback: core can and does roll back a failed update.** An update is staged, not
  applied in place: the new version's package is validated (manifest schema, `pluginApiVersion`
  range per above, `sbom` present and parseable per §13, `sessionRequirements` present per §6 —
  the full set of load-time checks §9.1 already applies to any fresh install, now re-run against
  the update before it's accepted) and the current version's files plus every affected record's
  pre-migration `config` are snapshotted *before* `migrate()` runs. If validation fails, `migrate()`
  throws, or its returned records don't parse as valid `PluginBackedRecord`s, core discards the
  staged version, restores the snapshotted previous version and config, and reports the failure —
  the plugin and its data are left exactly as they were, never in a partially-updated state.

- **Uninstall: preserve, don't delete.** Uninstalling a plugin never deletes its
  `PluginBackedRecord`s, their invoice history, or any Session created under a `sessionTypeId` only
  that plugin used — they become inactive (no plugin to route `discover()`/`fetchContent()`/
  `upload()` to). Reinstalling the same plugin (even a different version, via the `migrate()` path
  above) reactivates them with no data loss.

**A period argument, never a process-global**: `discover()` takes `period` as a plain argument
specifically so a plugin's own async work never depends on (or could clobber) shared process
state — a plugin mutating a global for the duration of its own async generator is exactly the kind
of thing a second, unrelated plugin's code could observe or clobber once independently-loaded
plugins coexist, even without relaxing the one-collect-job-at-a-time rule.

## 6. Sessions — a first-class, reusable connection concept

A **Session** promotes "an established connection" to its own first-class, securely-stored object
that any compatible Source or Destination record can reference — including across two *different*
plugins, as long as they agree on the same session type. This avoids every Source/Destination
record carrying its own private copy of credential state, and avoids two records that really
authenticate the same way against the same account (say, a delegated sign-in used by both a
source and a destination) having no way to share one sign-in between them.

```ts
export interface SessionTypeDescriptor {
  id: string;    // e.g. "microsoft-entra-delegated-device-code", "oauth2-client-credentials" —
                 // §6.1 covers the SDK's starting set
  label: string; // shown in the Sessions UI, e.g. "Microsoft sign-in"
}

export interface Session {
  id: string;
  sessionTypeId: string;
  label: string;              // human-readable, e.g. "admin@contoso.com (Contoso Ltd)"
  createdByPluginId: string;
  createdAt: string;
  updatedAt: string;
  status: 'active' | 'expired' | 'needs-reconnect';
  expiresAt?: string;          // known token/cookie expiry, if this session type has one — lets
                                // core schedule a proactive refresh ahead of expiry instead of
                                // only reacting after something fails
  keepAliveIntervalMs?: number; // set by a SessionPlugin whose session type needs periodic
                                  // "still alive" activity rather than a token-expiry renewal
                                  // (e.g. a browser-captured cookie session some providers idle
                                  // out) — core calls refresh() on this cadence
}

// A plugin implements this once per session type it knows how to establish.
export interface SessionPlugin {
  sessionTypeId: string;
  create(ctx: PluginContext, input: unknown, signal: AbortSignal): Promise<{ label: string; secret: unknown; expiresAt?: string; keepAliveIntervalMs?: number }>;
  // Called reactively (on a 401 during discover()/fetchContent()/upload(), §7) AND proactively (on
  // the schedule expiresAt/keepAliveIntervalMs implies) — the session type owns how "staying
  // valid" actually works: refresh-token renewal, a periodic keep-alive request, or (for something
  // like a plain pasted API key) nothing at all, in which case this is simply omitted.
  refresh?(ctx: PluginContext, session: Session, signal: AbortSignal): Promise<{ secret: unknown; expiresAt?: string } | 'unchanged'>;
  test(ctx: PluginContext, session: Session, signal: AbortSignal): Promise<'ok' | 'expired' | 'error'>;
  // §7 says core "attaches the right auth (header, cookie, or request signing) automatically" for
  // a request naming a sessionId — this is how: given the decrypted secret and an outbound
  // request, return the request modified to carry this session's auth. Auth attachment is
  // inherently session-type-specific (a bearer header vs. a cookie vs. real per-request request
  // signing), so core has no generic way to derive it from a secret's shape. Required, same as
  // create/test.
  applyAuth(secret: unknown, request: HttpRequestInput): HttpRequestInput | Promise<HttpRequestInput>;
}
```

**A session is responsible for keeping itself valid, not just for reconnecting after it's already
failed.** Where a session type has a real renewal mechanism — a refresh token that can mint a
fresh JWT, or a cookie-based session some provider idle-expires unless something keeps touching it
— that logic lives in the session type's own `refresh()`, and core drives it on a schedule derived
from `expiresAt`/`keepAliveIntervalMs`, not only when a request already came back unauthorized. A
session type with no such mechanism (a browser-captured session with no refresh path, a one-time
pasted API key) simply doesn't set these hints, and only ever recovers via a user-facing Reconnect
— an accurate reflection of the underlying provider, not a gap in this design. See §7 for the
reactive (401-triggered) half of this.

`PluginContext.sessions` is what core provides so a plugin never has to touch `safeStorage` (or any
raw encryption primitive) directly to keep session secrets safe — anything secret a plugin needs
to persist goes through a Session, not a bespoke encrypted field:

```ts
interface SessionsApi {
  list(sessionTypeId?: string): Promise<Session[]>; // scoped per the sharing rule below — never
                                                      // returns a session created under another
                                                      // plugin's own custom SessionPlugin
  get(sessionId: string): Promise<{ session: Session; secret: unknown } | undefined>;
  // Delegates to whichever registered SessionPlugin implements sessionTypeId. onProgress
  // surfaces that SessionPlugin's own ctx.progress.report() calls while establishing the session
  // (e.g. the device-code built-in's "enter this code at this URL") back to the caller — without
  // it there'd be no way for a device-code sign-in's own instructions to reach anyone driving it.
  create(sessionTypeId: string, input: unknown, signal?: AbortSignal, onProgress?: (message: string, data?: Record<string, unknown>) => void): Promise<Session>;
  reconnect(sessionId: string, signal?: AbortSignal, onProgress?: (message: string, data?: Record<string, unknown>) => void): Promise<Session>;
}
```

**Sharing across plugins: only for the SDK's own built-in session types, never for a plugin's
custom one.** Two independently-authored plugins can interoperate on the same session *only* if
that session's `sessionTypeId` is one of the SDK's own built-in `SessionPlugin` implementations
(this section's `confirmsBuiltIn: true` case, below — concretely, just
`microsoft-entra-delegated-device-code` for now, per §6.1) — established once, by whichever
plugin's wizard runs first, and then offered to any other plugin's wizard as "use an existing
session" instead of signing in again. A session created under a **custom** `sessionTypeId` — one a
specific plugin ships its own `SessionPlugin` for, per the rules below — is **never** exposed to a
different plugin: `list()`/the "use an existing session" picker only ever surfaces a custom-typed
session back to the plugin that created it, never to an unrelated one. Core can vouch for its own
built-in session implementations being safe to hand across arbitrary plugin boundaries; it can't
make that same claim about a third-party plugin's bespoke session logic, so that case simply isn't
shared at all rather than trying to adjudicate trust case by case.

**Two ways a plugin can get a session:**

1. **Use an SDK-provided built-in session type** — the plugin declares the `sessionTypeId` in its
   `sessionRequirements` (below) with `confirmsBuiltIn: true` and its own `requiredScopesOrRoles`;
   core handles establishing/refreshing it via the SDK's own `SessionPlugin`, and the resulting
   session is eligible for cross-plugin reuse as described above.
2. **Implement its own session type** — the plugin ships a `SessionPlugin` "according to the SDK's
   rules" (implements `create`/`refresh`/`test`/`applyAuth` per §6's interface) for a
   `sessionTypeId` of its own choosing, declared with `confirmsBuiltIn: false`. This is required
   for anything the built-in set doesn't cover — and, per the rule above, a session created this
   way stays scoped to that plugin, not shared with unrelated ones.

**Each plugin declares which session type(s) it supports — not left implicit.** Whichever way a
session type gets fulfilled, which type(s) a given `SourcePlugin`/`DestinationPlugin` actually
works with is the *plugin's own choice to declare*, not something core infers — via a required
field on both interfaces:

```ts
export interface SessionRequirement {
  sessionTypeId: string;   // a built-in SDK session type, or a custom one this plugin's own
                            // SessionPlugin implements
  confirmsBuiltIn: boolean; // must be true if sessionTypeId names an SDK-provided built-in type —
                             // an explicit acknowledgment from the plugin author that they've
                             // checked the built-in's actual behavior (e.g. exact OAuth flow,
                             // token handling) fits what this plugin needs, rather than assuming a
                             // session type ID match is enough on its own. False/absent for a
                             // sessionTypeId this plugin brings its own SessionPlugin for.
  requiredScopesOrRoles: string[]; // what access this specific plugin needs once a session of
                                    // this type is established — e.g. delegated scopes, RBAC role
                                    // names, or a plain permission name for a custom/API-key
                                    // session type
  permissionsNote?: string; // human-readable explanation of *why*, shown alongside the raw list
}
```

`SourcePlugin.sessionRequirements`/`DestinationPlugin.sessionRequirements` (§5) must list at least
one entry — a plugin with no declared session requirement fails load validation the same hard-gate
way §13 already treats a missing `sbom` field. This closes two gaps at once: (1) a plugin can no
longer silently piggyback on a built-in session type's assumed behavior without an explicit
sign-off from its author that they've actually verified it fits, and (2) the exact
roles/permissions a user needs to grant before this plugin can work becomes a structured, declared,
load-time-validated fact instead of documentation that can silently drift from what the code
actually requires. This applies even to a plugin whose "connection" is a local OS resource rather
than a remote API — e.g. the local-filesystem destination (§14.1 US7) still declares a real session
type, because access to a folder is itself something the OS gates (a permission prompt) and
something that can later be revoked or go stale (the folder gets deleted, permission gets pulled) —
exactly the lifecycle `Session`/`SessionPlugin` already exists to model, not something to route
around with an empty array.

**UI**: a Sessions section (Settings, or its own page) lists established sessions, their status, a
Reconnect action, and which Source/Destination records currently use each — and any wizard step
that needs a connection offers "use an existing session" (pick from compatible ones) alongside
"create a new one," instead of always forcing a fresh sign-in. Before creating (or reusing) a
session for a given plugin, the wizard shows that plugin's declared
`requiredScopesOrRoles`/`permissionsNote` — the same way an OAuth consent screen lists requested
scopes, so the user knows what they're granting before they grant it, not after something silently
fails for lack of access. This also gives the cross-plugin sharing rule above a concrete mechanism
to check, beyond just "is this a built-in session type": whether an existing session actually
satisfies a *different* plugin's `requiredScopesOrRoles` before offering to reuse it, rather than
assuming a matching `sessionTypeId` alone is sufficient.

### 6.1 Extracted session types — starting scope

Real auth mechanisms collapse to a handful of distinct session types — most providers turn out to
share a mechanism and only differ in which resource/scope they point it at:

| Session type | Mechanism |
|---|---|
| **`microsoft-entra-delegated-device-code`** | OAuth2 device-authorization grant (request a device code, poll for a token, refresh via refresh token) — Microsoft Entra-based, not Microsoft-specific by design |
| `oauth2-client-credentials` | App-only client ID + secret → token via the client-credentials grant |

**Decided starting scope: only `microsoft-entra-delegated-device-code` ships as an actual SDK
built-in right now.** It's the one the reference plugin's Graph Mail source genuinely needs, so
it's the one that gets built and proven for real, in `invoice-collector-plugin-sdk`, from day one
— a deliberate "build what's actually needed, not what's theoretically generalizable" call, not an
oversight: `oauth2-client-credentials` is just as mechanically generalizable in the abstract, but
nothing in this project uses it yet. A plugin needing a session type the SDK doesn't ship as a
built-in writes its own `SessionPlugin` for now — any such type can be promoted into the SDK's
built-in set later, exactly the way `microsoft-entra-delegated-device-code` was promoted; the
trigger for promotion is a second real consumer needing the same mechanism, not a hypothetical
future one.

**How "writes its own `SessionPlugin`" actually wires up (§14.1 US7's local-filesystem destination
is the first real case).** `SourcePlugin`/`DestinationPlugin` carry an optional `sessionPlugin?:
SessionPlugin` field — present exactly when the plugin declares a `confirmsBuiltIn: false`
`sessionRequirements` entry and brings its own implementation for it. §9.1's install pipeline
registers it into the Sessions registry as its very last step, right after registering the plugin
itself, the plugin-code counterpart to the built-in's own boot-time registration above. Not every
custom session type is really a *remote* connection either — the local-filesystem destination's
own session represents OS-level folder-access permission (a native folder-picker dialog is what
actually grants it, doubling as the OS's own consent step on a platform like macOS that gates
access to protected folders) rather than a token; its `refresh()` repurposes the same
`keepAliveIntervalMs` periodic-check mechanism §6 built for token renewal to instead periodically
re-verify the folder is still there and writable, throwing (same as a real refresh failure) if the
folder was deleted, moved, or its permissions were revoked — so a stale destination surfaces as
`needs-reconnect` the same way an expired sign-in would, not silently.

**Where this one built-in actually runs.** `invoice-collector-plugin-sdk` exports
`microsoft-entra-delegated-device-code`'s `SessionPlugin` implementation as a plain value (real
runtime code, not just its type) — `ic-core` imports it directly and registers it into its own
Sessions registry at boot, the same way it depends on any other npm library. It never goes through
§9.1's install/trust flow at all — that flow exists for *installed* plugins, and this ships as
`ic-core`'s own direct dependency, first-party by construction, at the same trust level as
`ic-core`'s own code. No generic "register a built-in `SessionPlugin`" mechanism is needed yet,
since there's only one — if/when a second type is promoted per the rule above, revisit whether a
real registration API is worth building versus just importing a second value the same way.

## 7. Core-provided HTTP client & logging

Centralizing outbound requests into a core-provided API removes "did this plugin remember to
sanitize" as a per-plugin, per-call risk:

```ts
interface HttpApi {
  request(
    input: {
      url: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
      sessionId?: string;   // core resolves this session and attaches the right auth
                            // (header, cookie, or request signing) automatically, recovers it via
                            // SessionPlugin.refresh() on a 401 and retries once (§6/§7), and
                            // retries on throttling responses per the Advanced Settings policy
                            // below — none of this is the calling plugin's own responsibility
      timeoutMs?: number;
    },
    signal?: AbortSignal,
  ): Promise<{
    status: number;
    headers: Record<string, string>;
    json(): unknown;
    text(): string;
    arrayBuffer(): ArrayBuffer;
  }>;
}
```

Core logs every call through it — method, host (sanitized: stripped of tenant/org/account
identifiers), status, duration — and **never** logs headers or body by default. Plugins get
request/response logging "for free," and there's exactly one place to audit for the "never log
secrets" guarantee instead of one per plugin/provider.

**401 handling: recover the session first, then retry.** When a `sessionId`-attached request comes
back `401`, `HttpApi` doesn't just fail — it first asks that session to recover (the same
`SessionPlugin.refresh()` from §6, called reactively this time rather than on a schedule). If
recovery succeeds, the original request is retried exactly once with the renewed session; if
recovery fails, or the session type has no `refresh()` at all, the request fails, the session's
status flips to `needs-reconnect`, and that surfaces through the Sessions UI (§6) for a manual
Reconnect.

**Throttling retry: core's job, not each plugin's.** `HttpApi` itself retries on throttling
responses (`429`, honoring a `Retry-After` header when present, falling back to an exponential
backoff otherwise) — a plugin never implements its own retry loop for this, the same way it never
hand-rolls its own log sanitization. **The delay/backoff behavior is user-configurable** via an
Advanced Settings section (base delay, max retry count) rather than a hardcoded constant.

**Defaults**: base delay **1 second**, up to **3 retries**, with the delay increasing each attempt
(e.g. 1s / 2s / 4s) rather than a flat 1-second wait every time; base delay and max retries are the
Advanced Settings knobs a user can override, not hardcoded floors. **No request/response size
limit for now** — left unbounded rather than picking an arbitrary cap; revisit only if a real case
for one shows up.

## 8. UI extensibility & design consistency

**Declarative descriptors only — no plugin-provided UI components, full stop.**
`WizardStepDescriptor[]`/`SettingsPanelDescriptor` are a JSON-like schema (fields, types,
validation, conditional visibility, and enough structure for list/detail/selection patterns, not
just flat forms) that **only core's own React components ever render**. A plugin never ships
renderer-side code, never gets a "custom element" escape hatch, and the renderer stays 100%
first-party `ic-core` code, with zero third-party code executing in it. This is the
security-motivated choice, made deliberately even though plugins are already fully trusted in the
main process (§2) — keeping the renderer as a smaller, controlled surface than it would otherwise
need to be is worth more than the UI flexibility a custom-element mechanism would have bought. This
is a closed decision, not a v1 scope cut — no "custom UI elements" capability is planned for any
future version of this plan either.

This is a real requirement on the schema's own design, not just a restriction: some real plugin
interactions (a live list/detail preview, an inline manual-capture form driven by a selected row's
data) are exactly the kind of thing a flat form schema can't express. Since there's no
custom-component escape hatch, the declarative schema itself has to be expressive enough to cover
cases like this from the start — list/detail views, row selection, an inline capture form driven
by the selected row's data — not just single-screen field forms. (The list/detail preview itself
is in current use, §14.1 US4/1.12; the manual-capture form specifically is backlog, §14.3 — the
primitives are built either way, since a live list/detail preview alone already needed them.)

**A ListDescriptor's rows are never embedded in the descriptor itself** — a plugin implements the
SDK's optional `WizardDataSourceProvider.resolveListData(ctx, { dataSource, fieldValues, sessionId },
signal)`, which core calls (via IPC, from the renderer, mid-wizard) whenever a step's declared
`dataSource` key needs populating. This is what keeps a list step able to reflect live plugin state
(e.g. scanning a mailbox) instead of a fixed snapshot, and it's a load-time-enforced contract, not
just a convention: a plugin whose `wizard`/`settingsPanel` declares any ListDescriptor but doesn't
implement `resolveListData` fails install validation the same hard-gate way a missing
`sessionRequirements` entry does (§6).

**A plugin's `wizard`/`sessionRequirements`/`settingsPanel` cross the IPC boundary as one summary
object, not just its manifest.** These live on the loaded `SourcePlugin`/`DestinationPlugin`
object in the main process — the renderer's Plugins-list call returns each installed plugin's
manifest *plus* this UI-facing subset (no functions; `resolveListData` etc. stay reachable only
through their own IPC calls), since an Add-Source/Destination wizard can't render a plugin's own
declared steps without it.

**A wizard's "create a new session" step needs `SessionsApi.create()`'s opaque `input`, and for a
built-in session type that shape is entirely the built-in's own** (e.g. the device-code built-in's
`{ deviceAuthorizationEndpoint, tokenEndpoint, clientId, scope, label }`) — no generic form could
collect it. The SDK's optional `BuiltInSessionInputProvider.builtInSessionCreateInput(requirement)`
closes this for the one case that matters today (`confirmsBuiltIn: true`): core calls it itself
when the renderer's own supplied input is absent. **Left open, deliberately**: the same problem for
a *custom* (`confirmsBuiltIn: false`) session type's own `create()` input — collecting whatever a
third-party `SessionPlugin` expects still has no generic UI mechanism, deferred until a real plugin
needs one rather than guessing the shape now. Relatedly, `PluginBackedRecord.sessionId` (below) is
only ever set at record-creation time, from whichever session the wizard's session step resolved —
there's no separate "reassign a record's session" action yet.

**Rendering stack: shadcn/ui's component set on Tailwind CSS v4 + Radix UI primitives.** This is
the concrete choice behind "only core's own React components ever render" above — a small, fixed
set of accessible, unstyled-by-default primitives (dialog, select, tabs, checkbox, ...) themed via
CSS custom properties in one stylesheet, rather than a heavier component framework or hand-rolled
styling per screen. Picked for the same reason the descriptor schema itself stays small: every
screen (core's own and, indirectly, anything a plugin's `wizard`/`settingsPanel` describes) ends up
visually consistent by construction, without a design system to maintain by hand alongside it.

## 9. Trust model

Only **two** states, both at the core-app level.

| State | How it's established | Install-time UI |
|---|---|---|
| Open source | `manifest.repository` is set to a public git URL | Neutral/informational: "Open source plugin — source: `<url>`" |
| Unverified | Anything else | Warning dialog: "This plugin is from an unverified developer and hasn't been reviewed. Installing it means running its code with full access to this app and your data. Only continue if you trust the source." + explicit confirm, remembered per plugin id+version so it doesn't re-prompt every launch |

Once past the warning (if any) and loaded, it's entirely up to the plugin's own code (using its own
Session(s), `settingsPanel`, and `PluginContext.storage` for any non-session state) to do whatever
it needs — including, if relevant, checking its own gating/state and refusing to do real work
(`discover()`/`fetchContent()`/`upload()` returning an error/empty result) until satisfied. Core
never has any related concept, API, or UI — it only ever asks "is this open source."

### 9.1 How a plugin is actually installed

One "Install Plugin" entry point (Settings → Plugins), one text field, two possible inputs — both
of which core resolves down to the same underlying shape: **a URL to download from, with
parameters carried as its query string.** That resolved URL is what core fetches the package from,
*and* the exact same URL is handed into the installed plugin's own context — core never interprets
the query parameters itself, but the plugin can use that same URL for its own purposes later, so
core only has to resolve and remember one thing per install.

- **A plain `https://` URL.** Accepted in any of three shapes: a link to the repository itself, a
  link to a build-artifacts listing (e.g. a GitHub Releases page), or a direct link to one specific
  artifact. When it resolves to a repository (the first case), core fetches and checks that
  repository's own `LICENSE` **before** downloading anything — confirming it's actually under an
  acceptable open license (the same MIT-compatibility bar §13 already applies to a package's
  *dependencies*, now applied to the plugin's *own* declared license too) — and only then locates
  and downloads the actual build. The fetch source *is* the URL the user typed, so there's nothing
  left for a malicious package to lie about — it can't claim to be from a reputable repo while
  actually shipping from somewhere else, because core never goes anywhere else to get it.
  **Required, not optional: core verifies a GitHub Artifact Attestation for the downloaded artifact
  before installing it.** Every plugin's release workflow must publish one (via
  `actions/attest-build-provenance` or an equivalent Sigstore-based attestation) — core verifies it
  programmatically (the `sigstore` npm package, not a shelled-out `gh` CLI dependency) and refuses
  to install if verification fails or no attestation exists. This confirms the exact artifact's
  digest was produced by CI running in that specific repository from a specific commit — closing
  the residual gap §9.2 would otherwise leave open (a compromised maintainer account manually
  publishing a malicious release asset to an otherwise-legitimate repo would fail this check, since
  there'd be no matching attestation for it). A plugin author who isn't using GitHub Actions can
  still comply by publishing an equivalent Sigstore attestation through `cosign` directly — the
  requirement is "a verifiable Sigstore attestation exists and checks out," not "must use GitHub
  Actions" specifically, though the GitHub Action is the path of least friction for a repo already
  there.
- **An encoded string that core can decode back into that same URL+query-string shape** — for a
  plugin distributed some other way than a plain link (the exact decoding scheme is a detail of
  whatever's issuing that string, entirely outside this project's own concern). Core decodes it,
  fetches the package from the resulting URL, and runs it through the same **manifest schema /
  `pluginApiVersion` range / `sbom` presence / `sessionRequirements` presence** checks as the
  plain-URL path — no separate install logic for those. **The GitHub Artifact Attestation check
  above only applies when the resolved source is a GitHub repository** — there's nothing to verify
  otherwise; a package installed this way naturally has no `repository` field, so it naturally
  lands in the *unverified* tier above with no separate check needed.
- **After download, any further gating a plugin author wants is entirely that plugin's own
  concern.** Core's only job is to load the installed package and hand its `settingsPanel` (or any
  lifecycle hook that needs it) the resolved URL from above — whatever the plugin's author designed
  to happen with it happens entirely inside the plugin, using `PluginContext.storage`/`http` (§6/
  §7) exactly as already specified. No new core mechanism beyond "remember and forward this one
  URL" is needed.

### 9.2 Open-source tier — closed, not just narrowed

A bare `manifest.repository` field is a **claim, not a proof** on its own — nothing would stop a
package from declaring a reputable repo's URL while shipping different code. §9.1 closes this in
two layers: fetching *from* the URL the user provided (rather than trusting a self-reported field)
removes any gap for a package to misrepresent *which* repo it came from, and the **required
Sigstore/GitHub Artifact Attestation check** closes the remaining piece — proving the specific
downloaded artifact was genuinely produced by that repository's own CI from a known commit, not
e.g. a compromised maintainer account manually publishing a malicious release asset to an
otherwise-legitimate repo. Both halves are decided requirements, not aspirational hardening for
later.

### 9.3 What this trust model does *not* protect against

Because plugins run in-process (§2), a trusted-tier plugin still has the same access to the running
app as built-in code does — arbitrary network calls, filesystem access, and (once other code
decrypts them) visibility into secrets in memory. The trust tier gates *installation*, not
*runtime behavior*. State this plainly wherever the warning/trust UI is shown — don't let the
open-source tier's lack of a warning imply a stronger guarantee than it is.

### 9.4 Plugin package format

- **A `.zip` archive** — contains `manifest.json`, the compiled entry module (`manifest.main`),
  the CycloneDX SBOM (`manifest.sbom`), and any other assets the plugin needs, extracted into its
  own directory under `plugins/<manifest.id>/` (sibling to `profiles/`). Zip over tar.gz:
  native/trivial on both Windows and macOS with no new dependency-hygiene surface beyond a single
  well-known extraction library.
- **The full pipeline runs through a live in-process plugin registry** — resolve → download →
  extract → validate (manifest shape via the SDK's own `validateManifest`/
  `validateSessionRequirements`, `pluginApiVersion` two-major window, `sbom` present and
  parseable) → GitHub Artifact Attestation check (where applicable) → trust-tier decision →
  dynamic `import()` of `manifest.main` → register into a `PluginRegistry` (loaded `SourcePlugin`/
  `DestinationPlugin` by id).

## 10. Development process: TDD, one feature per branch, PR review

- Every feature/fix is written test-first: a failing test committed (or at minimum present in the
  same PR) before the implementation that makes it pass.
- One feature per branch, merged to `main` only via pull request — no direct pushes to `main`.
- GitHub branch protection on `main` (required PR, required status checks) — on from the start.
- CI (GitHub Actions) on every PR: typecheck, build, and the test suite — gating merges via branch
  protection.
- **Test data policy: only generated/synthetic fixtures and tests, ever** — no real-life data of
  any kind. Every fixture (mail/invoice samples, tenant/account identifiers, etc.) is
  freshly-written and fully synthetic, built for its own test's purpose.
- **No real connection in any test, including E2E.** The E2E suite uses a mocked-backend approach
  (mock at `ipcMain`) — never a real device-code sign-in, real API call, or any other live network
  dependency. This is absolute, not scoped to just the reference plugin: **any** test that would
  need a real connection — including one nominally testing `ic-core`'s own generic behavior (job
  runner, config store, etc.) — simply isn't something this repo's test suite grows a version of.

## 11. Build & release artifacts

Three distinct outputs come out of this monorepo's release pipeline:

1. **`invoice-collector-plugin-sdk`** — published to the public npm registry, versioned
   independently (semver) from the app itself; any plugin author depends on it to implement
   `SourcePlugin`/`DestinationPlugin`/`SessionPlugin` and to describe its
   `WizardStepDescriptor`/`SettingsPanelDescriptor` UI declaratively (§8) — there's no UI component
   kit to build against, by design.
2. **`ic-email-to-downloads` plugin bundle** — a standalone, independently-versioned installable
   plugin package (same artifact shape any third-party plugin would ship), released as a
   downloadable build artifact (a GitHub Release asset, fetched via §9.1's install flow the same
   way any plugin is) for two purposes: (a) so it can be updated without a full app release, and
   (b) so it can be manually installed into an `ic-core` build that doesn't already have it.
   **Not published to npm** — nothing ever imports it as a library.
3. **Windows and macOS app bundles**, built via `electron-builder`, with `ic-email-to-downloads`'s
   build output copied into the packaged app's plugin directory at package time — so a fresh
   install works out of the box with zero plugin-install steps, while `ic-email-to-downloads`
   remains, logically, just an installed plugin like any other (removable/updatable independently,
   not special-cased in `ic-core`'s code).

Each of the three above **includes a third-party-dependency-license scan as a build step** (§13) —
`ic-core`'s own build produces its CycloneDX SBOM, `ic-email-to-downloads`'s build (whether
produced standalone or folded into the app bundle) produces its own, and
`invoice-collector-plugin-sdk`'s published package includes the `generate-sbom` build helper (§13)
every plugin author is expected to run as part of *their* build.

## 12. Distribution & website

- Discovery and download both happen on a project website, not an in-app marketplace/catalog.
- Pages for `ic-core`/the app releases, `invoice-collector-plugin-sdk` (npm + docs), and
  `ic-email-to-downloads`, each with donation links.
- **Site ownership**: the site is personally owned by the maintainer, designed/branded to present
  as the project's own. This is a business/registration detail, not a technical one — it doesn't
  change anything in §9's install flow, which stays agnostic to who owns the site issuing install
  links.

## 13. Third-party dependency license disclosure (SBOM)

Every package — `ic-core`, `ic-email-to-downloads`, and any third-party plugin, with no exception —
pulls in third-party dependencies of its own (npm packages at build time, effectively), each under
its own license. This needs to be collected mechanically as part of each package's build, and shown
to the end user inside the app, not left as an assumed-fine detail.

**Format: CycloneDX (JSON).** A full SBOM (Software Bill of Materials), not just a flat license
list — a real SBOM matters now, not as a later nicety. CycloneDX (OWASP's standard, JSON
representation) over hand-rolled JSON or a plain-text `NOTICE` file because it's an actual
interoperable spec — a `components` array carrying name/version/PURL/hashes and each component's
license (SPDX license expression where resolvable) — rather than a format only this project's own
tooling understands. It also means the artifact this produces is useful on its own (handed to a
security/compliance reviewer, fed into other SBOM-consuming tooling) beyond just rendering a
licenses screen.

**Build procedure requirement**: each package's build pipeline generates a CycloneDX JSON SBOM for
its resolved npm dependency tree (via `@cyclonedx/cyclonedx-npm`, invoked as a pinned-version `npx`
subprocess rather than a real dependency of anything — see below) as a build artifact bundled into
the package/plugin — not generated on the fly at runtime. `invoice-collector-plugin-sdk` ships this
as a shared build helper (`generate-sbom`, a real `bin` entry) specifically so every plugin author
produces their SBOM the same way `ic-core` knows how to parse and render, rather than each plugin
inventing its own generation path.

**`@cyclonedx/cyclonedx-npm` itself is a `devDependencies` entry of `invoice-collector-plugin-sdk`,
not `dependencies`.** The `generate-sbom` tool shells out to it via `npx --yes
@cyclonedx/cyclonedx-npm@<pinned version>`, a subprocess call that never actually required it to be
pre-installed. Keeping it out of `dependencies` means npm never installs it for anyone who installs
the SDK as a dependency (a package's own `devDependencies` are never installed for its consumers) —
its own (large) transitive tree never becomes part of what every SDK consumer installs, and can
never end up bundled into a downstream plugin's actual shipped artifact. Pinning the version at
the `npx` call site (rather than leaving it to `package.json` resolution) keeps behavior
reproducible for every caller regardless of what's installed locally.

**Enforced, not just collected: every third-party dependency must be MIT-compatible.** The
`generate-sbom` step doesn't only produce the SBOM — it **fails the build** if any resolved
dependency's license (read from the SBOM's own per-component license data) isn't MIT-compatible.
The allowlist: **MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, BlueOak-1.0.0, CC0-1.0,
Python-2.0** pass; copyleft licenses (GPL, LGPL, AGPL, and similar) fail; and a genuine Creative
Commons *license* (CC-BY, CC-BY-SA, etc. — not CC0, a different legal instrument) gets a third
outcome, **requires manual review**, same as a boolean SPDX license expression, since Creative
Commons itself advises against using CC licenses for software. This applies project-wide:
`ic-core`/`ic-email-to-downloads`'s own CI enforces it directly, and the same `generate-sbom` tool
is what every plugin author is expected to run as part of satisfying the mandatory `sbom`
requirement below — so the compatibility bar is the same everywhere, not an app-only nicety.

**Mandatory for every plugin, no exception**: `PluginManifest.sbom` (§5) is a **required** field,
not optional — it names the path, inside the plugin package, to that plugin's own generated
CycloneDX SBOM. `ic-core`'s plugin loader validates its presence (and that it parses as a
well-formed CycloneDX document) at install time and **refuses to load a plugin that omits it or
whose file doesn't parse**, the same hard-validation rigor as an incompatible `pluginApiVersion` —
distinct from (and stricter than) the softer open-source/unverified warning in §9's trust model,
which is about *installing* an unreviewed plugin at all, not about *this specific* disclosure
requirement.

**In-app UI**: a "Third-Party Licenses" / "Software Bill of Materials" screen (Settings/About) that
aggregates and shows, grouped by package: `ic-core`'s own SBOM, `invoice-collector-plugin-sdk`'s,
and — for each currently-installed plugin — that plugin's own SBOM, rendered as a per-package
component/license list so the full picture always reflects exactly what's actually installed, not
a static list baked in at app-release time. Also expose a raw "export SBOM" action per package
(just handing back the underlying CycloneDX JSON file) for anyone who wants the actual
machine-readable document rather than the rendered view.

**Spec version and aggregation approach — start simple on both**: don't hand-pin a CycloneDX spec
revision independently of tooling — target whatever `@cyclonedx/cyclonedx-npm`'s current stable
release emits by default, and let it move forward as that tool's defaults do; the schema is
additive across minor revisions and nothing here needs to pin an exact version. Similarly, `ic-core`
does **not** attempt a deep structural merge of multiple plugins' SBOMs into one combined
dependency graph for v1 — each package's (core's, the SDK's, and every installed plugin's) SBOM is
kept and shown/exported as its own independent document, side by side. A real merge is meaningfully
more engineering (normalizing PURLs/versions across independently-built, sometimes-closed-source
packages that may legitimately disagree on versions) with no payoff until something concrete asks
for it. If that need shows up later, use CycloneDX's own established merge tooling (`cyclonedx-cli
merge`) rather than building a bespoke merge step.

## 14. User stories

Every story below is grounded in an actual decision recorded earlier in this document — nothing
here is speculative.

### 14.1 Core use cases

**Source & destination onboarding**

| # | Story | Provided by |
|---|---|---|
| US4 | As an operator, I want an email-based source that scans a mailbox for invoice attachments and parses them with a fixed set of built-in field-extraction rules, so vendors who only send invoices by email are covered too. | `ic-email-to-downloads` |
| US7 | As an operator, I want a zero-setup local "Downloads" folder destination, so I can start collecting with no destination configuration at all. | `ic-email-to-downloads` |
| US8 | As an operator, I want many sources to share one destination, so I only configure a destination once. | `ic-core` (generic `PluginBackedRecord.destinationId`, §5 — plugin-agnostic) |

**Collect**

| # | Story | Provided by |
|---|---|---|
| US9 | As an operator, I want to pick a month and click Collect (one source or all), so new invoices get pulled without me tracking what's already done by hand. | `ic-core` (job runner, plugin-agnostic) |
| US10 | As an operator, I want already-collected invoices to show immediately without re-downloading, so re-running Collect is always safe. | Split — `ic-core` owns the dedup database and decides whether a source plugin's `fetchContent()` gets called at all; the destination plugin's own `upload()` handles the "does this already exist at the destination" case itself, via its own override behavior and `UploadResult.status` (§5) |
| US11 | As an operator, I want a per-destination start-month cutoff, so a brand-new destination can't accidentally backfill years of history on its first run. | `ic-core` (generic destination config field) |
| US12 | As an operator, I want a Collect run to show live progress and be cancellable, so I have control over and visibility into long-running work. | `ic-core` (job runner) |

**Invoice history**

| # | Story | Provided by |
|---|---|---|
| US13 | As an operator, I want a deduplicated, per-month record of everything ever collected, so I don't need an external spreadsheet to know what's done. | `ic-core` |
| US14 | As an operator, I want old history pruned after a configurable retention window, so the history file doesn't grow forever. | `ic-core` |

**Settings & config management**

| # | Story | Provided by |
|---|---|---|
| US15 | As an operator, I want to export/import my whole configuration as one password-protected file, so I can back it up or move machines. | `ic-core` |
| US16 | As an operator, I want fully isolated profiles (sources/destinations/history), so I can keep production and test configurations side by side. | `ic-core` |
| US17 | As an operator, I want sign-in state excluded from exports, so an imported source/destination lands in a safe "needs login" state instead of carrying a token that would just go stale. | `ic-core` ("Sessions are never exported," §6) |

**Session/connection lifecycle**

| # | Story | Provided by |
|---|---|---|
| US18 | As an operator, I want a clear Reconnect action when a session expires, so I can restore access without recreating the whole source/destination. | `ic-core` (Sessions UI, §6) + whichever plugin's `SessionPlugin.refresh()`/`test()` supplies the actual logic |
| US19 | As an operator, I want to see which sources/destinations have a credential problem before I run Collect, so I'm not surprised by a failure mid-run. | `ic-core` (Sessions status surfaced in UI) |

**Reporting**

| # | Story | Provided by |
|---|---|---|
| US20 | As an operator, I want to export a Collect run's results as HTML or Excel, so I can share or archive a record outside the app. | `ic-core` |

**Security & trust**

| # | Story | Provided by |
|---|---|---|
| US21 | As an operator, I want secrets stored only via OS-keychain-backed encryption, never plaintext, so a compromised machine or config file doesn't leak credentials. | `ic-core` (Sessions registry, §6) |
| US22 | As an operator, I want logs to never contain plaintext secrets or unredacted tenant/org identifiers, so I can safely share logs for troubleshooting. | `ic-core` (`HttpApi`'s centralized logging, §7) |

### 14.2 Stories specific to this architecture

| # | Story | Provided by |
|---|---|---|
| US23 | As a user, I want to install a new source/destination plugin by pasting a public repo URL, so I can extend the app with open-source integrations without waiting on an app update. | `ic-core` (§9.1) |
| US24 | As a user, I want a clear warning before installing anything that isn't verifiably open source, so I understand the risk before running unreviewed code. | `ic-core` (§9) |
| US26 | As a user, I want to see exactly which roles/permissions a plugin needs *before* I grant it access, so I make an informed decision, the same way an OAuth consent screen works. | `ic-core` (`SessionRequirement` UI, §6) |
| US27 | As a user, I want to sign in once and have multiple sources/destinations reuse that session, so I don't sign in to the same account twice. | The SDK's `microsoft-entra-delegated-device-code` built-in (§6/§6.1) |
| US28 | As a user, I want to see every installed plugin's open-source licenses/SBOM in one place, so I can audit exactly what's running in my app. | `ic-core` (§13) |
| US29 | As a developer evaluating this project, I want the core app and its bundled email/local-folder plugin fully open source under a permissive license, so I can inspect, audit, or contribute without asking permission. | `ic-core`, `ic-email-to-downloads`, `invoice-collector-plugin-sdk` (MIT, §2) |
| US30 | As a user, I want a plugin update that fails to automatically roll back rather than leave things half-broken, so a bad release from any plugin author never costs me working functionality. | `ic-core` (§5) |
| US31 | As a user uninstalling a plugin, I want my sources/destinations and their history preserved, so reinstalling (or upgrading) it later restores everything with no data loss. | `ic-core` (§5) |

### 14.3 Backlog — deferred past the first release

Not scheduled a phase number yet, unlike the rest of this document — kept here rather than dropped
so the decision to defer, and why, isn't lost.

| # | Story | Provided by | Why deferred |
|---|---|---|---|
| US5 | As an operator, I want to manually teach the app field-rules for an email template it can't parse automatically, so future emails of that template get handled without code changes. | `ic-email-to-downloads` | Phase 1.14 ships `ic-email-to-downloads` with a fixed set of **built-in** field-extraction rules only (US4) — real coverage for the common case, without the added surface of a manual-capture UI (persisting user-authored rules, migrating them across a plugin update, §8's list/detail wizard-step plumbing that UI would need) before a first release even exists. Picking this up later is additive: `ic-email-to-downloads`'s `wizard`/`settingsPanel` can grow a `ListDescriptor`/`DetailDescriptor` step for it without a breaking change, using primitives §8 already ships for exactly this reason. |

## 15. Open questions / action items

Resolved decisions accumulate inline throughout the relevant sections rather than being
re-summarized here.

Nothing is currently tracked as open.
