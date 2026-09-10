import type { SessionsApi } from './session.js';
import type { HttpApi } from './http.js';

/**
 * Generic per-plugin key/value store, separate from session secrets, for whatever non-secret
 * state a plugin needs to persist — invoice-parsing rule defaults, UI preferences, or (for a
 * commercial plugin, though the SDK has no idea that's what it's being used for) a
 * license-activation record.
 */
export interface PluginStorageApi {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Routes through core's own log-sanitization pipeline — a plugin logs through this, never a raw
 * console call, so it can't reintroduce a plaintext-secret-in-logs problem. */
export interface PluginLogApi {
  info(message: string, data?: Record<string, unknown>): void;
  warn(message: string, data?: Record<string, unknown>): void;
  error(message: string, data?: Record<string, unknown>): void;
}

/** Streams into the core job runner's progress-event pipe. */
export interface PluginProgressApi {
  report(message: string, data?: Record<string, unknown>): void;
}

/**
 * Scoped, not a security boundary (plugins run in-process) — but the contract every plugin is
 * expected to use rather than reaching past it.
 */
export interface PluginContext {
  sessions: SessionsApi;
  storage: PluginStorageApi;
  http: HttpApi;
  log: PluginLogApi;
  progress: PluginProgressApi;
  /**
   * The exact URL this plugin's own package was installed from (§9.1) — undefined for a plugin
   * bundled directly into core rather than installed through the generic pipeline. A commercial
   * plugin's install link can carry its own license/purchase parameters in this URL's query
   * string (§15 leaves the actual scheme entirely up to the plugin); this is how it gets to read
   * them back, the same URL a purchaser was given, with no separate "fetch my license" step or
   * core-side awareness of what the parameters mean.
   */
  installUrl?: string;
}
