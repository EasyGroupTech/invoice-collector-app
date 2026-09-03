import { describe, expect, it } from 'vitest';
import { emptyConfigStore, PACKAGE_NAME } from './index.js';

describe('index barrel', () => {
  it('exposes its package name', () => {
    expect(PACKAGE_NAME).toBe('ic-core');
  });

  it('re-exports the config-store module', () => {
    expect(emptyConfigStore()).toEqual({ version: 1, sources: [], destinations: [] });
  });
});
