import { useEffect, useRef, useState } from 'react';
import { Copy, Download, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';

/**
 * Ported from the reference app's own Settings page verbatim (JSX, copy, layout) — the only
 * adaptation is `logsDownload()` returning this app's own established `FileExportResult`
 * (`{ exported, filePath }`, already used by SBOM/report export) rather than the reference app's
 * own one-off `{ savedPath }` shape.
 */
export function LogsSection() {
  const [logContent, setLogContent] = useState('');
  const [logTruncated, setLogTruncated] = useState(false);
  const [logLoading, setLogLoading] = useState(false);
  const [logDownloading, setLogDownloading] = useState(false);
  const logScrollRef = useRef<HTMLPreElement | null>(null);

  function refreshLog() {
    setLogLoading(true);
    window.api
      .logsRead()
      .then((result) => {
        setLogContent(result.content);
        setLogTruncated(result.truncated);
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setLogLoading(false));
  }

  useEffect(() => {
    refreshLog();
  }, []);

  // Newest lines are at the bottom of the file, so scroll there whenever fresh content lands
  // instead of leaving the view sitting at the top.
  useEffect(() => {
    const el = logScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logContent]);

  async function copyLog() {
    await navigator.clipboard.writeText(logContent);
    toast.success('Log copied');
  }

  async function downloadLog() {
    setLogDownloading(true);
    try {
      const result = await window.api.logsDownload();
      if (result.exported) toast.success(`Saved to ${result.filePath}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setLogDownloading(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Logs</CardTitle>
        <CardDescription>
          Every action taken and every Collect run's activity, on one timeline, tagged <code>[application]</code> or <code>[collection]</code> to tell
          them apart. Passwords, secrets, and tokens are never written to it, and URLs are sanitized to remove tenant/account identifiers.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <Button size="sm" variant="ghost" onClick={refreshLog} disabled={logLoading} className="ml-auto">
            <RefreshCw className={logLoading ? 'animate-spin' : undefined} />
            Refresh
          </Button>
          <Button size="sm" variant="outline" onClick={() => void copyLog()} disabled={!logContent}>
            <Copy />
            Copy
          </Button>
          <Button size="sm" variant="outline" onClick={() => void downloadLog()} disabled={logDownloading}>
            <Download />
            {logDownloading ? 'Saving…' : 'Download'}
          </Button>
        </div>
        {logTruncated && <p className="text-xs text-muted-foreground">Showing only the end of this log — Download saves the full file.</p>}
        <pre ref={logScrollRef} className="max-h-64 overflow-auto rounded-md border bg-muted/30 p-3 font-mono text-xs whitespace-pre-wrap">
          {logContent || (logLoading ? 'Loading…' : 'Nothing logged yet.')}
        </pre>
      </CardContent>
    </Card>
  );
}
