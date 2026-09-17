import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { PluginBackedRecord } from 'invoice-collector-plugin-sdk';

export interface ConfigStore {
  version: 1;
  sources: PluginBackedRecord[];
  destinations: PluginBackedRecord[];
}

export function emptyConfigStore(): ConfigStore {
  return { version: 1, sources: [], destinations: [] };
}

export async function loadConfigFile(filePath: string): Promise<ConfigStore> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return emptyConfigStore();
    }
    throw err;
  }

  const parsed = JSON.parse(raw) as Partial<ConfigStore>;
  return {
    version: 1,
    sources: parsed.sources ?? [],
    destinations: parsed.destinations ?? [],
  };
}

export async function saveConfigFile(filePath: string, store: ConfigStore): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, JSON.stringify(store, null, 2), 'utf-8');
}

export interface CreateRecordInput {
  name: string;
  pluginId: string;
  pluginVersion: string;
  config: unknown;
  destinationId?: string | null;
  sessionId?: string;
  /** Sources only — see `PluginBackedRecord.scope`. */
  scope?: string;
}

export function createRecord(input: CreateRecordInput): PluginBackedRecord {
  const now = new Date().toISOString();
  return {
    id: randomUUID(),
    name: input.name,
    pluginId: input.pluginId,
    pluginVersion: input.pluginVersion,
    destinationId: input.destinationId,
    sessionId: input.sessionId,
    scope: input.scope,
    config: input.config,
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertRecord(records: PluginBackedRecord[], record: PluginBackedRecord): PluginBackedRecord[] {
  const index = records.findIndex((r) => r.id === record.id);
  if (index === -1) {
    return [...records, record];
  }
  const next = [...records];
  next[index] = record;
  return next;
}

export function removeRecord(records: PluginBackedRecord[], id: string): PluginBackedRecord[] {
  return records.filter((r) => r.id !== id);
}

export interface DeleteFlowResult {
  sources: PluginBackedRecord[];
  destinations: PluginBackedRecord[];
  /** sessionId(s) the removed source (and its destination, if that was removed too) referenced
   * that nothing remaining still uses — the caller is responsible for actually deleting these
   * (SessionsRegistry.removeSession()), since sessions live in a separate registry/file this pure
   * function has no access to. */
  orphanedSessionIds: string[];
}

/**
 * §14.1's "collection flow" concept: a flow *is* a source, named after it, paired with wherever it
 * collects to. Deleting a flow always removes its source; its destination goes with it too, but
 * only once nothing else still points at that destination (another flow can share the same
 * destination) — same reasoning for each one's own session, once nothing (source or destination)
 * references it any more. A no-op (nothing removed, no orphaned sessions) if `sourceId` isn't
 * actually a source in this store.
 */
export function deleteFlow(store: ConfigStore, sourceId: string): DeleteFlowResult {
  const source = store.sources.find((s) => s.id === sourceId);
  if (!source) {
    return { sources: store.sources, destinations: store.destinations, orphanedSessionIds: [] };
  }

  const remainingSources = removeRecord(store.sources, sourceId);
  const destinationId = source.destinationId ?? undefined;
  const destinationStillUsed = destinationId ? remainingSources.some((s) => s.destinationId === destinationId) : false;
  const removedDestination = destinationId && !destinationStillUsed ? store.destinations.find((d) => d.id === destinationId) : undefined;
  const remainingDestinations = removedDestination ? removeRecord(store.destinations, removedDestination.id) : store.destinations;

  const stillReferencedSessionIds = new Set(
    [...remainingSources, ...remainingDestinations].map((r) => r.sessionId).filter((id): id is string => Boolean(id)),
  );
  const candidateSessionIds = [source.sessionId, removedDestination?.sessionId].filter((id): id is string => Boolean(id));
  const orphanedSessionIds = [...new Set(candidateSessionIds.filter((id) => !stillReferencedSessionIds.has(id)))];

  return { sources: remainingSources, destinations: remainingDestinations, orphanedSessionIds };
}

export interface SweepOrphansResult {
  destinations: PluginBackedRecord[];
  orphanedSessionIds: string[];
}

/**
 * The generic cleanup counterpart to `deleteFlow()` — removes any destination no remaining
 * source points to any more, then any session (out of `allSessionIds`, every session that
 * currently exists — sessions live in a separate registry this module has no access to, so the
 * caller supplies the full list) that neither a remaining source nor a remaining destination
 * references any more. Sources are never swept themselves — a source *is* a flow (`deleteFlow`'s
 * own doc comment) — only ever a destination, or a session hanging off of one.
 *
 * Used wherever something could have been left dangling by an action that wasn't itself a
 * deliberate, completed delete: the Add Collector wizard signs a session in (or creates a new
 * destination) as it walks through its own steps, before the source that would actually reference
 * either one even exists — cancelling (or a later step failing) at that point leaves them
 * referenced by nothing; editing a flow's own `destinationId` can point it at a different
 * destination, leaving the old one (and its session) with nothing referencing it either.
 */
export function sweepOrphans(store: ConfigStore, allSessionIds: string[]): SweepOrphansResult {
  const referencedDestinationIds = new Set(store.sources.map((s) => s.destinationId).filter((id): id is string => Boolean(id)));
  const destinations = store.destinations.filter((d) => referencedDestinationIds.has(d.id));

  const stillReferencedSessionIds = new Set(
    [...store.sources, ...destinations].map((r) => r.sessionId).filter((id): id is string => Boolean(id)),
  );
  const orphanedSessionIds = allSessionIds.filter((id) => !stillReferencedSessionIds.has(id));

  return { destinations, orphanedSessionIds };
}
