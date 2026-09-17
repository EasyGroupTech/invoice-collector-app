import { useEffect, useState } from 'react';
import type { Session } from 'invoice-collector-plugin-sdk';
import { ChevronDown, ChevronRight, Download } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DeviceCodeSignInPrompt, extractDeviceCodeInfo } from '@/components/DeviceCodeSignInPrompt';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import type { InstalledPluginSummary } from '../../../electron/shared/ipcContracts';
import { validateWizardValues, type WizardFieldValues } from '../../../src/wizard-form-state.js';
import { WizardSteps } from '../descriptors/WizardSteps';
import { useJob } from '../hooks/useJob';

type BusyAction = 'login' | 'refresh' | 'logout' | 'rotate';

/**
 * Replaces the old `SessionsSection`'s single "Reconnect" button (silent-refresh-first,
 * interactive-fallback) with three distinct actions per §6, scoped to whichever profile is
 * currently active (sessionsRegistry/sessionsList are rebuilt on every profile switch, same as
 * invoiceHistory — see main/index.ts):
 *
 * - **Login** reuses `SessionsReconnect`/`SessionsApi.reconnect` verbatim (still tries a silent
 *   refresh first, only falling back to a real interactive sign-in when that fails) — a click here
 *   still gets an instant no-op-ish result for an already-active session, and a real device-code
 *   prompt for one that actually needs it.
 * - **Refresh** is new: `SessionsRegistry.recoverSession` (already existed, used internally for
 *   HttpApi's 401-triggered recovery) exposed as its own silent-only IPC action — no interactive
 *   fallback, so unlike Login it simply fails with an error toast if there's no refresh mechanism
 *   or the attempt itself doesn't succeed.
 * - **Logout** is new: `SessionsRegistry.logoutSession` only clears the stored credentials and
 *   moves the session to `needs-reconnect` — it does *not* delete the session record (§14.1: only
 *   a flow deletion's own cascade, once nothing references a session any more, actually removes
 *   one). Fully reversible with a Login click, so — unlike a real delete — no confirm dialog: same
 *   directness as Refresh.
 * - **Rotate** (phase 1.21) — only shown for a session type whose owning plugin declared
 *   `createInputFields` on its `SessionRequirement` (found by scanning `pluginsList()`, the same
 *   way the Add-Collector wizard's own `ConnectPanel` renders that form at fresh-create time):
 *   opens a dialog collecting fresh values through the exact same `WizardSteps` form, then calls
 *   `SessionsRotate`/`SessionsApi.rotate` instead of `create()`ing a brand new session — the
 *   point is swapping a new secret into the *same* session record (e.g. Azure Billing's
 *   secure-line client secret, which has a real expiry `reconnect()` alone can't fix by itself,
 *   since it only ever replays the *old*, now-expired input). Every session type without
 *   `createInputFields` (a device-code sign-in, a captured browser session) has nothing for this
 *   to collect, so no Rotate button shows at all — Login already covers those. Also shows the
 *   same `downloadableAsset` "Download {label}" button `ConnectPanel` shows at fresh-create time
 *   (phase 1.25), when the plugin declared one — rotating because a secret expired needs a *new*
 *   one from the exact same script that set it up in the first place, not just the paste field.
 *
 * Collapsed by default like `PluginsSection`; the card description is always a plain status
 * summary (active vs. needing attention), both collapsed and expanded — no per-row Type/Expires
 * columns anymore, just name + these three actions.
 */
interface SessionStatusSectionProps {
  /**
   * Bumped by `SettingsPage` (via `CollectionFlowsSection`'s own `onSessionsChanged`) whenever a
   * flow add/edit/delete elsewhere on the page could have changed which sessions exist — this
   * component fetches its own session list independently and has no other way to know that
   * happened. Without this, a flow delete that cascades to removing a session (§14.1,
   * `deleteFlow()`) leaves this card still showing that session as active until something else
   * happens to remount it.
   */
  refreshKey?: number;
}

