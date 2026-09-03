import type {
  DiscoveredInvoice,
  PluginContext,
  PluginDestinationRecord,
  PluginSourceRecord,
  SessionsApi,
  UploadResult,
} from 'invoice-collector-plugin-sdk';
import type { ProgressReporter } from './job-runner.js';
import type { PluginRegistry } from './plugin-registry.js';

export interface CollectPeriod {
  start: string;
  end: string;
}

export interface CollectSelection {
  sourceIds: 'all' | string[];
  period: CollectPeriod;
}

/**
 * The actual persisted dedup database (invoice history) is phase 1.10 — injected here rather
 * than built, the same dependency-injection boundary sessions-registry.ts (1.6) used for
 * ctx.http/storage/log/progress before HttpApi (1.7) existed.
 */
export interface DedupChecker {
  has(sourceId: string, invoiceId: string): Promise<boolean>;
  record(
    sourceId: string,
    destinationId: string,
    invoice: DiscoveredInvoice,
    status: UploadResult['status'],
  ): Promise<void>;
}

export type CollectItemStatus = UploadResult['status'] | 'skipped-dedup' | 'error';

export interface CollectItemOutcome {
  sourceId: string;
  destinationId: string;
  invoiceId: string;
  issuedDate: string;
  status: CollectItemStatus;
  error?: string;
}

export interface CollectRunResult {
  outcomes: CollectItemOutcome[];
}

export interface CollectPipelineDeps {
  registry: PluginRegistry;
  dedup: DedupChecker;
  /** Everything a PluginContext needs besides `sessions` — same injection point
   * sessions-registry.ts uses; real implementations land in 1.7/1.11. */
  createPluginServices: (pluginId: string) => Omit<PluginContext, 'sessions'>;
  sessionsApiForPlugin: (pluginId: string) => SessionsApi;
  /** Called when a destination's collectFromDate is lowered by an explicit backfill request
   * (§14.1 US11) — the caller persists it (config-store.ts's upsertRecord + saveConfigFile). */
  onDestinationCutoffLowered?: (destination: PluginDestinationRecord) => Promise<void>;
}

const CANCELLED_MESSAGE = 'Collect run was cancelled';

function buildContext(
  deps: CollectPipelineDeps,
  pluginId: string,
  report: ProgressReporter,
  correlationSourceId: string,
): PluginContext {
  const services = deps.createPluginServices(pluginId);
  return {
    ...services,
    sessions: deps.sessionsApiForPlugin(pluginId),
    // The run's own live report(), not whatever generic progress sink createPluginServices
    // provides — so a plugin's own ctx.progress.report() calls (e.g. "found 5 invoices") reach
    // the same place this pipeline's own report() calls already do (the same reasoning
    // sessions-registry.ts's onProgress threading applies to SessionPlugin.create()).
    progress: { report: (message, data) => report({ message, sourceId: correlationSourceId, data }) },
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * §14's Collect flow: discover() → per-item dedup check → fetchContent() → upload(), grouped by
 * destination so each destination's collectFromDate guardrail (US11) is checked once per group,
 * not once per source. A whole source failing (discover() itself throwing) is logged and skipped,
 * matching the reference app's "log and continue" pattern — only cancellation propagates and
 * aborts the whole run.
 */
export async function runCollectPipeline(
  sources: PluginSourceRecord[],
  destinations: PluginDestinationRecord[],
  selection: CollectSelection,
  deps: CollectPipelineDeps,
  report: ProgressReporter,
  signal: AbortSignal,
): Promise<CollectRunResult> {
  const selected = selection.sourceIds === 'all' ? sources : sources.filter((s) => selection.sourceIds.includes(s.id));

  const byDestination = new Map<string, PluginSourceRecord[]>();
  for (const source of selected) {
    if (!source.destinationId) {
      report({ message: `${source.name}: no destination assigned, skipping`, sourceId: source.id });
      continue;
    }
    const group = byDestination.get(source.destinationId) ?? [];
    group.push(source);
    byDestination.set(source.destinationId, group);
  }

  const outcomes: CollectItemOutcome[] = [];

  for (const [destinationId, groupSources] of byDestination) {
    if (signal.aborted) throw new Error(CANCELLED_MESSAGE);

    let destination = destinations.find((d) => d.id === destinationId);
    if (!destination) {
      report({ message: `Destination ${destinationId} no longer exists, skipping its sources` });
      continue;
    }

    const destinationPlugin = deps.registry.get(destination.pluginId);
    if (!destinationPlugin || !('upload' in destinationPlugin)) {
      report({ message: `${destination.name}: plugin ${destination.pluginId} not installed, skipping` });
      continue;
    }

    if (destination.collectFromDate && selection.period.start < destination.collectFromDate) {
      const lowered: PluginDestinationRecord = {
        ...destination,
        collectFromDate: selection.period.start,
        updatedAt: new Date().toISOString(),
      };
      report({ message: `${destination.name}: lowering backfill cutoff to ${selection.period.start} to include the requested period` });
      await deps.onDestinationCutoffLowered?.(lowered);
      destination = lowered;
    }

    for (const source of groupSources) {
      if (signal.aborted) throw new Error(CANCELLED_MESSAGE);

      const sourcePlugin = deps.registry.get(source.pluginId);
      if (!sourcePlugin || !('discover' in sourcePlugin)) {
        report({ message: `${source.name}: plugin ${source.pluginId} not installed, skipping`, sourceId: source.id });
        continue;
      }

      const sourceCtx = buildContext(deps, source.pluginId, report, source.id);

      try {
        for await (const discovered of sourcePlugin.discover(sourceCtx, source, selection.period, signal)) {
          if (signal.aborted) throw new Error(CANCELLED_MESSAGE);

          const alreadyHave = await deps.dedup.has(source.id, discovered.id);
          if (alreadyHave) {
            outcomes.push({
              sourceId: source.id,
              destinationId,
              invoiceId: discovered.id,
              issuedDate: discovered.issuedDate,
              status: 'skipped-dedup',
            });
            continue;
          }

          try {
            const content = await sourcePlugin.fetchContent(sourceCtx, source, discovered, signal);
            // Its own ctx, scoped to destination.pluginId — not sourceCtx. A destination plugin's
            // sessions/storage must never be attributed to the source plugin that happened to
            // discover this particular invoice (§6's cross-plugin scoping cares about exactly
            // this: createdByPluginId has to be the plugin that actually created a session).
            const destinationCtx = buildContext(deps, destination.pluginId, report, source.id);
            const uploadResult = await destinationPlugin.upload(destinationCtx, destination, { ...discovered, ...content }, signal);
            await deps.dedup.record(source.id, destinationId, discovered, uploadResult.status);
            outcomes.push({
              sourceId: source.id,
              destinationId,
              invoiceId: discovered.id,
              issuedDate: discovered.issuedDate,
              status: uploadResult.status,
            });
            report({ message: `${source.name}: ${uploadResult.status} ${discovered.id}`, sourceId: source.id });
          } catch (err) {
            if (signal.aborted) throw err;
            const message = errorMessage(err);
            outcomes.push({
              sourceId: source.id,
              destinationId,
              invoiceId: discovered.id,
              issuedDate: discovered.issuedDate,
              status: 'error',
              error: message,
            });
            report({ message: `${source.name}: FAILED ${discovered.id}: ${message}`, sourceId: source.id });
          }
        }
      } catch (err) {
        if (signal.aborted || errorMessage(err) === CANCELLED_MESSAGE) throw err;
        report({ message: `${source.name}: FAILED: ${errorMessage(err)}`, sourceId: source.id });
      }
    }
  }

  return { outcomes };
}
