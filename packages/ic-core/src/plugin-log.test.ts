import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPluginLog } from './plugin-log.js';

// info/warn/error are synchronous per PluginLogApi's own contract — the actual write is a real
// fire-and-forget async fs chain (mkdir then appendFile), so tests poll for the expected content
// to actually land rather than assuming a fixed number of ticks is enough.
async function waitForContent(filePath: string, expected: string): Promise<string> {
  return vi.waitFor(async () => {
    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain(expected);
    return content;
  });
}

describe('createPluginLog', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-plugin-log-'));
    filePath = path.join(dir, 'nested', 'app.log');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('info()/warn()/error() are synchronous (void), matching PluginLogApi', () => {
    const log = createPluginLog(filePath, 'app.easygroup.source.email-mail');
    expect(log.info('hello')).toBeUndefined();
  });

  it('appends a sanitized line to the log file, creating missing parent directories', async () => {
    const log = createPluginLog(filePath, 'app.easygroup.source.email-mail');
    log.info('found 3 invoices');

    const content = await waitForContent(filePath, 'found 3 invoices');
    expect(content).toContain('[app.easygroup.source.email-mail]');
  });

  it('tags the line with the level and includes structured data', async () => {
    const log = createPluginLog(filePath, 'plugin-x');
    log.warn('slow response', { durationMs: 5000 });

    const content = await waitForContent(filePath, 'slow response');
    expect(content).toContain('[warn]');
    expect(content).toContain('"durationMs":5000');
  });

  it('sanitizes the message before writing — never a plaintext secret in the log file', async () => {
    const log = createPluginLog(filePath, 'plugin-x');
    log.error('upload failed for https://contoso.sharepoint.com/sites/Finance/inv.pdf');

    const content = await waitForContent(filePath, '[tenant].sharepoint.com');
    expect(content).not.toContain('contoso.sharepoint.com');
  });

  it('sanitizes structured data before writing — a secret-shaped key is redacted', async () => {
    const log = createPluginLog(filePath, 'plugin-x');
    log.info('token refreshed', { clientSecret: 'super-secret-value' });

    const content = await waitForContent(filePath, '[REDACTED]');
    expect(content).not.toContain('super-secret-value');
  });

  it('appends multiple lines across calls, one line per call', async () => {
    const log = createPluginLog(filePath, 'plugin-x');
    log.info('first');
    log.info('second');

    const content = await waitForContent(filePath, 'second');
    const lines = content.trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('a write failure does not throw synchronously out of info()/warn()/error()', () => {
    const log = createPluginLog('/this/path/cannot/possibly/be/written/to/app.log', 'plugin-x');
    expect(() => log.error('boom')).not.toThrow();
  });
});
