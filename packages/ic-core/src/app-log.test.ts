import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { logAppEvent, logCollectionEvent, readLogTail, sanitizeIpcArgsForLog } from './app-log.js';

describe('logAppEvent / logCollectionEvent', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-app-log-'));
    filePath = path.join(dir, 'nested', 'app.log');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('logAppEvent() tags the line [application], creating missing parent directories', async () => {
    await logAppEvent(filePath, 'config:listSources []');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain('[application] config:listSources []');
  });

  it('logCollectionEvent() tags the line [collection] and sanitizes the message', async () => {
    await logCollectionEvent(filePath, 'uploaded to https://contoso.sharepoint.com/sites/Finance/inv.pdf');
    const content = await readFile(filePath, 'utf-8');
    expect(content).toContain('[collection] uploaded to https://[tenant].sharepoint.com/…/inv.pdf');
    expect(content).not.toContain('contoso.sharepoint.com');
  });

  it('appends multiple lines across calls, one line per call', async () => {
    await logAppEvent(filePath, 'first');
    await logAppEvent(filePath, 'second');
    const content = await readFile(filePath, 'utf-8');
    expect(content.trim().split('\n')).toHaveLength(2);
  });
});

describe('readLogTail', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-app-log-tail-'));
    filePath = path.join(dir, 'app.log');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns an empty, non-truncated result when no log file exists yet', async () => {
    expect(await readLogTail(filePath)).toEqual({ content: '', truncated: false });
  });

  it('returns the whole file untruncated when it fits within maxBytes', async () => {
    await writeFile(filePath, 'hello world', 'utf-8');
    expect(await readLogTail(filePath, 1000)).toEqual({ content: 'hello world', truncated: false });
  });

  it('returns only the final maxBytes and reports truncated when the file is larger', async () => {
    await writeFile(filePath, '0123456789', 'utf-8');
    expect(await readLogTail(filePath, 4)).toEqual({ content: '6789', truncated: true });
  });
});

describe('sanitizeIpcArgsForLog', () => {
  it('redacts a secret-shaped key anywhere in an object argument', () => {
    const result = sanitizeIpcArgsForLog('config:createRecord', [{ name: 'x', clientSecret: 'super-secret' }]);
    expect(result).toEqual([{ name: 'x', clientSecret: '[REDACTED]' }]);
  });

  it('redacts a bare positional password argument for config:exportAll', () => {
    expect(sanitizeIpcArgsForLog('config:exportAll', ['my-password'])).toEqual(['[REDACTED]']);
  });

  it('redacts only the password argument (index 1) for config:importAll, leaving the file argument alone', () => {
    const file = { version: 1 };
    expect(sanitizeIpcArgsForLog('config:importAll', [file, 'my-password'])).toEqual([file, '[REDACTED]']);
  });

  it('leaves an unrelated channel with no positional rule untouched (beyond key-based redaction)', () => {
    expect(sanitizeIpcArgsForLog('profiles:switch', ['profile-1'])).toEqual(['profile-1']);
  });
});
