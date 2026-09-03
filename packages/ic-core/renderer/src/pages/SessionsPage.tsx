import { useEffect, useState } from 'react';
import type { Session } from 'invoice-collector-plugin-sdk';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { runJobAndWait } from '../jobs';

/** §6's Sessions UI: lists established sessions, their status, and a Reconnect action. Creating a
 * *new* session isn't here — §6 frames that as part of a source/destination's own Add wizard flow
 * ("any wizard step that needs a connection offers 'use an existing session' ... alongside
 * 'create a new one'"), not a bare button on this page. */
export function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busySessionId, setBusySessionId] = useState<string | undefined>(undefined);

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

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h2 className="text-2xl font-semibold tracking-tight">Sessions</h2>
        <p className="text-sm text-muted-foreground">Established connections a source or destination signs in through.</p>
      </div>

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
    </div>
  );
}
