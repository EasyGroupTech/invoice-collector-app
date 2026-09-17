import { randomUUID } from 'node:crypto';
import {
  KNOWN_BUILT_IN_SESSION_TYPE_IDS,
  type HttpRequestInput,
  type PluginContext,
  type Session,
  type SessionPlugin,
  type SessionsApi,
} from 'invoice-collector-plugin-sdk';
import { decryptField, encryptField, type Encryptor } from './encryptor.js';
import { loadSessionsFile, saveSessionsFile, type SessionsFile, type StoredSession } from './session-store.js';

const DEFAULT_REFRESH_MARGIN_MS = 5 * 60 * 1000;

export interface SessionsRegistryOptions {
  filePath: string;
  encryptor: Encryptor;
  /**
   * Everything a PluginContext needs besides `sessions` — real http/storage/log/progress land in
   * later phases (1.7 HttpApi, 1.9 job runner, 1.11 Electron shell); this registry only needs to
   * be able to call into a SessionPlugin, not to know how those services are actually built.
   */
  createPluginServices: (pluginId: string) => Omit<PluginContext, 'sessions'>;
  now?: () => Date;
  /** How far ahead of expiresAt to proactively refresh. Default 5 minutes. */
  refreshMarginMs?: number;
}

export interface SessionsRegistry {
  registerSessionPlugin(plugin: SessionPlugin): void;
  /** Scoped per the cross-plugin sharing rule (§6): built-in session types are visible to any
   * plugin; a custom session type stays visible only to the plugin that created it. */
  forPlugin(pluginId: string): SessionsApi;
  /** Resumes proactive refresh scheduling for every persisted active session — call once at app
   * boot, after registering every available SessionPlugin. */
  startScheduler(): Promise<void>;
  stopScheduler(): void;
  /**
   * Internal primitives for HttpApi (§7) — not part of the plugin-facing SessionsApi. A plugin
   * never calls these directly; HttpApi's own implementation does, once per outbound request that
   * names a sessionId.
   */
  attachAuth(pluginId: string, sessionId: string, request: HttpRequestInput): Promise<HttpRequestInput>;
  /** Reactive counterpart to the proactive scheduler's own refresh — same underlying mechanism
   * (SessionPlugin.refresh()), triggered by a 401 instead of a timer. Throws if the session isn't
   * visible to `pluginId`, has no refresh() mechanism, or the refresh attempt itself fails (in
   * which case the session is still persisted as `needs-reconnect` before the throw). */
  recoverSession(pluginId: string, sessionId: string): Promise<Session>;
  /** Updates a session's own label — e.g. once a plugin's `suggestSessionLabel()` hook (§6)
   * resolves a friendlier name than whatever the session type itself set by default. Touches only
   * the label; the secret/status/expiry are untouched. Scoped by the same cross-plugin visibility
   * rule as `attachAuth`/`recoverSession`. */
  renameSession(pluginId: string, sessionId: string, label: string): Promise<Session>;
  /**
   * Every session, unscoped by the cross-plugin sharing rule — not part of the plugin-facing
   * SessionsApi. For core's own Sessions UI (§6: "lists established sessions, their status... and
   * which Source/Destination records currently use each"), which needs the full picture, not one
   * plugin's own view of it. A plugin never gets this; only core's own IPC layer does.
   */
  listAll(): Promise<Session[]>;
  /**
   * Forgets a session entirely — unscoped, same reasoning as `listAll`: this is core's own
   * housekeeping acting on the full picture, not a plugin-facing capability. Not a user-facing
   * "Logout" (see `logoutSession` for that) — this is the cascade-delete primitive a source/
   * destination removal uses once a session is no longer referenced by anything (§14.1's flow
   * concept: a flow's own session gets deleted for real once nothing uses it any more, the same
   * way its destination does). A source/destination record still pointing at this sessionId isn't
   * touched here — the caller is responsible for having already confirmed nothing does. Silently a
   * no-op if the session doesn't exist (already gone is the same end state as removed).
   */
  removeSession(sessionId: string): Promise<void>;
  /**
   * A user-facing "Logout" — clears the stored secret (and its own expiry info) and moves the
   * session to `needs-reconnect`, but keeps the session record itself: its id, label, type, and
   * `createInputCiphertext` (still needed for a later Login to re-establish it) all survive. This
   * is deliberately *not* the same as `removeSession` — logging out doesn't delete anything, it
   * just invalidates the credentials, exactly the way logging out of a website doesn't delete your
   * account. Unscoped, same reasoning as `listAll`. Silently a no-op if the session doesn't exist.
   */
  logoutSession(sessionId: string): Promise<void>;
}

