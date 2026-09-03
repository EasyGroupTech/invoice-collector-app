import { useEffect, useState } from 'react';
import type { InstalledPluginSummary } from '../../../electron/shared/ipcContracts';

/** §9.1's one Install Plugin entry point + §9's two-tier trust warning, plus uninstall (§5's
 * "preserve, don't delete" — ic-core's uninstallPlugin() already only touches the plugin's own
 * package files). Enable/disable isn't here — same known, deliberately-deferred gap
 * docs/implementation-plan.md's phase 1.11/1.12 notes track (no installed-plugin persistence
 * across a restart yet, so "disable" has nothing durable to attach to today). */
export function PluginsPage() {
  const [plugins, setPlugins] = useState<InstalledPluginSummary[]>([]);
  const [rawInput, setRawInput] = useState('');
  const [pendingConfirmation, setPendingConfirmation] = useState<{ manifestId: string; manifestName: string } | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    setPlugins(await window.api.pluginsList());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function install(confirmUnverified: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.api.pluginsInstall({ rawInput, confirmUnverified });
      if (result.status === 'needs-confirmation') {
        setPendingConfirmation({ manifestId: result.manifest.id, manifestName: result.manifest.name });
        return;
      }
      setPendingConfirmation(undefined);
      setRawInput('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function uninstall(pluginId: string) {
    setBusy(true);
    setError(undefined);
    try {
      await window.api.pluginsUninstall(pluginId);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <h2>Plugins</h2>

      <table>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Name</th>
            <th style={{ textAlign: 'left' }}>Version</th>
            <th style={{ textAlign: 'left' }}>Kind</th>
            <th style={{ textAlign: 'left' }}>Trust</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {plugins.map((p) => (
            <tr key={p.manifest.id}>
              <td>{p.manifest.name}</td>
              <td>{p.manifest.version}</td>
              <td>{p.manifest.kind}</td>
              <td>{p.manifest.repository ? `Open source — ${p.manifest.repository}` : 'Unverified'}</td>
              <td>
                <button type="button" disabled={busy} onClick={() => void uninstall(p.manifest.id)}>
                  Uninstall
                </button>
              </td>
            </tr>
          ))}
          {plugins.length === 0 && (
            <tr>
              <td colSpan={5}>No plugins installed yet.</td>
            </tr>
          )}
        </tbody>
      </table>

      <h3>Install a plugin</h3>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          placeholder="Plugin URL"
          value={rawInput}
          onChange={(e) => setRawInput(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" disabled={busy || !rawInput} onClick={() => void install(false)}>
          Install
        </button>
      </div>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}

      {pendingConfirmation && (
        <div style={{ border: '1px solid orange', padding: 12, marginTop: 12 }}>
          <p>
            <strong>{pendingConfirmation.manifestName}</strong> is from an unverified developer and hasn't been
            reviewed. Installing it means running its code with full access to this app and your data. Only
            continue if you trust the source.
          </p>
          <button type="button" disabled={busy} onClick={() => void install(true)}>
            Install anyway
          </button>
          <button type="button" disabled={busy} onClick={() => setPendingConfirmation(undefined)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}