export function SessionStatusSection({ refreshKey }: SessionStatusSectionProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [allPlugins, setAllPlugins] = useState<InstalledPluginSummary[]>([]);
  const [collapsed, setCollapsed] = useState(true);
  const [busySessionId, setBusySessionId] = useState<string | undefined>(undefined);
  const [busyAction, setBusyAction] = useState<BusyAction | undefined>(undefined);
  const loginJob = useJob<Session>();
  const rotateJob = useJob<Session>();
  const [rotateTarget, setRotateTarget] = useState<Session | undefined>(undefined);
  const [rotateValues, setRotateValues] = useState<WizardFieldValues>({});

  async function refresh() {
    setSessions(await window.api.sessionsList());
  }

  useEffect(() => {
    void refresh();
    void window.api.pluginsList().then(setAllPlugins);
  }, [refreshKey]);

  // The one SessionRequirement (across every installed plugin) whose sessionTypeId matches this
  // session's own type — backs both createInputFieldsFor (the form Rotate re-collects) and
  // downloadableAssetFor (the same "Download {label}" button ConnectPanel shows at fresh-create
  // time, e.g. Azure Billing's onboarding script — needed here too, since rotating because a
  // secret expired needs a *new* one from the exact same script).
  function requirementFor(session: Session) {
    for (const plugin of allPlugins) {
      const requirement = plugin.sessionRequirements.find((r) => r.sessionTypeId === session.sessionTypeId);
      if (requirement) return requirement;
    }
    return undefined;
  }

  function createInputFieldsFor(session: Session) {
    const fields = requirementFor(session)?.createInputFields;
    return fields?.length ? fields : undefined;
  }

  function downloadableAssetFor(session: Session) {
    return requirementFor(session)?.downloadableAsset;
  }

  async function downloadAsset(session: Session) {
    const asset = downloadableAssetFor(session);
    if (!asset) return;
    try {
      const result = await window.api.pluginsDownloadAsset({ pluginId: session.createdByPluginId, sessionTypeId: session.sessionTypeId });
      if (result.exported) toast.success(`Saved to ${result.filePath}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }

  async function login(session: Session) {
    setBusySessionId(session.id);
    setBusyAction('login');
    try {
      await loginJob.start(window.api.sessionsReconnect({ pluginId: session.createdByPluginId, sessionId: session.id }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
      setBusySessionId(undefined);
      setBusyAction(undefined);
    }
  }

  function cancelLogin() {
    loginJob.cancel();
    setBusySessionId(undefined);
    setBusyAction(undefined);
  }

  // Reacts to the login job's own terminal result, whichever path it actually took (a silent
  // refresh or the interactive fallback) — `login()` above only awaits the job *starting*.
  useEffect(() => {
    if (!loginJob.result || !busySessionId || busyAction !== 'login') return;
    const label = sessions.find((s) => s.id === busySessionId)?.label ?? 'Session';
    if (loginJob.result.ok) {
      toast.success(`${label} signed in`);
      void refresh();
    } else {
      toast.error(loginJob.result.error);
    }
    setBusySessionId(undefined);
    setBusyAction(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loginJob.result]);

  async function doRefresh(session: Session) {
    setBusySessionId(session.id);
    setBusyAction('refresh');
    try {
      await window.api.sessionsRefresh({ pluginId: session.createdByPluginId, sessionId: session.id });
      toast.success(`${session.label} refreshed`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySessionId(undefined);
      setBusyAction(undefined);
    }
  }

  async function logout(session: Session) {
    setBusySessionId(session.id);
    setBusyAction('logout');
    try {
      await window.api.sessionsLogout(session.id);
      toast(`Logged out ${session.label}`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySessionId(undefined);
      setBusyAction(undefined);
    }
  }

  function openRotate(session: Session) {
    setRotateTarget(session);
    setRotateValues({});
  }

  function cancelRotate() {
    rotateJob.cancel();
    setRotateTarget(undefined);
    setRotateValues({});
    setBusySessionId(undefined);
    setBusyAction(undefined);
  }

  function submitRotate() {
    if (!rotateTarget) return;
    setBusySessionId(rotateTarget.id);
    setBusyAction('rotate');
    void rotateJob.start(window.api.sessionsRotate({ pluginId: rotateTarget.createdByPluginId, sessionId: rotateTarget.id, input: rotateValues }));
  }

  // Reacts to the rotate job's own terminal result, same pattern as the login job above.
  useEffect(() => {
    if (!rotateJob.result || !rotateTarget) return;
    if (rotateJob.result.ok) {
      toast.success(`${rotateTarget.label} rotated`);
      setRotateTarget(undefined);
      setRotateValues({});
      void refresh();
    } else {
      toast.error(rotateJob.result.error);
    }
    setBusySessionId(undefined);
    setBusyAction(undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rotateJob.result]);

  const activeCount = sessions.filter((s) => s.status === 'active').length;
  const needsAttentionCount = sessions.length - activeCount;
  const statusSummary =
    sessions.length === 0
      ? 'No sessions yet'
      : `${activeCount} active${needsAttentionCount > 0 ? `, ${needsAttentionCount} need${needsAttentionCount === 1 ? 's' : ''} attention` : ''}`;

  const deviceCodeInfo = busyAction === 'login' && busySessionId && !loginJob.result ? extractDeviceCodeInfo(loginJob.progressLog) : undefined;

  return (
    <>
      <Card className="py-0">
        <CardHeader className="cursor-pointer gap-1.5 py-4 select-none" onClick={() => setCollapsed((c) => !c)}>
          <CardTitle className="flex items-center gap-2">
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
            Current profile session status
          </CardTitle>
          <CardDescription>{statusSummary}</CardDescription>
        </CardHeader>
        {!collapsed && (
          <CardContent className="flex flex-col gap-2 pb-4">
            {sessions.map((s) => {
              const rowBusy = busySessionId === s.id;
              const rotateFields = createInputFieldsFor(s);
              return (
                <div key={s.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <span className="flex items-center gap-2 truncate text-sm font-medium">
                    {s.label}
                    <Badge variant={s.status === 'active' ? 'secondary' : 'destructive'}>{s.status}</Badge>
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button size="sm" variant="outline" disabled={busySessionId !== undefined} onClick={() => void login(s)}>
                      {rowBusy && busyAction === 'login' ? 'Signing in…' : 'Login'}
                    </Button>
                    <Button size="sm" variant="outline" disabled={busySessionId !== undefined} onClick={() => void doRefresh(s)}>
                      {rowBusy && busyAction === 'refresh' ? 'Refreshing…' : 'Refresh'}
                    </Button>
                    {rotateFields && (
                      <Button size="sm" variant="outline" disabled={busySessionId !== undefined} onClick={() => openRotate(s)}>
                        Rotate
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" disabled={busySessionId !== undefined} onClick={() => void logout(s)}>
                      {rowBusy && busyAction === 'logout' ? 'Logging out…' : 'Logout'}
                    </Button>
                  </div>
                </div>
              );
            })}
            {sessions.length === 0 && (
              <p className="text-sm text-muted-foreground">No sessions yet — sessions are created from a source/destination's Add wizard.</p>
            )}
          </CardContent>
        )}
      </Card>

      {deviceCodeInfo !== undefined ? (
        <Dialog open onOpenChange={(open) => !open && cancelLogin()}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Sign in</DialogTitle>
            </DialogHeader>
            <DeviceCodeSignInPrompt progressLog={loginJob.progressLog} />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={cancelLogin}>
                Cancel
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}

      {rotateTarget && (
        <Dialog open onOpenChange={(open) => !open && cancelRotate()}>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Rotate {rotateTarget.label}</DialogTitle>
            </DialogHeader>
            <fieldset disabled={busySessionId !== undefined} className="flex flex-col gap-3">
              {downloadableAssetFor(rotateTarget) && (
                <Button type="button" variant="outline" size="sm" className="w-fit" onClick={() => void downloadAsset(rotateTarget)}>
                  <Download />
                  Download {downloadableAssetFor(rotateTarget)?.label}
                </Button>
              )}
              <WizardSteps
                pluginId={rotateTarget.createdByPluginId}
                steps={createInputFieldsFor(rotateTarget) ?? []}
                values={rotateValues}
                onChange={(name, value) => setRotateValues((prev) => ({ ...prev, [name]: value }))}
              />
              {rotateJob.result && !rotateJob.result.ok && <p className="text-sm text-destructive">{rotateJob.result.error}</p>}
            </fieldset>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={cancelRotate}>
                Cancel
              </Button>
              <Button
                type="button"
                disabled={busySessionId !== undefined || !validateWizardValues(createInputFieldsFor(rotateTarget) ?? [], rotateValues).valid}
                onClick={submitRotate}
              >
                {busyAction === 'rotate' ? 'Rotating…' : 'Rotate'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
