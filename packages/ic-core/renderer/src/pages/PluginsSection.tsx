import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { PluginManifest, SbomEntry } from '../../../electron/shared/ipcContracts';

/**
 * §9.4's actual concept: a plugin is a *bundle* of the sessions/sources/destinations it
 * implements — a module, with its own implementation and (declared via `sbom`) its own
 * dependencies. It's installed and removed as that one whole bundle, not per individual
 * source/destination it happens to contain (ic-email-to-downloads, say, bundles both a Graph Mail
 * source and a Local Folder destination — one install, one row here, one Uninstall). This list
 * reads `pluginsListPackages()` (package-level — see `InstalledPluginSummary`'s own doc comment
 * for why the Add-Source/Destination wizard still needs the flat, per-implementation
 * `pluginsList()` instead), and deliberately doesn't enumerate what a package implements — just
 * its name and, in place of a kind/version breakdown, its own repository URL as the description
 * (the same field §9's trust-tier decision already keys off of; "Unverified" when it's absent).
 *
 * §9.1's one Install Plugin entry point + §9's two-tier trust warning, plus uninstall (§5's
 * "preserve, don't delete" — ic-core's uninstallPlugin() already only touches the package's own
 * files). Enable/disable isn't here — same known, deliberately-deferred gap
 * docs/implementation-plan.md's phase 1.11/1.12 notes track (no installed-plugin persistence
 * across a restart yet, so "disable" has nothing durable to attach to today).
 *
 * Install comes first (plain URL input + button, not its own nested Card — this whole section is
 * already "Plugins," a second layer of Card chrome around one field added nothing), then the
 * installed-package list as a column of bordered rows rather than a table — same row style
 * `ProfileManagementSection`/`SessionStatusSection` already use.
 *
 * §13's "Third-Party Licenses"/SBOM screen lives here too, as a second subsection below a divider
 * — the reference app's own SBOM card was really "the license/component detail behind whatever's
 * installed," which is exactly what this card is already about; splitting it into its own
 * always-open card (as it was before) just meant two separate places to look for one topic. Its
 * own per-package expand/collapse (`expandedSbomEntries`) is independent of this card's own
 * collapse state. Uninstalling is only ever done from the plugin list above — the SBOM subsection
 * is read-only, matching the reference app's own SBOM screen.
 *
 * A Settings section (§8, phase 1.16), collapsed by default the same way the reference app's own
 * `SourcesPage` collapses its list — this can grow long and isn't something most sessions need
 * open at a glance the way Collect is. */
export function PluginsSection() {
  const [packages, setPackages] = useState<PluginManifest[]>([]);
  const [rawInput, setRawInput] = useState('');
  const [pendingConfirmation, setPendingConfirmation] = useState<{ manifestId: string; manifestName: string } | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState(true);

  const [sbomEntries, setSbomEntries] = useState<SbomEntry[]>([]);
  const [expandedSbomEntries, setExpandedSbomEntries] = useState<Record<string, boolean>>({});

  async function refreshPlugins() {
    setPackages(await window.api.pluginsListPackages());
  }

  async function refreshSbom() {
    setSbomEntries(await window.api.sbomList());
  }

  useEffect(() => {
    void refreshPlugins();
    void refreshSbom();
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
      await refreshPlugins();
      await refreshSbom();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  // §5's "preserve, don't delete" uninstallPlugin() — also refreshes the SBOM list, since
  // uninstalling a package removes its SBOM entry too.
  async function uninstall(pluginId: string) {
    setBusy(true);
    try {
      await window.api.pluginsUninstall(pluginId);
      toast.success('Plugin uninstalled');
      await refreshPlugins();
      await refreshSbom();
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
        <CardDescription>{packages.length} installed — install and manage plugins.</CardDescription>
      </CardHeader>
      {!collapsed && (
        <CardContent className="flex flex-col gap-4 pb-4">
          <fieldset disabled={busy} className="flex flex-col gap-4">
            <div className="flex flex-col gap-3">
              <h3 className="text-sm font-medium">Install a plugin</h3>
              <div className="flex items-center gap-2">
                <Input placeholder="Plugin URL" value={rawInput} onChange={(e) => setRawInput(e.target.value)} className="flex-1" />
                <Button type="button" disabled={!rawInput} onClick={() => void install(false)}>
                  Install
                </Button>
              </div>

              {pendingConfirmation && (
                <div className="flex flex-col gap-3 rounded-lg border border-amber-500/50 bg-amber-500/10 px-4 py-3">
                  <p className="text-sm">
                    <strong>{pendingConfirmation.manifestName}</strong> is from an unverified developer and hasn't been reviewed. Installing it means
                    running its code with full access to this app and your data. Only continue if you trust the source.
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
            </div>

            <div className="flex flex-col gap-2">
              {packages.map((pkg) => (
                <div key={pkg.id} className="flex items-center justify-between gap-2 rounded-md border px-3 py-2">
                  <div className="flex flex-col gap-0.5 truncate">
                    <span className="text-sm font-medium">{pkg.name}</span>
                    <span className="text-xs text-muted-foreground">{pkg.repository ?? 'Unverified — no public repository'}</span>
                  </div>
                  <Button type="button" variant="outline" size="sm" className="shrink-0" onClick={() => void uninstall(pkg.id)}>
                    Uninstall
                  </Button>
                </div>
              ))}
              {packages.length === 0 && <p className="text-sm text-muted-foreground">No plugins installed yet.</p>}
            </div>
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
