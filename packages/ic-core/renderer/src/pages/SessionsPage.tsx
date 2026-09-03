import { useEffect, useState } from 'react';
import type { Session } from 'invoice-collector-plugin-sdk';
import { runJobAndWait } from '../jobs';

/** §6's Sessions UI: lists established sessions, their status, and a Reconnect action. Creating a
 * *new* session isn't here — §6 frames that as part of a source/destination's own Add wizard flow
 * ("any wizard step that needs a connection offers 'use an existing session' ... alongside
 * 'create a new one'"), not a bare button on this page. */
export function SessionsPage() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [busySessionId, setBusySessionId] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  async function refresh() {
    setSessions(await window.api.sessionsList());
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function reconnect(session: Session) {
    setBusySessionId(session.id);
    setError(undefined);
    try {
      await runJobAndWait(window.api.sessionsReconnect({ pluginId: session.createdByPluginId, sessionId: session.id }));
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusySessionId(undefined);
    }
  }

  return (
    <div>
      <h2>Sessions</h2>
      {error && <p style={{ color: 'crimson' }}>{error}</p>}
      <table>
        <thead>
          <tr>
            <th style={{ textAlign: 'left' }}>Label</th>
            <th style={{ textAlign: 'left' }}>Type</th>
            <th style={{ textAlign: 'left' }}>Status</th>
            <th style={{ textAlign: 'left' }}>Expires</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {sessions.map((s) => (
            <tr key={s.id}>
              <td>{s.label}</td>
              <td>{s.sessionTypeId}</td>
              <td>{s.status}</td>
              <td>{s.expiresAt ?? '—'}</td>
              <td>
                <button type="button" disabled={busySessionId === s.id} onClick={() => void reconnect(s)}>
                  {busySessionId === s.id ? 'Reconnecting…' : 'Reconnect'}
                </button>
              </td>
            </tr>
          ))}
          {sessions.length === 0 && (
            <tr>
              <td colSpan={5}>No sessions yet — sessions are created from a source/destination's Add wizard.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
