import { describe, expect, it } from 'vitest';
import { KNOWN_BUILT_IN_SESSION_TYPE_IDS, validateManifest, validateSessionRequirements } from './index.js';

describe('index barrel', () => {
  it('re-exports the validators', () => {
    expect(typeof validateManifest).toBe('function');
    expect(typeof validateSessionRequirements).toBe('function');
  });

  it('re-exports the known built-in session type ids, currently just one (§6.1)', () => {
    expect(KNOWN_BUILT_IN_SESSION_TYPE_IDS).toEqual(['oauth2-delegated-device-code']);
  });
});
