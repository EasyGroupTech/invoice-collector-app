import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronDown, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { AdvancedSettings, SbomEntry } from '../../../electron/shared/ipcContracts';
import { PluginsSection } from './PluginsSection';
import { SessionsSection } from './SessionsSection';

interface SettingsPageProps {
  /** Back-arrow navigation to Collect, matching the reference app's own header button — not a
   * tab list (§8, phase 1.16). */
  onBack: () => void;
}

/** §6's Sessions UI, §9's Plugins management, §13's "Third-Party Licenses"/SBOM screen, and §7's
 * Advanced Settings — four sections of one page rather than separate top-level tabs (phase 1.16:
 * the reference app's own Settings page set real precedent for tolerating even more sections than
 * this, at 7, in one scroll, without ever reaching for sub-tabs). Sessions/Plugins first — the
 * two a user is more likely to actually need to act on — Advanced Settings/SBOM last, since both
 * are closer to "set once" than "check regularly." */
export function SettingsPage({ onBack }: SettingsPageProps) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
        <Button variant="ghost" size="icon" className="size-12" onClick={onBack}>
          <ArrowLeft className="size-6" />
        </Button>
      </div>
      <SessionsSection />
      <PluginsSection />
      <AdvancedSettingsSection />
      <SbomSection />
    </div>
  );
}

function AdvancedSettingsSection() {
  const [settings, setSettings] = useState<AdvancedSettings | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.api.settingsGetAdvanced().then(setSettings);
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

  if (!settings) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Advanced Settings</CardTitle>
        <p className="text-sm text-muted-foreground">HTTP retry policy (§7) — how a plugin's outbound requests retry on a 429/throttling response.</p>
      </CardHeader>
      <CardContent>
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
      </CardContent>
    </Card>
  );
}

function SbomSection() {
  const [entries, setEntries] = useState<SbomEntry[]>([]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  useEffect(() => {
    void window.api.sbomList().then(setEntries);
  }, []);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Third-Party Licenses / Software Bill of Materials</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {entries.map((entry) => {
          const isOpen = Boolean(expanded[entry.id]);
          return (
            <div key={entry.id} className="rounded-lg border">
              <div
                className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3 select-none"
                onClick={() => setExpanded((prev) => ({ ...prev, [entry.id]: !isOpen }))}
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
        {entries.length === 0 && <p className="text-sm text-muted-foreground">No packages to show.</p>}
      </CardContent>
    </Card>
  );
}
