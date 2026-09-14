import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain, shell, type IpcMainInvokeEvent } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { microsoftEntraDelegatedDeviceCodeSessionPlugin } from 'invoice-collector-plugin-sdk';
import { defaultAdvancedSettings, loadAdvancedSettings, saveAdvancedSettings, type AdvancedSettings } from '../../src/advanced-settings.js';
import { logAppEvent, logCollectionEvent, readLogTail, sanitizeIpcArgsForLog } from '../../src/app-log.js';
import { createCollectJobGuard } from '../../src/collect-job-guard.js';
import { runCollectPipeline } from '../../src/collect-pipeline.js';
import { decryptConfigExport, encryptConfigExport, type EncryptedConfigExportFile } from '../../src/config-export-crypto.js';
import { applyConfigImport, buildConfigExport, type ConfigExportFile } from '../../src/config-export.js';
import {
  createRecord,
  deleteFlow,
  loadConfigFile,
  removeRecord,
  saveConfigFile,
  upsertRecord,
  type CreateRecordInput as ConfigCreateRecordInput,
} from '../../src/config-store.js';
import { createHttpApi, type SessionAuthResolver } from '../../src/http-client.js';
import { installPlugin, reloadInstalledPlugins, uninstallPlugin } from '../../src/plugin-install.js';
import { renderHtmlToPdf } from './htmlToPdf.js';
import { createInvoiceHistory } from '../../src/invoice-history.js';
import { createJobRunner } from '../../src/job-runner.js';
import { advancedSettingsFile, appLogFile, pluginsDir, profilePaths } from '../../src/paths.js';
import { createPluginLog } from '../../src/plugin-log.js';
import { createPluginRegistry } from '../../src/plugin-registry.js';
import { createPackageWideStorage, createPluginStorage } from '../../src/plugin-storage.js';
import { createProfileManager } from '../../src/profiles.js';
import { buildExcelReport, buildHtmlReport, buildReportRows } from '../../src/reporting.js';
import { loadSboms, type SbomSource } from '../../src/sbom-registry.js';
import { resolveSessionCreateInput } from '../../src/session-create-input.js';
import { suggestSessionLabel } from '../../src/session-label-suggest.js';
import { createSessionsRegistry, type SessionsRegistry } from '../../src/sessions-registry.js';
import { resolveWizardListData } from '../../src/wizard-data.js';
import { suggestWizardValues } from '../../src/wizard-value-suggest.js';
import { safeStorageEncryptor } from './safeStorageEncryptor.js';
import {
  Channels,
  type ActivatePluginInput,
  type AssignSessionInput,
  type CreateRecordInput,
  type CreateSessionInput,
  type ExportInvoiceRowsInput,
  type ExportReportInput,
  type InstallPluginInput,
  type ProfileCreateInput,
  type ReconnectSessionInput,
  type RemoveRecordInput,
  type RenameSessionInput,
  type ResolveWizardListDataInput,
  type RunCollectInput,
  type SuggestSessionLabelInput,
  type SuggestWizardValuesInput,
  type UpdateFlowInput,
} from '../shared/ipcContracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dist/main -> ic-core's own package root is two levels up. Correct in dev; revisit once phase
// 1.17's electron-builder config decides where a packaged build's resources actually live.
const IC_CORE_SBOM_PATH = path.join(__dirname, '../../sbom.cdx.json');
// Resolved via real Node module resolution rather than a relative path from __dirname — robust
// to however the SDK ends up laid out in node_modules (a workspace symlink today; still correct
// once it's a real published dependency later), unlike IC_CORE_SBOM_PATH above.
// `require`, not `import.meta.resolve`: this file is bundled to CJS output (electron.vite.config.ts's
// format: 'cjs') — `import.meta.resolve` has no CJS equivalent and esbuild silently compiles it to
// `(void 0).resolve`, a real, confirmed-live failure (not a hypothetical), while `require` is a
// genuine working global in CJS output, further confirmed by externalizeDepsPlugin() already
// compiling this package's own `import ... from 'invoice-collector-plugin-sdk'` to a real require().
const SDK_SBOM_PATH = path.join(path.dirname(require.resolve('invoice-collector-plugin-sdk/package.json')), 'sbom.cdx.json');

// §0 item 3: invoice-collector-plugin-sdk isn't published yet, so there's no real released
// version to compare a plugin's pluginApiVersion range against — every package here is still
// 0.0.0 pre-release. Revisit once the SDK has an actual first published version.
const CORE_SDK_VERSION = '0.0.0';

