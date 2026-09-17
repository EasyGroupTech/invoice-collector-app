import { useCallback, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { AdvancedSettingsSection } from './AdvancedSettingsSection';
import { CollectionFlowsSection } from './CollectionFlowsSection';
import { LogsSection } from './LogsSection';
import { PluginsSection } from './PluginsSection';
import { ProfileManagementSection } from './ProfileManagementSection';
import { SessionStatusSection } from './SessionStatusSection';

interface SettingsPageProps {
  /** Back-arrow navigation to Collect, matching the reference app's own header button — not a
   * tab list (§8, phase 1.16). */
  onBack: () => void;
}

/** §6's Profile management (profiles + config Import/Export combined into one card — see
 * `ProfileManagementSection`'s own doc comment), §6's Sessions UI (`SessionStatusSection`, scoped
 * to the currently active profile — see its own doc comment), the operational Logs viewer,
 * §14.1's Collection flows (replacing separate Sources/Destinations management — a user works with
 * the flow a collector runs through, not the two records behind it; see
 * `CollectionFlowsSection`'s own doc comment), §9's Plugins management (§13's "Third-Party
 * Licenses"/SBOM screen combined into that same card — see `PluginsSection`'s own doc comment), and
 * §7's Advanced Settings (§14.1's Invoice history retention/clear folded into that same card too —
 * see `AdvancedSettingsSection`'s own doc comment) — sections of one page rather than separate
 * top-level tabs (phase 1.16: the reference app's own Settings page set real precedent for
 * tolerating even more sections than this in one scroll, without ever reaching for sub-tabs).
 * Profile management and session status lead (a profile switch changes both at once, so they
 * belong next to each other), then Logs; Collection flows next, then Plugins — things a user is
 * more likely to actually need to act on — Advanced Settings last, since it (and the "set once"
 * settings folded into it) is closer to "set once" than "check regularly." */
export function SettingsPage({ onBack }: SettingsPageProps) {
  // Bumped whenever CollectionFlowsSection's own add/edit/delete could have changed which
  // sessions exist (most notably a delete's cascade, §14.1 deleteFlow()) — SessionStatusSection
  // fetches its own session list independently and has no other way to learn that happened. See
  // both sections' own doc comments.
  const [sessionsVersion, setSessionsVersion] = useState(0);
  const bumpSessionsVersion = useCallback(() => setSessionsVersion((v) => v + 1), []);

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
      <SessionStatusSection refreshKey={sessionsVersion} />
      <LogsSection />
      <CollectionFlowsSection onSessionsChanged={bumpSessionsVersion} />
      <PluginsSection />
      <AdvancedSettingsSection />
    </div>
  );
}
