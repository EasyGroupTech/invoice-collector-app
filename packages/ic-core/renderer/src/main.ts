// Placeholder only — proves the IPC round trip actually works end to end. Real UI
// (WizardStepDescriptor/SettingsPanelDescriptor rendering, Sessions/Plugins pages) is phase 1.12.

const app = document.getElementById('app');

function appendLogLine(message: string): void {
  const log = document.getElementById('log');
  if (!log) return;
  const line = document.createElement('div');
  line.textContent = message;
  log.append(line);
}

async function render(): Promise<void> {
  if (!app) return;

  const [profiles, sources, destinations, plugins] = await Promise.all([
    window.api.profilesList(),
    window.api.configListSources(),
    window.api.configListDestinations(),
    window.api.pluginsList(),
  ]);
  const activeProfile = profiles.find((p) => p.isActive);

  app.innerHTML = `
    <h1>Invoice Collector</h1>
    <p>Profile: ${activeProfile?.name ?? 'unknown'}</p>
    <p>Sources: ${sources.length} &middot; Destinations: ${destinations.length} &middot; Plugins installed: ${plugins.length}</p>
    <div id="log"></div>
  `;
  console.log(`[main.ts] IPC round trip OK — profile "${activeProfile?.name}", ${sources.length} sources, ${destinations.length} destinations, ${plugins.length} plugins`);
}

window.api.onJobProgress((event) => appendLogLine(`[${event.kind}] ${event.message}`));
window.api.onJobDone((event) => appendLogLine(`[${event.kind}] ${event.ok ? 'done' : `FAILED: ${event.error}`}`));

render().catch((err: unknown) => {
  if (app) app.textContent = `Failed to load: ${err instanceof Error ? err.message : String(err)}`;
});
