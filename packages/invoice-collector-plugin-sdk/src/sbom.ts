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
 * The permissive licenses §16 names as passing — deliberately not a longer "everything roughly
 * permissive" list (0BSD, CC0-1.0, Unlicense, …): sticking to exactly what was decided rather than
 * quietly expanding it. Easy to extend later if a real dependency needs it.
 */
const MIT_COMPATIBLE_LICENSE_IDS = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0']);

/**
 * The load-time MIT-compatibility gate §16 describes: every third-party dependency's license must
 * be one of the permissive set above. Fails closed on anything it can't confidently confirm —
 * missing license info, an unrecognized license name, or a boolean SPDX expression (which would
 * need real expression evaluation to judge correctly; flagged for manual review instead of
 * guessing at AND/OR semantics).
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
