import { Copy, ExternalLink, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import type { JobProgressEvent } from '../../../electron/shared/ipcContracts';

/** Scans a job's progress log, most recent first, for the device-code flow's own
 * `ctx.progress.report(message, {userCode, verificationUri, verificationUriComplete})` — the SDK
 * nests this under `event.data` rather than flattening it onto the event itself, unlike the
 * reference app's own (unrelated) `JobProgressEvent` shape. */
export function extractDeviceCodeInfo(progressLog: JobProgressEvent[]): { userCode: string; verificationUri: string } | undefined {
  for (let i = progressLog.length - 1; i >= 0; i--) {
    const data = progressLog[i].data as { userCode?: string; verificationUri?: string } | undefined;
    if (data?.userCode && data.verificationUri) {
      return { userCode: data.userCode, verificationUri: data.verificationUri };
    }
  }
  return undefined;
}

async function copyToClipboard(value: string, label: string) {
  await navigator.clipboard.writeText(value);
  toast.success(`${label} copied`);
}

/** The live "here's the code, go sign in" half of the device-code flow (RFC 8628) — without this,
 * a device-code session create/reconnect just looks stuck until it eventually times out. Ported
 * from the reference app's own `DeviceCodePrompt` (link + code, each with its own copy button, the
 * link itself clickable via `window.api.openExternal` — real OS browser, not an in-app
 * navigation), adapted only for this app's nested `event.data` progress shape. Shared by
 * `AddCollectorWizard`'s own "create new session" step and `SessionsSection`'s Reconnect flow (a
 * silent refresh-token renewal falls back to this exact same interactive flow when it fails). */
export function DeviceCodeSignInPrompt({ progressLog }: { progressLog: JobProgressEvent[] }) {
  const info = extractDeviceCodeInfo(progressLog);

  if (!info) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {progressLog[progressLog.length - 1]?.message ?? 'Starting…'}
      </div>
    );
  }

  const { userCode, verificationUri } = info;

  return (
    <div className="flex flex-col gap-3 rounded-md border p-3">
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-xs text-muted-foreground">Go to</span>
        <button
          type="button"
          onClick={() => void window.api.openExternal(verificationUri)}
          className="flex items-center gap-1 truncate text-sm text-primary underline underline-offset-2"
        >
          {verificationUri}
          <ExternalLink className="size-3.5 shrink-0" />
        </button>
        <Button variant="ghost" size="icon" className="ml-auto shrink-0" onClick={() => void copyToClipboard(verificationUri, 'Link')}>
          <Copy />
        </Button>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-16 shrink-0 text-xs text-muted-foreground">Enter code</span>
        <code className="rounded bg-muted px-2 py-1 text-sm font-medium tracking-wide">{userCode}</code>
        <Button variant="ghost" size="icon" className="ml-auto shrink-0" onClick={() => void copyToClipboard(userCode, 'Code')}>
          <Copy />
        </Button>
      </div>
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Loader2 className="size-3.5 animate-spin" />
        Waiting for you to complete sign-in…
      </div>
    </div>
  );
}
