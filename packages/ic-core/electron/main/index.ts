import { readFile, writeFile } from 'node:fs/promises';
import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { microsoftEntraDelegatedDeviceCodeSessionPlugin } from 'invoice-collector-plugin-sdk';
import { defaultAdvancedSettings, loadAdvancedSettings, saveAdvancedSettings, type AdvancedSettings } from '../../src/advanced-settings.js';
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
import { installPlugin, uninstallPlugin } from '../../src/plugin-install.js';
import { createInvoiceHistory } from '../../src/invoice-history.js';
import { createJobRunner } from '../../src/job-runner.js';
import { advancedSettingsFile, appLogFile, pluginsDir, profilePaths } from '../../src/paths.js';
import { createPluginLog } from '../../src/plugin-log.js';
import { createPluginRegistry } from '../../src/plugin-registry.js';
import { createPluginStorage } from '../../src/plugin-storage.js';
import { createProfileManager } from '../../src/profiles.js';
import { buildExcelReport, buildHtmlReport, buildReportRows } from '../../src/reporting.js';
import { loadSboms, type SbomSource } from '../../src/sbom-registry.js';
import { resolveSessionCreateInput } from '../../src/session-create-input.js';
import { createSessionsRegistry, type SessionsRegistry } from '../../src/sessions-registry.js';
import { resolveWizardListData } from '../../src/wizard-data.js';
import { safeStorageEncryptor } from './safeStorageEncryptor.js';
import {
  Channels,
  type CreateRecordInput,
  type CreateSessionInput,
  type ExportReportInput,
  type InstallPluginInput,
  type ProfileCreateInput,
  type ReconnectSessionInput,
  type RemoveRecordInput,
  type ResolveWizardListDataInput,
  type RunCollectInput,
} from '../shared/ipcContracts.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// dist/main -> ic-core's own package root is two levels up. Correct in dev; revisit once phase
// 1.16's electron-builder config decides where a packaged build's resources actually live.
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
    sessionId: input.sessionId,
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

// --- Plugins ---
// Installed-plugin persistence (reloading what's already in plugins/ across an app restart) is a
// known gap, not silently skipped — see docs/implementation-plan.md's phase 1.11/1.12 notes.
// pluginRegistry starts empty every launch; installing is the only way to populate it today.
// Enable/disable is the same underlying gap and isn't built either — only uninstall is, below.

ipcMain.handle(Channels.PluginsList, () =>
  pluginRegistry.list().map((plugin) => ({
    manifest: plugin.manifest,
    sessionRequirements: plugin.sessionRequirements,
    wizard: plugin.wizard,
    settingsPanel: plugin.settingsPanel,
  })),
);

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

// --- SBOM / licenses (§13) ---

function buildSbomSources(): SbomSource[] {
  return [
    { id: 'ic-core', label: 'Invoice Collector (core app)', filePath: IC_CORE_SBOM_PATH },
    { id: 'invoice-collector-plugin-sdk', label: 'invoice-collector-plugin-sdk', filePath: SDK_SBOM_PATH },
    ...pluginRegistry.list().map((plugin) => ({
      id: plugin.manifest.id,
      label: plugin.manifest.name,
      filePath: path.join(pluginsDir(app.getPath('userData')), plugin.manifest.id, plugin.manifest.sbom),
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

// --- Advanced Settings (§7) ---

ipcMain.handle(Channels.SettingsGetAdvanced, () => currentAdvancedSettings);

ipcMain.handle(Channels.SettingsSaveAdvanced, async (_event, settings: AdvancedSettings) => {
  await saveAdvancedSettings(advancedSettingsFile(app.getPath('userData')), settings);
  currentAdvancedSettings = settings;
  return currentAdvancedSettings;
});

// --- Lifecycle ---

app.whenReady().then(async () => {
  await profileManager.init();
  currentAdvancedSettings = await loadAdvancedSettings(advancedSettingsFile(app.getPath('userData')));
  rebuildProfileScopedServices();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
