import type {
  DestinationPlugin,
  DiscoveredInvoice,
  PluginContext,
  PluginDestinationRecord,
  PluginSourceRecord,
  SessionsApi,
  SourcePlugin,
  UploadResult,
} from 'invoice-collector-plugin-sdk';
import { describe, expect, it, vi } from 'vitest';
import { runCollectPipeline, type CollectItemOutcome, type DedupChecker } from './collect-pipeline.js';
import { createPluginRegistry } from './plugin-registry.js';

function record(overrides: Partial<PluginSourceRecord> = {}): PluginSourceRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: 'source-1',
    name: 'Mailbox',
    pluginId: 'ic-email-to-downloads',
    pluginVersion: '1.0.0',
    destinationId: 'dest-1',
    config: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function destinationRecord(overrides: Partial<PluginDestinationRecord> = {}): PluginDestinationRecord {
  const now = '2026-01-01T00:00:00.000Z';
  return {
    id: 'dest-1',
    name: 'Downloads',
    pluginId: 'ic-local-downloads',
    pluginVersion: '1.0.0',
    config: {},
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function fakeSourcePlugin(invoices: DiscoveredInvoice[], overrides: Partial<SourcePlugin> = {}): SourcePlugin {
  return {
    manifest: { id: 'ic-email-to-downloads', name: 'Mail', version: '1.0.0', pluginApiVersion: '^1.0.0', kind: 'source', sbom: 's.json', main: 'i.js' },
    sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [] }],
    wizard: [],
    discover: async function* () {
      for (const inv of invoices) yield inv;
    },
    fetchContent: vi.fn(async () => ({ fileName: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1]) })),
    ...overrides,
  };
}

function fakeDestinationPlugin(overrides: Partial<DestinationPlugin> = {}): DestinationPlugin {
  return {
    manifest: { id: 'ic-local-downloads', name: 'Local Downloads', version: '1.0.0', pluginApiVersion: '^1.0.0', kind: 'destination', sbom: 's.json', main: 'i.js' },
    sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [] }],
    wizard: [],
    upload: vi.fn(async (): Promise<UploadResult> => ({ status: 'uploaded' })),
    ...overrides,
  };
}

function fakeDedup(overrides: Partial<DedupChecker> = {}): DedupChecker {
  return {
    has: vi.fn(async () => false),
    record: vi.fn(async () => {}),
    ...overrides,
  };
}

