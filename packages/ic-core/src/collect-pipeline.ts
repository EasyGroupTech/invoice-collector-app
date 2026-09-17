import type {
  DiscoveredInvoice,
  InvoiceContent,
  PluginContext,
  PluginDestinationRecord,
  PluginSourceRecord,
  SessionsApi,
  UploadResult,
} from 'invoice-collector-plugin-sdk';
import type { ProgressReporter } from './job-runner.js';
import type { PluginRegistry } from './plugin-registry.js';
import { appendDiscoveredScope } from './scope-format.js';

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
    result: UploadResult,
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
  /** Called when a source's own `ScopeDescriber.describeCollectionScope()` result changes what
   * `scope` should read (`scope-format.ts`'s `appendDiscoveredScope`) — the caller persists it
   * the same way `onDestinationCutoffLowered` does for a destination. */
  onSourceScopeDiscovered?: (source: PluginSourceRecord) => Promise<void>;
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

/** `yyyy-mm` when the period is a single calendar month (the common case — the Collect page's
 * own month/year picker always produces one of these); a plain date range otherwise, since a
 * multi-month period has no single `yyyy-mm` that would honestly describe it. */
function periodLabel(period: CollectPeriod): string {
  const startMonth = period.start.slice(0, 7);
  const endMonth = period.end.slice(0, 7);
  return startMonth === endMonth ? startMonth : `${period.start} to ${period.end}`;
}

/**
 * `DiscoveredInvoice.name` is fixed at discover() time, before fetchContent() has run — for a
 * plugin with no real invoice-number field (e.g. the Stripe-backed browser-session providers),
 * that's only ever an opaque id-like composite key (e.g. "2026-08-30T21:47:12Z:10265"), never the
 * actual document name. `InvoiceContent.fileName` is often far more recognizable (a provider's own
 * Content-Disposition-suggested filename), but only becomes known after fetchContent() succeeds —
 * so it's preferred here, once available, for anything that displays the invoice afterward
 * (history record, the final per-invoice report line), matching the reference app's own
 * displayName() convention (browserSessionUpload.ts).
 */
function bestDisplayName(discovered: DiscoveredInvoice, content: InvoiceContent): string {
  return content.fileName.replace(/\.pdf$/i, '') || discovered.name || discovered.id;
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
      // The renderer's own progress log only ever fills in from report() calls (§14.1) — without
      // one here, a source whose discover()/fetchContent() genuinely takes a while (a real network
      // call, or a browser-session provider's own PDF download escalating to a real hidden-browser
      // navigation, §9.1) shows nothing at all until its first invoice finishes end to end, which
      // reads as "stuck" rather than "working." Matches the reference app's own upload.ts, which
      // reported this before doing anything else per source.
      report({ message: `${source.name} started`, sourceId: source.id });

      if (sourcePlugin.describeCollectionScope) {
        try {
          const labels = await sourcePlugin.describeCollectionScope(sourceCtx, source, signal);
          const nextScope = appendDiscoveredScope(source.scope, labels);
          if (nextScope !== (source.scope ?? '')) {
            await deps.onSourceScopeDiscovered?.({ ...source, scope: nextScope, updatedAt: new Date().toISOString() });
          }
        } catch (err) {
          // Best-effort, same contract as the SDK's own ScopeDescriber doc comment — a failed
          // scope lookup (a permissions edge case, a transient network blip) never blocks the
          // actual collection below; scope simply keeps whatever it already had.
          sourceCtx.log.warn(`${source.name}: couldn't refresh scope`, { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Drained fully before any per-invoice work starts — a deliberate change from the previous
      // fully-streaming loop (discover() is still consumed lazily by the plugin, only core's own
      // consumption here changed), needed so "discovered N for <period>" can report a real total
      // instead of a number that would otherwise only be known after the fact. Trades away
      // per-invoice progress being visible *during* a slow multi-scope discover() (Azure Billing/
      // AWS iterating several accounts) for a count the user explicitly asked to see up front.
      const discoveredAll: DiscoveredInvoice[] = [];
      try {
        for await (const discovered of sourcePlugin.discover(sourceCtx, source, selection.period, signal)) {
          if (signal.aborted) throw new Error(CANCELLED_MESSAGE);
          discoveredAll.push(discovered);
        }
      } catch (err) {
        if (signal.aborted || errorMessage(err) === CANCELLED_MESSAGE) throw err;
        report({ message: `${source.name}: ${errorMessage(err)}`, sourceId: source.id });
        continue;
      }

      const total = discoveredAll.length;
      report({ message: `${source.name}: discovered ${total} for ${periodLabel(selection.period)}`, sourceId: source.id });

      const errors: string[] = [];

      for (let i = 0; i < discoveredAll.length; i++) {
        if (signal.aborted) throw new Error(CANCELLED_MESSAGE);
        const discovered = discoveredAll[i];
        const position = i + 1;
        const discoveredLabel = discovered.name ?? discovered.id;

        const alreadyHave = await deps.dedup.has(source.id, discovered.id);
        if (alreadyHave) {
          outcomes.push({
            sourceId: source.id,
            destinationId,
            invoiceId: discovered.id,
            issuedDate: discovered.issuedDate,
            status: 'skipped-dedup',
          });
          // "Not all events shown" (a real, reported gap) — this branch used to report nothing at
          // all, silently dropping every already-collected invoice out of the log entirely.
          report({ message: `${source.name}: skipping ${position} of ${total} "${discoveredLabel}" — already collected`, sourceId: source.id });
          continue;
        }

        try {
          report({ message: `${source.name}: downloading ${position} of ${total} "${discoveredLabel}"`, sourceId: source.id });
          const content = await sourcePlugin.fetchContent(sourceCtx, source, discovered, signal);
          // Its own ctx, scoped to destination.pluginId — not sourceCtx. A destination plugin's
          // sessions/storage must never be attributed to the source plugin that happened to
          // discover this particular invoice (§6's cross-plugin scoping cares about exactly
          // this: createdByPluginId has to be the plugin that actually created a session).
          const destinationCtx = buildContext(deps, destination.pluginId, report, source.id);
          const displayName = bestDisplayName(discovered, content);
          report({ message: `${source.name}: uploading ${position} of ${total} "${displayName}"`, sourceId: source.id });
          const uploadResult = await destinationPlugin.upload(
            destinationCtx,
            destination,
            { ...discovered, ...content, sourceName: source.name },
            signal,
          );
          await deps.dedup.record(source.id, destinationId, { ...discovered, name: displayName }, uploadResult);
          outcomes.push({
            sourceId: source.id,
            destinationId,
            invoiceId: discovered.id,
            issuedDate: discovered.issuedDate,
            status: uploadResult.status,
          });
          // Tagged so the renderer can refresh the collected-invoices table live, per invoice,
          // instead of only once the whole run finishes.
          report({ message: `${source.name}: ${uploadResult.status} "${displayName}"`, sourceId: source.id, data: { kind: 'uploaded' } });
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
          errors.push(`"${discoveredLabel}": ${message}`);
          report({ message: `${source.name}: error on ${position} of ${total} "${discoveredLabel}" — ${message}`, sourceId: source.id });
        }
      }

      report({ message: `${source.name} finished`, sourceId: source.id });
      if (errors.length > 0) {
        report({ message: `${source.name}: ${errors.length} error(s) while processing — ${errors.join('; ')}`, sourceId: source.id });
      }
    }
  }

  return { outcomes };
}
