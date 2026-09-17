import type { PluginContext, Session, SessionsApi } from 'invoice-collector-plugin-sdk';
import type { PluginRegistry } from './plugin-registry.js';

/** Same injection points as `session-label-suggest.ts`'s own deps — a short one-off call, not a
 * long-running job, so the default progress sink `createPluginServices()` already provides is
 * enough. */
export interface SuggestSourceNameDeps {
  registry: PluginRegistry;
  createPluginServices: (pluginId: string) => Omit<PluginContext, 'sessions'>;
  sessionsApiForPlugin: (pluginId: string) => SessionsApi;
}

/**
 * §14.1's "what should this record be called" follow-up: once the config wizard's own values are
 * known (the last step before creating the record), gives the owning plugin one chance to suggest
 * a name combining the session's own label with a plugin-specific summary of that config
 * (`plugin.suggestSourceName()`, `SourceNameSuggester`, optional). Returns `undefined` — not an
 * error — both for a plugin with nothing to suggest and for one whose hook itself throws: same
 * best-effort contract as `suggestSessionLabel`. The caller (core's own Add Collector wizard)
 * falls back to the session's own label alone in either case, never to an empty/placeholder name.
 */
export async function suggestSourceName(
  deps: SuggestSourceNameDeps,
  pluginId: string,
  session: Session,
  configValues: unknown,
  signal: AbortSignal,
): Promise<string | undefined> {
  const plugin = deps.registry.get(pluginId);
  if (!plugin?.suggestSourceName) return undefined;

  const ctx: PluginContext = {
    ...deps.createPluginServices(pluginId),
    sessions: deps.sessionsApiForPlugin(pluginId),
  };

  try {
    return await plugin.suggestSourceName(ctx, session, configValues, signal);
  } catch {
    return undefined;
  }
}
