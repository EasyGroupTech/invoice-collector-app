// @vitest-environment jsdom
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DestinationPlugin, SourcePlugin } from 'invoice-collector-plugin-sdk';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CollectPage } from '../pages/CollectPage.js';
import { createTestBackend, type TestBackend } from './test-backend.js';

const SOURCE_PLUGIN_ID = 'app.easygroup.source.fake-collect-source';
const DESTINATION_PLUGIN_ID = 'app.easygroup.destination.fake-collect-destination';
const SOURCE_SESSION_TYPE_ID = `${SOURCE_PLUGIN_ID}/session`;
const DESTINATION_SESSION_TYPE_ID = `${DESTINATION_PLUGIN_ID}/session`;

const TODAY = new Date().toISOString().slice(0, 10);

/** No `createInputFields`, no `wizard` — `ConnectPanel` auto-connects on mount with zero user
 * input (the `!hasFields` branch), and the Add-Collector wizard's own "configure" step has
 * nothing to fill in, so the whole flow only needs the two "what and how" button clicks. */
function fakeSourcePlugin(): SourcePlugin {
  return {
    manifest: { id: SOURCE_PLUGIN_ID, name: 'Fake Collect Source', kind: 'source', main: 'index.js' },
    sessionRequirements: [
      { sessionTypeId: SOURCE_SESSION_TYPE_ID, confirmsBuiltIn: false, requiredScopesOrRoles: [], collects: 'test invoices', connectHow: 'connecting automatically.', connectInstructions: 'Connecting…' },
    ],
    // Even a trivial custom session still needs *some* create() input value — ConnectPanel omits
    // `input` entirely when there are no createInputFields, and resolveSessionCreateInput() then
    // falls back to this (same pattern local-folder-plugin.ts's own real destination uses,
    // returning a bare `{}` since there's genuinely nothing to collect from the user).
    builtInSessionCreateInput: () => ({}),
    sessionPlugin: {
      sessionTypeId: SOURCE_SESSION_TYPE_ID,
      async create() {
        return { label: 'Fake Source Session', secret: {} };
      },
      async test() {
        return 'ok' as const;
      },
      applyAuth(_secret, request) {
        return request;
      },
    },
    wizard: [],
    async *discover() {
      yield { id: 'invoice-1', name: 'Test Invoice #1', issuedDate: TODAY, amount: { value: 42, currency: 'USD' } };
    },
    async fetchContent() {
      // collect-pipeline.ts's own bestDisplayName() prefers the filename (minus .pdf) over the
      // discovered invoice's own `name` — matching it here rather than fighting it.
      return { fileName: 'Test Invoice #1.pdf', mimeType: 'application/pdf', bytes: new TextEncoder().encode('%PDF-fake') };
    },
  };
}

function fakeDestinationPlugin(): DestinationPlugin {
  return {
    manifest: { id: DESTINATION_PLUGIN_ID, name: 'Fake Collect Destination', kind: 'destination', main: 'index.js' },
    sessionRequirements: [
      { sessionTypeId: DESTINATION_SESSION_TYPE_ID, confirmsBuiltIn: false, requiredScopesOrRoles: [], collects: 'test invoices', connectHow: 'connecting automatically.', connectInstructions: 'Connecting…' },
    ],
    builtInSessionCreateInput: () => ({}),
    sessionPlugin: {
      sessionTypeId: DESTINATION_SESSION_TYPE_ID,
      async create() {
        return { label: 'Fake Destination Session', secret: {} };
      },
      async test() {
        return 'ok' as const;
      },
      applyAuth(_secret, request) {
        return request;
      },
    },
    wizard: [],
    async upload() {
      return { status: 'uploaded' as const, location: 'fake/destination/invoice-1.pdf' };
    },
  };
}

let backend: TestBackend;

beforeEach(async () => {
  backend = await createTestBackend();
  window.api = backend.api;
  backend.registerSourcePlugin(fakeSourcePlugin());
  backend.registerDestinationPlugin(fakeDestinationPlugin());
});

afterEach(async () => {
  await backend.cleanup();
});

/**
 * §14's Collect flow, end to end through the real UI: the Add-Collector wizard creates a real
 * source+destination (real `configCreateRecord`/real freshly-created sessions, not seeded
 * directly), then a real Collect run actually calls the fake plugins' own `discover()`/
 * `fetchContent()`/`upload()` through the real collect pipeline, landing a real row in the
 * invoice-history file that the page then reads back and renders.
 */
describe('Collect flow', () => {
  it(
    'adds a source+destination through the wizard, runs Collect, and shows the collected invoice',
    async () => {
      const user = userEvent.setup();
      render(<CollectPage onOpenSettings={() => {}} />);

      await user.click(screen.getByRole('button', { name: /Add/ }));

      await waitFor(() => expect(screen.getByText('Add a collector (step 1 of 3)')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Collect test invoices/ }));

      // ConnectPanel auto-connects on mount and, once done, auto-advances to step 2 — nothing to
      // click in between, just wait for the real session-create job to actually finish.
      await waitFor(() => expect(screen.getByText('Add a collector (step 2 of 3)')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: /Save invoices test invoices/ }));

      await waitFor(() => expect(screen.getByText('Add a collector (step 3 of 3)')).toBeInTheDocument());
      await user.click(screen.getByRole('button', { name: 'Add' }));

      await waitFor(() => expect(screen.queryByText('Add a collector (step 3 of 3)')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getByText('2 of 2 sessions connected')).toBeInTheDocument());

      const collectButton = screen.getByRole('button', { name: 'Collect' });
      await waitFor(() => expect(collectButton).not.toBeDisabled());
      await user.click(collectButton);

      await waitFor(() => expect(screen.getByText('Test Invoice #1')).toBeInTheDocument(), { timeout: 10_000 });
      expect(screen.getByText('42.00 USD')).toBeInTheDocument();
    },
    15_000,
  );
});
