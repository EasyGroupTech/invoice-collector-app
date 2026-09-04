import { useEffect, useState } from 'react';
import type { Session } from 'invoice-collector-plugin-sdk';
import { ChevronDown, ChevronRight, RefreshCw } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { runJobAndWait } from '../jobs';

const NEEDS_ATTENTION_STATUSES: Session['status'][] = ['expired', 'needs-reconnect'];

/** §6's Sessions UI: lists established sessions, their status, and a Reconnect action. Creating a
 * *new* session isn't here — §6 frames that as part of a source/destination's own Add wizard flow
 * ("any wizard step that needs a connection offers 'use an existing session' ... alongside
 * 'create a new one'"), not a bare button on this page.
 *
 * A Settings section (§8, phase 1.16), collapsed by default like `PluginsSection` — but, matching
 * the reference app's own `SourcesPage` card-header rollup, a stale session still surfaces a count
 * and a one-click way to jump straight to it even while collapsed, since Reconnect is the one
 * action here a user genuinely needs to notice without first having to expand the section. */
export function SessionsSection() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busySessionId, setBusySessionId] = useState<string | undefined>(undefined);
  const [collapsed, setCollapsed] = useState(true);

  async function refresh() {
    setSessions(await window.api.sessionsList());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function reconnect(session: Session) {
    setBusySessionId(session.id);
    try {
      await runJobAndWait(window.api.sessionsReconnect({ pluginId: session.createdByPluginId, sessionId: session.id }));
      toast.success(`${session.label} reconnected`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySessionId(undefined);
    }
  }

  const needsAttentionCount = sessions.filter((s) => NEEDS_ATTENTION_STATUSES.includes(s.status)).length;

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
                      <Button type="button" variant="outline" size="sm" disabled={busySessionId === s.id} onClick={() => void reconnect(s)}>
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
    </Card>
  );
}
