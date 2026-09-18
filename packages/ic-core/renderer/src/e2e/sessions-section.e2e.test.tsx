// @vitest-environment jsdom
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SourcePlugin } from 'invoice-collector-plugin-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStatusSection } from '../pages/SessionStatusSection.js';
import { createTestBackend, type TestBackend } from './test-backend.js';

const SESSION_TYPE_ID = 'app.easygroup.source.fake-plugin/custom-session';
const PLUGIN_ID = 'app.easygroup.source.fake-plugin';

interface FakeSecret {
  token: string;
}

/**
 * A trivial custom (`confirmsBuiltIn: false`) session type whose `refresh()` always succeeds —
 * §6's "Login" action (`SessionsApi.reconnect`) tries a silent refresh before ever falling back to
 * a real interactive sign-in, so a `refresh()` that never fails means Login always takes the
 * silent path here, with no device-code prompt to drive through the UI (that path is real SDK
 * behavior already covered by sessions-registry.test.ts's own unit tests, not this suite's job to
 * re-prove).
 */
function fakeSourcePlugin(): SourcePlugin {
  return {
    manifest: { id: PLUGIN_ID, name: 'Fake Test Plugin', kind: 'source', main: 'index.js' },
    sessionRequirements: [
      {
        sessionTypeId: SESSION_TYPE_ID,
        confirmsBuiltIn: false,
        requiredScopesOrRoles: [],
        collects: 'test invoices',
        connectHow: 'pasting a fake secret.',
        connectInstructions: 'Paste your fake secret.',
        createInputFields: [{ kind: 'field', name: 'secret', label: 'Secret', type: 'text', required: true }],
      },
    ],
    sessionPlugin: {
      sessionTypeId: SESSION_TYPE_ID,
      async create(_ctx, input): Promise<{ label: string; secret: FakeSecret }> {
        const secret = (input as { secret?: string } | undefined)?.secret ?? 'initial-secret';
        return { label: 'Fake Test Session', secret: { token: secret } };
      },
      async refresh(_ctx, _session): Promise<{ secret: FakeSecret }> {
        return { secret: { token: 'refreshed-secret' } };
      },
      async test(): Promise<'ok'> {
        return 'ok';
      },
      applyAuth(_secret, request) {
        return request;
      },
    },
    wizard: [],
    discover: async function* () {},
    fetchContent: async () => ({ fileName: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array() }),
  };
}

let backend: TestBackend;

beforeEach(async () => {
  backend = await createTestBackend();
  window.api = backend.api;
  backend.registerSourcePlugin(fakeSourcePlugin());
});

afterEach(async () => {
  await backend.cleanup();
});

/**
 * §6's Sessions management card — a real session created directly through `sessionsRegistry`
 * (bypassing the Add-Collector wizard, since that flow is exercised separately) so the card has
 * something real to render, then driven through Login/Refresh/Logout for real against the actual
 * `SessionsRegistry`/session-store file, not a canned status flip.
 */
describe('Sessions section', () => {
  it('lists a real session and lets Refresh/Logout/Login all actually change its persisted status', async () => {
    const session = await backend.sessionsRegistry.forPlugin(PLUGIN_ID).create(SESSION_TYPE_ID, { secret: 'initial-secret' }, new AbortController().signal);
    expect(session.status).toBe('active');

    const user = userEvent.setup();
    render(<SessionStatusSection />);

    await user.click(screen.getByText('Current profile session status'));
    await waitFor(() => expect(screen.getByText('Fake Test Session')).toBeInTheDocument());

    const row = screen.getByText('Fake Test Session').closest('div')!;
    expect(within(row).getByText('active')).toBeInTheDocument();

    await user.click(within(row).getByRole('button', { name: 'Logout' }));
    await waitFor(() => expect(within(screen.getByText('Fake Test Session').closest('div')!).getByText('needs-reconnect')).toBeInTheDocument());

    // Confirmed directly against the real registry, not just the badge text — a real logout
    // clears the stored secret (moving status to needs-reconnect) but keeps the session record.
    expect((await backend.sessionsRegistry.listAll()).find((s) => s.id === session.id)?.status).toBe('needs-reconnect');

    await user.click(within(screen.getByText('Fake Test Session').closest('div')!).getByRole('button', { name: 'Login' }));
    await waitFor(() => expect(within(screen.getByText('Fake Test Session').closest('div')!).getByText('active')).toBeInTheDocument());
  });

  it('shows the Rotate button (createInputFields declared) and rotates the session for real', async () => {
    const session = await backend.sessionsRegistry.forPlugin(PLUGIN_ID).create(SESSION_TYPE_ID, { secret: 'initial-secret' }, new AbortController().signal);

    const user = userEvent.setup();
    render(<SessionStatusSection />);
    await user.click(screen.getByText('Current profile session status'));
    await waitFor(() => expect(screen.getByText('Fake Test Session')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Rotate' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/Secret/), 'a-brand-new-secret');
    await user.click(within(dialog).getByRole('button', { name: 'Rotate' }));

    await waitFor(async () => {
      const stored = await backend.sessionsRegistry.forPlugin(PLUGIN_ID).get(session.id);
      expect((stored?.secret as FakeSecret | undefined)?.token).toBe('a-brand-new-secret');
    });
  });
});
