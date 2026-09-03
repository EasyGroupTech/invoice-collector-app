import { useEffect, useState } from 'react';
import type { AdvancedSettings, SbomEntry } from '../../../electron/shared/ipcContracts';

/** §13's "Third-Party Licenses"/SBOM screen + §7's Advanced Settings, both framed as a
 * Settings/About area — kept as two sections of one page rather than separate tabs. */
export function SettingsPage() {
  return (
    <div>
      <h2>Settings</h2>
      <AdvancedSettingsSection />
      <SbomSection />
    </div>
  );
}

function AdvancedSettingsSection() {
  const [settings, setSettings] = useState<AdvancedSettings | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    void window.api.settingsGetAdvanced().then(setSettings);
  }, []);

  async function save() {
    if (!settings) return;
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      const result = await window.api.settingsSaveAdvanced(settings);
      setSettings(result);
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!settings) return null;

  return (
    <section>
      <h3>Advanced Settings</h3>
      <p>HTTP retry policy (§7) — how a plugin's outbound requests retry on a 429/throttling response.</p>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Base delay (ms)
        <input
          type="number"
          min={0}
          value={settings.retryPolicy.baseDelayMs}
          onChange={(e) => setSettings({ ...settings, retryPolicy: { ...settings.retryPolicy, baseDelayMs: e.target.valueAsNumber } })}
        />
      </label>
      <label style={{ display: 'block', marginBottom: 8 }}>
        Max retries
        <input
          type="number"
          min={0}
          value={settings.retryPolicy.maxRetries}
          onChange={(e) => setSettings({ ...settings, retryPolicy: { ...settings.retryPolicy, maxRetries: e.target.valueAsNumber } })}
        />
      </label>
      <button type="button" disabled={saving} onClick={() => void save()}>
        {saving ? 'Saving…' : 'Save'}
      </button>
      {saved && <span style={{ marginLeft: 8 }}>Saved.</span>}
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
    </section>
  );
}

function SbomSection() {
  const [entries, setEntries] = useState<SbomEntry[]>([]);

  useEffect(() => {
    void window.api.sbomList().then(setEntries);
  }, []);

  return (
    <section>
      <h3>Third-Party Licenses / Software Bill of Materials</h3>
      {entries.map((entry) => (
        <details key={entry.id} style={{ marginBottom: 8 }}>
          <summary>
            {entry.label} {entry.sbom ? `(${entry.sbom.components?.length ?? 0} components)` : ''}
            {entry.sbom && (
              <button
                type="button"
                style={{ marginLeft: 12 }}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void window.api.sbomExport(entry.id);
                }}
              >
                Export SBOM
              </button>
            )}
          </summary>
          {entry.error && <p style={{ color: 'crimson' }}>Could not load: {entry.error}</p>}
          {entry.sbom && (
            <table>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Package</th>
                  <th style={{ textAlign: 'left' }}>Version</th>
                  <th style={{ textAlign: 'left' }}>License</th>
                </tr>
              </thead>
              <tbody>
                {(entry.sbom.components ?? []).map((component, index) => (
                  // No stable id on a CycloneDX component beyond name+version, which isn't
                  // guaranteed unique across a large dependency tree (e.g. differing bom-refs
                  // for the same name@version resolved at different paths) — index is simpler
                  // and safe here since this list is never reordered or filtered client-side.
                  <tr key={index}>
                    <td>{component.name}</td>
                    <td>{component.version ?? '—'}</td>
                    <td>
                      {(component.licenses ?? [])
                        .map((entry) => entry.license?.id ?? entry.license?.name ?? entry.expression ?? 'unknown')
                        .join(', ') || 'unknown'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </details>
      ))}
      {entries.length === 0 && <p>No packages to show.</p>}
    </section>
  );
}
