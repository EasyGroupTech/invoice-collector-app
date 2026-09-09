import type { PluginContext, Session, SessionsApi } from 'invoice-collector-plugin-sdk';
import type { PluginRegistry } from './plugin-registry.js';

/** Same injection points as `wizard-data.ts`'s `ResolveWizardListDataDeps` — a short one-off call,
 * not a long-running job, so the default progress sink `createPluginServices()` already provides
 * is enough. */
export interface SuggestSessionLabelDeps {
  registry: PluginRegistry;
  createPluginServices: (pluginId: string) => Omit<PluginContext, 'sessions'>;
  sessionsApiForPlugin: (pluginId: string) => SessionsApi;
}

/**
 * §6's "friendly session name" follow-up: once a session is established, gives the owning plugin
 * one chance to suggest a better label than whatever the session type itself set (e.g. a generic
 * "Microsoft 365 sign-in") by calling `plugin.suggestSessionLabel()` (`SessionLabelSuggester`,
 * optional). Returns `undefined` — not an error — both for a plugin with nothing to suggest and
 * for one whose hook itself throws: a suggestion is a nice-to-have, never something a session's
 * own usability should be blocked on.
 */
export async function suggestSessionLabel(
  deps: SuggestSessionLabelDeps,
  pluginId: string,
  session: Session,
  signal: AbortSignal,
): Promise<string | undefined> {
  const plugin = deps.registry.get(pluginId);
  if (!plugin?.suggestSessionLabel) return undefined;

  const ctx: PluginContext = {
    ...deps.createPluginServices(pluginId),
    sessions: deps.sessionsApiForPlugin(pluginId),
  };

  try {
    return await plugin.suggestSessionLabel(ctx, session, signal);
  } catch {
    return undefined;
  }
}
