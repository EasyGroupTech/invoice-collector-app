import { useEffect, useState } from 'react';
import { Check, Loader2, Plug, Plus, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { ProfileSummary } from '../../../electron/shared/ipcContracts';

/**
 * Ported from the reference app's own Settings page verbatim (JSX, copy, layout) — a plain,
 * always-visible `Card`, deliberately not collapsed-by-default the way `SessionsSection`/
 * `PluginsSection` are (phase 1.16's own new pattern for a list that can grow long; profiles
 * don't). No delete-confirmation dialog either, matching the reference app exactly — the only
 * guard against a destructive mistake is that the delete button is hidden for the active profile
 * and for the last remaining one, so there's always at least one profile and you can never delete
 * the one you're currently using.
 *
 * Unlike the reference app (which keeps every page mounted at once and propagates a profile
 * switch via an explicit `onProfileChanged` callback + a `profileVersion` counter), this app's own
 * `App.tsx` unmounts `CollectPage` whenever the user navigates to Settings — so switching back to
 * Collect after a profile switch already remounts it fresh, re-running its own `refresh()`. No
 * extra propagation plumbing is needed here for the same end-user-visible result.
 */
export function ProfilesSection() {
  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profileBusyId, setProfileBusyId] = useState<string | undefined>(undefined);
  const [newProfileOpen, setNewProfileOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileCopyCurrent, setNewProfileCopyCurrent] = useState(true);
  const [creatingProfile, setCreatingProfile] = useState(false);

  function refreshProfiles() {
    return window.api.profilesList().then(setProfiles);
  }

  useEffect(() => {
    void refreshProfiles();
  }, []);

  async function switchProfile(id: string) {
    setProfileBusyId(id);
    try {
      await window.api.profilesSwitch(id);
      await refreshProfiles();
      toast.success('Switched profile');
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setProfileBusyId(undefined);
    }
  }

  async function deleteProfile(id: string, name: string) {
    setProfileBusyId(id);
    try {
      await window.api.profilesDelete(id);
      await refreshProfiles();
      toast(`Removed profile "${name}"`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setProfileBusyId(undefined);
    }
  }

  async function createProfile() {
    setCreatingProfile(true);
    try {
      await window.api.profilesCreate({ name: newProfileName, copyFromCurrent: newProfileCopyCurrent });
      await refreshProfiles();
      toast.success(`Created profile "${newProfileName}"`);
      setNewProfileOpen(false);
      setNewProfileName('');
      setNewProfileCopyCurrent(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingProfile(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Profiles</CardTitle>
          <CardDescription>
            Separate, fully isolated configurations — sources, destinations, and invoice history each profile keeps entirely to itself. Export/import
            always apply to whichever profile is active.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {profiles.map((p) => (
            <div key={p.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
              <span className="flex items-center gap-2 truncate text-sm font-medium">
                {p.name}
                {p.isActive && (
                  <Badge variant="outline" className="gap-1">
                    <Check className="size-3" />
                    Active
                  </Badge>
                )}
              </span>
              <div className="flex shrink-0 items-center gap-1">
                {!p.isActive && (
                  <Button size="sm" variant="outline" disabled={profileBusyId === p.id} onClick={() => void switchProfile(p.id)}>
                    {profileBusyId === p.id ? <Loader2 className="animate-spin" /> : <Plug />}
                    Switch
                  </Button>
                )}
                {!p.isActive && profiles.length > 1 && (
                  <Button variant="ghost" size="icon" disabled={profileBusyId === p.id} onClick={() => void deleteProfile(p.id, p.name)}>
                    <Trash2 />
                  </Button>
                )}
              </div>
            </div>
          ))}
          <Button variant="outline" className="w-fit" onClick={() => setNewProfileOpen(true)}>
            <Plus />
            New profile
          </Button>
        </CardContent>
      </Card>

      <Dialog open={newProfileOpen} onOpenChange={setNewProfileOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New profile</DialogTitle>
            <DialogDescription>A completely separate set of sources, destinations, and invoice history from the rest of this install.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="new-profile-name">Name</Label>
              <Input id="new-profile-name" value={newProfileName} onChange={(e) => setNewProfileName(e.target.value)} placeholder="Test" />
            </div>
            <div className="flex items-center gap-2">
              <Checkbox
                id="new-profile-copy"
                checked={newProfileCopyCurrent}
                onCheckedChange={(checked) => setNewProfileCopyCurrent(checked === true)}
              />
              <Label htmlFor="new-profile-copy" className="font-normal">
                Copy sources &amp; destinations from the current profile
              </Label>
            </div>
            <p className="text-xs text-muted-foreground">
              Invoice history is never copied — the new profile always starts with an empty collected-invoice record, even when copying
              sources/destinations.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNewProfileOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createProfile()} disabled={creatingProfile || !newProfileName.trim()}>
              {creatingProfile && <Loader2 className="animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
