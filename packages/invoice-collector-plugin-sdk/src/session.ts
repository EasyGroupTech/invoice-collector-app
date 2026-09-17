import type { PluginContext } from './context.js';
import type { HttpRequestInput } from './http.js';
import type { FieldDescriptor } from './ui.js';

/**
 * The SDK's own built-in session types — currently just one, deliberately. See §6.1.
 *
 * Named for the identity platform, not an API — Microsoft Entra ID's OAuth2 device-authorization
 * grant. This one built-in serves Graph-backed consumers (Graph Mail, SharePoint) *and*
 * Azure ARM billing's Login connection method, which authenticates against `management.azure.com`
 * — not Graph or M365 at all. "Entra" is the thing all three actually share.
 */
export const KNOWN_BUILT_IN_SESSION_TYPE_IDS = ['microsoft-entra-delegated-device-code'] as const;

export type BuiltInSessionTypeId = (typeof KNOWN_BUILT_IN_SESSION_TYPE_IDS)[number];

export interface SessionTypeDescriptor {
  id: string;
  /** Shown in the Sessions UI, e.g. "Microsoft sign-in". */
  label: string;
}

export type SessionStatus = 'active' | 'expired' | 'needs-reconnect';

export interface Session {
  id: string;
  sessionTypeId: string;
  /** Human-readable, e.g. "admin@contoso.com (Contoso Ltd)". */
  label: string;
  createdByPluginId: string;
  createdAt: string;
  updatedAt: string;
  status: SessionStatus;
  /** Known token/cookie expiry, if this session type has one — lets core schedule a proactive
   * refresh ahead of expiry instead of only reacting after something fails. */
  expiresAt?: string;
  /** Set by a SessionPlugin whose session type needs periodic "still alive" activity rather
   * than a token-expiry renewal — core calls refresh() on this cadence. */
  keepAliveIntervalMs?: number;
}

export interface SessionCreateResult {
  label: string;
  secret: unknown;
  expiresAt?: string;
  keepAliveIntervalMs?: number;
}

export interface SessionRefreshResult {
  secret: unknown;
  expiresAt?: string;
}

/** A plugin implements this once per session type it knows how to establish. */
export interface SessionPlugin {
  sessionTypeId: string;
  /**
   * `signal` matters here specifically because some session types (device-code flows) can take
   * minutes of real waiting on a human — this wasn't in the interface's first pass (§5's
   * discover()/fetchContent()/upload() all take a trailing signal; this was the missed one),
   * added once actually implementing the device-code built-in made the gap concrete.
   */
  create(ctx: PluginContext, input: unknown, signal: AbortSignal): Promise<SessionCreateResult>;
  /**
   * Called reactively (on a 401 during discover()/fetchContent()/upload()) AND proactively (on
   * the schedule expiresAt/keepAliveIntervalMs implies). Omit entirely if this session type has
   * no renewal mechanism at all (e.g. a one-time pasted API key) — it then only ever recovers
   * via a user-facing Reconnect.
   */
  refresh?(ctx: PluginContext, session: Session, signal: AbortSignal): Promise<SessionRefreshResult | 'unchanged'>;
  test(ctx: PluginContext, session: Session, signal: AbortSignal): Promise<'ok' | 'expired' | 'error'>;
  /**
   * Given this session's decrypted secret and an outbound request, return the request modified to
   * carry this session's auth — a bearer header, a cookie header, real per-request SigV4 signing,
   * whatever this session type's mechanism actually is. Core calls this for every HttpApi request
   * that names a sessionId (§7); the session type owns *how* auth attaches, since core has no
   * generic way to derive it from a secret's shape alone (§6.1 already calls AWS SigV4 out as real
   * cryptographic work, not just attaching a static credential). Required, same as create/test.
   */
  applyAuth(secret: unknown, request: HttpRequestInput): HttpRequestInput | Promise<HttpRequestInput>;
}

