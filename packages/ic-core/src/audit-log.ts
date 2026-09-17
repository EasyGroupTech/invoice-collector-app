import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AuditBody } from './log-sanitize.js';

/**
 * §7's network audit log (phase 1.22) — every real outbound call `ctx.http`/`HttpApi` makes,
 * redacted before it's ever stored, not just before it's ever *displayed*: this file only ever
 * holds what `sanitizeHeadersForLog`/`sanitizeBodyForLog`/`sanitizeResponseBodyForLog` already
 * produced. There is deliberately no "store the real request, reveal it later on demand" path —
 * doing that would mean persisting real secrets somewhere, defeating the entire point. One
 * continuous, app-wide file (not per-profile), same reasoning `appLogFile`'s own doc comment
 * gives: a run's own sequence of calls should read in order regardless of a profile switch
 * mid-run, and "which profile was active" isn't a distinction worth losing that for.
 */
export interface AuditLogEntry {
  id: string;
  timestamp: string;
  /** The plugin whose `ctx.http` made this call — the implementation id, same as everywhere
   * else in this codebase (`PluginBackedRecord.pluginId`, `Session.createdByPluginId`, …). */
  pluginId: string;
  method: string;
  /** Already sanitized (`sanitizeUrlForAudit`, not `sanitizeUrlForLog`'s more aggressive
   * "origin + last segment, no query string" — this one keeps the full path shape and
   * non-secret query params, since "Copy as cURL" needs it to actually be replayable). */
  url: string;
  status?: number;
  durationMs: number;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  requestBody: AuditBody;
  responseBody: AuditBody;
}

export interface AuditLogFile {
  version: 1;
  entries: AuditLogEntry[];
}

export function emptyAuditLogFile(): AuditLogFile {
  return { version: 1, entries: [] };
}

export async function loadAuditLogFile(filePath: string): Promise<AuditLogFile> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyAuditLogFile();
    }
    throw err;
  }

  const parsed = JSON.parse(raw) as Partial<AuditLogFile>;
  return { version: 1, entries: parsed.entries ?? [] };
}

export async function saveAuditLogFile(filePath: string, file: AuditLogFile): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(file, null, 2), 'utf-8');
}

export interface AuditLog {
  record(entry: Omit<AuditLogEntry, 'id' | 'timestamp'>): Promise<void>;
  list(): Promise<AuditLogEntry[]>;
  clear(): Promise<void>;
}

export interface AuditLogOptions {
  filePath: string;
  /** Bounded ring buffer — oldest entries dropped once over this cap, so a long-running app
   * never grows this file unboundedly. Default 500: generous for "what just happened," not meant
   * as a long-term archive. */
  maxEntries?: number;
  now?: () => Date;
  randomId?: () => string;
}

const DEFAULT_MAX_ENTRIES = 500;

/**
 * Same in-memory-cache-then-persist shape `sessions-registry.ts`'s own `state()`/`persist()`
 * pair uses, and the same accepted trade-off: two `record()` calls racing (two plugins' requests
 * finishing at almost the same instant during a Collect run) could still interleave oddly on the
 * on-disk write, same as sessions already can — not addressed here either, consistent with this
 * codebase's existing bar rather than a new risk introduced by this file specifically. Losing an
 * occasional audit entry is a materially smaller concern than losing a session or invoice-history
 * record would be.
 */
export function createAuditLog(options: AuditLogOptions): AuditLog {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const now = options.now ?? (() => new Date());
  const randomId = options.randomId ?? randomUUID;
  let cached: AuditLogFile | null = null;

  async function state(): Promise<AuditLogFile> {
    if (!cached) cached = await loadAuditLogFile(options.filePath);
    return cached;
  }

  return {
    async record(partial) {
      const current = await state();
      const entry: AuditLogEntry = { id: randomId(), timestamp: now().toISOString(), ...partial };
      const entries = [...current.entries, entry];
      const trimmed = entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries;
      const next: AuditLogFile = { version: 1, entries: trimmed };
      cached = next;
      await saveAuditLogFile(options.filePath, next);
    },

    async list() {
      return (await state()).entries;
    },

    async clear() {
      const next = emptyAuditLogFile();
      cached = next;
      await saveAuditLogFile(options.filePath, next);
    },
  };
}
