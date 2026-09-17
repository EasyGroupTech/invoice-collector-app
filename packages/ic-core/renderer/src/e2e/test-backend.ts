import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { DestinationPlugin, PluginContext, SourcePlugin } from 'invoice-collector-plugin-sdk';
import {
  createRecord,
  loadConfigFile,
  removeRecord,
  saveConfigFile,
  sweepOrphans,
  upsertRecord,
  type CreateRecordInput as ConfigCreateRecordInput,
} from '../../../src/config-store.js';
import { createCollectJobGuard } from '../../../src/collect-job-guard.js';
import { runCollectPipeline } from '../../../src/collect-pipeline.js';
import type { Encryptor } from '../../../src/encryptor.js';
import { createHttpApi } from '../../../src/http-client.js';
import { createInvoiceHistory } from '../../../src/invoice-history.js';
import { createJobRunner } from '../../../src/job-runner.js';
import { profilePaths } from '../../../src/paths.js';
import { createPluginLog } from '../../../src/plugin-log.js';
import { createPluginRegistry } from '../../../src/plugin-registry.js';
import { createPluginStorage } from '../../../src/plugin-storage.js';
import { resolveSessionCreateInput } from '../../../src/session-create-input.js';
import { suggestSessionLabel } from '../../../src/session-label-suggest.js';
import { createSessionsRegistry } from '../../../src/sessions-registry.js';
import { suggestSourceName } from '../../../src/source-name-suggest.js';
import { suggestWizardValues } from '../../../src/wizard-value-suggest.js';

/**
 * §10's "no real connection in any test, including E2E" rule, enforced structurally rather than
 * just by convention — any code path that reaches for the real network (a fake plugin calling
 * `ctx.http`, or `installPlugin`'s own attestation/license checks if a test forgets to pass its
 * own `fetchImpl`) fails loudly with this, instead of silently reaching a real endpoint.
 */
async function forbiddenFetch(): Promise<Response> {
  throw new Error('E2E test backend: a real network call was attempted — every plugin/install path in these tests must be fully faked.');
}

// A trivial reversible fake — round-trip correctness is what these tests care about, not any
// specific cipher (same fixture sessions-registry.test.ts already uses; the real safeStorage-
// backed implementation only exists in the real Electron main process, not testable outside it).
const testEncryptor: Encryptor = {
  isAvailable: () => true,
  encrypt: (plaintext) => Buffer.from(plaintext, 'utf-8'),
  decrypt: (ciphertext) => ciphertext.toString('utf-8'),
};

export interface TestBackend {
  /** `window.api`-shaped — pass to a rendered page/dialog exactly like the real preload bridge. */
  api: Window['api'];
  registry: ReturnType<typeof createPluginRegistry>;
  sessionsRegistry: ReturnType<typeof createSessionsRegistry>;
  registerSourcePlugin(plugin: SourcePlugin, packageId?: string): void;
  registerDestinationPlugin(plugin: DestinationPlugin, packageId?: string): void;
  /** A real, writable temp directory — for a test that needs to call `installPlugin()` itself
   * directly (with its own test-specific `fetchImpl`/`importModule`), rather than through `api`. */
  pluginsDir: string;
  trustAckFilePath: string;
  cleanup(): Promise<void>;
}

/**
 * §10's E2E design: "mock at ipcMain" — every method below calls the exact same real `src/*`
 * modules `electron/main/index.ts`'s own handlers call (config-store, sessions-registry,
 * collect-pipeline, plugin-registry, job-runner, ...), against a real temp profile directory, so
 * a rendered page's actual behavior is under test, not a canned response. The only things
 * genuinely faked are what a real Electron process alone can provide (a native dialog, OS
 * keychain encryption) or a real external network call — neither of which any of this phase's
 * target scenarios (install flow, Collect flow, Sessions/Plugins sections, trust-tier warning)
 * touches. A method with no real caller in this suite yet throws a clear "not implemented" error
 * rather than a silent wrong answer, so a test that grows to need it fails loudly, not quietly.
 */
