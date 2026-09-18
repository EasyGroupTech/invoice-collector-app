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
    manifest: { id: 'ic-email-to-downloads', name: 'Mail', kind: 'source', main: 'i.js' },
    sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [], collects: 'test', connectHow: 'test', connectInstructions: 'test' }],
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
    manifest: { id: 'ic-local-downloads', name: 'Local Downloads', kind: 'destination', main: 'i.js' },
    sessionRequirements: [{ sessionTypeId: 'microsoft-entra-delegated-device-code', confirmsBuiltIn: true, requiredScopesOrRoles: [], collects: 'test', connectHow: 'test', connectInstructions: 'test' }],
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
    appStorage: { get: vi.fn(), set: vi.fn(), delete: vi.fn() },
    http: { request: vi.fn() },
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    progress: { report: vi.fn() },
    pdf: { extractText: vi.fn() },
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
    registry.register(sourcePlugin, 'test-package');
    registry.register(destinationPlugin, 'test-package');

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

  it('routes a source plugin\'s ctx.progress.report() calls to the run\'s own report()', async () => {
    const invoice: DiscoveredInvoice = { id: 'inv-1', issuedDate: '2026-01-15' };
    const registry = createPluginRegistry();
    registry.register(
      fakeSourcePlugin([], {
        discover: async function* (ctx: PluginContext) {
          ctx.progress.report('scanning mailbox', { found: 1 });
          yield invoice;
        },
      }),
      'test-package',
    );
    registry.register(fakeDestinationPlugin(), 'test-package');
    const messages: Array<{ message: string; data?: unknown }> = [];

    await runCollectPipeline(
      [record()],
      [destinationRecord()],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      (update) => messages.push({ message: update.message, data: update.data }),
      new AbortController().signal,
    );

    expect(messages).toContainEqual({ message: 'scanning mailbox', data: { found: 1 } });
  });

  it('gives the destination plugin its own ctx scoped to its own pluginId, not the source\'s', async () => {
    const invoice: DiscoveredInvoice = { id: 'inv-1', issuedDate: '2026-01-15' };
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin([invoice]), 'test-package');
    let uploadCtx: PluginContext | undefined;
    registry.register(
      fakeDestinationPlugin({
        upload: vi.fn(async (ctx: PluginContext) => {
          uploadCtx = ctx;
          return { status: 'uploaded' as const };
        }),
      }),
      'test-package',
    );
    const servicesByPluginId = new Map<string, Omit<PluginContext, 'sessions'>>();
    const createPluginServicesSpy = vi.fn((pluginId: string) => {
      const services = pluginServices();
      servicesByPluginId.set(pluginId, services);
      return services;
    });

    await runCollectPipeline(
      [record()], // pluginId: 'ic-email-to-downloads'
      [destinationRecord()], // pluginId: 'ic-local-downloads'
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup: fakeDedup(), createPluginServices: createPluginServicesSpy, sessionsApiForPlugin: fakeSessionsApi },
      noopReport,
      new AbortController().signal,
    );

    expect(createPluginServicesSpy).toHaveBeenCalledWith('ic-local-downloads');
    expect(uploadCtx?.storage).toBe(servicesByPluginId.get('ic-local-downloads')?.storage);
    expect(uploadCtx?.storage).not.toBe(servicesByPluginId.get('ic-email-to-downloads')?.storage);
  });

  it('skips fetchContent/upload for an invoice the dedup checker already has, but still reports it (not silently dropped)', async () => {
    const invoice: DiscoveredInvoice = { id: 'inv-1', name: 'Invoice #1', issuedDate: '2026-01-15' };
    const registry = createPluginRegistry();
    const sourcePlugin = fakeSourcePlugin([invoice]);
    const destinationPlugin = fakeDestinationPlugin();
    registry.register(sourcePlugin, 'test-package');
    registry.register(destinationPlugin, 'test-package');
    const dedup = fakeDedup({ has: vi.fn(async () => true) });
    const messages: string[] = [];

    const result = await runCollectPipeline(
      [record()],
      [destinationRecord()],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      (update) => messages.push(update.message),
      new AbortController().signal,
    );

    expect(result.outcomes).toEqual([{ sourceId: 'source-1', destinationId: 'dest-1', invoiceId: 'inv-1', issuedDate: '2026-01-15', status: 'skipped-dedup' }]);
    expect(sourcePlugin.fetchContent).not.toHaveBeenCalled();
    expect(destinationPlugin.upload).not.toHaveBeenCalled();
    expect(messages).toEqual([
      'Mailbox started',
      'Mailbox: discovered 1 for 2026-01',
      'Mailbox: skipping 1 of 1 "Invoice #1" — already collected',
      'Mailbox finished',
    ]);
  });

  it('records a successful upload in the dedup checker', async () => {
    const invoice: DiscoveredInvoice = { id: 'inv-1', issuedDate: '2026-01-15' };
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin([invoice]), 'test-package');
    registry.register(fakeDestinationPlugin(), 'test-package');
    const dedup = fakeDedup();

    await runCollectPipeline(
      [record()],
      [destinationRecord()],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      noopReport,
      new AbortController().signal,
    );

    expect(dedup.record).toHaveBeenCalledWith('source-1', 'dest-1', { ...invoice, name: 'a' }, { status: 'uploaded' });
  });

  it('prefers the fetched content\'s own filename over an opaque discover()-time name once fetchContent resolves it', async () => {
    // A Stripe-backed browser-session provider commonly has no invoice-number field at discover()
    // time, only an id-like composite key — the real, recognizable name only becomes known once
    // fetchContent() reads it off the provider's own Content-Disposition header. That nicer name
    // should win for both the history record and the final report line, not the composite key.
    const invoice: DiscoveredInvoice = { id: '1749945600:4250', name: '1749945600:4250', issuedDate: '2026-01-15' };
    const registry = createPluginRegistry();
    registry.register(
      fakeSourcePlugin([invoice], {
        fetchContent: vi.fn(async () => ({ fileName: 'Invoice-ABC-0037.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1]) })),
      }),
      'test-package',
    );
    registry.register(fakeDestinationPlugin(), 'test-package');
    const dedup = fakeDedup();
    const messages: string[] = [];

    await runCollectPipeline(
      [record()],
      [destinationRecord()],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup, createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      (update) => messages.push(update.message),
      new AbortController().signal,
    );

    expect(dedup.record).toHaveBeenCalledWith('source-1', 'dest-1', { ...invoice, name: 'Invoice-ABC-0037' }, { status: 'uploaded' });
    expect(messages).toEqual([
      'Mailbox started',
      'Mailbox: discovered 1 for 2026-01',
      'Mailbox: downloading 1 of 1 "1749945600:4250"',
      'Mailbox: uploading 1 of 1 "Invoice-ABC-0037"',
      'Mailbox: uploaded "Invoice-ABC-0037"',
      'Mailbox finished',
    ]);
  });

  it('records a per-invoice error outcome when fetchContent throws, without recording it in dedup', async () => {
    const invoice: DiscoveredInvoice = { id: 'inv-1', issuedDate: '2026-01-15' };
    const registry = createPluginRegistry();
    const sourcePlugin = fakeSourcePlugin([invoice], {
      fetchContent: vi.fn(async () => {
        throw new Error('network error');
      }),
    });
    registry.register(sourcePlugin, 'test-package');
    registry.register(fakeDestinationPlugin(), 'test-package');
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
      manifest: { id: 'failing-plugin', name: 'x', kind: 'source', main: 'm' },
      // eslint-disable-next-line require-yield -- intentionally throws before ever yielding
      discover: async function* (): AsyncGenerator<DiscoveredInvoice> {
        throw new Error('auth expired');
      },
    });
    const workingInvoice: DiscoveredInvoice = { id: 'inv-2', issuedDate: '2026-01-10' };
    const workingSource = fakeSourcePlugin([workingInvoice], {
      manifest: { id: 'working-plugin', name: 'x', kind: 'source', main: 'm' },
    });
    registry.register(failingSource, 'test-package');
    registry.register(workingSource, 'test-package');
    registry.register(fakeDestinationPlugin(), 'test-package');

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
    registry.register(fakeSourcePlugin([]), 'test-package');
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
    registry.register(fakeSourcePlugin([{ id: 'inv-1', issuedDate: '2026-01-15' }]), 'test-package');
    registry.register(fakeDestinationPlugin(), 'test-package');

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
    registry.register(fakeSourcePlugin([]), 'test-package');
    registry.register(fakeDestinationPlugin(), 'test-package');
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
    registry.register(fakeSourcePlugin([]), 'test-package');
    registry.register(fakeDestinationPlugin(), 'test-package');
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
    registry.register(sourcePlugin, 'test-package');
    registry.register(fakeDestinationPlugin(), 'test-package');

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

  it('reports "Started X" up front and "downloading"/"uploading" before each slow step — not just the final outcome (phase 1.19)', async () => {
    const invoice: DiscoveredInvoice = { id: 'inv-1', name: 'Invoice #1', issuedDate: '2026-01-15' };
    const registry = createPluginRegistry();
    registry.register(
      fakeSourcePlugin([invoice], {
        fetchContent: vi.fn(async () => ({ fileName: 'Invoice #1.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1]) })),
      }),
      'test-package',
    );
    registry.register(fakeDestinationPlugin(), 'test-package');
    const messages: string[] = [];

    await runCollectPipeline(
      [record()],
      [destinationRecord()],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      (update) => messages.push(update.message),
      new AbortController().signal,
    );

    expect(messages).toEqual([
      'Mailbox started',
      'Mailbox: discovered 1 for 2026-01',
      'Mailbox: downloading 1 of 1 "Invoice #1"',
      'Mailbox: uploading 1 of 1 "Invoice #1"',
      'Mailbox: uploaded "Invoice #1"',
      'Mailbox finished',
    ]);
  });

  it('reports "X started"/"discovered 0"/"X finished" even for a source that discovers nothing at all — still visible feedback, not silence', async () => {
    const registry = createPluginRegistry();
    registry.register(fakeSourcePlugin([]), 'test-package');
    registry.register(fakeDestinationPlugin(), 'test-package');
    const messages: string[] = [];

    await runCollectPipeline(
      [record()],
      [destinationRecord()],
      { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
      { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
      (update) => messages.push(update.message),
      new AbortController().signal,
    );

    expect(messages).toEqual(['Mailbox started', 'Mailbox: discovered 0 for 2026-01', 'Mailbox finished']);
  });

  it('skips a source whose plugin is not installed, reporting why', async () => {
    const registry = createPluginRegistry();
    registry.register(fakeDestinationPlugin(), 'test-package');
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

  describe('ScopeDescriber (§14.1 — scope = user prefix + discovered accounts)', () => {
    it("calls describeCollectionScope and persists the appended scope via onSourceScopeDiscovered, before discover() itself runs", async () => {
      const registry = createPluginRegistry();
      const callOrder: string[] = [];
      registry.register(
        fakeSourcePlugin([], {
          describeCollectionScope: vi.fn(async () => {
            callOrder.push('describeCollectionScope');
            return ['acct-1', 'acct-2'];
          }),
          // eslint-disable-next-line require-yield -- intentionally discovers nothing, only records call order
          discover: async function* () {
            callOrder.push('discover');
          },
        }),
        'test-package',
      );
      registry.register(fakeDestinationPlugin(), 'test-package');
      const onSourceScopeDiscovered = vi.fn(async () => {});

      await runCollectPipeline(
        [record({ scope: 'Finance' })],
        [destinationRecord()],
        { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
        { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi, onSourceScopeDiscovered },
        noopReport,
        new AbortController().signal,
      );

      expect(callOrder).toEqual(['describeCollectionScope', 'discover']);
      expect(onSourceScopeDiscovered).toHaveBeenCalledWith(expect.objectContaining({ id: 'source-1', scope: 'Finance · acct-1, acct-2' }));
    });

    it('does not call onSourceScopeDiscovered when the computed scope is unchanged', async () => {
      const registry = createPluginRegistry();
      registry.register(fakeSourcePlugin([], { describeCollectionScope: vi.fn(async () => ['acct-1']) }), 'test-package');
      registry.register(fakeDestinationPlugin(), 'test-package');
      const onSourceScopeDiscovered = vi.fn(async () => {});

      await runCollectPipeline(
        [record({ scope: 'Finance · acct-1' })],
        [destinationRecord()],
        { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
        { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi, onSourceScopeDiscovered },
        noopReport,
        new AbortController().signal,
      );

      expect(onSourceScopeDiscovered).not.toHaveBeenCalled();
    });

    it('never calls onSourceScopeDiscovered for a plugin with no ScopeDescriber at all', async () => {
      const registry = createPluginRegistry();
      registry.register(fakeSourcePlugin([]), 'test-package');
      registry.register(fakeDestinationPlugin(), 'test-package');
      const onSourceScopeDiscovered = vi.fn(async () => {});

      await runCollectPipeline(
        [record()],
        [destinationRecord()],
        { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
        { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi, onSourceScopeDiscovered },
        noopReport,
        new AbortController().signal,
      );

      expect(onSourceScopeDiscovered).not.toHaveBeenCalled();
    });

    it('still runs discover() normally when describeCollectionScope itself throws — best-effort, never blocks the actual collection', async () => {
      const invoice: DiscoveredInvoice = { id: 'inv-1', issuedDate: '2026-01-15' };
      const registry = createPluginRegistry();
      registry.register(
        fakeSourcePlugin([invoice], {
          describeCollectionScope: vi.fn(async () => {
            throw new Error('permission denied');
          }),
        }),
        'test-package',
      );
      registry.register(fakeDestinationPlugin(), 'test-package');

      const result = await runCollectPipeline(
        [record()],
        [destinationRecord()],
        { sourceIds: 'all', period: { start: '2026-01-01', end: '2026-01-31' } },
        { registry, dedup: fakeDedup(), createPluginServices: pluginServices, sessionsApiForPlugin: fakeSessionsApi },
        noopReport,
        new AbortController().signal,
      );

      expect(result.outcomes).toEqual([{ sourceId: 'source-1', destinationId: 'dest-1', invoiceId: 'inv-1', issuedDate: '2026-01-15', status: 'uploaded' }]);
    });
  });
});
