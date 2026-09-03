import { useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Toaster } from '@/components/ui/sonner';
import { CollectPage } from './pages/CollectPage';
import { SessionsPage } from './pages/SessionsPage';
import { PluginsPage } from './pages/PluginsPage';
import { SettingsPage } from './pages/SettingsPage';

type Tab = 'collect' | 'sessions' | 'plugins' | 'settings';

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
              <TabsTrigger value="sessions">Sessions</TabsTrigger>
              <TabsTrigger value="plugins">Plugins</TabsTrigger>
              <TabsTrigger value="settings">Settings</TabsTrigger>
            </TabsList>
            <TabsContent value="collect" className="mt-6">
              <CollectPage />
            </TabsContent>
            <TabsContent value="sessions" className="mt-6">
              <SessionsPage />
            </TabsContent>
            <TabsContent value="plugins" className="mt-6">
              <PluginsPage />
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
