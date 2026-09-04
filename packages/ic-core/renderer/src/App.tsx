import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toaster } from '@/components/ui/sonner';
import { CollectPage } from './pages/CollectPage';
import { SettingsPage } from './pages/SettingsPage';

/** Two top-level views, matching the reference app's own IA (phase 1.16) — Sessions and Plugins
 * live inside Settings as sections (`SettingsPage.tsx`), not their own tabs. `settings` exposes
 * `onSelectSettings` so `CollectPage` can jump here directly (its stale-session summary). */
type Tab = 'collect' | 'settings';

export function App() {
  const [tab, setTab] = useState<Tab>('collect');

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-background text-foreground">
      <Toaster position="bottom-right" />
      <main className="flex-1 overflow-y-auto">
        <div className="mx-auto max-w-6xl p-8">
          <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
            <TabsList>
              <TabsTrigger value="collect">Collect</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
            <TabsContent value="collect" className="mt-6">
              <CollectPage onOpenSettings={() => setTab('settings')} />
            </TabsContent>
            <TabsContent value="settings" className="mt-6">
              <SettingsPage />
            </TabsContent>
          </Tabs>
        </div>
      </main>
    </div>
  );
}
