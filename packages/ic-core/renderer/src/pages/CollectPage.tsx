import { useEffect, useState } from 'react';
import type { PluginBackedRecord, Session } from 'invoice-collector-plugin-sdk';
import type { InstalledPluginSummary } from '../../../electron/shared/ipcContracts';
import { validateWizardValues, type WizardFieldValues } from '../../../src/wizard-form-state.js';
import { WizardSteps } from '../descriptors/WizardSteps';
import { runJobAndWait } from '../jobs';

type RecordKind = 'source' | 'destination';

/** §14's Collect flow, plus §5/§6/§8's Add-Source/Destination wizard. A record's session step
 * only ever looks at `sessionRequirements[0]` — a real simplification for a plugin that declares
 * more than one alternative session type, deferred until a real plugin actually needs that (same
 * "don't design for a hypothetical" reasoning as the other gaps this phase deferred). */
export function CollectPage() {
  const [sources, setSources] = useState<PluginBackedRecord[]>([]);
  const [destinations, setDestinations] = useState<PluginBackedRecord[]>([]);
  const [addingKind, setAddingKind] = useState<RecordKind | undefined>(undefined);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [collecting, setCollecting] = useState(false);
  const [collectError, setCollectError] = useState<string | undefined>(undefined);

  async function refresh() {
    setSources(await window.api.configListSources());
    setDestinations(await window.api.configListDestinations());
  }

  useEffect(() => {
    void refresh();
  }, []);

  useEffect(() => window.api.onJobProgress((event) => setProgressLog((prev) => [...prev, event.message])), []);

  async function removeRecord(kind: RecordKind, id: string) {
    await window.api.configRemoveRecord({ kind, id });
    await refresh();
  }

  async function runCollect() {
    setCollecting(true);
    setCollectError(undefined);
    setProgressLog([]);
    try {
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString().slice(0, 10);
      const end = now.toISOString().slice(0, 10);
      const result = await window.api.collectRun({ sourceIds: 'all', period: { start, end } });
      if ('error' in result) {
        setCollectError(result.error);
        return;
      }
      await new Promise<void>((resolve, reject) => {
        const unsubscribe = window.api.onJobDone((event) => {
          if (event.jobId !== result.jobId) return;
          unsubscribe();
          if (event.ok) resolve();
          else reject(new Error(event.error));
        });
      });
    } catch (err) {
      setCollectError(err instanceof Error ? err.message : String(err));
    } finally {
      setCollecting(false);
    }
  }

  return (
    <div>
      <h2>Sources</h2>
      <RecordTable records={sources} onRemove={(id) => void removeRecord('source', id)} />
      <button type="button" onClick={() => setAddingKind('source')}>
        Add Source
      </button>

      <h2>Destinations</h2>
      <RecordTable records={destinations} onRemove={(id) => void removeRecord('destination', id)} />
      <button type="button" onClick={() => setAddingKind('destination')}>
        Add Destination
      </button>

      <h2>Collect</h2>
      <button type="button" disabled={collecting || sources.length === 0} onClick={() => void runCollect()}>
        {collecting ? 'Collecting…' : 'Run Collect'}
      </button>
      {collectError && <p style={{ color: 'crimson' }}>{collectError}</p>}
      {progressLog.length > 0 && (
        <pre style={{ background: '#f5f5f5', padding: 8, maxHeight: 200, overflow: 'auto' }}>{progressLog.join('\n')}</pre>
      )}

      {addingKind && (
        <AddRecordWizard
          kind={addingKind}
          destinations={destinations}
          onClose={() => setAddingKind(undefined)}
          onCreated={() => {
            setAddingKind(undefined);
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function RecordTable({ records, onRemove }: { records: PluginBackedRecord[]; onRemove: (id: string) => void }) {
  return (
    <table>
      <thead>
        <tr>
          <th style={{ textAlign: 'left' }}>Name</th>
          <th style={{ textAlign: 'left' }}>Plugin</th>
          <th />
        </tr>
      </thead>
      <tbody>
        {records.map((r) => (
          <tr key={r.id}>
            <td>{r.name}</td>
            <td>{r.pluginId}</td>
            <td>
              <button type="button" onClick={() => onRemove(r.id)}>
                Remove
              </button>
            </td>
          </tr>
        ))}
        {records.length === 0 && (
          <tr>
            <td colSpan={3}>None yet.</td>
          </tr>
        )}
      </tbody>
    </table>
  );
}

interface AddRecordWizardProps {
  kind: RecordKind;
  destinations: PluginBackedRecord[];
  onClose: () => void;
  onCreated: () => void;
}

function AddRecordWizard({ kind, destinations, onClose, onCreated }: AddRecordWizardProps) {
  const [plugins, setPlugins] = useState<InstalledPluginSummary[]>([]);
  const [selectedPluginId, setSelectedPluginId] = useState<string | undefined>(undefined);
  const [sessions, setSessions] = useState<Session[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | undefined>(undefined);
  const [creatingSession, setCreatingSession] = useState(false);
  const [name, setName] = useState('');
  const [destinationId, setDestinationId] = useState<string | undefined>(undefined);
  const [values, setValues] = useState<WizardFieldValues>({});
  const [error, setError] = useState<string | undefined>(undefined);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    void window.api.pluginsList().then((all) => setPlugins(all.filter((p) => p.manifest.kind === kind)));
    void window.api.sessionsList().then(setSessions);
  }, [kind]);

  const plugin = plugins.find((p) => p.manifest.id === selectedPluginId);
  const requirement = plugin?.sessionRequirements[0];
  const compatibleSessions = requirement
    ? sessions.filter(
        (s) => s.sessionTypeId === requirement.sessionTypeId && (requirement.confirmsBuiltIn || s.createdByPluginId === plugin.manifest.id),
      )
    : [];

  async function createSession() {
    if (!plugin || !requirement) return;
    setCreatingSession(true);
    setError(undefined);
    try {
      const session = await runJobAndWait<Session>(
        window.api.sessionsCreate({ pluginId: plugin.manifest.id, sessionTypeId: requirement.sessionTypeId }),
      );
      setSessions((prev) => [...prev, session]);
      setSelectedSessionId(session.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreatingSession(false);
    }
  }

  async function submit() {
    if (!plugin) return;
    const validation = validateWizardValues(plugin.wizard, values);
    if (!validation.valid) {
      setError(`Missing required field(s): ${validation.missingFields.join(', ')}`);
      return;
    }
    setSubmitting(true);
    setError(undefined);
    try {
      await window.api.configCreateRecord({
        kind,
        pluginId: plugin.manifest.id,
        pluginVersion: plugin.manifest.version,
        name: name || plugin.manifest.name,
        config: values,
        destinationId: kind === 'source' ? destinationId : undefined,
        sessionId: selectedSessionId,
      });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: 'white', padding: 24, minWidth: 480, maxHeight: '80vh', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 16 }}>
        <h3>Add {kind === 'source' ? 'Source' : 'Destination'}</h3>

        <label>
          Plugin
          <select value={selectedPluginId ?? ''} onChange={(e) => setSelectedPluginId(e.target.value || undefined)}>
            <option value="" disabled>
              Select…
            </option>
            {plugins.map((p) => (
              <option key={p.manifest.id} value={p.manifest.id}>
                {p.manifest.name}
              </option>
            ))}
          </select>
        </label>

        {plugin && requirement && (
          <fieldset>
            <legend>Session ({requirement.sessionTypeId})</legend>
            {requirement.permissionsNote && <p>{requirement.permissionsNote}</p>}
            <p>Requires: {requirement.requiredScopesOrRoles.join(', ') || 'no specific scopes declared'}</p>
            {compatibleSessions.map((s) => (
              <label key={s.id} style={{ display: 'block' }}>
                <input
                  type="radio"
                  name="session"
                  checked={selectedSessionId === s.id}
                  onChange={() => setSelectedSessionId(s.id)}
                />
                {s.label}
              </label>
            ))}
            <button type="button" disabled={creatingSession} onClick={() => void createSession()}>
              {creatingSession ? 'Creating…' : 'Create new session'}
            </button>
          </fieldset>
        )}

        {plugin && (
          <label>
            Name
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={plugin.manifest.name} />
          </label>
        )}

        {plugin && kind === 'source' && destinations.length > 0 && (
          <label>
            Destination
            <select value={destinationId ?? ''} onChange={(e) => setDestinationId(e.target.value || undefined)}>
              <option value="">None</option>
              {destinations.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
        )}

        {plugin && (
          <WizardSteps pluginId={plugin.manifest.id} steps={plugin.wizard} values={values} sessionId={selectedSessionId} onChange={(n, v) => setValues((prev) => ({ ...prev, [n]: v }))} />
        )}

        {error && <p style={{ color: 'crimson' }}>{error}</p>}

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="button" disabled={!plugin || submitting} onClick={() => void submit()}>
            {submitting ? 'Adding…' : 'Add'}
          </button>
        </div>
      </div>
    </div>
  );
}