// Distinct identity for unpackaged runs (electron:dev) so userData and safeStorage/keychain never
// collide with a packaged install — must run before any app.getPath()/safeStorage call, so before
// app.whenReady(). "Invoice Collector App Dev", not "Invoice Collector Dev" — the latter is the
// private predecessor repo's own dev identity; sharing it would mean two unrelated codebases
// reading/writing the same userData dir and safeStorage keychain entry, an active data-corruption
// risk if both are ever run at once (confirmed live: the predecessor's dev instance was still
// running while this was being built). The packaged dev build variant gets its own identity via
// electron-builder config instead (phase 1.17, not built yet), since app.isPackaged is true for
// any packaged build regardless of channel.
if (!app.isPackaged) {
  app.setName('Invoice Collector App Dev');
}

let mainWindow: BrowserWindow | null = null;

// One continuous operational log, not per-profile (paths.ts's own appLogFile is base-dir-scoped) —
// the same file plugin-log.ts's createPluginLog already appends "[pluginId]"-tagged lines to.
const APP_LOG_FILE = appLogFile(app.getPath('userData'));

// Wraps every ipcMain.handle(channel, listener) registered AFTER this call (so it must run before
// any of them below) to log the channel name, sanitized arguments, and success/failure — ported
// from the reference app's own installIpcAuditLogging, a single interception point that gives an
// audit trail of every action the user took without instrumenting each handler individually.
function installIpcAuditLogging(): void {
  const originalHandle = ipcMain.handle.bind(ipcMain);
  ipcMain.handle = ((channel: string, listener: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => {
    return originalHandle(channel, async (event, ...args: unknown[]) => {
      void logAppEvent(APP_LOG_FILE, `${channel} ${JSON.stringify(sanitizeIpcArgsForLog(channel, args))}`);
      try {
        return await listener(event, ...args);
      } catch (err) {
        void logAppEvent(APP_LOG_FILE, `${channel} FAILED: ${err instanceof Error ? err.message : String(err)}`);
        throw err;
      }
    });
  }) as typeof ipcMain.handle;
}
installIpcAuditLogging();

const profileManager = createProfileManager(app.getPath('userData'));
const pluginRegistry = createPluginRegistry();
const jobRunner = createJobRunner();
const collectGuard = createCollectJobGuard(jobRunner);

// sessionsRegistry/invoiceHistory are tied to a fixed filePath at construction (profiles.ts's own
// "resolve baseDir once, at construction" pattern doesn't fit here directly since *which* profile
// is active can change at runtime, via profiles:switch) — rebuilt on every switch. sessionAuthResolver
// is created once and always delegates to whatever sessionsRegistry currently is, so
// createHttpApi() (built once per plugin call, not tied to a specific registry instance) keeps
// working across a rebuild without needing to know one happened.
let sessionsRegistry: SessionsRegistry;
let invoiceHistory: ReturnType<typeof createInvoiceHistory>;

// Not per-profile (paths.ts's advancedSettingsFile is base-dir-scoped) — loaded once at boot,
// re-read live by createHttpApi's retryPolicy callback below rather than baked in at construction,
// so a save from the Advanced Settings page takes effect on the very next request (§7).
let currentAdvancedSettings: AdvancedSettings = defaultAdvancedSettings();

const sessionAuthResolver: SessionAuthResolver = {
  attachAuth: (pluginId, sessionId, request) => sessionsRegistry.attachAuth(pluginId, sessionId, request),
  recoverSession: (pluginId, sessionId) => sessionsRegistry.recoverSession(pluginId, sessionId),
};

function createPluginServices(pluginId: string) {
  const paths = profilePaths(profileManager.getActiveProfileDir());
  const log = createPluginLog(appLogFile(app.getPath('userData')), pluginId);
  return {
    storage: createPluginStorage(paths.pluginStorageFile(pluginId)),
    http: createHttpApi(pluginId, { sessionsRegistry: sessionAuthResolver, retryPolicy: () => currentAdvancedSettings.retryPolicy }),
    installUrl: pluginRegistry.getInstallUrl(pluginId),
    log,
    // Default sink for a ctx.progress.report() call with no live job listening (e.g. the
    // scheduler's own background refresh) — recorded, not dropped silently.
    progress: { report: (message: string, data?: Record<string, unknown>) => log.info(message, data) },
  };
}

function rebuildProfileScopedServices(): void {
  sessionsRegistry?.stopScheduler();
  const paths = profilePaths(profileManager.getActiveProfileDir());

  sessionsRegistry = createSessionsRegistry({
    filePath: paths.sessionsFile,
    encryptor: safeStorageEncryptor,
    createPluginServices,
  });
  sessionsRegistry.registerSessionPlugin(microsoftEntraDelegatedDeviceCodeSessionPlugin);
  // A fresh SessionsRegistry starts with an empty custom-sessionPlugin map of its own — every
  // plugin already loaded into pluginRegistry (whether from this same boot's reloadInstalledPlugins()
  // call below, or installed earlier in this same running process) needs its own sessionPlugin, if
  // any, re-registered here too, or SessionsApi.create() for it would silently break the next time
  // a profile switch (ProfilesSwitch, §16) rebuilds this registry — the plugin *code* isn't
  // profile-scoped and never gets reloaded on a switch, only this registry is.
  for (const plugin of pluginRegistry.list()) {
    if (plugin.sessionPlugin) {
      sessionsRegistry.registerSessionPlugin(plugin.sessionPlugin);
    }
  }
  void sessionsRegistry.startScheduler();

  invoiceHistory = createInvoiceHistory(paths.invoiceHistoryFile);
}

async function currentConfigFilePath(): Promise<string> {
  return profilePaths(profileManager.getActiveProfileDir()).configFile;
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Dev convenience: renderer console output (and any error the placeholder's own try/catch
  // reports) lands in the same terminal as the main process, instead of only in devtools.
  mainWindow.webContents.on('console-message', (event) => {
    console.log(`[renderer:${event.level}] ${event.message}`);
  });

  // A job (collect run, session sign-in, ...) can be mid-flight when the user tries to close the
  // window — closing then would abandon it silently rather than cancelling it cleanly, so confirm
  // first instead of just letting it happen.
  mainWindow.on('close', (event) => {
    if (!jobRunner.hasActiveJobs()) return;
    const choice = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      buttons: ['Cancel', 'Quit Anyway'],
      defaultId: 0,
      cancelId: 0,
      message: 'A job is still running',
      detail: 'Closing now will abandon it. Quit anyway?',
    });
    if (choice === 0) event.preventDefault();
  });
}

