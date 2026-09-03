import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  acknowledgeUnverifiedInstall,
  hasAcknowledgedUnverifiedInstall,
  loadTrustAckFile,
  saveTrustAckFile,
} from './trust-ack-store.js';

describe('trust-ack-store', () => {
  let dir: string;
  let filePath: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'ic-core-trust-ack-'));
    filePath = path.join(dir, 'trust-ack.json');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reports not-acknowledged for a fresh store', async () => {
    const store = await loadTrustAckFile(filePath);
    expect(hasAcknowledgedUnverifiedInstall(store, 'some-plugin', '1.0.0')).toBe(false);
  });

  it('acknowledging a plugin id+version persists it', async () => {
    let store = await loadTrustAckFile(filePath);
    store = acknowledgeUnverifiedInstall(store, 'some-plugin', '1.0.0');
    await saveTrustAckFile(filePath, store);

    const reloaded = await loadTrustAckFile(filePath);
    expect(hasAcknowledgedUnverifiedInstall(reloaded, 'some-plugin', '1.0.0')).toBe(true);
  });

  it('acknowledgement is scoped to the exact id+version — a version bump re-prompts', async () => {
    let store = await loadTrustAckFile(filePath);
    store = acknowledgeUnverifiedInstall(store, 'some-plugin', '1.0.0');

    expect(hasAcknowledgedUnverifiedInstall(store, 'some-plugin', '2.0.0')).toBe(false);
  });

  it('acknowledging the same id+version twice does not duplicate entries', () => {
    let store = acknowledgeUnverifiedInstall({ version: 1, acknowledged: [] }, 'p', '1.0.0');
    store = acknowledgeUnverifiedInstall(store, 'p', '1.0.0');
    expect(store.acknowledged).toEqual(['p@1.0.0']);
  });
});
