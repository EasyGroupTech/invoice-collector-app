import type { DestinationPlugin, DiscoveredInvoice, InvoiceContent, PluginContext, PluginDestinationRecord, SessionRequirement, UploadResult } from 'invoice-collector-plugin-sdk';
import { LOCAL_FOLDER_SESSION_TYPE_ID, localFolderAccessSessionPlugin } from './local-folder-session.js';
import { writeInvoiceToFolder } from './local-folder-write.js';

/**
 * `create()` needs no real programmatic input at all — the folder picker gathers everything
 * interactively (see local-folder-session.ts's own doc comment on why the OS-native picker is
 * itself the permission step). Reusing `BuiltInSessionInputProvider` for the trivial "no input
 * needed" case is explicitly sanctioned even for a custom session type — see plugin.ts's own doc
 * comment on `BuiltInSessionInputProvider`.
 */
function builtInSessionCreateInput(_requirement: SessionRequirement): unknown {
  return {};
}

async function upload(
  ctx: PluginContext,
  record: PluginDestinationRecord,
  invoice: DiscoveredInvoice & InvoiceContent,
  _signal: AbortSignal,
): Promise<UploadResult> {
  if (!record.sessionId) {
    throw new Error('No destination folder selected — create a session first');
  }

  const stored = await ctx.sessions.get(record.sessionId);
  if (!stored || typeof (stored.secret as { folderPath?: unknown } | null)?.folderPath !== 'string') {
    throw new Error('No destination folder found for this session');
  }

  return writeInvoiceToFolder((stored.secret as { folderPath: string }).folderPath, invoice);
}

/**
 * §14.1 US7's local-folder destination. No wizard fields at all — the only real setup is
 * granting folder access once, via the session (local-folder-session.ts); everything else about
 * "where does this invoice go" is exactly that one folder, unconditionally.
 */
const localFolderDestination: DestinationPlugin = {
  manifest: {
    id: 'app.easygroup.destination.local-folder',
    name: 'Local Folder',
    version: '0.0.0',
    pluginApiVersion: '0.0.0',
    kind: 'destination',
    // Genuinely true — this bundled reference plugin lives in this same public repo (§2/§9).
    repository: 'https://github.com/EasyGroupTech/invoice-collector-app',
    sbom: 'sbom.cdx.json',
    main: 'local-folder-plugin.js',
  },
  sessionRequirements: [
    {
      sessionTypeId: LOCAL_FOLDER_SESSION_TYPE_ID,
      confirmsBuiltIn: false,
      requiredScopesOrRoles: ['write'],
      permissionsNote:
        'Grants this destination permission to write invoice files into the folder you choose. Re-checked periodically — if the folder is deleted, moved, or its permissions change, this session flips to "needs reconnect" so you can pick a folder again.',
    },
  ],
  sessionPlugin: localFolderAccessSessionPlugin,
  wizard: [],
  builtInSessionCreateInput,
  upload,
};

export default localFolderDestination;