jobRunner.onProgress((event) => mainWindow?.webContents.send(Channels.JobProgress, event));
jobRunner.onProgress((event) => void logCollectionEvent(APP_LOG_FILE, event.message));
jobRunner.onDone((event) => mainWindow?.webContents.send(Channels.JobDone, event));

// --- Config ---

ipcMain.handle(Channels.ConfigListSources, async () => (await loadConfigFile(await currentConfigFilePath())).sources);
ipcMain.handle(Channels.ConfigListDestinations, async () => (await loadConfigFile(await currentConfigFilePath())).destinations);

ipcMain.handle(Channels.ConfigCreateRecord, async (_event, input: CreateRecordInput) => {
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
});

ipcMain.handle(Channels.ConfigRemoveRecord, async (_event, input: RemoveRecordInput) => {
  const filePath = await currentConfigFilePath();
  const store = await loadConfigFile(filePath);
  const key = input.kind === 'source' ? 'sources' : 'destinations';
  await saveConfigFile(filePath, { ...store, [key]: removeRecord(store[key], input.id) });
});

// §14.1's "collection flow" concept: deletes the flow's own source, cascading to its destination
// (if nothing else still uses it) and to each one's own session (if nothing — source or
// destination — still references it), same reasoning deleteFlow() itself already documents.
ipcMain.handle(Channels.FlowsDelete, async (_event, sourceId: string) => {
  const filePath = await currentConfigFilePath();
  const store = await loadConfigFile(filePath);
  const result = deleteFlow(store, sourceId);
  await saveConfigFile(filePath, { ...store, sources: result.sources, destinations: result.destinations });
  for (const sessionId of result.orphanedSessionIds) {
    await sessionsRegistry.removeSession(sessionId);
  }
});

ipcMain.handle(Channels.FlowsUpdate, async (_event, input: UpdateFlowInput) => {
  const filePath = await currentConfigFilePath();
  const store = await loadConfigFile(filePath);
  const existing = store.sources.find((s) => s.id === input.sourceId);
  if (!existing) throw new Error(`Flow ${input.sourceId} not found`);
  const updated = {
    ...existing,
    name: input.name,
    scope: input.scope,
    config: input.config,
    destinationId: input.destinationId,
    updatedAt: new Date().toISOString(),
  };
  await saveConfigFile(filePath, { ...store, sources: upsertRecord(store.sources, updated) });
  return updated;
});

