import type { PluginContext } from './context.js';
import type { HttpRequestInput } from './http.js';

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
}

/**
 * Core-provided Sessions registry. Scoped per the cross-plugin sharing rule: only ever returns a
 * session whose type is one of the SDK's own built-ins, or one this plugin itself created under a
 * custom type — never another plugin's custom-typed session.
 */
export interface SessionsApi {
  list(sessionTypeId?: string): Promise<Session[]>;
  get(sessionId: string): Promise<{ session: Session; secret: unknown } | undefined>;
  /** Delegates to whichever registered SessionPlugin implements sessionTypeId. */
  create(sessionTypeId: string, input: unknown, signal?: AbortSignal): Promise<Session>;
  reconnect(sessionId: string, signal?: AbortSignal): Promise<Session>;
}
