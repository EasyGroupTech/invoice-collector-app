import { useState } from 'react';
import { Download, Upload } from 'lucide-react';
import { toast } from 'sonner';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PasswordPromptDialog } from '@/components/PasswordPromptDialog';
import type { ConfigImportResult, EncryptedConfigExportFile } from '../../../electron/shared/ipcContracts';

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
 * Ported from the reference app's own Settings page verbatim (JSX, copy, layout) — the only
 * adaptation is field-name parity with this app's own `ConfigImportItemResult` (`needsReconnect`,
 * not the reference app's `needsLogin` — same meaning, this app's own established term for a
 * record with no working session attached). Both export and import go through native OS
 * dialogs entirely on the main-process side (`dialog.showSaveDialog`/`showOpenDialog`, same
 * pattern already used for SBOM/report export) — the renderer never touches a file directly.
 * Import is deliberately two IPC calls (pick the file, then ask for its password), matching the
 * reference app's own reasoning: asking for a passphrase before the user has even chosen a file
 * is backwards.
 *
 * Doesn't call the reference app's own post-import `refreshAll()` — same reasoning as
 * `ProfilesSection`'s own skip of `onProfileChanged`: this app's `App.tsx` unmounts `CollectPage`
 * whenever the user navigates to Settings, so it already remounts fresh (re-fetching sources/
 * destinations) on the way back, with no extra propagation needed for the same end result.
 */
export function ImportExportSection() {
  const [exportOpen, setExportOpen] = useState(false);
  const [importPasswordOpen, setImportPasswordOpen] = useState(false);
  const [importFile, setImportFile] = useState<EncryptedConfigExportFile | undefined>(undefined);
  const [importResult, setImportResult] = useState<ConfigImportResult | undefined>(undefined);
  const [busy, setBusy] = useState<'export' | 'import' | undefined>(undefined);

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

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Import &amp; export configuration</CardTitle>
          <CardDescription>
            Export saves every source and destination — names, tenant IDs, and (where needed) client secrets — to a password-protected file. Import adds
            or overwrites sources/destinations in this install from that file.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
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
        </CardContent>
      </Card>

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
