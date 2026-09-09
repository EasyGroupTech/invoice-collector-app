import { appendFile, mkdir, open, readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { sanitizeMessageForLog, sanitizeValueForLog } from './log-sanitize.js';

/**
 * Ported from the reference app's electron/main/appLog.ts, split the same way plugin-log.ts
 * already is from its own Electron-specific caller: the file-append/read/rotate/sanitize logic
 * here is plain fs, so it's testable without Electron; `installIpcAuditLogging` (which has to
 * monkey-patch the real `ipcMain.handle`) stays in electron/main/index.ts, calling into
 * `logAppEvent`/`sanitizeIpcArgsForLog` here.
 *
 * Writes to the same shared `appLogFile(baseDir)` that plugin-log.ts's `createPluginLog` already
 * appends to (one continuous timeline, not split by source) — "[application]" tags every IPC
 * action the user took, "[collection]" tags every Job's progress events across every job kind,
 * matching the reference app's own two tags exactly.
 */
const MAX_LOG_BYTES = 5 * 1024 * 1024; // 5 MB before rotating
const TAIL_BYTES_FOR_VIEW = 200 * 1024; // 200 KB shown in the Settings viewer

async function rotateIfNeeded(filePath: string): Promise<void> {
  try {
    const info = await stat(filePath);
    if (info.size >= MAX_LOG_BYTES) {
      await rename(filePath, `${filePath}.1`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

async function appendLogLine(filePath: string, line: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await rotateIfNeeded(filePath);
  await appendFile(filePath, `${line}\n`, 'utf-8');
}

function timestamp(): string {
  return new Date().toISOString();
}

export async function logAppEvent(filePath: string, message: string): Promise<void> {
  await appendLogLine(filePath, `[${timestamp()}] [application] ${message}`);
}

export async function logCollectionEvent(filePath: string, message: string): Promise<void> {
  await appendLogLine(filePath, `[${timestamp()}] [collection] ${sanitizeMessageForLog(message)}`);
}

export async function readLogTail(filePath: string, maxBytes: number = TAIL_BYTES_FOR_VIEW): Promise<{ content: string; truncated: boolean }> {
  try {
    const info = await stat(filePath);
    if (info.size <= maxBytes) {
      return { content: await readFile(filePath, 'utf-8'), truncated: false };
    }
    const fd = await open(filePath, 'r');
    try {
      const buffer = Buffer.alloc(maxBytes);
      await fd.read(buffer, 0, maxBytes, info.size - maxBytes);
      return { content: buffer.toString('utf-8'), truncated: true };
    } finally {
      await fd.close();
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { content: '', truncated: false };
    throw err;
  }
}

// Channels whose sensitive argument is a bare positional string rather than a named object field,
// so log-sanitize.ts's key-based redaction can't see it — ConfigExportAll(password) and
// ConfigImportAll(file, password). Redacts by argument index instead. Keyed by this app's own
// camelCase channel strings (config:exportAll/config:importAll), not the reference app's
// kebab-case ones.
const POSITIONAL_REDACT: Record<string, number[]> = {
  'config:exportAll': [0],
  'config:importAll': [1],
};

export function sanitizeIpcArgsForLog(channel: string, args: unknown[]): unknown {
  const positional = POSITIONAL_REDACT[channel];
  if (positional) {
    return args.map((a, i) => (positional.includes(i) ? '[REDACTED]' : sanitizeValueForLog(a)));
  }
  return args.map((a) => sanitizeValueForLog(a));
}