ipcMain.handle(Channels.ConfigAssignSession, async (_event, input: AssignSessionInput) => {
  const filePath = await currentConfigFilePath();
  const store = await loadConfigFile(filePath);
  const key = input.kind === 'source' ? 'sources' : 'destinations';
  const existing = store[key].find((r) => r.id === input.id);
  if (!existing) throw new Error(`${input.kind} ${input.id} not found`);
  const updated = { ...existing, sessionId: input.sessionId, updatedAt: new Date().toISOString() };
  await saveConfigFile(filePath, { ...store, [key]: upsertRecord(store[key], updated) });
  return updated;
});

// Save-dialog + write, same pattern as SbomExport/ReportExport below — the encrypted payload
// itself is produced first regardless of whether the user actually picks a destination, since
// there's no point prompting for a password only to then also cancel a save dialog.
ipcMain.handle(Channels.ConfigExportAll, async (_event, password: string) => {
  const store = await loadConfigFile(await currentConfigFilePath());
  const encrypted = encryptConfigExport(buildConfigExport(store), password);

  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: `invoice-collector-config-${new Date().toISOString().slice(0, 10)}.json`,
    filters: [{ name: 'Invoice Collector configuration', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { exported: false };

  await writeFile(result.filePath, JSON.stringify(encrypted), 'utf-8');
  return { exported: true, filePath: result.filePath };
});

// Split from ConfigImportAll so the renderer can let the user pick the file first, then ask for
// its passphrase — matching the reference app's own two-step flow, rather than prompting for a
// password before the user has even chosen a file.
ipcMain.handle(Channels.ConfigPickImportFile, async () => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [{ name: 'Invoice Collector configuration', extensions: ['json'] }],
  });
  if (result.canceled || result.filePaths.length === 0) return undefined;

  const raw = await readFile(result.filePaths[0], 'utf-8');
  return JSON.parse(raw) as EncryptedConfigExportFile;
});

ipcMain.handle(Channels.ConfigImportAll, async (_event, file: EncryptedConfigExportFile, password: string) => {
  const filePath = await currentConfigFilePath();
  const store = await loadConfigFile(filePath);
  const payload = decryptConfigExport<ConfigExportFile>(file, password);
  const result = applyConfigImport(store, payload);
  await saveConfigFile(filePath, result.store);
  return { importedSources: result.importedSources, importedDestinations: result.importedDestinations };
});

// --- Profiles ---

ipcMain.handle(Channels.ProfilesList, () => profileManager.list());
ipcMain.handle(Channels.ProfilesSwitch, async (_event, profileId: string) => {
  await profileManager.switchActive(profileId);
  rebuildProfileScopedServices();
});
ipcMain.handle(Channels.ProfilesCreate, (_event, input: ProfileCreateInput) => profileManager.create(input.name, input.copyFromCurrent));
ipcMain.handle(Channels.ProfilesDelete, (_event, profileId: string) => profileManager.remove(profileId));

// --- Sessions ---

ipcMain.handle(Channels.SessionsList, () => sessionsRegistry.listAll());

ipcMain.handle(Channels.SessionsCreate, (_event, input: CreateSessionInput) => {
  return jobRunner.runJob('session-create', async (report, signal) => {
    const plugin = pluginRegistry.get(input.pluginId);
    if (!plugin) throw new Error(`Plugin "${input.pluginId}" is not installed`);
    const resolvedInput = resolveSessionCreateInput(plugin, input.sessionTypeId, input.input);
    return sessionsRegistry
      .forPlugin(input.pluginId)
      .create(input.sessionTypeId, resolvedInput, signal, (message, data) => report({ message, data }));
  });
});

ipcMain.handle(Channels.SessionsReconnect, (_event, input: ReconnectSessionInput) => {
  return jobRunner.runJob('session-reconnect', async (report, signal) =>
    sessionsRegistry
      .forPlugin(input.pluginId)
      .reconnect(input.sessionId, signal, (message, data) => report({ message, data })),
  );
});

