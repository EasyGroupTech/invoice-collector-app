import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, Clipboard, RefreshCw, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { AuditLogEntry } from '../../../electron/shared/ipcContracts';
import { buildCurlCommand } from '../audit-log-curl.js';

function bodyPreview(body: AuditLogEntry['requestBody']): string {
  if (body.kind === 'json') return JSON.stringify(body.value, null, 2);
  if (body.kind === 'text') return body.value;
  return `(${body.reason})`;
}

/**
 * §7's network audit log (phase 1.22) — every real outbound `ctx.http` call, redacted *before*
 * it's ever stored (`http-client.ts`'s own `onAudit` hook, `sanitizeHeadersForLog`/
 * `sanitizeBodyForLog`/`sanitizeResponseBodyForLog`), not just before it's displayed here.
 * There is deliberately no "reveal the real value" toggle anywhere in this section — the real
 * headers/body were never persisted at all, so there is nothing left to reveal; a redacted field
 * always reads as the literal `[REDACTED]` placeholder, safe to paste anywhere as-is. Collapsed
 * by default, same as every other Settings section (`LogsSection`/`PluginsSection`/
 * `SessionStatusSection`) — this can grow long and isn't something most sessions need open.
 */
export function AuditLogSection() {
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [collapsed, setCollapsed] = useState(true);
  const [expandedId, setExpandedId] = useState<string | undefined>(undefined);
  const [clearing, setClearing] = useState(false);

  function refresh() {
    setLoading(true);
    window.api
      .auditLogList()
      .then((result) => setEntries([...result].reverse()) /* newest first */)
      .catch((err) => toast.error(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    refresh();
  }, []);

  async function clearAll() {
    setClearing(true);
    try {
      await window.api.auditLogClear();
      setEntries([]);
      setExpandedId(undefined);
      toast.success('Audit log cleared');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setClearing(false);
    }
  }

  async function copyCurl(entry: AuditLogEntry) {
    await navigator.clipboard.writeText(buildCurlCommand(entry));
    toast.success('Copied as cURL');
  }

  return (
    <Card className="py-0">
      <CardHeader className="cursor-pointer gap-1.5 py-4 select-none" onClick={() => setCollapsed((c) => !c)}>
        <CardTitle className="flex items-center gap-2">
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          Network activity
        </CardTitle>
        <CardDescription>
          {entries.length} recent call{entries.length === 1 ? '' : 's'} — every real request a plugin made, redacted before it was ever stored.
        </CardDescription>
      </CardHeader>
      {!collapsed && (
        <CardContent className="flex flex-col gap-3 pb-4">
          <div className="flex items-center gap-2">
            <Button size="sm" variant="ghost" onClick={refresh} disabled={loading} className="ml-auto">
              <RefreshCw className={loading ? 'animate-spin' : undefined} />
              Refresh
            </Button>
            <Button size="sm" variant="outline" onClick={() => void clearAll()} disabled={clearing || entries.length === 0}>
              <Trash2 />
              Clear
            </Button>
          </div>

          {entries.length === 0 ? (
            <p className="text-sm text-muted-foreground">{loading ? 'Loading…' : 'No network activity recorded yet.'}</p>
          ) : (
            <div className="flex max-h-96 flex-col gap-1 overflow-y-auto">
              {entries.map((entry) => {
                const isOpen = expandedId === entry.id;
                const failed = entry.status === undefined || entry.status >= 400;
                return (
                  <div key={entry.id} className="rounded-md border">
                    <div
                      className="flex cursor-pointer items-center justify-between gap-3 px-3 py-2 select-none"
                      onClick={() => setExpandedId(isOpen ? undefined : entry.id)}
                    >
                      <div className="flex min-w-0 items-center gap-2 truncate text-xs">
                        {isOpen ? <ChevronDown className="size-3.5 shrink-0" /> : <ChevronRight className="size-3.5 shrink-0" />}
                        <span className="shrink-0 font-mono font-medium">{entry.method}</span>
                        <span className="truncate text-muted-foreground">{entry.url}</span>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <Badge variant={failed ? 'destructive' : 'secondary'}>{entry.status ?? '—'}</Badge>
                        <span className="text-xs text-muted-foreground">{entry.durationMs}ms</span>
                      </div>
                    </div>
                    {isOpen && (
                      <div className="flex flex-col gap-3 border-t px-3 py-3 text-xs">
                        <div className="flex items-center justify-between gap-2 text-muted-foreground">
                          <span>
                            {entry.pluginId} · {new Date(entry.timestamp).toLocaleString()}
                          </span>
                          <Button size="sm" variant="outline" onClick={() => void copyCurl(entry)}>
                            <Clipboard />
                            Copy as cURL
                          </Button>
                        </div>
                        <div>
                          <p className="mb-1 font-medium">Request headers</p>
                          <pre className="overflow-x-auto rounded bg-muted/30 p-2 font-mono">{JSON.stringify(entry.requestHeaders, null, 2)}</pre>
                        </div>
                        <div>
                          <p className="mb-1 font-medium">Request body</p>
                          <pre className="overflow-x-auto rounded bg-muted/30 p-2 font-mono">{bodyPreview(entry.requestBody)}</pre>
                        </div>
                        <div>
                          <p className="mb-1 font-medium">Response headers</p>
                          <pre className="overflow-x-auto rounded bg-muted/30 p-2 font-mono">{JSON.stringify(entry.responseHeaders, null, 2)}</pre>
                        </div>
                        <div>
                          <p className="mb-1 font-medium">Response body</p>
                          <pre className="overflow-x-auto rounded bg-muted/30 p-2 font-mono">{bodyPreview(entry.responseBody)}</pre>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
