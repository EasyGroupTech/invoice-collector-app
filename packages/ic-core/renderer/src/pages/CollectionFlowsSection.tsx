import { useEffect, useState } from 'react';
import type { PluginBackedRecord, Session } from 'invoice-collector-plugin-sdk';
import { ChevronDown, ChevronRight, Pencil, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { InstalledPluginSummary } from '../../../electron/shared/ipcContracts';
import { joinScope, splitScope } from '../../../src/scope-format.js';
import { validateWizardValues, type WizardFieldValues } from '../../../src/wizard-form-state.js';
import { WizardSteps } from '../descriptors/WizardSteps';
import { AddCollectorWizard } from './AddCollectorWizard';
import { sessionFor } from './SourcesDestinationsSection';

const NEEDS_ATTENTION_STATUSES: Session['status'][] = ['expired', 'needs-reconnect'];
const NO_DESTINATION_VALUE = '__none__';

/** True for a record (source or destination) whose own session is either stale (expired/needs-
 * reconnect) or gone entirely (a sessionId that no longer resolves at all — e.g. a Logout that
 * cleared credentials still leaves the session id assigned, but a full delete elsewhere wouldn't).
 * A record with no sessionId assigned yet isn't "stale," just not connected. */
function recordNeedsAttention(record: PluginBackedRecord, sessions: Session[]): boolean {
  if (!record.sessionId) return false;
  const session = sessionFor(record, sessions);
  return session === undefined || NEEDS_ATTENTION_STATUSES.includes(session.status);
}

interface EditFlowDialogProps {
  source: PluginBackedRecord;
  destinations: PluginBackedRecord[];
  onClose: () => void;
  onSaved: () => void;
}

/**
 * §14.1's flow editing — the flow's own plugin can't change (that's what makes it the same flow),
 * so this only ever re-renders the same `WizardSteps` `AddCollectorWizard`'s own configure step
 * uses, pre-filled from the existing record, plus name/scope/destination. Session reassignment
 * isn't here — see `UpdateFlowInput`'s own doc comment (ipcContracts.ts) for why.
 */
function EditFlowDialog({ source, destinations, onClose, onSaved }: EditFlowDialogProps) {
  const [plugin, setPlugin] = useState<InstalledPluginSummary | undefined>(undefined);
  const [name, setName] = useState(source.name);
  // Only the user's own typed half is ever shown/edited here — whatever a ScopeDescriber-backed
  // plugin last appended (scope-format.ts's ` · accounts...` half) stays out of this field
  // entirely, carried forward as-is until the next real collect run recomputes it fresh.
  const initialScope = splitScope(source.scope);
  const [scope, setScope] = useState(initialScope.prefix);
  const [discoveredScope] = useState(initialScope.discovered);
  const [destinationId, setDestinationId] = useState<string | undefined>(source.destinationId ?? undefined);
  const [values, setValues] = useState<WizardFieldValues>((source.config as WizardFieldValues) ?? {});
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.api.pluginsList().then((all) => setPlugin(all.find((p) => p.manifest.id === source.pluginId)));
  }, [source.pluginId]);

  async function submit() {
    if (!plugin) return;
    const validation = validateWizardValues(plugin.wizard, values);
    if (!validation.valid) {
      setError(`Missing required field(s): ${validation.missingFields.join(', ')}`);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      await window.api.flowsUpdate({
        sourceId: source.id,
        name: name || plugin.manifest.name,
        scope: joinScope(scope, discoveredScope) || undefined,
        config: values,
        destinationId: destinationId ?? null,
      });
      // Pointing the flow at a different destination (or at none) can leave the old one — and its
      // own session, if nothing else uses it either — referenced by nothing. Best-effort: a failed
      // sweep here should never block the edit itself from being considered saved.
      await window.api.flowsSweepOrphans().catch(() => {});
      toast.success(`"${name || plugin.manifest.name}" saved`);
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-[80vh] flex-col gap-4 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Edit flow</DialogTitle>
        </DialogHeader>

        {plugin && (
          <fieldset disabled={saving} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-flow-name">Source name</Label>
              <Input id="edit-flow-name" value={name} onChange={(e) => setName(e.target.value)} placeholder={plugin.manifest.name} />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-flow-scope">Scope (optional)</Label>
              <Input id="edit-flow-scope" value={scope} onChange={(e) => setScope(e.target.value)} placeholder="e.g. Finance department" />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="edit-flow-destination">Destination</Label>
              <Select
                value={destinationId ?? NO_DESTINATION_VALUE}
                onValueChange={(v) => setDestinationId(v === NO_DESTINATION_VALUE ? undefined : v)}
              >
                <SelectTrigger id="edit-flow-destination" className="w-full">
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_DESTINATION_VALUE}>None</SelectItem>
                  {destinations.map((d) => (
                    <SelectItem key={d.id} value={d.id}>
                      {d.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <WizardSteps
              pluginId={plugin.manifest.id}
              steps={plugin.wizard}
              values={values}
              sessionId={source.sessionId}
              onChange={(n, v) => setValues((prev) => ({ ...prev, [n]: v }))}
            />
            {error && <p className="text-sm text-destructive">{error}</p>}
          </fieldset>
        )}

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button type="button" disabled={!plugin || saving} onClick={() => void submit()}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
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
 * Collect page's own Add button; this is the same wizard, a second entry point. Editing a flow
 * (`EditFlowDialog`, above) is a narrower, single-step counterpart — a flow's plugin is fixed once
 * created, so there's no multi-step "choose connections"/"establish connections" to re-walk, just
 * its own name/scope/config/destination.
 *
 * Deleting a flow always removes its source; whether its destination and either one's session also
 * go with it depends on whether anything else still uses them — `FlowsDelete`'s own cascade
 * (`deleteFlow()`, config-store.ts) decides that server-side, this UI just shows a confirm
 * explaining the possible cascade before calling it, since (unlike Sessions' own reversible
 * Logout) a flow delete cannot be undone.
 *
 * Collapsed by default, matching every other Settings section.
 */
interface CollectionFlowsSectionProps {
  /**
   * Called every time this section's own `refresh()` runs (mount, or after add/edit/delete) —
   * `SessionStatusSection` renders its own, separately-fetched session list right above this card
   * on the same Settings page, with no way to know a delete's cascade (§14.1, `deleteFlow()`) just
   * removed a session out from under it. Without this, that section keeps showing an
   * already-deleted session as still present until something else happens to remount it (e.g.
   * navigating away from Settings and back).
   */
  onSessionsChanged?: () => void;
}

export function CollectionFlowsSection({ onSessionsChanged }: CollectionFlowsSectionProps) {
  const [sources, setSources] = useState<PluginBackedRecord[]>([]);
  const [destinations, setDestinations] = useState<PluginBackedRecord[]>([]);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const [adding, setAdding] = useState(false);
  const [editTarget, setEditTarget] = useState<PluginBackedRecord | undefined>(undefined);
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
    onSessionsChanged?.();
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
                    <div className="flex shrink-0 items-center gap-1">
                      <Button type="button" variant="outline" size="sm" onClick={() => setEditTarget(source)}>
                        <Pencil />
                        Edit
                      </Button>
                      <Button type="button" variant="outline" size="sm" onClick={() => setDeleteTarget(source)}>
                        <Trash2 />
                        Delete
                      </Button>
                    </div>
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

      {editTarget && (
        <EditFlowDialog
          source={editTarget}
          destinations={destinations}
          onClose={() => setEditTarget(undefined)}
          onSaved={() => {
            setEditTarget(undefined);
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
