import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

  it('writes a new file into <source>/<yyyy-mm> and reports uploaded, with the actual path it wrote to', async () => {
    const result = await writeInvoiceToFolder(dir, 'Contoso Mailbox', {
      fileName: 'INV-1_invoice.pdf',
      issuedDate: '2026-01-15',
      mimeType: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3]),
    });

    const expectedPath = path.join(dir, 'Contoso Mailbox', '2026-01', 'INV-1_invoice.pdf');
    expect(result).toEqual({ status: 'uploaded', location: expectedPath });
    expect(await readFile(expectedPath)).toEqual(Buffer.from([1, 2, 3]));
  });

  it('creates the destination folder, source subfolder, and month subfolder if none exist yet', async () => {
    const nested = path.join(dir, 'not-yet-created');

    const result = await writeInvoiceToFolder(nested, 'A Source', {
      fileName: 'a.pdf',
      issuedDate: '2026-02-01',
      mimeType: 'application/pdf',
      bytes: new Uint8Array([1]),
    });

    const expectedPath = path.join(nested, 'A Source', '2026-02', 'a.pdf');
    expect(result).toEqual({ status: 'uploaded', location: expectedPath });
    expect(await readFile(expectedPath)).toEqual(Buffer.from([1]));
  });

  it('reports already-existed (with its path) and never overwrites a file already at that exact path', async () => {
    const filePath = path.join(dir, 'A Source', '2026-01', 'a.pdf');
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, Buffer.from([9, 9, 9]));

    const result = await writeInvoiceToFolder(dir, 'A Source', {
      fileName: 'a.pdf',
      issuedDate: '2026-01-20',
      mimeType: 'application/pdf',
      bytes: new Uint8Array([1, 2, 3]),
    });

    expect(result).toEqual({ status: 'already-existed', location: filePath });
    expect(await readFile(filePath)).toEqual(Buffer.from([9, 9, 9]));
  });

  it('keeps two sources sharing one destination in separate subfolders', async () => {
    const invoice = { fileName: 'a.pdf', issuedDate: '2026-01-15', mimeType: 'application/pdf', bytes: new Uint8Array([1]) };
    await writeInvoiceToFolder(dir, 'Source One', invoice);
    await writeInvoiceToFolder(dir, 'Source Two', invoice);

    expect(await readFile(path.join(dir, 'Source One', '2026-01', 'a.pdf'))).toEqual(Buffer.from([1]));
    expect(await readFile(path.join(dir, 'Source Two', '2026-01', 'a.pdf'))).toEqual(Buffer.from([1]));
  });

  it('keeps invoices from different issued months, within the same source, in separate subfolders', async () => {
    const fileName = 'a.pdf';
    await writeInvoiceToFolder(dir, 'A Source', { fileName, issuedDate: '2026-01-31', mimeType: 'application/pdf', bytes: new Uint8Array([1]) });
    await writeInvoiceToFolder(dir, 'A Source', { fileName, issuedDate: '2026-02-01', mimeType: 'application/pdf', bytes: new Uint8Array([2]) });

    expect(await readFile(path.join(dir, 'A Source', '2026-01', 'a.pdf'))).toEqual(Buffer.from([1]));
    expect(await readFile(path.join(dir, 'A Source', '2026-02', 'a.pdf'))).toEqual(Buffer.from([2]));
  });

  it('sanitizes filesystem-unsafe characters in the source name', async () => {
    const result = await writeInvoiceToFolder(dir, 'Sales / Support: "Team"', {
      fileName: 'a.pdf',
      issuedDate: '2026-01-15',
      mimeType: 'application/pdf',
      bytes: new Uint8Array([1]),
    });

    expect(result.location).toBe(path.join(dir, 'Sales _ Support_ _Team_', '2026-01', 'a.pdf'));
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
