import { useEffect, useState } from 'react';
import type { PluginBackedRecord, Session } from 'invoice-collector-plugin-sdk';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { AddCollectorWizard } from './AddCollectorWizard';
import { sessionFor } from './SourcesDestinationsSection';

const NEEDS_ATTENTION_STATUSES: Session['status'][] = ['expired', 'needs-reconnect'];

/** True for a record (source or destination) whose own session is either stale (expired/needs-
 * reconnect) or gone entirely (a sessionId that no longer resolves at all — e.g. a Logout that
 * cleared credentials still leaves the session id assigned, but a full delete elsewhere wouldn't).
 * A record with no sessionId assigned yet isn't "stale," just not connected. */
function recordNeedsAttention(record: PluginBackedRecord, sessions: Session[]): boolean {
  if (!record.sessionId) return false;
  const session = sessionFor(record, sessions);
  return session === undefined || NEEDS_ATTENTION_STATUSES.includes(session.status);
}

/**
 * §14.1's "collection flow" concept, replacing the old separate Sources/Destinations cards: a
 * user doesn't work with a source or a destination directly, they set up *where a collector
 * collects to* — one flow, named after its own source (a flow's name is always its source's own
 * `name`). Each row also names the flow's destination (or says it has none) and flags either half
 * needing a session reconnect.
 *
 * Adding a flow reuses `AddCollectorWizard` verbatim — it already builds a source paired with its
 * destination in one guided dialog, exactly the flow concept, previously only reachable from the
 * Collect page's own Add button; this is the same wizard, a second entry point.
 *
 * Deleting a flow always removes its source; whether its destination and either one's session also
 * go with it depends on whether anything else still uses them — `FlowsDelete`'s own cascade
 * (`deleteFlow()`, config-store.ts) decides that server-side, this UI just shows a confirm
 * explaining the possible cascade before calling it, since (unlike Sessions' own reversible
 * Logout) a flow delete cannot be undone.
 *
 * Collapsed by default, matching every other Settings section.
 */
export function CollectionFlowsSection() {
  const [sources, setSources] = useState<PluginBackedRecord[]>([]);
  const [destinations, setDestinations] = useState<PluginBackedRecord[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const [adding, setAdding] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PluginBackedRecord | undefined>(undefined);
  const [deleting, setDeleting] = useState(false);

  async function refresh() {
    const [nextSources, nextDestinations, nextSessions] = await Promise.all([
      window.api.configListSources(),
      window.api.configListDestinations(),
      window.api.sessionsList(),
    ]);
    setSources(nextSources);
    setDestinations(nextDestinations);
    setSessions(nextSessions);
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function confirmDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await window.api.flowsDelete(deleteTarget.id);
      toast.success(`"${deleteTarget.name}" deleted`);
      setDeleteTarget(undefined);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setDeleting(false);
    }
  }

  function destinationFor(source: PluginBackedRecord): PluginBackedRecord | undefined {
    return source.destinationId ? destinations.find((d) => d.id === source.destinationId) : undefined;
  }

  const staleCount = sources.filter((s) => {
    const destination = destinationFor(s);
    return recordNeedsAttention(s, sessions) || (destination !== undefined && recordNeedsAttention(destination, sessions));
  }).length;

  return (
    <>
      <Card className="py-0">
        <CardHeader className="cursor-pointer gap-1.5 py-4 select-none" onClick={() => setCollapsed((c) => !c)}>
          <CardTitle className="flex items-center gap-2">
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
            Collection flows
          </CardTitle>
          <CardDescription>
            {sources.length} flow{sources.length === 1 ? '' : 's'}
            {staleCount > 0 && `, ${staleCount} need${staleCount === 1 ? 's' : ''} reconnecting`}
          </CardDescription>
        </CardHeader>
        {!collapsed && (
          <CardContent className="flex flex-col gap-4 pb-4">
            <div className="flex flex-col gap-2">
              {sources.map((source) => {
                const destination = destinationFor(source);
                const sourceStale = recordNeedsAttention(source, sessions);
                const destinationStale = destination !== undefined && recordNeedsAttention(destination, sessions);
                return (
                  <div key={source.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                    <div className="flex flex-col gap-0.5 truncate">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        {source.name}
                        {sourceStale && <Badge variant="destructive">session</Badge>}
                      </span>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">
                        {destination ? `→ ${destination.name}` : 'No destination configured'}
                        {destinationStale && <Badge variant="destructive">destination session</Badge>}
                      </span>
                    </div>
                    <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => setDeleteTarget(source)}>
                      <Trash2 />
                      Delete
                    </Button>
                  </div>
                );
              })}
              {sources.length === 0 && <p className="text-sm text-muted-foreground">No collection flows yet.</p>}
            </div>
            <div>
              <Button type="button" variant="outline" onClick={() => setAdding(true)}>
                Add flow
              </Button>
            </div>
          </CardContent>
        )}
      </Card>

      {adding && (
        <AddCollectorWizard
          onClose={() => setAdding(false)}
          onCreated={() => {
            setAdding(false);
            void refresh();
          }}
        />
      )}

      <Dialog open={deleteTarget !== undefined} onOpenChange={(open) => !open && setDeleteTarget(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete "{deleteTarget?.name}"?</DialogTitle>
            <DialogDescription>
              Removes this flow's source. Its destination and either one's session are removed too, but only if nothing else still uses them — a
              destination or session shared with another flow stays put. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(undefined)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void confirmDelete()} disabled={deleting}>
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