export async function createTestBackend(): Promise<TestBackend> {
  const tmpDir = await mkdtemp(path.join(tmpdir(), 'ic-e2e-'));
  const paths = profilePaths(tmpDir);

  const registry = createPluginRegistry();
  const jobRunner = createJobRunner();
  const collectGuard = createCollectJobGuard(jobRunner);
  const invoiceHistory = createInvoiceHistory(paths.invoiceHistoryFile);

  function createPluginServices(pluginId: string): Omit<PluginContext, 'sessions'> {
    return {
      storage: createPluginStorage(paths.pluginStorageFile(pluginId)),
      appStorage: createPluginStorage(paths.pluginStorageFile(`${pluginId}.app`)),
      http: createHttpApi(pluginId, { sessionsRegistry: sessionAuthResolver, fetchImpl: forbiddenFetch }),
      log: createPluginLog(path.join(tmpDir, 'app.log'), pluginId),
      progress: { report: () => {} },
    };
  }

  const sessionsRegistry = createSessionsRegistry({
    filePath: paths.sessionsFile,
    encryptor: testEncryptor,
    createPluginServices,
  });

  const sessionAuthResolver = {
    attachAuth: (pluginId: string, sessionId: string, request: Parameters<typeof sessionsRegistry.attachAuth>[2]) =>
      sessionsRegistry.attachAuth(pluginId, sessionId, request),
    recoverSession: (pluginId: string, sessionId: string) => sessionsRegistry.recoverSession(pluginId, sessionId),
  };

  function registerSourcePlugin(plugin: SourcePlugin, packageId = plugin.manifest.id): void {
    registry.registerPackage(
      { id: packageId, name: plugin.manifest.name, version: '1.0.0', pluginApiVersion: '*', sbom: 'sbom.cdx.json', implementations: [plugin.manifest] },
      undefined,
    );
    registry.register(plugin, packageId);
    if (plugin.sessionPlugin) sessionsRegistry.registerSessionPlugin(plugin.sessionPlugin);
  }

  function registerDestinationPlugin(plugin: DestinationPlugin, packageId = plugin.manifest.id): void {
    registry.registerPackage(
      { id: packageId, name: plugin.manifest.name, version: '1.0.0', pluginApiVersion: '*', sbom: 'sbom.cdx.json', implementations: [plugin.manifest] },
      undefined,
    );
    registry.register(plugin, packageId);
    if (plugin.sessionPlugin) sessionsRegistry.registerSessionPlugin(plugin.sessionPlugin);
  }

  async function currentConfigFilePath(): Promise<string> {
    return paths.configFile;
  }

  const jobDoneListeners = new Set<(event: unknown) => void>();
  const jobProgressListeners = new Set<(event: unknown) => void>();
  jobRunner.onDone((event) => jobDoneListeners.forEach((l) => l(event)));
  jobRunner.onProgress((event) => jobProgressListeners.forEach((l) => l(event)));

  function notImplemented(name: string) {
    return () => {
      throw new Error(`E2E test backend: "${name}" is not implemented — this suite's scenarios don't need it yet.`);
    };
  }

  const api: Window['api'] = {
    configListSources: async () => (await loadConfigFile(await currentConfigFilePath())).sources,
    configListDestinations: async () => (await loadConfigFile(await currentConfigFilePath())).destinations,
    configCreateRecord: async (input) => {
      const filePath = await currentConfigFilePath();
      const store = await loadConfigFile(filePath);
      const recordInput: ConfigCreateRecordInput = {
        name: input.name,
        pluginId: input.pluginId,
        pluginVersion: input.pluginVersion,
        config: input.config,
        destinationId: input.destinationId,
        sessionId: input.sessionId,
        scope: input.scope,
      };
      const record = createRecord(recordInput);
      const key = input.kind === 'source' ? 'sources' : 'destinations';
      await saveConfigFile(filePath, { ...store, [key]: upsertRecord(store[key], record) });
      return record;
    },
    configRemoveRecord: async (input) => {
      const filePath = await currentConfigFilePath();
      const store = await loadConfigFile(filePath);
      const key = input.kind === 'source' ? 'sources' : 'destinations';
      await saveConfigFile(filePath, { ...store, [key]: removeRecord(store[key], input.id) });
    },
    flowsDelete: notImplemented('flowsDelete'),
    flowsUpdate: notImplemented('flowsUpdate'),
    flowsSweepOrphans: async () => {
      const filePath = await currentConfigFilePath();
      const store = await loadConfigFile(filePath);
      const allSessionIds = (await sessionsRegistry.listAll()).map((s) => s.id);
      const result = sweepOrphans(store, allSessionIds);
      await saveConfigFile(filePath, { ...store, destinations: result.destinations });
      for (const sessionId of result.orphanedSessionIds) await sessionsRegistry.removeSession(sessionId);
    },
    configAssignSession: async (input) => {
      const filePath = await currentConfigFilePath();
      const store = await loadConfigFile(filePath);
      const key = input.kind === 'source' ? 'sources' : 'destinations';
      const existing = store[key].find((r) => r.id === input.id);
      if (!existing) throw new Error(`${input.kind} ${input.id} not found`);
      const updated = { ...existing, sessionId: input.sessionId, updatedAt: new Date().toISOString() };
      await saveConfigFile(filePath, { ...store, [key]: upsertRecord(store[key], updated) });
      return updated;
    },
    configExportAll: notImplemented('configExportAll'),
    configPickImportFile: notImplemented('configPickImportFile'),
    configImportAll: notImplemented('configImportAll'),

    profilesList: async () => [],
    profilesSwitch: notImplemented('profilesSwitch'),
    profilesCreate: notImplemented('profilesCreate'),
    profilesDelete: notImplemented('profilesDelete'),

    sessionsList: () => sessionsRegistry.listAll(),
    sessionsCreate: (input) => {
      const handle = jobRunner.runJob('session-create', async (report, signal) => {
        const plugin = registry.get(input.pluginId);
        if (!plugin) throw new Error(`Plugin "${input.pluginId}" is not installed`);
        const resolvedInput = resolveSessionCreateInput(plugin as SourcePlugin | DestinationPlugin, input.sessionTypeId, input.input);
        return sessionsRegistry.forPlugin(input.pluginId).create(input.sessionTypeId, resolvedInput, signal, (message, data) => report({ message, data }));
      });
      return Promise.resolve(handle);
    },
    sessionsReconnect: (input) =>
      Promise.resolve(
        jobRunner.runJob('session-reconnect', async (report, signal) =>
          sessionsRegistry.forPlugin(input.pluginId).reconnect(input.sessionId, signal, (message, data) => report({ message, data })),
        ),
      ),
    sessionsRefresh: (input) => sessionsRegistry.recoverSession(input.pluginId, input.sessionId),
    sessionsLogout: (sessionId) => sessionsRegistry.logoutSession(sessionId),
    sessionsRotate: (input) =>
      Promise.resolve(
        jobRunner.runJob('session-rotate', async (report, signal) =>
          sessionsRegistry.forPlugin(input.pluginId).rotate(input.sessionId, input.input, signal, (message, data) => report({ message, data })),
        ),
      ),
    sessionsSuggestLabel: async (input) => {
      const stored = await sessionsRegistry.forPlugin(input.pluginId).get(input.sessionId);
      if (!stored) return undefined;
      return suggestSessionLabel(
        { registry, createPluginServices, sessionsApiForPlugin: (pluginId) => sessionsRegistry.forPlugin(pluginId) },
        input.pluginId,
        stored.session,
        new AbortController().signal,
      );
    },
    sessionsRename: (input) => sessionsRegistry.renameSession(input.pluginId, input.sessionId, input.label),

    pluginsList: () =>
      Promise.resolve(
        registry.listPackages().flatMap((packageManifest) =>
          packageManifest.implementations
            .map((implementationManifest) => registry.get(implementationManifest.id))
            .filter((loaded): loaded is NonNullable<typeof loaded> => loaded !== undefined)
            .map((loaded) => ({
              manifest: loaded.manifest,
              packageId: packageManifest.id,
              packageVersion: packageManifest.version,
              sessionRequirements: loaded.sessionRequirements,
              wizard: loaded.wizard,
              settingsPanel: loaded.settingsPanel,
            })),
        ),
      ),
    pluginsListPackages: () =>
      Promise.resolve(registry.listPackages().map((manifest) => ({ manifest, enabled: registry.isPackageEnabled(manifest.id) }))),
    pluginsInstall: notImplemented('pluginsInstall — pass fetchImpl/importModule explicitly per test instead'),
    pluginsActivate: notImplemented('pluginsActivate'),
    pluginsUninstall: notImplemented('pluginsUninstall'),
    pluginsDisable: (packageId) => {
      registry.setPackageEnabled(packageId, false);
      return Promise.resolve();
    },
    pluginsEnable: (packageId) => {
      registry.setPackageEnabled(packageId, true);
      return Promise.resolve();
    },
    pluginsDownloadAsset: notImplemented('pluginsDownloadAsset'),
    pluginsCheckForUpdates: async () => ({}),

    wizardResolveListData: notImplemented('wizardResolveListData'),
    wizardSuggestValues: async (input) => {
      const stored = await sessionsRegistry.forPlugin(input.pluginId).get(input.sessionId);
      if (!stored) return undefined;
      return suggestWizardValues(
        { registry, createPluginServices, sessionsApiForPlugin: (pluginId) => sessionsRegistry.forPlugin(pluginId) },
        input.pluginId,
        stored.session,
        new AbortController().signal,
      );
    },
    wizardSuggestSourceName: async (input) => {
      const stored = await sessionsRegistry.forPlugin(input.pluginId).get(input.sessionId);
      if (!stored) return undefined;
      return suggestSourceName(
        { registry, createPluginServices, sessionsApiForPlugin: (pluginId) => sessionsRegistry.forPlugin(pluginId) },
        input.pluginId,
        stored.session,
        input.configValues,
        new AbortController().signal,
      );
    },

    collectRun: async (input) => {
      const filePath = await currentConfigFilePath();
      const store = await loadConfigFile(filePath);
      return collectGuard.startCollect(async (report, signal) => {
        const result = await runCollectPipeline(
          store.sources,
          store.destinations,
          input,
          {
            registry,
            dedup: {
              has: (sourceId, invoiceId) => invoiceHistory.has(sourceId, invoiceId),
              record: (sourceId, destinationId, invoice, status) => invoiceHistory.record(sourceId, destinationId, invoice, status),
            },
            createPluginServices,
            sessionsApiForPlugin: (pluginId) => sessionsRegistry.forPlugin(pluginId),
            onDestinationCutoffLowered: async (destination) => {
              const current = await loadConfigFile(filePath);
              await saveConfigFile(filePath, { ...current, destinations: upsertRecord(current.destinations, destination) });
            },
            onSourceScopeDiscovered: async (source) => {
              const current = await loadConfigFile(filePath);
              await saveConfigFile(filePath, { ...current, sources: upsertRecord(current.sources, source) });
            },
          },
          report,
          signal,
        );
        await invoiceHistory.prune();
        return result;
      });
    },
    jobsCancel: (jobId) => {
      jobRunner.cancelJob(jobId);
      return Promise.resolve();
    },

    historyListForMonth: (issuedMonth) => invoiceHistory.listForMonth(issuedMonth),
    historyGetRetentionMonths: () => invoiceHistory.getRetentionMonths(),
    historySetRetentionMonths: (months) => invoiceHistory.setRetentionMonths(months),
    historyClearAll: () => invoiceHistory.clear(),

    sbomList: async () => [],
    sbomExport: notImplemented('sbomExport'),

    reportExport: notImplemented('reportExport'),
    reportExportRows: notImplemented('reportExportRows'),

    settingsGetAdvanced: notImplemented('settingsGetAdvanced'),
    settingsSaveAdvanced: notImplemented('settingsSaveAdvanced'),

    logsRead: notImplemented('logsRead'),
    logsDownload: notImplemented('logsDownload'),

    auditLogList: async () => [],
    auditLogClear: notImplemented('auditLogClear'),

    openExternal: () => Promise.resolve(),

    onJobProgress: (callback) => {
      jobProgressListeners.add(callback as (event: unknown) => void);
      return () => jobProgressListeners.delete(callback as (event: unknown) => void);
    },
    onJobDone: (callback) => {
      jobDoneListeners.add(callback as (event: unknown) => void);
      return () => jobDoneListeners.delete(callback as (event: unknown) => void);
    },
  };

  return {
    api,
    registry,
    sessionsRegistry,
    registerSourcePlugin,
    registerDestinationPlugin,
    pluginsDir: path.join(tmpDir, 'plugins'),
    trustAckFilePath: paths.trustAckFile,
    cleanup: async () => {
      sessionsRegistry.stopScheduler();
      await rm(tmpDir, { recursive: true, force: true });
    },
  };
}
