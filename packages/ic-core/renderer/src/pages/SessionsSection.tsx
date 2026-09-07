import { useEffect, useState } from 'react';
import type { Session } from 'invoice-collector-plugin-sdk';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DeviceCodeSignInPrompt, extractDeviceCodeInfo } from '@/components/DeviceCodeSignInPrompt';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useJob } from '../hooks/useJob';

const NEEDS_ATTENTION_STATUSES: Session['status'][] = ['expired', 'needs-reconnect'];

/** §6's Sessions UI: lists established sessions, their status, and a Reconnect action. Creating a
 * *new* session isn't here — §6 frames that as part of a source/destination's own Add wizard flow
 * ("any wizard step that needs a connection offers 'use an existing session' ... alongside
 * 'create a new one'"), not a bare button on this page.
 *
 * Reconnect tries a silent refresh-token renewal first (`SessionsRegistry.reconnect()`'s own
 * refresh-before-create fallback) — most of the time this finishes instantly with nothing to show.
 * Only when that fails (or the session type has no refresh mechanism at all) does the backend fall
 * back to the full interactive create() flow, and only then does this open a dialog with the live
 * device-code prompt — a plain "Reconnecting…" button with no way to see the code would otherwise
 * leave that fallback silently unusable.
 *
 * A Settings section (§8, phase 1.16), collapsed by default like `PluginsSection` — but, matching
 * the reference app's own `SourcesPage` card-header rollup, a stale session still surfaces a count
 * and a one-click way to jump straight to it even while collapsed, since Reconnect is the one
 * action here a user genuinely needs to notice without first having to expand the section. */
export function SessionsSection() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busySessionId, setBusySessionId] = useState<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState(true);
  const reconnectJob = useJob<Session>();

  async function refresh() {
    setSessions(await window.api.sessionsList());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function reconnect(session: Session) {
    setBusySessionId(session.id);
    try {
      await reconnectJob.start(window.api.sessionsReconnect({ pluginId: session.createdByPluginId, sessionId: session.id }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setBusySessionId(undefined);
    }
  }

  function cancelReconnect() {
    reconnectJob.cancel();
    setBusySessionId(undefined);
  }

  // Reacts to the reconnect job's own terminal result, whichever path it actually took (a silent
  // refresh or the interactive fallback) — `reconnect()` above only awaits the job *starting*.
  useEffect(() => {
    if (!reconnectJob.result || !busySessionId) return;
    const label = sessions.find((s) => s.id === busySessionId)?.label ?? 'Session';
    if (reconnectJob.result.ok) {
      toast.success(`${label} reconnected`);
      void refresh();
    } else {
      toast.error(reconnectJob.result.error);
    }
    setBusySessionId(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectJob.result]);

  const needsAttentionCount = sessions.filter((s) => NEEDS_ATTENTION_STATUSES.includes(s.status)).length;
  const deviceCodeInfo = busySessionId && !reconnectJob.result ? extractDeviceCodeInfo(reconnectJob.progressLog) : undefined;

  return (
    <Card className="py-0">
      <CardHeader className="cursor-pointer gap-1.5 py-4 select-none" onClick={() => setCollapsed((c) => !c)}>
        <CardTitle className="flex items-center gap-2">
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          Sessions
        </CardTitle>
        <CardDescription>
          {sessions.length} established connection{sessions.length === 1 ? '' : 's'}
          {needsAttentionCount > 0 && `, ${needsAttentionCount} need${needsAttentionCount === 1 ? 's' : ''} reconnecting`}
        </CardDescription>
        {collapsed && needsAttentionCount > 0 && (
          <CardAction>
            <Button
              size="sm"
              onClick={(e) => {
                e.stopPropagation();
                setCollapsed(false);
              }}
            >
              <RefreshCw />
              Reconnect
            </Button>
          </CardAction>
        )}
      </CardHeader>
      {!collapsed && (
        <CardContent className="pb-4">
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Label</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Expires</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {sessions.map((s) => (
                  <TableRow key={s.id}>
                    <TableCell>{s.label}</TableCell>
                    <TableCell>{s.sessionTypeId}</TableCell>
                    <TableCell>
                      <Badge variant={s.status === 'active' ? 'secondary' : 'destructive'}>{s.status}</Badge>
                    </TableCell>
                    <TableCell>{s.expiresAt ?? '—'}</TableCell>
                    <TableCell>
                      <Button type="button" variant="outline" size="sm" disabled={busySessionId !== undefined} onClick={() => void reconnect(s)}>
                        {busySessionId === s.id ? 'Reconnecting…' : 'Reconnect'}
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
                {sessions.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-muted-foreground">
                      No sessions yet — sessions are created from a source/destination's Add wizard.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      )}

      {deviceCodeInfo !== undefined ? (
        <Dialog open onOpenChange={(open) => !open && cancelReconnect()}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Sign in to reconnect</DialogTitle>
            </DialogHeader>
            <DeviceCodeSignInPrompt progressLog={reconnectJob.progressLog} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={cancelReconnect}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
    </Card>
  );
}
