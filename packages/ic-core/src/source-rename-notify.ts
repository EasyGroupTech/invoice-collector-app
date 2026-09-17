import type { DestinationPlugin, PluginContext, PluginDestinationRecord, SessionsApi } from 'invoice-collector-plugin-sdk';
import type { PluginRegistry } from './plugin-registry.js';

/** Same injection points as `source-name-suggest.ts`'s own deps — a short one-off call, not a
 * long-running job, so the default progress sink `createPluginServices()` already provides is
 * enough. */
export interface NotifySourceRenamedDeps {
  registry: PluginRegistry;
  createPluginServices: (pluginId: string) => Omit<PluginContext, 'sessions'>;
  sessionsApiForPlugin: (pluginId: string) => SessionsApi;
}

/**
 * §14.1's "renaming a flow should rename whatever its destination organized under the old name"
 * follow-up — fired once, right after a flow's own source record is renamed, giving the
 * destination it's paired with one chance to react via the optional
 * `SourceRenameHandler.onSourceRenamed()` hook (e.g. the local-folder destination renaming its
 * own per-source subfolder). Same best-effort contract as `suggestSourceName`: a plugin with
 * nothing to do, or one whose hook throws, is treated identically — `undefined`, never surfaced —
 * since the rename itself (already persisted by the caller before this ever runs) is never rolled
 * back or blocked on this succeeding. The caller uses a returned `locationRewrite` (see
 * `SourceRenameHandler`'s own doc comment) to keep `InvoiceHistoryRecord.location` in sync —
 * `notifySourceRenamed` itself has no invoice-history access, it only ever hands that function
 * back up.
 */
export async function notifySourceRenamed(
  deps: NotifySourceRenamedDeps,
  destinationPluginId: string,
  record: PluginDestinationRecord,
  oldSourceName: string,
  newSourceName: string,
  signal: AbortSignal,
): Promise<{ locationRewrite?: (oldLocation: string) => string } | undefined> {
  const plugin = deps.registry.get(destinationPluginId) as DestinationPlugin | undefined;
  if (!plugin?.onSourceRenamed) return undefined;

  const ctx: PluginContext = {
    ...deps.createPluginServices(destinationPluginId),
    sessions: deps.sessionsApiForPlugin(destinationPluginId),
  };

  try {
    return await plugin.onSourceRenamed(ctx, record, oldSourceName, newSourceName, signal);
  } catch {
    // Best-effort — see doc comment above.
    return undefined;
  }
}