function pluginServices(): Omit<PluginContext, 'sessions'> {
  return {
    storage: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    http: { request: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    progress: { report: vi.fn() },
  };
}

function fakeSessionsApi(): SessionsApi {
  return { list: vi.fn(async () => []), get: vi.fn(async () => undefined), create: vi.fn(), reconnect: vi.fn() } as unknown as SessionsApi;
}

const noopReport = () => {};

describe('runCollectPipeline', () => {
  it('discovers, fetches, and uploads a new invoice end-to-end', async () => {
    const invoice: DiscoveredInvoice = { id: 'inv-1', issuedDate: '2026-01-15' };
    const registry = createPluginRegistry();
    const sourcePlugin = fakeSourcePlugin([invoice]);
    const destinationPlugin = fakeDestinationPlugin();
    registry.register(sourcePlugin);
    registry.register(destinationPlugin);

    const result = await runCollectPipeline(
      [record()],
      [destinationRecord()],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      noopReport,
      new AbortController().signal,
    );

    expect(result.outcomes).toEqual([{ sourceId: 'source-1', destinationId: 'dest-1', invoiceId: 'inv-1', issuedDate: '2026-01-15', status: 'uploaded' }]);
    expect(sourcePlugin.fetchContent).toHaveBeenCalled();
    expect(destinationPlugin.upload).toHaveBeenCalled();
  });

  it('skips fetchContent/upload for an invoice the dedup checker already has', async () => {
    const invoice: DiscoveredInvoice = { id: 'inv-1', issuedDate: '2026-01-15' };
    const registry = createPluginRegistry();
    const sourcePlugin = fakeSourcePlugin([invoice]);
    const destinationPlugin = fakeDestinationPlugin();
    registry.register(sourcePlugin);
    registry.register(destinationPlugin);
    const dedup = fakeDedup({ has: vi.fn(async () => true) });

    const result = await runCollectPipeline(
      [record()],
      [destinationRecord()],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      noopReport,
      new AbortController().signal,
    );

    expect(result.outcomes).toEqual([{ sourceId: 'source-1', destinationId: 'dest-1', invoiceId: 'inv-1', issuedDate: '2026-01-15', status: 'skipped-dedup' }]);
    expect(sourcePlugin.fetchContent).not.toHaveBeenCalled();
    expect(destinationPlugin.upload).not.toHaveBeenCalled();
  });

  it('records a successful upload in the dedup checker', async () => {
    const invoice: DiscoveredInvoice = { id: 'inv-1', issuedDate: '2026-01-15' };
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin([invoice]));
    registry.register(fakeDestinationPlugin());
    const dedup = fakeDedup();

    await runCollectPipeline(
      [record()],
      [destinationRecord()],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      noopReport,
      new AbortController().signal,
    );

    expect(dedup.record).toHaveBeenCalledWith('source-1', invoice, 'uploaded');
  });

  it('records a per-invoice error outcome when fetchContent throws, without recording it in dedup', async () => {
    const invoice: DiscoveredInvoice = { id: 'inv-1', issuedDate: '2026-01-15' };
    const registry = createPluginRegistry();
    const sourcePlugin = fakeSourcePlugin([invoice], {
      fetchContent: vi.fn(async () => {
        throw new Error('network error');
      }),
    });
    registry.register(sourcePlugin);
    registry.register(fakeDestinationPlugin());
    const dedup = fakeDedup();

    const result = await runCollectPipeline(
      [record()],
      [destinationRecord()],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      noopReport,
      new AbortController().signal,
    );

    expect(result.outcomes).toEqual([
      { sourceId: 'source-1', destinationId: 'dest-1', invoiceId: 'inv-1', issuedDate: '2026-01-15', status: 'error', error: 'network error' },
    ]);
    expect(dedup.record).not.toHaveBeenCalled();
  });

  it('continues to the next source when one source\'s discover() throws entirely', async () => {
    const registry = createPluginRegistry();
    const failingSource = fakeSourcePlugin([], {
      manifest: { id: 'failing-plugin', name: 'x', version: '1.0.0', pluginApiVersion: '^1.0.0', kind: 'source', sbom: 's', main: 'm' },
      // eslint-disable-next-line require-yield -- intentionally throws before ever yielding
      discover: async function* (): AsyncGenerator<DiscoveredInvoice> {
        throw new Error('auth expired');
      },
    });
    const workingInvoice: DiscoveredInvoice = { id: 'inv-2', issuedDate: '2026-01-10' };
    const workingSource = fakeSourcePlugin([workingInvoice], {
      manifest: { id: 'working-plugin', name: 'x', version: '1.0.0', pluginApiVersion: '^1.0.0', kind: 'source', sbom: 's', main: 'm' },
    });
    registry.register(failingSource);
    registry.register(workingSource);
    registry.register(fakeDestinationPlugin());

    const messages: string[] = [];
    const result = await runCollectPipeline(
      [record({ id: 'source-a', pluginId: 'failing-plugin' }), record({ id: 'source-b', pluginId: 'working-plugin' })],
      [destinationRecord()],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      (update) => messages.push(update.message),
      new AbortController().signal,
    );

    expect(result.outcomes.map((o: CollectItemOutcome) => o.invoiceId)).toEqual(['inv-2']);
    expect(messages.some((m) => m.includes('auth expired'))).toBe(true);
  });

  it('skips a source with no destination assigned, reporting why', async () => {
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin([]));
    const messages: string[] = [];

    const result = await runCollectPipeline(
      [record({ destinationId: null })],
      [],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      (update) => messages.push(update.message),
      new AbortController().signal,
    );

    expect(result.outcomes).toEqual([]);
    expect(messages.some((m) => m.includes('no destination assigned'))).toBe(true);
  });

  it('filters sources by sourceIds when not "all"', async () => {
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin([{ id: 'inv-1', issuedDate: '2026-01-15' }]));
    registry.register(fakeDestinationPlugin());

    const result = await runCollectPipeline(
      [record({ id: 'source-a' }), record({ id: 'source-b' })],
      [destinationRecord()],
      { sourceIds: ['source-a'], period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      noopReport,
      new AbortController().signal,
    );

    expect(result.outcomes.every((o: CollectItemOutcome) => o.sourceId === 'source-a')).toBe(true);
  });

  it('lowers a destination\'s collectFromDate when the requested period starts earlier, and persists it', async () => {
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin([]));
    registry.register(fakeDestinationPlugin());
    const onDestinationCutoffLowered = vi.fn(async () => {});

    await runCollectPipeline(
      [record()],
      [destinationRecord({ collectFromDate: '2026-03-01' })],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi, onDestinationCutoffLowered },
      noopReport,
      new AbortController().signal,
    );

    expect(onDestinationCutoffLowered).toHaveBeenCalledWith(expect.objectContaining({ id: 'dest-1', collectFromDate: '2026-01-01' }));
  });

  it('does not lower collectFromDate when the requested period starts on/after it', async () => {
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin([]));
    registry.register(fakeDestinationPlugin());
    const onDestinationCutoffLowered = vi.fn(async () => {});

    await runCollectPipeline(
      [record()],
      [destinationRecord({ collectFromDate: '2026-01-01' })],
      { sourceIds: 'all', period: { start: '2026-01-15', end: '2026-01-31' } },
      { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi, onDestinationCutoffLowered },
      noopReport,
      new AbortController().signal,
    );

    expect(onDestinationCutoffLowered).not.toHaveBeenCalled();
  });

  it('respects cancellation, throwing rather than continuing to the next source', async () => {
    const registry = createPluginRegistry();
    const controller = new AbortController();
    const sourcePlugin = fakeSourcePlugin([{ id: 'inv-1', issuedDate: '2026-01-15' }], {
      fetchContent: vi.fn(async () => {
        controller.abort();
        return { fileName: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() };
      }),
    });
    registry.register(sourcePlugin);
    registry.register(fakeDestinationPlugin());

    await expect(
      runCollectPipeline(
        [record({ id: 'source-a' }), record({ id: 'source-b' })],
        [destinationRecord()],
        { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
        { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
        noopReport,
        controller.signal,
      ),
    ).rejects.toThrow(/cancel/i);
  });

  it('skips a source whose plugin is not installed, reporting why', async () => {
    const registry = createPluginRegistry();
    registry.register(fakeDestinationPlugin());
    const messages: string[] = [];

    const result = await runCollectPipeline(
      [record({ pluginId: 'not-installed' })],
      [destinationRecord()],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      (update) => messages.push(update.message),
      new AbortController().signal,
    );

    expect(result.outcomes).toEqual([]);
    expect(messages.some((m) => m.includes('not installed'))).toBe(true);
  });
});
