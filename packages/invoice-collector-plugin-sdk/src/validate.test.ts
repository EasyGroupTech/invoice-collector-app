import { describe, expect, it } from 'vitest';
import { validateManifest, validateSessionRequirements } from './validate.js';

const validManifest = {
  id: 'app.easygroup.source.email-mail',
  name: 'Graph Mail',
  version: '0.1.0',
  pluginApiVersion: '^1.0.0',
  kind: 'source',
  sbom: 'sbom.cdx.json',
  main: 'index.js',
};

describe('validateManifest', () => {
  it('accepts a well-formed manifest', () => {
    expect(validateManifest(validManifest)).toEqual({ valid: true, errors: [] });
  });

  it('accepts an optional repository field when it is a string', () => {
    const result = validateManifest({ ...validManifest, repository: 'https://github.com/x/y' });
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects a non-object input', () => {
    const result = validateManifest('not an object');
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('manifest must be an object');
  });

  it('rejects a missing sbom — the field this plugin is loaded/rejected on (§16)', () => {
    const { sbom, ...withoutSbom } = validManifest;
    const result = validateManifest(withoutSbom);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('manifest.sbom must be a non-empty string');
  });

  it('rejects a missing main — core has no entry module to load without it (§9.1)', () => {
    const { main, ...withoutMain } = validManifest;
    const result = validateManifest(withoutMain);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('manifest.main must be a non-empty string');
  });

  it('rejects an empty-string required field', () => {
    const result = validateManifest({ ...validManifest, id: '' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('manifest.id must be a non-empty string');
  });

  it('rejects a kind that is neither "source" nor "destination"', () => {
    const result = validateManifest({ ...validManifest, kind: 'transform' });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('manifest.kind must be "source" or "destination"');
  });

  it('rejects a non-string repository field', () => {
    const result = validateManifest({ ...validManifest, repository: 123 });
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('manifest.repository must be a string when present');
  });

  it('collects every violation at once rather than stopping at the first', () => {
    const result = validateManifest({ id: '', kind: 'nope' });
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(1);
  });
});

const validRequirement = {
  sessionTypeId: 'microsoft-entra-delegated-device-code',
  confirmsBuiltIn: true,
  requiredScopesOrRoles: ['Mail.Read'],
};

describe('validateSessionRequirements', () => {
  it('accepts a single well-formed built-in requirement', () => {
    expect(validateSessionRequirements([validRequirement])).toEqual({ valid: true, errors: [] });
  });

  it('accepts a custom (non-built-in) session type', () => {
    const result = validateSessionRequirements([
      { sessionTypeId: 'aws-sigv4-keypair', confirmsBuiltIn: false, requiredScopesOrRoles: [] },
    ]);
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('rejects an empty array — a plugin must declare at least one session type (§6)', () => {
    const result = validateSessionRequirements([]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('sessionRequirements must be a non-empty array');
  });

  it('rejects a non-array input', () => {
    const result = validateSessionRequirements(undefined);
    expect(result.valid).toBe(false);
  });

  it('rejects confirmsBuiltIn: true for a sessionTypeId that is not actually a known built-in', () => {
    const result = validateSessionRequirements([
      { sessionTypeId: 'browser-captured-session', confirmsBuiltIn: true, requiredScopesOrRoles: [] },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain(
      'sessionRequirements[0]: confirmsBuiltIn is true but "browser-captured-session" is not a known SDK built-in session type',
    );
  });

  it('rejects a missing sessionTypeId', () => {
    const result = validateSessionRequirements([
      { confirmsBuiltIn: false, requiredScopesOrRoles: [] },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('sessionRequirements[0].sessionTypeId must be a non-empty string');
  });

  it('rejects a non-boolean confirmsBuiltIn', () => {
    const result = validateSessionRequirements([
      { sessionTypeId: 'api-key', confirmsBuiltIn: 'yes', requiredScopesOrRoles: [] },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('sessionRequirements[0].confirmsBuiltIn must be a boolean');
  });

  it('rejects a non-array requiredScopesOrRoles', () => {
    const result = validateSessionRequirements([
      { sessionTypeId: 'api-key', confirmsBuiltIn: false, requiredScopesOrRoles: 'Mail.Read' },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('sessionRequirements[0].requiredScopesOrRoles must be an array of strings');
  });

  it('reports errors with the correct index across multiple requirements', () => {
    const result = validateSessionRequirements([
      validRequirement,
      { sessionTypeId: '', confirmsBuiltIn: false, requiredScopesOrRoles: [] },
    ]);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('sessionRequirements[1].sessionTypeId must be a non-empty string');
  });
});
