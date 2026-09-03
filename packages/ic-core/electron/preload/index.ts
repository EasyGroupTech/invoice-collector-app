import { contextBridge, ipcRenderer } from 'electron';
import {
  Channels,
  type AdvancedSettings,
  type ConfigImportResult,
  type CreateRecordInput,
  type CreateSessionInput,
  type EncryptedConfigExportFile,
  type InstallPluginInput,
  type InstalledPluginSummary,
  type InvoiceHistoryRecord,
  type JobDoneEvent,
  type JobHandle,
  type JobProgressEvent,
  type PluginBackedRecord,
  type PluginInstallNeedsConfirmation,
  type PluginInstallResult,
  type ProfileCreateInput,
  type ProfileSummary,
  type ReconnectSessionInput,
  type RemoveRecordInput,
  type ResolveWizardListDataInput,
  type RunCollectInput,
  type RunCollectResult,
  type SbomEntry,
  type SbomExportResult,
  type Session,
  type WizardListDataResult,
} from '../shared/ipcContracts.js';

function onJobProgress(callback: (event: JobProgressEvent) => void): () => void {
  const listener = (_event: unknown, data: JobProgressEvent) => callback(data);
  ipcRenderer.on(Channels.JobProgress, listener);
  return () => ipcRenderer.removeListener(Channels.JobProgress, listener);
}

function onJobDone(callback: (event: JobDoneEvent) => void): () => void {
  const listener = (_event: unknown, data: JobDoneEvent) => callback(data);
  ipcRenderer.on(Channels.JobDone, listener);
  return () => ipcRenderer.removeListener(Channels.JobDone, listener);
}

contextBridge.exposeInMainWorld('api', {
  configListSources: (): Promise<PluginBackedRecord[]> => ipcRenderer.invoke(Channels.ConfigListSources),
  configListDestinations: (): Promise<PluginBackedRecord[]> => ipcRenderer.invoke(Channels.ConfigListDestinations),
  configCreateRecord: (input: CreateRecordInput): Promise<PluginBackedRecord> => ipcRenderer.invoke(Channels.ConfigCreateRecord, input),
  configRemoveRecord: (input: RemoveRecordInput): Promise<void> => ipcRenderer.invoke(Channels.ConfigRemoveRecord, input),
  configExportAll: (password: string): Promise<EncryptedConfigExportFile> => ipcRenderer.invoke(Channels.ConfigExportAll, password),
  configImportAll: (file: EncryptedConfigExportFile, password: string): Promise<ConfigImportResult> =>
    ipcRenderer.invoke(Channels.ConfigImportAll, file, password),

  profilesList: (): Promise<ProfileSummary[]> => ipcRenderer.invoke(Channels.ProfilesList),
  profilesSwitch: (profileId: string): Promise<void> => ipcRenderer.invoke(Channels.ProfilesSwitch, profileId),
  profilesCreate: (input: ProfileCreateInput): Promise<ProfileSummary> => ipcRenderer.invoke(Channels.ProfilesCreate, input),
  profilesDelete: (profileId: string): Promise<void> => ipcRenderer.invoke(Channels.ProfilesDelete, profileId),

  sessionsList: (): Promise<Session[]> => ipcRenderer.invoke(Channels.SessionsList),
  sessionsCreate: (input: CreateSessionInput): Promise<JobHandle> => ipcRenderer.invoke(Channels.SessionsCreate, input),
  sessionsReconnect: (input: ReconnectSessionInput): Promise<JobHandle> => ipcRenderer.invoke(Channels.SessionsReconnect, input),

  pluginsList: (): Promise<InstalledPluginSummary[]> => ipcRenderer.invoke(Channels.PluginsList),
  pluginsInstall: (input: InstallPluginInput): Promise<PluginInstallResult | PluginInstallNeedsConfirmation> =>
    ipcRenderer.invoke(Channels.PluginsInstall, input),
  pluginsUninstall: (pluginId: string): Promise<void> => ipcRenderer.invoke(Channels.PluginsUninstall, pluginId),

  wizardResolveListData: (input: ResolveWizardListDataInput): Promise<WizardListDataResult> =>
    ipcRenderer.invoke(Channels.WizardResolveListData, input),

  collectRun: (input: RunCollectInput): Promise<RunCollectResult> => ipcRenderer.invoke(Channels.CollectRun, input),
  jobsCancel: (jobId: string): Promise<void> => ipcRenderer.invoke(Channels.JobsCancel, jobId),

  historyListForMonth: (issuedMonth: string): Promise<InvoiceHistoryRecord[]> =>
    ipcRenderer.invoke(Channels.HistoryListForMonth, issuedMonth),

  sbomList: (): Promise<SbomEntry[]> => ipcRenderer.invoke(Channels.SbomList),
  sbomExport: (id: string): Promise<SbomExportResult> => ipcRenderer.invoke(Channels.SbomExport, id),

  settingsGetAdvanced: (): Promise<AdvancedSettings> => ipcRenderer.invoke(Channels.SettingsGetAdvanced),
  settingsSaveAdvanced: (settings: AdvancedSettings): Promise<AdvancedSettings> =>
    ipcRenderer.invoke(Channels.SettingsSaveAdvanced, settings),

  onJobProgress,
  onJobDone,
});
