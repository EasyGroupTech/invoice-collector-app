import type { DestinationPlugin, SourcePlugin } from 'invoice-collector-plugin-sdk';

export type LoadedPlugin = SourcePlugin | DestinationPlugin;

/**
 * Live in-process registry of loaded plugins (§9.1's install pipeline's final step). Nothing
 * consumes this yet — the job runner (phase 1.9) is what will actually call discover()/
 * fetchContent()/upload() on what's registered here — but it's real, testable infrastructure
 * later phases build on, the same position sessions-registry.ts (1.6) was in before HttpApi (1.7)
 * needed it.
 */
export interface PluginRegistry {
  register(plugin: LoadedPlugin): void;
  unregister(pluginId: string): void;
  get(pluginId: string): LoadedPlugin | undefined;
  list(): LoadedPlugin[];
  listSources(): SourcePlugin[];
  listDestinations(): DestinationPlugin[];
}

export function createPluginRegistry(): PluginRegistry {
  const plugins = new Map<string, LoadedPlugin>();

  return {
    register(plugin) {
      plugins.set(plugin.manifest.id, plugin);
    },

    unregister(pluginId) {
      plugins.delete(pluginId);
    },

    get(pluginId) {
      return plugins.get(pluginId);
    },

    list() {
      return [...plugins.values()];
    },

    listSources() {
      return [...plugins.values()].filter((p): p is SourcePlugin => p.manifest.kind === 'source');
    },

    listDestinations() {
      return [...plugins.values()].filter((p): p is DestinationPlugin => p.manifest.kind === 'destination');
    },
  };
}
