import { describe, expect, it } from 'vitest';
import { checkMitCompatibility, type CycloneDxDocument } from './sbom.js';

function sbomWith(components: CycloneDxDocument['components']): CycloneDxDocument {
  return { bomFormat: 'CycloneDX', specVersion: '1.6', components };
}

describe('checkMitCompatibility', () => {
  it('passes an SBOM whose components are all MIT-compatible (by license.id)', () => {
    const sbom = sbomWith([
      { name: 'lodash', version: '4.18.1', licenses: [{ license: { id: 'MIT' } }] },
      { name: 'ms', version: '2.1.3', licenses: [{ license: { id: 'ISC' } }] },
      { name: 'accepts', version: '1.3.8', licenses: [{ license: { id: 'BSD-2-Clause' } }] },
      { name: 'array-flatten', version: '1.1.1', licenses: [{ license: { id: 'BSD-3-Clause' } }] },
      { name: 'undici', version: '5.28.4', licenses: [{ license: { id: 'Apache-2.0' } }] },
    ]);

    expect(checkMitCompatibility(sbom)).toEqual({ compatible: true, violations: [] });
  });

  it('passes an SBOM with no components at all', () => {
    expect(checkMitCompatibility(sbomWith([]))).toEqual({ compatible: true, violations: [] });
    expect(checkMitCompatibility({ bomFormat: 'CycloneDX', specVersion: '1.6' })).toEqual({
      compatible: true,
      violations: [],
    });
  });

  it('flags a copyleft-licensed component by id', () => {
    const sbom = sbomWith([{ name: 'some-gpl-lib', version: '1.0.0', licenses: [{ license: { id: 'GPL-3.0-only' } }] }]);

    const result = checkMitCompatibility(sbom);
    expect(result.compatible).toBe(false);
    expect(result.violations).toEqual([
      { name: 'some-gpl-lib', version: '1.0.0', reason: 'license "GPL-3.0-only" is not MIT-compatible' },
    ]);
  });

  it('accepts a recognized license supplied as license.name instead of license.id', () => {
    const sbom = sbomWith([{ name: 'legacy-pkg', version: '0.1.0', licenses: [{ license: { name: 'MIT' } }] }]);
    expect(checkMitCompatibility(sbom)).toEqual({ compatible: true, violations: [] });
  });

  it('flags an unrecognized license name as non-compatible rather than assuming it is fine', () => {
    const sbom = sbomWith([
      { name: 'weird-pkg', version: '0.1.0', licenses: [{ license: { name: 'Custom Proprietary License' } }] },
    ]);
    const result = checkMitCompatibility(sbom);
    expect(result.compatible).toBe(false);
    expect(result.violations).toEqual([
      {
        name: 'weird-pkg',
        version: '0.1.0',
        reason: 'license "Custom Proprietary License" is not MIT-compatible',
      },
    ]);
  });

  it('flags a component with no license information at all — fails closed, never assumed fine', () => {
    const sbom = sbomWith([{ name: 'no-license-pkg', version: '0.1.0' }]);
    const result = checkMitCompatibility(sbom);
    expect(result.compatible).toBe(false);
    expect(result.violations).toEqual([
      { name: 'no-license-pkg', version: '0.1.0', reason: 'no license information found' },
    ]);
  });

  it('flags a component whose licenses array is present but empty', () => {
    const sbom = sbomWith([{ name: 'empty-licenses-pkg', version: '0.1.0', licenses: [] }]);
    const result = checkMitCompatibility(sbom);
    expect(result.compatible).toBe(false);
    expect(result.violations).toEqual([
      { name: 'empty-licenses-pkg', version: '0.1.0', reason: 'no license information found' },
    ]);
  });

  it('flags a boolean SPDX license expression for manual review rather than evaluating it', () => {
    const sbom = sbomWith([
      { name: 'dual-licensed-pkg', version: '0.1.0', licenses: [{ expression: '(MIT OR Apache-2.0)' }] },
    ]);
    const result = checkMitCompatibility(sbom);
    expect(result.compatible).toBe(false);
    expect(result.violations).toEqual([
      {
        name: 'dual-licensed-pkg',
        version: '0.1.0',
        reason: 'license expression "(MIT OR Apache-2.0)" requires manual review',
      },
    ]);
  });

  it('collects every violation across every component, not just the first', () => {
    const sbom = sbomWith([
      { name: 'ok-pkg', version: '1.0.0', licenses: [{ license: { id: 'MIT' } }] },
      { name: 'bad-pkg-1', version: '1.0.0', licenses: [{ license: { id: 'GPL-3.0-only' } }] },
      { name: 'bad-pkg-2', version: '1.0.0' },
    ]);
    const result = checkMitCompatibility(sbom);
    expect(result.compatible).toBe(false);
    expect(result.violations).toHaveLength(2);
    expect(result.violations.map((v) => v.name)).toEqual(['bad-pkg-1', 'bad-pkg-2']);
  });

  it('flags a component with multiple license entries if any single one is non-compatible', () => {
    const sbom = sbomWith([
      {
        name: 'multi-license-pkg',
        version: '1.0.0',
        licenses: [{ license: { id: 'MIT' } }, { license: { id: 'GPL-2.0-only' } }],
      },
    ]);
    const result = checkMitCompatibility(sbom);
    expect(result.compatible).toBe(false);
    expect(result.violations).toEqual([
      { name: 'multi-license-pkg', version: '1.0.0', reason: 'license "GPL-2.0-only" is not MIT-compatible' },
    ]);
  });

  it('accepts BlueOak-1.0.0, CC0-1.0, and Python-2.0 — genuinely permissive, just uncommon names', () => {
    const sbom = sbomWith([
      { name: 'tar', version: '7.5.22', licenses: [{ license: { id: 'BlueOak-1.0.0' } }] },
      { name: 'spdx-license-ids', version: '3.0.23', licenses: [{ license: { id: 'CC0-1.0' } }] },
      { name: 'argparse', version: '2.0.1', licenses: [{ license: { id: 'Python-2.0' } }] },
    ]);
    expect(checkMitCompatibility(sbom)).toEqual({ compatible: true, violations: [] });
  });

  it('flags a Creative Commons *license* (not CC0) for manual review rather than allowing it outright', () => {
    // Creative Commons itself advises against using CC licenses for software — unlike CC0 (a
    // public-domain dedication, genuinely compatible), a CC-BY/CC-BY-SA/etc. license is legally
    // ill-suited for code (no software-specific patent/source-distribution handling), so this
    // gets the same "can't confidently auto-approve" treatment as a license expression, not a
    // blanket allow or a blanket fail.
    const sbom = sbomWith([{ name: 'spdx-exceptions', version: '2.5.0', licenses: [{ license: { id: 'CC-BY-3.0' } }] }]);
    const result = checkMitCompatibility(sbom);
    expect(result.compatible).toBe(false);
    expect(result.violations).toEqual([
      {
        name: 'spdx-exceptions',
        version: '2.5.0',
        reason:
          'license "CC-BY-3.0" is a Creative Commons license — Creative Commons advises against using CC licenses for software, requires manual review',
      },
    ]);
  });

  it('flags any CC-BY-family license the same way, not just the exact 3.0 version', () => {
    const sbom = sbomWith([{ name: 'some-pkg', version: '1.0.0', licenses: [{ license: { id: 'CC-BY-SA-4.0' } }] }]);
    const result = checkMitCompatibility(sbom);
    expect(result.compatible).toBe(false);
    expect(result.violations[0].reason).toMatch(/Creative Commons/);
  });

  it('does not mistake CC0-1.0 for the CC- (Creative Commons license) prefix it is not', () => {
    // A regression guard: CC0 and "CC-*" are different legal instruments (public-domain
    // dedication vs. an actual Creative Commons license) despite the similar-looking prefix.
    const sbom = sbomWith([{ name: 'cc0-pkg', version: '1.0.0', licenses: [{ license: { id: 'CC0-1.0' } }] }]);
    expect(checkMitCompatibility(sbom)).toEqual({ compatible: true, violations: [] });
  });
});
