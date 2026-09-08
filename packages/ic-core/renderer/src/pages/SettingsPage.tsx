import { useEffect, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { AdvancedSettings } from '../../../electron/shared/ipcContracts';
import { InvoiceHistorySection } from './InvoiceHistorySection';
import { LogsSection } from './LogsSection';
import { PluginsSection } from './PluginsSection';
import { ProfileManagementSection } from './ProfileManagementSection';
import { SessionStatusSection } from './SessionStatusSection';
import { DestinationsSection, SourcesSection } from './SourcesDestinationsSection';

interface SettingsPageProps {
  /** Back-arrow navigation to Collect, matching the reference app's own header button — not a
   * tab list (§8, phase 1.16). */
  onBack: () => void;
}

/** §6's Profile management (profiles + config Import/Export combined into one card — see
 * `ProfileManagementSection`'s own doc comment), §6's Sessions UI (`SessionStatusSection`, scoped
 * to the currently active profile — see its own doc comment), §14.1's Invoice history
 * retention/clear, the operational Logs viewer, Sources/Destinations management, §9's Plugins
 * management (§13's "Third-Party Licenses"/SBOM screen combined into that same card — see
 * `PluginsSection`'s own doc comment), and §7's Advanced Settings — sections of one page rather
 * than separate top-level tabs (phase 1.16: the reference app's own Settings page set real
 * precedent for tolerating even more sections than this in one scroll, without ever reaching for
 * sub-tabs). Profile management and session status lead (a profile switch changes both at once, so
 * they belong next to each other), then Invoice history and Logs, matching the reference app's own
 * section order for those (its separate "Invoice collection" buffer-days card sits between Invoice
 * history and Logs there, but has no equivalent here yet — see InvoiceHistorySection's own doc
 * comment); Sources/Destinations next, then Plugins — things a user is more likely to actually need
 * to act on — Advanced Settings last, since it's closer to "set once" than "check regularly." */
export function SettingsPage({ onBack }: SettingsPageProps) {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">Settings</h2>
          <p className="text-sm text-muted-foreground">Manage collection flow, application configuration, and access logs.</p>
        </div>
        <Button variant="ghost" size="icon" className="size-12" onClick={onBack}>
          <ArrowLeft className="size-6" />
        </Button>
      </div>
      <ProfileManagementSection />
      <SessionStatusSection />
      <InvoiceHistorySection />
      <LogsSection />
      <SourcesSection />
      <DestinationsSection />
      <PluginsSection />
      <AdvancedSettingsSection />
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
