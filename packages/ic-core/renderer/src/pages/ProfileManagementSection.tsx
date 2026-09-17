import { useEffect, useState } from 'react';
import { Check, ChevronDown, ChevronRight, Download, Loader2, Plug, Plus, Trash2, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PasswordPromptDialog } from '@/components/PasswordPromptDialog';
import type { ConfigImportResult, EncryptedConfigExportFile, ProfileSummary } from '../../../electron/shared/ipcContracts';

type ImportResultItem = ConfigImportResult['importedSources'][number];

function ImportResultList({ title, items }: { title: string; items: ImportResultItem[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="mb-1 text-sm font-medium">{title}</p>
      <ul className="flex flex-col gap-1">
        {items.map((item) => (
          <li key={item.name} className="flex items-center justify-between gap-2 text-sm">
            <span>{item.name}</span>
            <span className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">{item.action === 'overwritten' ? 'Overwritten' : 'Added'}</span>
              {item.needsReconnect && <Badge variant="outline">Needs reconnect</Badge>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * Combines the reference app's own separate "Profiles" and "Import & export configuration" cards
 * into one "Profile management" card — export/import always apply to whichever profile is active,
 * so the two were already conceptually one topic, just split across two cards there. Collapsed by
 * default like `SessionsSection`/`PluginsSection` (phase 1.16's own pattern for a section that
 * isn't something a user needs to act on every visit); the card's own description always names the
 * active profile, both collapsed and expanded, so switching context away from Settings and back
 * still shows which profile is live without having to expand anything.
 */
export function ProfileManagementSection() {
  const [collapsed, setCollapsed] = useState(true);

  const [profiles, setProfiles] = useState<ProfileSummary[]>([]);
  const [profileBusyId, setProfileBusyId] = useState<string | undefined>(undefined);
  const [newProfileOpen, setNewProfileOpen] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileCopyCurrent, setNewProfileCopyCurrent] = useState(true);
  const [creatingProfile, setCreatingProfile] = useState(false);

  const [exportOpen, setExportOpen] = useState(false);
  const [importPasswordOpen, setImportPasswordOpen] = useState(false);
  const [importFile, setImportFile] = useState<EncryptedConfigExportFile | undefined>(undefined);
  const [importResult, setImportResult] = useState<ConfigImportResult | undefined>(undefined);
  const [busy, setBusy] = useState<'export' | 'import' | undefined>(undefined);

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
      const created = await window.api.profilesCreate({ name: newProfileName, copyFromCurrent: newProfileCopyCurrent });
      // A newly-created profile is what the user almost always wants to work in next — switching
      // to it here matches switchProfile()'s own behavior below, rather than leaving them still on
      // whichever profile was active before and having to find+click the new one separately.
      await window.api.profilesSwitch(created.id);
      await refreshProfiles();
      toast.success(`Created and switched to profile "${newProfileName}"`);
      setNewProfileOpen(false);
      setNewProfileName('');
      setNewProfileCopyCurrent(true);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingProfile(false);
    }
  }

  async function handleExport(password: string) {
    setBusy('export');
    try {
      const result = await window.api.configExportAll(password);
      if (result.exported) toast.success(`Saved to ${result.filePath}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
    }
  }

  async function handleImportClick() {
    const picked = await window.api.configPickImportFile();
    if (!picked) return;
    setImportFile(picked);
    setImportPasswordOpen(true);
  }

  async function handleImportPassword(password: string) {
    if (!importFile) return;
    setBusy('import');
    try {
      const result = await window.api.configImportAll(importFile, password);
      setImportResult(result);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(undefined);
      setImportFile(undefined);
    }
  }

  const activeProfileName = profiles.find((p) => p.isActive)?.name;

  return (
    <>
      <Card className="py-0">
        <CardHeader className="cursor-pointer gap-1.5 py-4 select-none" onClick={() => setCollapsed((c) => !c)}>
          <CardTitle className="flex items-center gap-2">
            {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
            Profile management
          </CardTitle>
          <CardDescription>{activeProfileName ? `Active profile: ${activeProfileName}` : 'Loading…'}</CardDescription>
        </CardHeader>
        {!collapsed && (
          <CardContent className="flex flex-col gap-6 pb-4">
            <div className="flex flex-col gap-2">
              <p className="text-sm text-muted-foreground">
                Separate, fully isolated configurations — sources, destinations, and invoice history each profile keeps entirely to itself. Export/import
                below always apply to whichever profile is active.
              </p>
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
            </div>

            <div className="flex flex-col gap-4 border-t pt-6">
              <div>
                <h3 className="text-sm font-medium">Import &amp; export configuration</h3>
                <p className="text-sm text-muted-foreground">
                  Export saves every source and destination — names, tenant IDs, and (where needed) client secrets — to a password-protected file. Import
                  adds or overwrites sources/destinations in this install from that file.
                </p>
              </div>
              <p className="text-xs text-muted-foreground">
                Sign-in tokens (device-flow Login/Reconnect, SharePoint Connect) are never included — reconnect those after import. The built-in local
                Downloads destination isn't included either; it's created automatically on every install. Importing a source or destination with the same
                name as an existing one overwrites it (keeping its existing sign-in, if any) rather than creating a duplicate.
              </p>
              <div className="flex gap-2">
                <Button onClick={() => setExportOpen(true)} disabled={busy !== undefined}>
                  <Download />
                  {busy === 'export' ? 'Exporting…' : 'Export configuration'}
                </Button>
                <Button variant="outline" onClick={() => void handleImportClick()} disabled={busy !== undefined}>
                  <Upload />
                  {busy === 'import' ? 'Importing…' : 'Import configuration'}
                </Button>
              </div>
            </div>
          </CardContent>
        )}
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

      <PasswordPromptDialog
        open={exportOpen}
        onOpenChange={setExportOpen}
        title="Set an export password"
        description="This password encrypts the export file. You'll need it again to import the file, so keep it somewhere safe."
        confirmLabel="Export"
        requireConfirmation
        onSubmit={(password) => void handleExport(password)}
      />
      <PasswordPromptDialog
        open={importPasswordOpen}
        onOpenChange={setImportPasswordOpen}
        title="Enter the export password"
        description="Enter the password the file was exported with."
        confirmLabel="Import"
        onSubmit={(password) => void handleImportPassword(password)}
      />

      <Dialog open={importResult !== undefined} onOpenChange={(open) => !open && setImportResult(undefined)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Import complete</DialogTitle>
            <DialogDescription>
              {importResult && `${importResult.importedSources.length} source(s) and ${importResult.importedDestinations.length} destination(s) processed.`}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4">
            {importResult && (
              <>
                <ImportResultList title="Destinations" items={importResult.importedDestinations} />
                <ImportResultList title="Sources" items={importResult.importedSources} />
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
