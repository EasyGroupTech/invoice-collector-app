import type { PluginContext, SessionsApi, WizardListDataRequest, WizardListDataResult } from 'invoice-collector-plugin-sdk';
import type { PluginRegistry } from './plugin-registry.js';

/**
 * Everything needed to build a PluginContext for a wizard-time data-source resolution call — same
 * injection points collect-pipeline.ts's buildContext() uses, minus a progress-report override:
 * this is a short one-off fetch (populate a list step's rows), not a long-running job, so the
 * default sink createPluginServices() already provides is enough.
 */
export interface ResolveWizardListDataDeps {
  registry: PluginRegistry;
  createPluginServices: (pluginId: string) => Omit<PluginContext, 'sessions'>;
  sessionsApiForPlugin: (pluginId: string) => SessionsApi;
}

/**
 * §8's ListDescriptor.dataSource resolution: the renderer never gets rows embedded in a
 * descriptor, it calls back into the owning plugin's own resolveListData() (§5's
 * WizardDataSourceProvider) through this. installPlugin() already refuses to install a plugin
 * whose wizard/settingsPanel declares a list step without implementing resolveListData
 * (validateWizardDataSources), so a "not implemented" error here would mean a registry/install
 * invariant broke, not a normal runtime case.
 */
export async function resolveWizardListData(
  deps: ResolveWizardListDataDeps,
  pluginId: string,
  request: WizardListDataRequest,
  signal: AbortSignal,
): Promise<WizardListDataResult> {
  const plugin = deps.registry.get(pluginId);
  if (!plugin) {
    throw new Error(`Plugin "${pluginId}" is not installed`);
  }
  if (!plugin.resolveListData) {
    throw new Error(`Plugin "${pluginId}" has no resolveListData for dataSource "${request.dataSource}"`);
  }

  const ctx: PluginContext = {
    ...deps.createPluginServices(pluginId),
    sessions: deps.sessionsApiForPlugin(pluginId),
  };

  return plugin.resolveListData(ctx, request, signal);
}
