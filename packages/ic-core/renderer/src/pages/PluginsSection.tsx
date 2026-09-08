import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { InstalledPluginSummary, SbomEntry } from '../../../electron/shared/ipcContracts';

/** §9.1's one Install Plugin entry point + §9's two-tier trust warning, plus uninstall (§5's
 * "preserve, don't delete" — ic-core's uninstallPlugin() already only touches the plugin's own
 * package files). Enable/disable isn't here — same known, deliberately-deferred gap
 * docs/implementation-plan.md's phase 1.11/1.12 notes track (no installed-plugin persistence
 * across a restart yet, so "disable" has nothing durable to attach to today).
 *
 * §13's "Third-Party Licenses"/SBOM screen lives here too, as a second subsection below a divider
 * — the reference app's own SBOM card was really "the license/component detail behind whatever's
 * installed," which is exactly what this card is already about; splitting it into its own
 * always-open card (as it was before) just meant two separate places to look for one topic. Its
 * own per-package expand/collapse (`expandedSbomEntries`) is independent of this card's own
 * collapse state.
 *
 * A Settings section (§8, phase 1.16), collapsed by default the same way the reference app's own
 * `SourcesPage` collapses its list — this can grow long and isn't something most sessions need
 * open at a glance the way Collect is. */
export function PluginsSection() {
  const [plugins, setPlugins] = useState<InstalledPluginSummary[]>([]);
  const [rawInput, setRawInput] = useState('');
  const [pendingConfirmation, setPendingConfirmation] = useState<{ manifestId: string; manifestName: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  const [sbomEntries, setSbomEntries] = useState<SbomEntry[]>([]);
  const [expandedSbomEntries, setExpandedSbomEntries] = useState<Record<string, boolean>>({});

  async function refresh() {
    setPlugins(await window.api.pluginsList());
  }

  useEffect(() => {
    void refresh();
    void window.api.sbomList().then(setSbomEntries);
  }, []);

  async function install(confirmUnverified: boolean) {
    setBusy(true);
    try {
      const result = await window.api.pluginsInstall({ rawInput, confirmUnverified });
      if (result.status === 'needs-confirmation') {
        setPendingConfirmation({ manifestId: result.manifest.id, manifestName: result.manifest.name });
        return;
      }
      setPendingConfirmation(undefined);
      setRawInput('');
      toast.success(`${result.manifest.name} installed`);
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function uninstall(pluginId: string) {
    setBusy(true);
    try {
      await window.api.pluginsUninstall(pluginId);
      toast.success('Plugin uninstalled');
      await refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="py-0">
      <CardHeader className="cursor-pointer gap-1.5 py-4 select-none" onClick={() => setCollapsed((c) => !c)}>
        <CardTitle className="flex items-center gap-2">
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
          Plugins
        </CardTitle>
        <CardDescription>
          {plugins.length} installed — install and manage source/destination plugins.
        </CardDescription>
      </CardHeader>
      {!collapsed && (
        <CardContent className="flex flex-col gap-4 pb-4">
          <fieldset disabled={busy} className="contents">
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Version</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Trust</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {plugins.map((p) => (
                    <TableRow key={p.manifest.id}>
                      <TableCell>{p.manifest.name}</TableCell>
                      <TableCell>{p.manifest.version}</TableCell>
                      <TableCell>{p.manifest.kind}</TableCell>
                      <TableCell>{p.manifest.repository ? `Open source — ${p.manifest.repository}` : 'Unverified'}</TableCell>
                      <TableCell>
                        <Button type="button" variant="outline" size="sm" onClick={() => void uninstall(p.manifest.id)}>
                          Uninstall
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {plugins.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-muted-foreground">
                        No plugins installed yet.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>

            <Card>
              <CardHeader>
                <CardTitle>Install a plugin</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-4">
                <div className="flex items-center gap-2">
                  <Input placeholder="Plugin URL" value={rawInput} onChange={(e) => setRawInput(e.target.value)} className="flex-1" />
                  <Button type="button" disabled={!rawInput} onClick={() => void install(false)}>
                    Install
                  </Button>
                </div>

                {pendingConfirmation && (
                  <div className="flex flex-col gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3">
                    <p className="text-sm">
                      <strong>{pendingConfirmation.manifestName}</strong> is from an unverified developer and hasn't been
                      reviewed. Installing it means running its code with full access to this app and your data. Only
                      continue if you trust the source.
                    </p>
                    <div className="flex items-center gap-2">
                      <Button type="button" size="sm" onClick={() => void install(true)}>
                        Install anyway
                      </Button>
                      <Button type="button" variant="ghost" size="sm" onClick={() => setPendingConfirmation(undefined)}>
                        Cancel
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </fieldset>

          <div className="flex flex-col gap-3 border-t pt-6">
            <h3 className="text-sm font-medium">Third-Party Licenses / Software Bill of Materials</h3>
            {sbomEntries.map((entry) => {
              const isOpen = Boolean(expandedSbomEntries[entry.id]);
              return (
                <div key={entry.id} className="rounded-lg border">
                  <div
                    className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3 select-none"
                    onClick={() => setExpandedSbomEntries((prev) => ({ ...prev, [entry.id]: !isOpen }))}
                  >
                    <div className="flex items-center gap-2">
                      {isOpen ? <ChevronDown className="size-4 text-muted-foreground" /> : <ChevronRight className="size-4 text-muted-foreground" />}
                      <span className="text-sm font-medium">{entry.label}</span>
                      {entry.sbom && <span className="text-sm text-muted-foreground">({entry.sbom.components?.length ?? 0} components)</span>}
                    </div>
                    {entry.sbom && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={(e) => {
                          e.stopPropagation();
                          void window.api.sbomExport(entry.id);
                        }}
                      >
                        Export SBOM
                      </Button>
                    )}
                  </div>
                  {entry.error && <p className="px-4 pb-3 text-sm text-destructive">Could not load: {entry.error}</p>}
                  {isOpen && entry.sbom && (
                    <div className="border-t">
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Package</TableHead>
                            <TableHead>Version</TableHead>
                            <TableHead>License</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {(entry.sbom.components ?? []).map((component, index) => (
                            // No stable id on a CycloneDX component beyond name+version, which isn't
                            // guaranteed unique across a large dependency tree (e.g. differing bom-refs
                            // for the same name@version resolved at different paths) — index is simpler
                            // and safe here since this list is never reordered or filtered client-side.
                            <TableRow key={index}>
                              <TableCell>{component.name}</TableCell>
                              <TableCell>{component.version ?? '—'}</TableCell>
                              <TableCell>
                                {(component.licenses ?? [])
                                  .map((license) => license.license?.id ?? license.license?.name ?? license.expression ?? 'unknown')
                                  .join(', ') || 'unknown'}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </div>
                  )}
                </div>
              );
            })}
            {sbomEntries.length === 0 && <p className="text-sm text-muted-foreground">No packages to show.</p>}
          </div>
        </CardContent>
      )}
    </Card>
  );
}