// Silent-only — no job/progress wrapping, unlike SessionsReconnect: recoverSession() never falls
// back to an interactive sign-in, so there's nothing for a progress dialog to ever show.
ipcMain.handle(Channels.SessionsRefresh, (_event, input: ReconnectSessionInput) =>
  sessionsRegistry.recoverSession(input.pluginId, input.sessionId),
);

// A user-facing Logout only clears stored credentials — it doesn't delete the session record
// (FlowsDelete's own cascade is the only thing that does that, once nothing references it).
ipcMain.handle(Channels.SessionsLogout, (_event, sessionId: string) => sessionsRegistry.logoutSession(sessionId));

ipcMain.handle(Channels.SessionsSuggestLabel, async (_event, input: SuggestSessionLabelInput) => {
  const stored = await sessionsRegistry.forPlugin(input.pluginId).get(input.sessionId);
  if (!stored) return undefined;
  return suggestSessionLabel(
    { registry: pluginRegistry, createPluginServices, sessionsApiForPlugin: (pluginId) => sessionsRegistry.forPlugin(pluginId) },
    input.pluginId,
    stored.session,
    new AbortController().signal,
  );
});

ipcMain.handle(Channels.WizardSuggestValues, async (_event, input: SuggestWizardValuesInput) => {
  const stored = await sessionsRegistry.forPlugin(input.pluginId).get(input.sessionId);
  if (!stored) return undefined;
  return suggestWizardValues(
    { registry: pluginRegistry, createPluginServices, sessionsApiForPlugin: (pluginId) => sessionsRegistry.forPlugin(pluginId) },
    input.pluginId,
    stored.session,
    new AbortController().signal,
  );
});

ipcMain.handle(Channels.SessionsRename, (_event, input: RenameSessionInput) =>
  sessionsRegistry.renameSession(input.pluginId, input.sessionId, input.label),
);

// --- Plugins ---
// Enable/disable isn't built (docs/implementation-plan.md's phase 1.11/1.12 notes) — only
// install/uninstall are, below. reloadInstalledPlugins() (app.whenReady(), above) repopulates
// pluginRegistry from whatever's already on disk at every boot, not just after a fresh install.

// One row per *implementation* (§9.4 — see InstalledPluginSummary's own doc comment), for the
// Add-Source/Destination wizard. Settings' own Plugins management card reads PluginsListPackages
// instead, below.
ipcMain.handle(Channels.PluginsList, () =>
  pluginRegistry.listPackages().flatMap((packageManifest) =>
    packageManifest.implementations.map((implementationManifest) => {
      const loaded = pluginRegistry.get(implementationManifest.id)!;
      return {
        manifest: loaded.manifest,
        packageId: packageManifest.id,
        packageVersion: packageManifest.version,
        sessionRequirements: loaded.sessionRequirements,
        wizard: loaded.wizard,
        settingsPanel: loaded.settingsPanel,
      };
    }),
  ),
);

ipcMain.handle(Channels.PluginsListPackages, () => pluginRegistry.listPackages());

ipcMain.handle(Channels.PluginsInstall, (_event, input: InstallPluginInput) =>
  installPlugin(input.rawInput, {
    pluginsDir: pluginsDir(app.getPath('userData')),
    coreSdkVersion: CORE_SDK_VERSION,
    trustAckFilePath: profilePaths(profileManager.getActiveProfileDir()).trustAckFile,
    registry: pluginRegistry,
    sessionsRegistry,
    confirmUnverified: input.confirmUnverified,
  }),
);

// §9.1/§15's one-time, package-scoped activation step — fired once, right after PluginsInstall
// returns an activationRequirement, never again per source/destination. pluginId here is the
// *implementation* id installPlugin() picked (the first bundled implementation that declared
// activationRequirement), matching plugin-install.ts's own PluginInstallResult.activationRequirement.
// `storage` is fanned out (plugin-storage.ts's createPackageWideStorage) across every sibling
// implementation the same package bundles — a real gap found live (Claude API failing "hasn't
// been activated yet" right after Claude Team's own activation succeeded): ctx.storage is
// otherwise scoped per *implementation* id, so a package bundling more than one (Claude Team +
// Claude API/Console) only ever actually activated the single implementation core happened to run
// activate() against, leaving every sibling permanently stuck unactivated with no way for the user
// to fix it (activation isn't a repeatable per-record step). A single-implementation package's own
// fan-out is just itself — no behavior change, no storage-path migration for anyone.
ipcMain.handle(Channels.PluginsActivate, async (_event, input: ActivatePluginInput) => {
  const plugin = pluginRegistry.get(input.pluginId);
  if (!plugin?.activationRequirement) {
    throw new Error(`Plugin ${input.pluginId} has no activation requirement`);
  }
  const paths = profilePaths(profileManager.getActiveProfileDir());
  const storage = createPackageWideStorage(pluginRegistry.siblingImplementationIds(input.pluginId).map((id) => createPluginStorage(paths.pluginStorageFile(id))));
  const ctx = { ...createPluginServices(input.pluginId), storage, sessions: sessionsRegistry.forPlugin(input.pluginId) };
  return plugin.activationRequirement.activate(ctx, input.input, new AbortController().signal);
});

