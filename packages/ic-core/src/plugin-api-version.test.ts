import { describe, expect, it } from 'vitest';
import { isPluginApiVersionSupported } from './plugin-api-version.js';

describe('isPluginApiVersionSupported', () => {
  it('accepts a range matching the current core major', () => {
    expect(isPluginApiVersionSupported('^2.0.0', '2.3.1')).toBe(true);
  });

  it('accepts a range matching the previous major (the one-version runway)', () => {
    expect(isPluginApiVersionSupported('^1.0.0', '2.3.1')).toBe(true);
  });

  it('rejects a range for a major more than one behind current', () => {
    expect(isPluginApiVersionSupported('^0.5.0', '2.3.1')).toBe(false);
  });

  it('rejects a range for a major ahead of current (plugin built against an unreleased core)', () => {
    expect(isPluginApiVersionSupported('^3.0.0', '2.3.1')).toBe(false);
  });

  it('accepts an exact-pin range within the supported window', () => {
    expect(isPluginApiVersionSupported('1.5.0', '2.0.0')).toBe(true);
  });

  it('handles core major 0 with no "previous major" to fall back to', () => {
    expect(isPluginApiVersionSupported('^0.1.0', '0.3.0')).toBe(true);
    expect(isPluginApiVersionSupported('^1.0.0', '0.3.0')).toBe(false);
  });

  it('rejects a malformed range rather than throwing', () => {
    expect(isPluginApiVersionSupported('not-a-range', '2.0.0')).toBe(false);
  });
});
