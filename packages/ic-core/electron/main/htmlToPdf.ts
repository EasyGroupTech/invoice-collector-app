import { BrowserWindow } from 'electron';

/**
 * Renders a self-contained HTML string (no external assets — `reporting.ts`'s `buildHtmlReport`
 * already produces exactly that) to a PDF buffer via a hidden, disposable `BrowserWindow` and
 * Electron's own `printToPDF` — no new npm dependency needed for this, unlike a PDF-generation
 * library that would need §13's MIT-compatibility gate run against its own dependency tree.
 *
 * `backgroundThrottling: false` is a deliberate precaution, not a proven-necessary fix: Chromium
 * throttles a hidden/backgrounded page's own rendering loop, which could in principle affect a
 * `printToPDF` call on a `show: false` window. (A suspected hang while first verifying this turned
 * out to actually be a stdout-buffering artifact of the throwaway verification script, not a real
 * defect — the export itself completed and wrote a valid PDF every time it was tested. Left the
 * flag in anyway, since it costs nothing and is the standard defensive setting for this exact
 * "render a hidden window headlessly" pattern.)
 */
export async function renderHtmlToPdf(html: string): Promise<Uint8Array> {
  const win = new BrowserWindow({ show: false, webPreferences: { backgroundThrottling: false } });
  try {
    await win.loadURL(`data:text/html;base64,${Buffer.from(html, 'utf-8').toString('base64')}`);
    const buffer = await win.webContents.printToPDF({});
    return new Uint8Array(buffer);
  } finally {
    win.destroy();
  }
}