// pluginId here is a *package* id (§9.4) — uninstallPlugin() unregisters every implementation the
// package bundles, together.
ipcMain.handle(Channels.PluginsUninstall, (_event, pluginId: string) =>
  uninstallPlugin(pluginId, { pluginsDir: pluginsDir(app.getPath('userData')), registry: pluginRegistry }),
);

// --- Wizard ---

ipcMain.handle(Channels.WizardResolveListData, (_event, input: ResolveWizardListDataInput) =>
  resolveWizardListData(
    { registry: pluginRegistry, createPluginServices, sessionsApiForPlugin: (pluginId) => sessionsRegistry.forPlugin(pluginId) },
    input.pluginId,
    input.request,
    new AbortController().signal,
  ),
);

// --- Collect ---

ipcMain.handle(Channels.CollectRun, async (_event, input: RunCollectInput) => {
  const filePath = await currentConfigFilePath();
  const store = await loadConfigFile(filePath);

  return collectGuard.startCollect(async (report, signal) => {
    const result = await runCollectPipeline(
      store.sources,
      store.destinations,
      input,
      {
        registry: pluginRegistry,
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
      },
      report,
      signal,
    );
    await invoiceHistory.prune();
    return result;
  });
});

ipcMain.handle(Channels.JobsCancel, (_event, jobId: string) => jobRunner.cancelJob(jobId));

// --- History ---

ipcMain.handle(Channels.HistoryListForMonth, (_event, issuedMonth: string) => invoiceHistory.listForMonth(issuedMonth));
ipcMain.handle(Channels.HistoryGetRetentionMonths, () => invoiceHistory.getRetentionMonths());
ipcMain.handle(Channels.HistorySetRetentionMonths, (_event, months: number) => invoiceHistory.setRetentionMonths(months));
ipcMain.handle(Channels.HistoryClearAll, () => invoiceHistory.clear());

// --- SBOM / licenses (§13) ---

function buildSbomSources(): SbomSource[] {
  return [
    { id: 'ic-core', label: 'Invoice Collector (core app)', filePath: IC_CORE_SBOM_PATH },
    { id: 'invoice-collector-plugin-sdk', label: 'invoice-collector-plugin-sdk', filePath: SDK_SBOM_PATH },
    // §9.4: one shared SBOM per installed *package*, not per implementation — a package that
    // bundles a source and a destination together still has just one dependency tree.
    ...pluginRegistry.listPackages().map((packageManifest) => ({
      id: packageManifest.id,
      label: packageManifest.name,
      filePath: path.join(pluginsDir(app.getPath('userData')), packageManifest.id, packageManifest.sbom),
    })),
  ];
}

ipcMain.handle(Channels.SbomList, () => loadSboms(buildSbomSources(), (filePath) => readFile(filePath, 'utf-8')));

// §13's "raw export SBOM action per package" — hands back the underlying CycloneDX JSON file
// itself via a native Save dialog, rather than just the rendered view SbomList drives.
ipcMain.handle(Channels.SbomExport, async (_event, id: string) => {
  const source = buildSbomSources().find((s) => s.id === id);
  if (!source) throw new Error(`No SBOM source for "${id}"`);

  const raw = await readFile(source.filePath, 'utf-8');
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: `${id}-sbom.cdx.json`,
    filters: [{ name: 'CycloneDX SBOM', extensions: ['json'] }],
  });
  if (result.canceled || !result.filePath) return { exported: false };

  await writeFile(result.filePath, raw, 'utf-8');
  return { exported: true, filePath: result.filePath };
});

// --- Reporting (§14.1 US20) ---

