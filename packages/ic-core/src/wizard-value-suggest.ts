import type { PluginContext, Session, SessionsApi } from 'invoice-collector-plugin-sdk';
import type { PluginRegistry } from './plugin-registry.js';

/** Same injection points as `session-label-suggest.ts`'s own deps — a short one-off call, not a
 * long-running job, so the default progress sink `createPluginServices()` already provides is
 * enough. */
export interface SuggestWizardValuesDeps {
  registry: PluginRegistry;
  createPluginServices: (pluginId: string) => Omit<PluginContext, 'sessions'>;
  sessionsApiForPlugin: (pluginId: string) => SessionsApi;
}

/**
 * Once a session is established, gives the owning plugin one chance to suggest values for its own
 * `wizard` (§8) step by calling `plugin.suggestWizardValues()` (`WizardValueSuggester`, optional)
 * — e.g. an organization id a browser-captured session's own stored secret already carries,
 * sparing the user from having to go dig it up and paste it in by hand. Returns `undefined` — not
 * an error — both for a plugin with nothing to suggest and for one whose hook itself throws: a
 * suggestion is a nice-to-have, never something the wizard's own usability should be blocked on.
 * Mirrors `suggestSessionLabel()` exactly, one field renamed.
 */
export async function suggestWizardValues(
  deps: SuggestWizardValuesDeps,
  pluginId: string,
  session: Session,
  signal: AbortSignal,
): Promise<Record<string, unknown> | undefined> {
  const plugin = deps.registry.get(pluginId);
  if (!plugin?.suggestWizardValues) return undefined;

  const ctx: PluginContext = {
    ...deps.createPluginServices(pluginId),
    sessions: deps.sessionsApiForPlugin(pluginId),
  };

  try {
    return await plugin.suggestWizardValues(ctx, session, signal);
  } catch {
    return undefined;
  }
}
