import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

/**
 * Ported from the reference app's own Settings page verbatim (JSX, copy, layout) — no adaptation
 * needed: `InvoiceHistoryStore.retentionMonths` already existed here (§14.1), just with no IPC
 * exposure or UI yet. `setRetentionMonths` deliberately doesn't prune immediately, matching the
 * reference app's own handler exactly — the new window only takes effect on the next `prune()`
 * call (already wired to run once per completed Collect, in `electron/main/index.ts`).
 *
 * The reference app's Settings page also has a second, separate "Invoice collection" card (a
 * buffer-days setting for the ARM billing-invoice query window) right next to this one — that's a
 * distinct concept with no equivalent here yet (ic-core's plugins each own their own listing
 * logic, there's no single shared query window to configure), so it's left for its own port later
 * rather than folded into this one.
 */
export function InvoiceHistorySection() {
  const [retentionMonths, setRetentionMonths] = useState<number | undefined>(undefined);
  const [savingRetention, setSavingRetention] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [clearingHistory, setClearingHistory] = useState(false);

  useEffect(() => {
    void window.api.historyGetRetentionMonths().then(setRetentionMonths);
  }, []);

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

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Invoice history</CardTitle>
          <CardDescription>How long the Collect page's per-month invoice list is kept before older months are dropped.</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
