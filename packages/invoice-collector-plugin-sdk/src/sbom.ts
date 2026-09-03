/**
 * Minimal shape of the parts of a CycloneDX document this module actually reads — not a full
 * schema. Verified against real `@cyclonedx/cyclonedx-npm@6.0.1` output, not guessed at: a
 * component's `licenses` is an array of "LicenseChoice" entries, each either `{ license: { id }
 * | { name } }` (a recognized/unrecognized single license) or `{ expression }` (a boolean SPDX
 * expression like "(MIT OR Apache-2.0)") — never both on the same entry.
 */
export interface CycloneDxLicenseEntry {
  license?: { id?: string; name?: string };
  expression?: string;
}

export interface CycloneDxComponent {
  name: string;
  version?: string;
  licenses?: CycloneDxLicenseEntry[];
}

export interface CycloneDxDocument {
  bomFormat?: string;
  specVersion?: string;
  components?: CycloneDxComponent[];
}

export interface MitCompatibilityViolation {
  name: string;
  version?: string;
  reason: string;
}

export interface MitCompatibilityResult {
  compatible: boolean;
  violations: MitCompatibilityViolation[];
}

/**
 * §16's original permissive set, plus three verified as genuinely permissive and low-risk on
 * review (not blanket-widened): BlueOak-1.0.0 (a modern permissive license, at least as
 * permissive as MIT, increasingly common in core npm/Node tooling), CC0-1.0 (a public-domain
 * dedication — stronger than permissive, no attribution required at all), and Python-2.0 (the
 * Python Software Foundation's own BSD-style license — FSF lists it as GPL-compatible, a
 * stronger bar than this). Each was a real finding from actually running this check, not added
 * speculatively.
 */
const MIT_COMPATIBLE_LICENSE_IDS = new Set([
  'MIT',
  'ISC',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'Apache-2.0',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'Python-2.0',
]);

/**
 * Any *actual* Creative Commons license (CC-BY, CC-BY-SA, etc. — not CC0, a different legal
 * instrument despite the similar name) gets flagged for manual review rather than either
 * allowed or rejected outright: Creative Commons itself advises against using CC licenses for
 * software, since they weren't drafted with source code, compiled forms, or patent grants in
 * mind — a real, published concern, not a fringe one. The terms themselves are often permissive
 * (attribution-only for CC-BY), so this isn't treated as a hard failure like copyleft; it's
 * treated like a license expression — something a human should actually look at.
 */
function isCreativeCommonsLicense(id: string): boolean {
  return id.startsWith('CC-');
}

/**
 * The load-time MIT-compatibility gate §16 describes: every third-party dependency's license must
 * be one of the permissive set above. Fails closed on anything it can't confidently confirm —
 * missing license info, an unrecognized license name, a Creative Commons license, or a boolean
 * SPDX expression (which would need real expression evaluation to judge correctly; flagged for
 * manual review instead of guessing at AND/OR semantics).
 */
export function checkMitCompatibility(sbom: CycloneDxDocument): MitCompatibilityResult {
  const violations: MitCompatibilityViolation[] = [];

  for (const component of sbom.components ?? []) {
    const entries = component.licenses ?? [];

    if (entries.length === 0) {
      violations.push({ name: component.name, version: component.version, reason: 'no license information found' });
      continue;
    }

    for (const entry of entries) {
      if (entry.expression !== undefined) {
        violations.push({
          name: component.name,
          version: component.version,
          reason: `license expression "${entry.expression}" requires manual review`,
        });
        continue;
      }

      const id = entry.license?.id ?? entry.license?.name;

      if (id && isCreativeCommonsLicense(id)) {
        violations.push({
          name: component.name,
          version: component.version,
          reason: `license "${id}" is a Creative Commons license — Creative Commons advises against using CC licenses for software, requires manual review`,
        });
        continue;
      }

      if (!id || !MIT_COMPATIBLE_LICENSE_IDS.has(id)) {
        violations.push({
          name: component.name,
          version: component.version,
          reason: `license "${id ?? 'unknown'}" is not MIT-compatible`,
        });
      }
    }
  }

  return { compatible: violations.length === 0, violations };
}
