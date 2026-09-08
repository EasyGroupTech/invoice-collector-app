import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AdvancedSettings } from '../../../electron/shared/ipcContracts';

/**
 * §7's HTTP retry policy, plus §14.1's Invoice history retention/clear as a second subsection
 * below a divider — both are "set once, rarely revisited" app-behavior preferences, the same
 * reasoning `SettingsPage`'s own doc comment already gives for putting Advanced Settings last, so
 * folding history retention in here (rather than its own always-open card) keeps that grouping
 * consistent instead of treating one "set and forget" setting differently from another. Ported
 * from the reference app's own Invoice history card verbatim (JSX, copy, layout, including
 * `setRetentionMonths` deliberately not pruning immediately — the new window only takes effect on
 * the next `prune()` call, already wired to run once per completed Collect).
 *
 * The reference app's separate "Invoice collection" card (a buffer-days setting for the ARM
 * billing-invoice query window) still has no equivalent here — ic-core's plugins each own their
 * own listing logic, there's no single shared query window to configure — left for its own port
 * later, same as before this move.
 */
export function AdvancedSettingsSection() {
  const [settings, setSettings] = useState<AdvancedSettings | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  const [retentionMonths, setRetentionMonths] = useState<number | undefined>(undefined);
  const [savingRetention, setSavingRetention] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);

  useEffect(() => {
    void window.api.settingsGetAdvanced().then(setSettings);
    void window.api.historyGetRetentionMonths().then(setRetentionMonths);
  }, []);

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      const result = await window.api.settingsSaveAdvanced(settings);
      setSettings(result);
      toast.success('Advanced Settings saved');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleSaveRetention() {
    if (retentionMonths === undefined || retentionMonths < 1) return;
    setSavingRetention(true);
    try {
      await window.api.historySetRetentionMonths(retentionMonths);
      toast.success('History retention updated');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingRetention(false);
    }
  }

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
      <Card>
        <CardHeader>
          <CardTitle>Advanced Settings</CardTitle>
          <p className="text-sm text-muted-foreground">HTTP retry policy (§7) — how a plugin's outbound requests retry on a 429/throttling response.</p>
        </CardHeader>
        <CardContent className="flex flex-col gap-6">
          <fieldset disabled={saving} className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="retry-base-delay">Base delay (ms)</Label>
              <Input
                id="retry-base-delay"
                type="number"
                min={0}
                value={settings.retryPolicy.baseDelayMs}
                onChange={(e) => setSettings({ ...settings, retryPolicy: { ...settings.retryPolicy, baseDelayMs: e.target.valueAsNumber } })}
                className="max-w-40"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="retry-max-retries">Max retries</Label>
              <Input
                id="retry-max-retries"
                type="number"
                min={0}
                value={settings.retryPolicy.maxRetries}
                onChange={(e) => setSettings({ ...settings, retryPolicy: { ...settings.retryPolicy, maxRetries: e.target.valueAsNumber } })}
                className="max-w-40"
              />
            </div>
            <div>
              <Button type="button" onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </fieldset>

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
              <Button
                size="sm"
                variant="outline"
                onClick={() => void handleSaveRetention()}
                disabled={savingRetention || retentionMonths === undefined || retentionMonths < 1}
              >
                Save
              </Button>
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
