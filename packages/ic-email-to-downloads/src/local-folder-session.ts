import type { HttpRequestInput, SessionCreateResult, SessionPlugin, SessionRefreshResult } from 'invoice-collector-plugin-sdk';
import { checkFolderAccess } from './local-folder-write.js';

export const LOCAL_FOLDER_SESSION_TYPE_ID = 'app.easygroup.destination.local-folder/folder-access';

export interface LocalFolderSecret {
  folderPath: string;
}

function isLocalFolderSecret(secret: unknown): secret is LocalFolderSecret {
  return typeof secret === 'object' && secret !== null && typeof (secret as Record<string, unknown>).folderPath === 'string';
}

/**
 * How often core re-checks this session is still good (`Session.keepAliveIntervalMs` — "a
 * SessionPlugin whose session type needs periodic 'still alive' activity rather than a
 * token-expiry renewal"). Folder access has no token to expire, but it can still go stale — the
 * folder gets deleted, moved, or its OS permissions get revoked — so this repurposes the exact
 * same scheduling mechanism §6 already built for token refresh, just for a filesystem check
 * instead. A local disk stat is cheap; every 30 minutes is frequent enough to catch a stale
 * destination well before it'd otherwise surface as a run of failed uploads.
 */
const KEEP_ALIVE_INTERVAL_MS = 30 * 60 * 1000;

/**
 * On macOS, letting the user pick the folder through a native `dialog.showOpenDialog` (rather
 * than e.g. reading a typed path) is what grants this unsandboxed app access to a protected
 * folder (Desktop/Documents/Downloads/removable or network volumes) without the OS's own TCC
 * permission prompt blocking a later, unattended write — the picker itself *is* the OS's consent
 * step. Dynamically imported so this module (and everything that depends on it — the destination
 * plugin, its tests) stays loadable outside a real Electron process; only `create()` itself ever
 * needs the real `dialog`.
 */
async function pickFolder(): Promise<string | undefined> {
  const { dialog } = await import('electron');
  const result = await dialog.showOpenDialog({
    title: 'Choose a folder to save invoices to',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (result.canceled || result.filePaths.length === 0) return undefined;
  return result.filePaths[0];
}

/**
 * A custom (`confirmsBuiltIn: false`) session type owned by the local-folder destination plugin
 * (local-folder-plugin.ts) — not one of the SDK's own built-ins, since "session" here means OS
 * folder-access permission, not a remote API connection, and no other plugin has any reason to
 * share it (§6's cross-plugin sharing rule only applies to built-ins).
 */
export const localFolderAccessSessionPlugin: SessionPlugin = {
  sessionTypeId: LOCAL_FOLDER_SESSION_TYPE_ID,

  async create(): Promise<SessionCreateResult> {
    const folderPath = await pickFolder();
    if (!folderPath) {
      throw new Error('No folder was selected');
    }

    const access = await checkFolderAccess(folderPath);
    if (access === 'error') {
      throw new Error(`Cannot write to "${folderPath}" — check the folder's permissions and try again`);
    }

    const secret: LocalFolderSecret = { folderPath };
    return { label: folderPath, secret, keepAliveIntervalMs: KEEP_ALIVE_INTERVAL_MS };
  },

  /** Repurposed as the periodic health check described above — there's no token to renew, so
   * 'unchanged' on success; throwing on failure is what flips this session to `needs-reconnect`
   * (sessions-registry.ts's own attemptRefresh() catch), the same path a real token-refresh
   * failure takes. */
  async refresh(ctx, session): Promise<SessionRefreshResult | 'unchanged'> {
    const stored = await ctx.sessions.get(session.id);
    if (!stored || !isLocalFolderSecret(stored.secret)) {
      throw new Error(`No stored folder path found for session ${session.id}`);
    }

    const access = await checkFolderAccess(stored.secret.folderPath);
    if (access === 'error') {
      throw new Error(
        `Lost access to "${stored.secret.folderPath}" — it may have been moved, deleted, or its permissions changed`,
      );
    }

    return 'unchanged';
  },

  async test(ctx, session): Promise<'ok' | 'expired' | 'error'> {
    const stored = await ctx.sessions.get(session.id);
    if (!stored || !isLocalFolderSecret(stored.secret)) return 'error';
    return checkFolderAccess(stored.secret.folderPath);
  },

  // Folder access has no per-request auth to attach — no HttpApi request tied to this session
  // ever gets made (this destination writes to disk directly). A pass-through, not a lie about
  // attaching something that doesn't exist.
  applyAuth(_secret: unknown, request: HttpRequestInput): HttpRequestInput {
    return request;
  },
};
