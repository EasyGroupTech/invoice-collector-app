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
  /**
   * Every session, unscoped by the cross-plugin sharing rule — not part of the plugin-facing
   * SessionsApi. For core's own Sessions UI (§6: "lists established sessions, their status... and
   * which Source/Destination records currently use each"), which needs the full picture, not one
   * plugin's own view of it. A plugin never gets this; only core's own IPC layer does.
   */
  listAll(): Promise<Session[]>;
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
          secret: JSON.parse(decryptField(options.encryptor, stored.secretCiphertext)) as unknown,
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

    async listAll() {
      const current = await state();
      return current.sessions.map(toPublicSession);
    },
  };
}
