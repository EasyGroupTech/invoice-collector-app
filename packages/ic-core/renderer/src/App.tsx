import { useState } from 'react';
import { Toaster } from '@/components/ui/sonner';
import { CollectPage } from './pages/CollectPage';
import { SettingsPage } from './pages/SettingsPage';

/** Two top-level views, matching the reference app's own IA (phase 1.16) — Sessions and Plugins
 * live inside Settings as sections (`SettingsPage.tsx`), not their own tabs. Navigation between
 * the two is a Settings gear button (Collect) / a back arrow button (Settings), not a tab list —
 * same as the reference app, not Radix `Tabs`. */
type Tab = 'collect' | 'settings';

export function App() {
  const [tab, setTab] = useState<Tab>('collect');

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <Toaster position="bottom-right" />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl p-8">
          {tab === 'collect' ? (
            <CollectPage onOpenSettings={() => setTab('settings')} />
          ) : (
            <SettingsPage onBack={() => setTab('collect')} />
          )}
        </div>
      </main>
    </div>
  );
}