ipcMain.handle(Channels.ReportExport, async (_event, input: ExportReportInput) => {
  const store = await loadConfigFile(await currentConfigFilePath());
  const records = await invoiceHistory.listForPeriod(input.period);
  const rows = buildReportRows(records, store.sources, store.destinations);

  const isHtml = input.format === 'html';
  const content = isHtml ? buildHtmlReport(rows, input.period) : await buildExcelReport(rows, input.period);

  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: `collect-report-${input.period.start}-to-${input.period.end}.${isHtml ? 'html' : 'xlsx'}`,
    filters: isHtml ? [{ name: 'HTML', extensions: ['html'] }] : [{ name: 'Excel workbook', extensions: ['xlsx'] }],
  });
  if (result.canceled || !result.filePath) return { exported: false };

  await writeFile(result.filePath, content);
  return { exported: true, filePath: result.filePath };
});

// Exports exactly the rows the renderer already has (and has already filtered) — see
// ExportInvoiceRowsInput's own doc comment for why this doesn't re-query invoiceHistory itself.
ipcMain.handle(Channels.ReportExportRows, async (_event, input: ExportInvoiceRowsInput) => {
  const store = await loadConfigFile(await currentConfigFilePath());
  const rows = buildReportRows(input.records, store.sources, store.destinations);

  const isExcel = input.format === 'excel';
  const content = isExcel ? await buildExcelReport(rows, input.period) : await renderHtmlToPdf(buildHtmlReport(rows, input.period));

  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: `collected-invoices-${input.period.start}-to-${input.period.end}.${isExcel ? 'xlsx' : 'pdf'}`,
    filters: isExcel ? [{ name: 'Excel workbook', extensions: ['xlsx'] }] : [{ name: 'PDF document', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return { exported: false };

  await writeFile(result.filePath, content);
  return { exported: true, filePath: result.filePath };
});

// --- Advanced Settings (§7) ---

ipcMain.handle(Channels.SettingsGetAdvanced, () => currentAdvancedSettings);

ipcMain.handle(Channels.SettingsSaveAdvanced, async (_event, settings: AdvancedSettings) => {
  await saveAdvancedSettings(advancedSettingsFile(app.getPath('userData')), settings);
  currentAdvancedSettings = settings;
  return currentAdvancedSettings;
});

// --- Logs ---

ipcMain.handle(Channels.LogsRead, () => readLogTail(APP_LOG_FILE));

ipcMain.handle(Channels.LogsDownload, async () => {
  const result = await dialog.showSaveDialog(mainWindow!, {
    defaultPath: `invoice-collector-log-${new Date().toISOString().slice(0, 10)}.txt`,
    filters: [{ name: 'Log file', extensions: ['txt', 'log'] }],
  });
  if (result.canceled || !result.filePath) return { exported: false };

  try {
    await copyFile(APP_LOG_FILE, result.filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Nothing has been logged yet.');
    }
    throw err;
  }
  return { exported: true, filePath: result.filePath };
});

// --- App ---

// A device-code sign-in's own verification URL (Microsoft's own domain, never user-typed) needs
// to open in the OS's real browser, not inside this app — shell.openExternal is the only way to
// do that from the renderer. Restricted to https: so a compromised/malicious plugin's own progress
// data can't smuggle a file:/javascript: URI through this generic channel.
ipcMain.handle(Channels.AppOpenExternal, (_event, url: string) => {
  if (!url.startsWith('https://')) {
    throw new Error(`Refusing to open a non-https URL: ${url}`);
  }
  return shell.openExternal(url);
});

// --- Lifecycle ---

app.whenReady().then(async () => {
  await profileManager.init();
  currentAdvancedSettings = await loadAdvancedSettings(advancedSettingsFile(app.getPath('userData')));
  // §5's "plugins aren't reloaded from disk at boot yet" gap — a plugin installed in an earlier
  // run left real files under pluginsDir, but nothing re-registered them into this fresh launch's
  // registry until now. Runs before rebuildProfileScopedServices() so its own sessionPlugin
  // re-registration loop (sessionsRegistry doesn't exist yet at this point) picks up every plugin
  // loaded here.
  await reloadInstalledPlugins({
    pluginsDir: pluginsDir(app.getPath('userData')),
    coreSdkVersion: CORE_SDK_VERSION,
    registry: pluginRegistry,
    onError: (pluginId, error) => {
      console.error(`Failed to reload plugin "${pluginId}" from disk:`, error);
    },
  });
  rebuildProfileScopedServices();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
