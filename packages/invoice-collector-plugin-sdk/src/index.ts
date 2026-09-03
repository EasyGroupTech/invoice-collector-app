export type { PluginManifest } from './manifest.js';

export type {
  HttpRequestInput,
  HttpResponse,
  HttpApi,
} from './http.js';

export {
  KNOWN_BUILT_IN_SESSION_TYPE_IDS,
} from './session.js';
export type {
  BuiltInSessionTypeId,
  SessionTypeDescriptor,
  SessionStatus,
  Session,
  SessionCreateResult,
  SessionRefreshResult,
  SessionPlugin,
  SessionRequirement,
  SessionsApi,
} from './session.js';

export type {
  PluginStorageApi,
  PluginLogApi,
  PluginProgressApi,
  CapturedBrowserSession,
  PluginContext,
} from './context.js';

export type {
  FieldType,
  FieldOption,
  FieldVisibleWhen,
  FieldDescriptor,
  ListColumn,
  ListDescriptor,
  DetailDescriptor,
  WizardStepDescriptor,
  SettingsPanelDescriptor,
} from './ui.js';

export type {
  PluginBackedRecord,
  PluginSourceRecord,
  PluginDestinationRecord,
  DiscoveredInvoice,
  InvoiceContent,
  UploadResult,
  PluginLifecycle,
  SourcePlugin,
  DestinationPlugin,
} from './plugin.js';

export type { ValidationResult } from './validate.js';
export { validateManifest, validateSessionRequirements } from './validate.js';

export { microsoftEntraDelegatedDeviceCodeSessionPlugin } from './builtin/microsoft-entra-delegated-device-code.js';
export type {
  MicrosoftEntraDelegatedDeviceCodeCreateInput,
  MicrosoftEntraDelegatedDeviceCodeSecret,
} from './builtin/microsoft-entra-delegated-device-code.js';
