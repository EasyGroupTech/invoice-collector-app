import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AdvancedSettings } from '../../../electron/shared/ipcContracts';

// Same debounce window WizardSteps.tsx's own auto-apply-on-change fields use — long enough that a
// still-typing user doesn't fire a save per keystroke, short enough that autosave still feels
// immediate once they pause.
const AUTOSAVE_DEBOUNCE_MS = 400;

/**
 * §7's HTTP retry policy, plus §14.1's Invoice history retention/clear as a second subsection
 * below a divider — both are "set once, rarely revisited" app-behavior preferences, the same
 * reasoning `SettingsPage`'s own doc comment already gives for putting Advanced Settings last, so
 * folding history retention in here (rather than its own always-open card) keeps that grouping
 * consistent instead of treating one "set and forget" setting differently from another.
 *
 * Every field here is one row — label then input, inline (`flex items-center gap-2`), no Save
 * button — autosaved instead, debounced, the same shape for both subsections: a field's own
 * `useEffect` skips its *first* run (the initial load landing, not a user edit — tracked per field
 * via its own `justLoaded` ref, since the effect can't tell "value changed because it was fetched"
 * from "value changed because the user typed" any other way) and otherwise debounce-saves on every
 * change after that. "Clear history" stays a real button — it's a destructive one-shot action, not
 * a value to autosave.
 *
 * The reference app's separate "Invoice collection" card (a buffer-days setting for the ARM
 * billing-invoice query window) still has no equivalent here — ic-core's plugins each own their
 * own listing logic, there's no single shared query window to configure — left for its own port
 * later, same as before this move.
 *
 * Collapsed by default, same as every other Settings section — "set once, rarely revisited" is as
 * true of the whole card as it is of each field inside it. The collapsed description summarizes
 * both subsections' current values so there's still something to glance at without expanding.
 */
export function AdvancedSettingsSection() {
  const [settings, setSettings] = useState<AdvancedSettings | undefined>(undefined);
  const [retentionMonths, setRetentionMonths] = useState<number | undefined>(undefined);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  const settingsJustLoaded = useRef(true);
  const retentionJustLoaded = useRef(true);

  useEffect(() => {
    void window.api.settingsGetAdvanced().then(setSettings);
    void window.api.historyGetRetentionMonths().then(setRetentionMonths);
  }, []);

  useEffect(() => {
    if (!settings) return; // still loading — nothing to autosave yet
    if (settingsJustLoaded.current) {
      settingsJustLoaded.current = false; // this run is the initial fetch landing, not an edit
      return;
    }
    const timer = setTimeout(() => {
      window.api
        .settingsSaveAdvanced(settings)
        .then(() => toast.success('Advanced Settings saved'))
        .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings?.retryPolicy.baseDelayMs, settings?.retryPolicy.maxRetries]);

  useEffect(() => {
    if (retentionMonths === undefined || retentionMonths < 1) return; // still loading, or mid-edit to an invalid value
    if (retentionJustLoaded.current) {
      retentionJustLoaded.current = false;
      return;
    }
    const timer = setTimeout(() => {
      window.api
        .historySetRetentionMonths(retentionMonths)
        .then(() => toast.success('History retention updated'))
        .catch((err) => toast.error(err instanceof Error ? err.message : String(err)));
    }, AUTOSAVE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [retentionMonths]);

  async function handleClearHistory() {
    setClearingHistory(true);
    try {
      await window.api.historyClearAll();
      toast.success('Invoice history cleared');
      setClearConfirmOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setClearingHistory(false);
    }
  }

  if (!settings) return null;

  return (
    <>
      <Card className="py-0">
        <CardHeader className="cursor-pointer gap-1.5 py-4 select-none" onClick={() => setCollapsed((c) => !c)}>
          <CardTitle className="flex items-center gap-2">
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
            Advanced Settings
          </CardTitle>
          <CardDescription>
            {settings.retryPolicy.baseDelayMs}ms base delay, {settings.retryPolicy.maxRetries} max retries
            {retentionMonths !== undefined && ` · history kept ${retentionMonths} months`}
          </CardDescription>
        </CardHeader>
        {!collapsed && (
          <CardContent className="flex flex-col gap-6 pb-4">
            <div className="flex flex-col gap-4">
              <p className="text-sm text-muted-foreground">HTTP retry policy (§7) — how a plugin's outbound requests retry on a 429/throttling response.</p>
              <div className="flex items-center gap-2">
                <Label htmlFor="retry-base-delay">Base delay (ms)</Label>
                <Input
                  id="retry-base-delay"
                  type="number"
                  min={0}
                  value={settings.retryPolicy.baseDelayMs}
                  onChange={(e) => setSettings({ ...settings, retryPolicy: { ...settings.retryPolicy, baseDelayMs: e.target.valueAsNumber } })}
                  className="w-24"
                />
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="retry-max-retries">Max retries</Label>
                <Input
                  id="retry-max-retries"
                  type="number"
                  min={0}
                  value={settings.retryPolicy.maxRetries}
                  onChange={(e) => setSettings({ ...settings, retryPolicy: { ...settings.retryPolicy, maxRetries: e.target.valueAsNumber } })}
                  className="w-24"
                />
              </div>
            </div>

            <div className="flex flex-col gap-4 border-t pt-6">
              <div>
                <h3 className="text-sm font-medium">Invoice history</h3>
                <p className="text-sm text-muted-foreground">How long the Collect page's per-month invoice list is kept before older months are dropped.</p>
              </div>
              <div className="flex items-center gap-2">
                <Label htmlFor="retention-months">Keep history for</Label>
                <Input
                  id="retention-months"
                  type="number"
                  min={1}
                  value={retentionMonths ?? ''}
                  onChange={(e) => setRetentionMonths(e.target.value ? Number(e.target.value) : undefined)}
                  className="w-20"
                />
                <span className="text-sm text-muted-foreground">months</span>
              </div>
              <div className="flex items-center gap-2">
                <Button size="sm" variant="outline" onClick={() => setClearConfirmOpen(true)}>
                  <Trash2 />
                  Clear history
                </Button>
                <span className="text-xs text-muted-foreground">Removes every collected-invoice record — useful for clearing out test data.</span>
              </div>
            </div>
          </CardContent>
        )}
      </Card>

      <Dialog open={clearConfirmOpen} onOpenChange={setClearConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Clear invoice history?</DialogTitle>
            <DialogDescription>
              This removes every collected-invoice record for every month. It only clears the local history — it doesn't delete anything already
              uploaded to a destination, and re-collecting will just re-detect those files as already present. This can't be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setClearConfirmOpen(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void handleClearHistory()} disabled={clearingHistory}>
              {clearingHistory ? 'Clearing…' : 'Clear history'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
