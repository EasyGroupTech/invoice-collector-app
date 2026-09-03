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

function buildContext(deps: CollectPipelineDeps, pluginId: string): PluginContext {
  return { ...deps.createPluginServices(pluginId), sessions: deps.sessionsApiForPlugin(pluginId) };
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

      const ctx = buildContext(deps, source.pluginId);

      try {
        for await (const discovered of sourcePlugin.discover(ctx, source, selection.period, signal)) {
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
            const content = await sourcePlugin.fetchContent(ctx, source, discovered, signal);
            const uploadResult = await destinationPlugin.upload(ctx, destination, { ...discovered, ...content }, signal);
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
