import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkFolderAccess, writeInvoiceToFolder } from './local-folder-write.js';

describe('writeInvoiceToFolder', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-email-to-downloads-local-folder-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a new file and reports uploaded', async () => {
    const result = await writeInvoiceToFolder(dir, { fileName: 'INV-1_invoice.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) });

    expect(result).toEqual({ status: 'uploaded' });
    expect(await readFile(path.join(dir, 'INV-1_invoice.pdf'))).toEqual(Buffer.from([1, 2, 3]));
  });

  it('creates the destination folder if it does not exist yet', async () => {
    const nested = path.join(dir, 'not-yet-created');

    const result = await writeInvoiceToFolder(nested, { fileName: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1]) });

    expect(result).toEqual({ status: 'uploaded' });
    expect(await readFile(path.join(nested, 'a.pdf'))).toEqual(Buffer.from([1]));
  });

  it('reports already-existed and never overwrites a file already at that exact path', async () => {
    const filePath = path.join(dir, 'a.pdf');
    await writeFile(filePath, Buffer.from([9, 9, 9]));

    const result = await writeInvoiceToFolder(dir, { fileName: 'a.pdf', mimeType: 'application/pdf', bytes: new Uint8Array([1, 2, 3]) });

    expect(result).toEqual({ status: 'already-existed' });
    expect(await readFile(filePath)).toEqual(Buffer.from([9, 9, 9]));
  });
});

describe('checkFolderAccess', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-email-to-downloads-local-folder-access-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports ok for a writable, existing folder', async () => {
    expect(await checkFolderAccess(dir)).toBe('ok');
  });

  it('reports error for a folder that no longer exists', async () => {
    await rm(dir, { recursive: true, force: true });
    expect(await checkFolderAccess(dir)).toBe('error');
  });
});
