import path from 'node:path';
import type { DestinationPlugin, PluginContext, PluginDestinationRecord, SessionRequirement, UploadableInvoice, UploadResult } from 'invoice-collector-plugin-sdk';
import { LOCAL_FOLDER_SESSION_TYPE_ID, localFolderAccessSessionPlugin } from './local-folder-session.js';
import { renameSourceFolder, writeInvoiceToFolder } from './local-folder-write.js';

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
  invoice: UploadableInvoice,
  _signal: AbortSignal,
): Promise<UploadResult> {
  if (!record.sessionId) {
    throw new Error('No destination folder selected — create a session first');
  }

  const stored = await ctx.sessions.get(record.sessionId);
  if (!stored || typeof (stored.secret as { folderPath?: unknown } | null)?.folderPath !== 'string') {
    throw new Error('No destination folder found for this session');
  }

  return writeInvoiceToFolder((stored.secret as { folderPath: string }).folderPath, invoice.sourceName, invoice);
}

/**
 * §14.1's "renaming a flow should rename its destination folder too" follow-up — see
 * `renameSourceFolder`'s own doc comment for the exact rename rules/edge cases. When it actually
 * moved something, hands back a `locationRewrite` mapping an already-recorded
 * `InvoiceHistoryRecord.location` under the old directory to its new equivalent — a location that
 * doesn't start with the old directory at all (never written by this destination, or from before
 * some earlier naming convention) is left exactly as it was, same as `renameSourceFolder` itself
 * leaves anything alone it isn't sure about.
 */
async function onSourceRenamed(
  ctx: PluginContext,
  record: PluginDestinationRecord,
  oldSourceName: string,
  newSourceName: string,
  _signal: AbortSignal,
): Promise<{ locationRewrite?: (oldLocation: string) => string } | undefined> {
  if (!record.sessionId) return undefined;

  const stored = await ctx.sessions.get(record.sessionId);
  const folderPath = (stored?.secret as { folderPath?: unknown } | null)?.folderPath;
  if (typeof folderPath !== 'string') return undefined;

  const moved = await renameSourceFolder(folderPath, oldSourceName, newSourceName);
  if (!moved) return undefined;

  return {
    locationRewrite: (oldLocation: string) =>
      oldLocation === moved.oldDir || oldLocation.startsWith(moved.oldDir + path.sep) ? moved.newDir + oldLocation.slice(moved.oldDir.length) : oldLocation,
  };
}

/**
 * §14.1 US7's local-folder destination. No wizard fields at all — the only real setup is
 * granting folder access once, via the session (local-folder-session.ts); everything else about
 * "where does this invoice go" is exactly that one folder, unconditionally.
 */
const localFolderDestination: DestinationPlugin = {
  // §9.4: version/pluginApiVersion/repository/sbom are package-level now (this implementation's
  // package is app.easygroup.email-to-downloads — see package-manifest.ts).
  manifest: {
    id: 'app.easygroup.destination.local-folder',
    name: 'Local Folder',
    kind: 'destination',
    main: 'local-folder-plugin.js',
  },
  sessionRequirements: [
    {
      sessionTypeId: LOCAL_FOLDER_SESSION_TYPE_ID,
      confirmsBuiltIn: false,
      requiredScopesOrRoles: ['write'],
      permissionsNote:
        'Grants this destination permission to write invoice files into the folder you choose. Re-checked periodically — if the folder is deleted, moved, or its permissions change, this session flips to "needs reconnect" so you can pick a folder again.',
      collects: 'to a folder on this device',
      connectHow: "I'll choose a folder.",
      connectInstructions:
        "Pick any folder on this computer — invoices get saved there, organized by source and month. We'll periodically check it's still accessible.",
    },
  ],
  sessionPlugin: localFolderAccessSessionPlugin,
  wizard: [],
  builtInSessionCreateInput,
  upload,
  onSourceRenamed,
};

export default localFolderDestination;
