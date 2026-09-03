import { useState } from 'react';
import { CollectPage } from './pages/CollectPage';
import { SessionsPage } from './pages/SessionsPage';
import { PluginsPage } from './pages/PluginsPage';

type Tab = 'collect' | 'sessions' | 'plugins';

const TABS: { id: Tab; label: string }[] = [
  { id: 'collect', label: 'Collect' },
  { id: 'sessions', label: 'Sessions' },
  { id: 'plugins', label: 'Plugins' },
];

export function App() {
  const [tab, setTab] = useState<Tab>('collect');

  return (
    <div>
      <nav style={{ display: 'flex', gap: 4, borderBottom: '1px solid #ccc', marginBottom: 16 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            style={{ padding: '8px 16px', fontWeight: tab === t.id ? 'bold' : 'normal', border: 'none', background: 'none', cursor: 'pointer' }}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {tab === 'collect' && <CollectPage />}
      {tab === 'sessions' && <SessionsPage />}
      {tab === 'plugins' && <PluginsPage />}
    </div>
  );
}
