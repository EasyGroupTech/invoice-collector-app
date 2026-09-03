import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { microsoftEntraDelegatedDeviceCodeSessionPlugin } from 'invoice-collector-plugin-sdk';
import { createCollectJobGuard } from '../../src/collect-job-guard.js';
import { runCollectPipeline } from '../../src/collect-pipeline.js';
import { decryptConfigExport, encryptConfigExport, type EncryptedConfigExportFile } from '../../src/config-export-crypto.js';
import { applyConfigImport, buildConfigExport, type ConfigExportFile } from '../../src/config-export.js';
import {
  createRecord,
  loadConfigFile,
  removeRecord,
  saveConfigFile,
  upsertRecord,
  type CreateRecordInput as ConfigCreateRecordInput,
} from '../../src/config-store.js';
import { createHttpApi, type SessionAuthResolver } from '../../src/http-client.js';
import { installPlugin } from '../../src/plugin-install.js';
import { createInvoiceHistory } from '../../src/invoice-history.js';
import { createJobRunner } from '../../src/job-runner.js';
import { appLogFile, pluginsDir, profilePaths } from '../../src/paths.js';
import { createPluginLog } from '../../src/plugin-log.js';
import { createPluginRegistry } from '../../src/plugin-registry.js';
import { createPluginStorage } from '../../src/plugin-storage.js';
import { createProfileManager } from '../../src/profiles.js';
import { createSessionsRegistry, type SessionsRegistry } from '../../src/sessions-registry.js';
import { safeStorageEncryptor } from './safeStorageEncryptor.js';
import {
  Channels,
  type CreateRecordInput,
  type CreateSessionInput,
  type InstallPluginInput,
  type ProfileCreateInput,
  type ReconnectSessionInput,
  type RemoveRecordInput,
  type RunCollectInput,
} from '../shared/ipcContracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
// electron-builder config instead (phase 1.16, not built yet), since app.isPackaged is true for
// any packaged build regardless of channel.
if (!app.isPackaged) {
  app.setName('Invoice Collector App Dev');
}

let mainWindow: BrowserWindow | null = null;

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

const sessionAuthResolver: SessionAuthResolver = {
  attachAuth: (pluginId, sessionId, request) => sessionsRegistry.attachAuth(pluginId, sessionId, request),
  recoverSession: (pluginId, sessionId) => sessionsRegistry.recoverSession(pluginId, sessionId),
};

function createPluginServices(pluginId: string) {
  const paths = profilePaths(profileManager.getActiveProfileDir());
  const log = createPluginLog(appLogFile(app.getPath('userData')), pluginId);
  return {
    storage: createPluginStorage(paths.pluginStorageFile(pluginId)),
    http: createHttpApi(pluginId, { sessionsRegistry: sessionAuthResolver }),
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

ipcMain.handle(Channels.ConfigExportAll, async (_event, password: string) => {
  const store = await loadConfigFile(await currentConfigFilePath());
  return encryptConfigExport(buildConfigExport(store), password);
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
  return jobRunner.runJob('session-create', async (report, signal) =>
    sessionsRegistry
      .forPlugin(input.pluginId)
      .create(input.sessionTypeId, input.input, signal, (message, data) => report({ message, data })),
  );
});

ipcMain.handle(Channels.SessionsReconnect, (_event, input: ReconnectSessionInput) => {
  return jobRunner.runJob('session-reconnect', async (report, signal) =>
    sessionsRegistry
      .forPlugin(input.pluginId)
      .reconnect(input.sessionId, signal, (message, data) => report({ message, data })),
  );
});

// --- Plugins ---
// Installed-plugin persistence (reloading what's already in plugins/ across an app restart) is a
// known gap, not silently skipped — see docs/implementation-plan.md's phase 1.11 notes. pluginRegistry
// starts empty every launch; installing is the only way to populate it today.

ipcMain.handle(Channels.PluginsList, () => pluginRegistry.list().map((plugin) => plugin.manifest));

ipcMain.handle(Channels.PluginsInstall, (_event, input: InstallPluginInput) =>
  installPlugin(input.rawInput, {
    pluginsDir: pluginsDir(app.getPath('userData')),
    coreSdkVersion: CORE_SDK_VERSION,
    trustAckFilePath: profilePaths(profileManager.getActiveProfileDir()).trustAckFile,
    registry: pluginRegistry,
    confirmUnverified: input.confirmUnverified,
  }),
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

// --- Lifecycle ---

app.whenReady().then(async () => {
  await profileManager.init();
  rebuildProfileScopedServices();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
