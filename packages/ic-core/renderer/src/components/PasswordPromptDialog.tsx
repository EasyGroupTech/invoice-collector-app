import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

interface PasswordPromptDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  /** Export needs the password typed twice (nothing else ever gets a chance to catch a typo in a
   * password only ever stored in the user's own head) — import doesn't, since a wrong guess there
   * just fails to decrypt and can be retried immediately. */
  requireConfirmation?: boolean;
  onSubmit: (password: string) => void;
}

/** Ported from the reference app's own `PasswordPromptDialog` verbatim — shared between the
 * export and import flows (§6), just configured differently for each. No password-strength
 * guidance of any kind, matching the reference app exactly: just non-empty, and (for export)
 * matching its own confirmation field. */
export function PasswordPromptDialog({ open, onOpenChange, title, description, confirmLabel, requireConfirmation, onSubmit }: PasswordPromptDialogProps) {
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');

  useEffect(() => {
    if (open) {
      setPassword('');
      setConfirm('');
    }
  }, [open]);

  const mismatch = Boolean(requireConfirmation) && confirm.length > 0 && password !== confirm;
  const canSubmit = password.length > 0 && (!requireConfirmation || password === confirm);

  function handleSubmit() {
    if (!canSubmit) return;
    onSubmit(password);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="password-prompt-password">Password</Label>
            <Input
              id="password-prompt-password"
              type="password"
              autoFocus
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !requireConfirmation && handleSubmit()}
            />
          </div>
          {requireConfirmation && (
            <div className="flex flex-col gap-2">
              <Label htmlFor="password-prompt-confirm">Confirm password</Label>
              <Input
                id="password-prompt-confirm"
                type="password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSubmit()}
              />
              {mismatch && <p className="text-xs text-destructive">Passwords don't match.</p>}
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!canSubmit}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