function isBuiltInSessionType(sessionTypeId: string): boolean {
  return (KNOWN_BUILT_IN_SESSION_TYPE_IDS as readonly string[]).includes(sessionTypeId);
}

function toPublicSession(stored: StoredSession): Session {
  const { secretCiphertext: _secretCiphertext, createInputCiphertext: _createInputCiphertext, ...session } = stored;
  return session;
}

function upsert(sessions: StoredSession[], next: StoredSession): StoredSession[] {
  const index = sessions.findIndex((s) => s.id === next.id);
  if (index === -1) return [...sessions, next];
  const copy = [...sessions];
  copy[index] = next;
  return copy;
}

export function createSessionsRegistry(options: SessionsRegistryOptions): SessionsRegistry {
  const now = options.now ?? (() => new Date());
  const refreshMarginMs = options.refreshMarginMs ?? DEFAULT_REFRESH_MARGIN_MS;
  const plugins = new Map<string, SessionPlugin>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  let cached: SessionsFile | null = null;

  async function state(): Promise<SessionsFile> {
    if (!cached) {
      cached = await loadSessionsFile(options.filePath);
    }
    return cached;
  }

  async function persist(next: SessionsFile): Promise<void> {
    cached = next;
    await saveSessionsFile(options.filePath, next);
  }

  function visibleTo(stored: StoredSession, pluginId: string): boolean {
    return isBuiltInSessionType(stored.sessionTypeId) || stored.createdByPluginId === pluginId;
  }

  function clearTimerFor(sessionId: string): void {
    const timer = timers.get(sessionId);
    if (timer) {
      clearTimeout(timer);
      timers.delete(sessionId);
    }
  }

  function scheduleFor(stored: StoredSession): void {
    clearTimerFor(stored.id);
    if (stored.status !== 'active') return;

    const plugin = plugins.get(stored.sessionTypeId);
    if (!plugin?.refresh) return;

    let delayMs: number | undefined;
    if (stored.keepAliveIntervalMs !== undefined) {
      delayMs = stored.keepAliveIntervalMs;
    } else if (stored.expiresAt) {
      delayMs = new Date(stored.expiresAt).getTime() - refreshMarginMs - now().getTime();
    }
    if (delayMs === undefined) return;

    const timer = setTimeout(() => {
      void runScheduledRefresh(stored.id);
    }, Math.max(delayMs, 0));
    timers.set(stored.id, timer);
  }

  function buildContext(
    pluginId: string,
    onProgress?: (message: string, data?: Record<string, unknown>) => void,
  ): PluginContext {
    const services = options.createPluginServices(pluginId);
    return {
      ...services,
      sessions: forPlugin(pluginId),
      // A caller-supplied reporter (create()/reconnect() called interactively, e.g. from a job)
      // takes priority over whatever generic progress sink createPluginServices provides — the
      // device-code built-in's "enter this code at this URL" has to actually reach that caller.
      progress: onProgress ? { report: onProgress } : services.progress,
    };
  }

  type RefreshOutcome =
    | { kind: 'no-refresh-method' }
    | { kind: 'unchanged'; updated: StoredSession }
    | { kind: 'refreshed'; updated: StoredSession }
    | { kind: 'failed'; updated: StoredSession };

  /** Shared by the proactive scheduler and the reactive (401-triggered) recovery path — both
   * ultimately just call SessionPlugin.refresh() once and interpret the result the same way. */
  async function attemptRefresh(stored: StoredSession): Promise<RefreshOutcome> {
    const plugin = plugins.get(stored.sessionTypeId);
    if (!plugin?.refresh) return { kind: 'no-refresh-method' };

    const ctx = buildContext(stored.createdByPluginId);
    try {
      const result = await plugin.refresh(ctx, toPublicSession(stored), new AbortController().signal);
      if (result === 'unchanged') {
        return { kind: 'unchanged', updated: stored };
      }
      const updated: StoredSession = {
        ...stored,
        status: 'active',
        updatedAt: now().toISOString(),
        expiresAt: result.expiresAt,
        secretCiphertext: encryptField(options.encryptor, JSON.stringify(result.secret)),
      };
      return { kind: 'refreshed', updated };
    } catch {
      const failed: StoredSession = { ...stored, status: 'needs-reconnect', updatedAt: now().toISOString() };
      return { kind: 'failed', updated: failed };
    }
  }

  async function runScheduledRefresh(sessionId: string): Promise<void> {
    const current = await state();
    const stored = current.sessions.find((s) => s.id === sessionId);
    if (!stored) return;

    const outcome = await attemptRefresh(stored);
    if (outcome.kind === 'no-refresh-method') return;

    const latest = await state();
    await persist({ ...latest, sessions: upsert(latest.sessions, outcome.updated) });

    // 'failed' is deliberately not rescheduled — a session whose refresh attempt just failed only
    // recovers via a user-facing Reconnect from here on.
    if (outcome.kind !== 'failed') {
      scheduleFor(outcome.updated);
    }
  }

  async function attachAuth(pluginId: string, sessionId: string, request: HttpRequestInput): Promise<HttpRequestInput> {
    const current = await state();
    const stored = current.sessions.find((s) => s.id === sessionId);
    if (!stored || !visibleTo(stored, pluginId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const plugin = plugins.get(stored.sessionTypeId);
    if (!plugin) {
      throw new Error(`No SessionPlugin registered for session type "${stored.sessionTypeId}"`);
    }
    if (!stored.secretCiphertext) {
      throw new Error(`Session ${sessionId} needs to be reconnected — logged out`);
    }
    const secret = JSON.parse(decryptField(options.encryptor, stored.secretCiphertext)) as unknown;
    return plugin.applyAuth(secret, request);
  }

  async function recoverSession(pluginId: string, sessionId: string): Promise<Session> {
    const current = await state();
    const stored = current.sessions.find((s) => s.id === sessionId);
    if (!stored || !visibleTo(stored, pluginId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }

    const outcome = await attemptRefresh(stored);
    if (outcome.kind === 'no-refresh-method') {
      throw new Error(`Session ${sessionId} has no refresh mechanism — reconnect required`);
    }

    const latest = await state();
    await persist({ ...latest, sessions: upsert(latest.sessions, outcome.updated) });

    if (outcome.kind === 'failed') {
      throw new Error(`Failed to refresh session ${sessionId} — reconnect required`);
    }

    scheduleFor(outcome.updated);
    return toPublicSession(outcome.updated);
  }

  async function renameSession(pluginId: string, sessionId: string, label: string): Promise<Session> {
    const current = await state();
    const stored = current.sessions.find((s) => s.id === sessionId);
    if (!stored || !visibleTo(stored, pluginId)) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const updated: StoredSession = { ...stored, label, updatedAt: now().toISOString() };
    await persist({ ...current, sessions: upsert(current.sessions, updated) });
    return toPublicSession(updated);
  }

  function forPlugin(pluginId: string): SessionsApi {
    return {
      async list(sessionTypeId) {
        const current = await state();
        return current.sessions
          .filter((s) => visibleTo(s, pluginId))
          .filter((s) => !sessionTypeId || s.sessionTypeId === sessionTypeId)
          .map(toPublicSession);
      },

      async get(sessionId) {
        const current = await state();
        const stored = current.sessions.find((s) => s.id === sessionId);
        if (!stored || !visibleTo(stored, pluginId)) return undefined;
        return {
          session: toPublicSession(stored),
          // Logged out (§6) — no secret to decrypt. A plugin's own refresh()/upload()/discover()
          // reading this back gets `undefined` and fails on its own terms (e.g.
          // local-folder-session.ts's refresh() already throws "No stored folder path found" for
          // exactly this shape), which attemptRefresh()'s existing try/catch already turns into a
          // clean needs-reconnect outcome — no special-casing needed here beyond not crashing on
          // decrypting a value that isn't there.
          secret: stored.secretCiphertext ? (JSON.parse(decryptField(options.encryptor, stored.secretCiphertext)) as unknown) : undefined,
        };
      },

      async create(sessionTypeId, input, signal, onProgress) {
        const plugin = plugins.get(sessionTypeId);
        if (!plugin) {
          throw new Error(`No SessionPlugin registered for session type "${sessionTypeId}"`);
        }

        const ctx = buildContext(pluginId, onProgress);
        const result = await plugin.create(ctx, input, signal ?? new AbortController().signal);
        const timestamp = now().toISOString();
        const stored: StoredSession = {
          id: randomUUID(),
          sessionTypeId,
          label: result.label,
          createdByPluginId: pluginId,
          createdAt: timestamp,
          updatedAt: timestamp,
          status: 'active',
          expiresAt: result.expiresAt,
          keepAliveIntervalMs: result.keepAliveIntervalMs,
          secretCiphertext: encryptField(options.encryptor, JSON.stringify(result.secret)),
          createInputCiphertext: encryptField(options.encryptor, JSON.stringify(input)),
        };

        const current = await state();
        await persist({ ...current, sessions: [...current.sessions, stored] });
        scheduleFor(stored);
        return toPublicSession(stored);
      },

      async reconnect(sessionId, signal, onProgress) {
        const current = await state();
        const stored = current.sessions.find((s) => s.id === sessionId);
        if (!stored || !visibleTo(stored, pluginId)) {
          throw new Error(`Session not found: ${sessionId}`);
        }

        // Try a silent refresh-token renewal first — same mechanism the proactive scheduler and
        // 401-triggered recovery already use. Only fall back to the full interactive create() flow
        // (a brand new device-code sign-in, for the built-in) when there's no refresh mechanism or
        // it actually failed — a user-facing Reconnect click shouldn't force a new sign-in prompt
        // when the existing refresh token still works.
        const refreshOutcome = await attemptRefresh(stored);
        if (refreshOutcome.kind === 'refreshed' || refreshOutcome.kind === 'unchanged') {
          const latest = await state();
          await persist({ ...latest, sessions: upsert(latest.sessions, refreshOutcome.updated) });
          scheduleFor(refreshOutcome.updated);
          return toPublicSession(refreshOutcome.updated);
        }

        const plugin = plugins.get(stored.sessionTypeId);
        if (!plugin) {
          throw new Error(`No SessionPlugin registered for session type "${stored.sessionTypeId}"`);
        }

        const input = JSON.parse(decryptField(options.encryptor, stored.createInputCiphertext)) as unknown;
        const ctx = buildContext(stored.createdByPluginId, onProgress);
        const result = await plugin.create(ctx, input, signal ?? new AbortController().signal);

        const updated: StoredSession = {
          ...stored,
          label: result.label,
          status: 'active',
          updatedAt: now().toISOString(),
          expiresAt: result.expiresAt,
          keepAliveIntervalMs: result.keepAliveIntervalMs,
          secretCiphertext: encryptField(options.encryptor, JSON.stringify(result.secret)),
        };
        await persist({ ...current, sessions: upsert(current.sessions, updated) });
        scheduleFor(updated);
        return toPublicSession(updated);
      },

      async rotate(sessionId, input, signal, onProgress) {
        const current = await state();
        const stored = current.sessions.find((s) => s.id === sessionId);
        if (!stored || !visibleTo(stored, pluginId)) {
          throw new Error(`Session not found: ${sessionId}`);
        }
        const plugin = plugins.get(stored.sessionTypeId);
        if (!plugin) {
          throw new Error(`No SessionPlugin registered for session type "${stored.sessionTypeId}"`);
        }

        // Deliberately no silent-refresh attempt first (unlike reconnect()) — the caller already
        // has a fresh credential in hand, so there's nothing worth trying to avoid using it for.
        const ctx = buildContext(stored.createdByPluginId, onProgress);
        const result = await plugin.create(ctx, input, signal ?? new AbortController().signal);

        const updated: StoredSession = {
          ...stored,
          label: result.label,
          status: 'active',
          updatedAt: now().toISOString(),
          expiresAt: result.expiresAt,
          keepAliveIntervalMs: result.keepAliveIntervalMs,
          secretCiphertext: encryptField(options.encryptor, JSON.stringify(result.secret)),
          // The new input replaces what create() was originally called with — a later plain
          // reconnect() (if create() ever needs replaying again) should use the fresh one, not
          // the now-stale value that made rotation necessary in the first place.
          createInputCiphertext: encryptField(options.encryptor, JSON.stringify(input)),
        };
        await persist({ ...current, sessions: upsert(current.sessions, updated) });
        scheduleFor(updated);
        return toPublicSession(updated);
      },
    };
  }

  return {
    registerSessionPlugin(plugin) {
      plugins.set(plugin.sessionTypeId, plugin);
    },

    forPlugin,

    async startScheduler() {
      const current = await state();
      for (const stored of current.sessions) {
        scheduleFor(stored);
      }
    },

    stopScheduler() {
      for (const sessionId of [...timers.keys()]) {
        clearTimerFor(sessionId);
      }
    },

    attachAuth,
    recoverSession,
    renameSession,

    async listAll() {
      const current = await state();
      return current.sessions.map(toPublicSession);
    },

    async removeSession(sessionId) {
      clearTimerFor(sessionId);
      const current = await state();
      await persist({ ...current, sessions: current.sessions.filter((s) => s.id !== sessionId) });
    },

    async logoutSession(sessionId) {
      const current = await state();
      const stored = current.sessions.find((s) => s.id === sessionId);
      if (!stored) return;
      clearTimerFor(sessionId); // nothing left to proactively refresh — there's no secret anymore
      const updated: StoredSession = {
        ...stored,
        status: 'needs-reconnect',
        secretCiphertext: undefined,
        expiresAt: undefined,
        keepAliveIntervalMs: undefined,
        updatedAt: now().toISOString(),
      };
      await persist({ ...current, sessions: upsert(current.sessions, updated) });
    },
  };
}