export interface SessionRequirement {
  /** A built-in SDK session type, or a custom one this plugin's own SessionPlugin implements. */
  sessionTypeId: string;
  /**
   * Must be true if sessionTypeId names an SDK-provided built-in type — an explicit
   * acknowledgment from the plugin author that they've checked the built-in's actual behavior
   * fits what this plugin needs, rather than assuming a session type ID match is enough on its
   * own. False for a sessionTypeId this plugin brings its own SessionPlugin for.
   */
  confirmsBuiltIn: boolean;
  /**
   * What access this specific plugin needs once a session of this type is established — e.g.
   * Graph delegated scopes ("Mail.Read"), Azure RBAC role names ("Billing Reader"), or a plain
   * permission name for a custom/API-key session type.
   */
  requiredScopesOrRoles: string[];
  /** Human-readable explanation of *why*, shown alongside the raw list. */
  permissionsNote?: string;
  /**
   * Plain input fields (§8) this session type's own create() needs collected from the user before
   * it can run — only meaningful when confirmsBuiltIn is false (a built-in type's input always
   * comes from a plugin's own BuiltInSessionInputProvider.builtInSessionCreateInput() instead) and
   * the session genuinely needs real structured input, unlike the trivial custom case (e.g. an
   * OS-native picker) which needs none. Rendered by core's own wizard (the same FieldInput/
   * WizardSteps components a plugin's own `wizard` array already uses, §8) before the "create new
   * session" action runs, and the resulting values are passed straight through as SessionsApi.
   * create()'s own `input` argument.
   *
   * Deliberately FieldDescriptor[] only, not the full WizardStepDescriptor[] — a list/detail/
   * textSelect step needs an established session to resolve its own dataSource, which doesn't
   * exist yet at this point in the flow (there's no session to resolve it *through*).
   */
  createInputFields?: FieldDescriptor[];
  /**
   * §14.1's single-question "what and how" wizard first step: short noun/prepositional phrase
   * naming what this connection is for — a source's own button reads "Collect {collects}, ...";
   * a destination's reads "Save invoices {collects}, ..." (the same field, phrased by the plugin
   * author to fit whichever sentence its own kind completes). E.g. "invoices from my Microsoft
   * Email" (Graph Mail, a source), "to a folder on this device" (Local Folder, a destination).
   */
  collects: string;
  /**
   * The clause completing "Collect {collects}, ..." (or "Save invoices {collects}, ...") for a
   * *fresh* connection via this specific requirement — e.g. "I'll authenticate this device.",
   * "I'll ask my tenant administrator to create an enterprise application.", "I'll paste my AWS
   * access keys.", "I'll choose a folder." One button per `SessionRequirement` a plugin declares
   * is generated this way — a plugin with more than one (Azure Billing's client-credentials *and*
   * device-code) gets one independent, distinctly-worded button per requirement, not a dropdown.
   * The *reuse* counterpart (shown only when a compatible session already exists) is never
   * plugin-authored — core always generates "Collect {collects}, reusing existing
   * authentication." verbatim, since how the session was originally established doesn't matter
   * once you're just reusing it.
   */
  connectHow: string;
  /**
   * Real, concrete how-to shown in the connect popup this requirement's own button opens —
   * *always* shown, regardless of mechanism (a sign-in flow gets "a window will open, sign in
   * normally"-style framing above the live device-code/browser prompt; a `createInputFields`
   * paste-flow gets the actual steps to go obtain the value, above the form). Distinct from
   * `permissionsNote`, which explains *why* the access is needed/safe to grant, not *how* to
   * actually go get connected.
   */
  connectInstructions: string;
  /**
   * Whether the wizard's own "reusing existing authentication" button is worth offering for this
   * requirement at all — defaults to `true` (every plugin's behavior before this field existed).
   * Set `false` when a second source built on the *same* session would be indistinguishable from
   * the first: either the plugin's own `wizard` is empty (Claude Team/API, Figma, the legacy
   * Microsoft 365 billing account, OpenAI — nothing left to configure differently at all), or
   * whatever config field looks like a differentiator is really just a fact *about the
   * credentials themselves* (AWS's `orgId`, Cloudflare's `orgId` — a different account needs a
   * different key/token, i.e. a different session, not a different value typed against the same
   * one). `true` is for the opposite case: Graph Mail's own subject/sender filters, say, where two
   * sources sharing one mailbox sign-in genuinely can collect different things.
   */
  allowSessionReuse?: boolean;
}

/**
 * §14.1's replacement for a plugin-agnostic "Source name" text field: called once the config
 * wizard's own values are known (the last step before creating the record), so the name can
 * combine the session's own label with a plugin-specific summary of that config — e.g.
 * `alice@contoso.com — Microsoft 365 (Subject contains "Invoice")` for Graph Mail. Same
 * best-effort semantics as `SessionLabelSuggester`/`WizardValueSuggester` (a thrown/rejected call
 * is treated as no suggestion) and the same signature shape, for consistency — a plugin that
 * needs to look something up through the session to build the name can (`ctx.sessions.get`),
 * even though the common case (Graph Mail's own filter summary) never needs to. Optional: core
 * falls back to the session's own label alone when a plugin doesn't implement this (or it
 * returns undefined) — never back to an empty/placeholder name.
 */
export interface SourceNameSuggester {
  suggestSourceName?(ctx: PluginContext, session: Session, configValues: unknown, signal: AbortSignal): Promise<string | undefined>;
}

/**
 * Core-provided Sessions registry. Scoped per the cross-plugin sharing rule: only ever returns a
 * session whose type is one of the SDK's own built-ins, or one this plugin itself created under a
 * custom type — never another plugin's custom-typed session.
 */
export interface SessionsApi {
  list(sessionTypeId?: string): Promise<Session[]>;
  get(sessionId: string): Promise<{ session: Session; secret: unknown } | undefined>;
  /**
   * Delegates to whichever registered SessionPlugin implements sessionTypeId. `onProgress`
   * surfaces whatever that SessionPlugin's own `create()` reports via `ctx.progress.report()`
   * while establishing the session — the device-code built-in's "enter this code at this URL" is
   * exactly this, and with no way to route it back to the caller, a device-code sign-in would be
   * silently unusable (the user never learns the code/URL to visit). A real gap surfaced
   * implementing phase 1.11's Electron shell, closed here rather than worked around.
   */
  create(
    sessionTypeId: string,
    input: unknown,
    signal?: AbortSignal,
    onProgress?: (message: string, data?: Record<string, unknown>) => void,
  ): Promise<Session>;
  /**
   * Tries a silent `SessionPlugin.refresh()` renewal first (the same mechanism the proactive
   * scheduler and 401-triggered recovery already use) — only falls back to the full interactive
   * `create()` flow (using the session's originally-stored `create()` input) if there's no
   * `refresh()` method or the refresh attempt itself fails. A user clicking "Reconnect" shouldn't
   * be forced through a brand new device-code sign-in when the existing refresh token still works;
   * `onProgress` only ever fires for the fallback path, since a successful refresh has nothing to
   * report.
   */
  reconnect(sessionId: string, signal?: AbortSignal, onProgress?: (message: string, data?: Record<string, unknown>) => void): Promise<Session>;
}
