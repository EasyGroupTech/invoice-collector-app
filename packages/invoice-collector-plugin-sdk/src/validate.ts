import { KNOWN_BUILT_IN_SESSION_TYPE_IDS } from './session.js';
import type { WizardStepDescriptor, SettingsPanelDescriptor } from './ui.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

const REQUIRED_MANIFEST_STRING_FIELDS = ['id', 'name', 'version', 'pluginApiVersion', 'sbom', 'main'] as const;

/**
 * The load-time manifest shape check core applies to every plugin, OSS or commercial, before
 * installing it — the same hard-gate rigor §13 already applies to a missing `sbom` specifically,
 * generalized here to the whole manifest shape.
 */
export function validateManifest(manifest: unknown): ValidationResult {
  const errors: string[] = [];

  if (typeof manifest !== 'object' || manifest === null) {
    return { valid: false, errors: ['manifest must be an object'] };
  }

  const m = manifest as Record<string, unknown>;

  for (const field of REQUIRED_MANIFEST_STRING_FIELDS) {
    if (typeof m[field] !== 'string' || m[field] === '') {
      errors.push(`manifest.${field} must be a non-empty string`);
    }
  }

  if (m.kind !== 'source' && m.kind !== 'destination') {
    errors.push('manifest.kind must be "source" or "destination"');
  }

  if (m.repository !== undefined && typeof m.repository !== 'string') {
    errors.push('manifest.repository must be a string when present');
  }

  return { valid: errors.length === 0, errors };
}

/**
 * The load-time check core applies to a plugin's declared session requirements: at least one
 * entry (§6), each one well-formed, and — the part that actually catches a real mistake, not just
 * a shape error — `confirmsBuiltIn: true` only accepted for a sessionTypeId that's genuinely one
 * of the SDK's known built-in session types, not just any string the plugin author typed.
 */
export function validateSessionRequirements(requirements: unknown): ValidationResult {
  if (!Array.isArray(requirements) || requirements.length === 0) {
    return { valid: false, errors: ['sessionRequirements must be a non-empty array'] };
  }

  const errors: string[] = [];

  requirements.forEach((requirement, index) => {
    if (typeof requirement !== 'object' || requirement === null) {
      errors.push(`sessionRequirements[${index}] must be an object`);
      return;
    }

    const r = requirement as Record<string, unknown>;

    if (typeof r.sessionTypeId !== 'string' || r.sessionTypeId === '') {
      errors.push(`sessionRequirements[${index}].sessionTypeId must be a non-empty string`);
    }

    if (typeof r.confirmsBuiltIn !== 'boolean') {
      errors.push(`sessionRequirements[${index}].confirmsBuiltIn must be a boolean`);
    }

    if (
      !Array.isArray(r.requiredScopesOrRoles) ||
      !r.requiredScopesOrRoles.every((scope) => typeof scope === 'string')
    ) {
      errors.push(`sessionRequirements[${index}].requiredScopesOrRoles must be an array of strings`);
    }

    if (
      r.confirmsBuiltIn === true &&
      typeof r.sessionTypeId === 'string' &&
      !(KNOWN_BUILT_IN_SESSION_TYPE_IDS as readonly string[]).includes(r.sessionTypeId)
    ) {
      errors.push(
        `sessionRequirements[${index}]: confirmsBuiltIn is true but "${r.sessionTypeId}" is not a known SDK built-in session type`,
      );
    }
  });

  return { valid: errors.length === 0, errors };
}

/**
 * A ListDescriptor's `dataSource` (§8) is resolved by calling the plugin's own
 * `resolveListData()` — if a plugin's `wizard`/`settingsPanel` declares one but doesn't implement
 * that optional method, its wizard would render a list with no way to ever populate it. Checked
 * at install time, after the plugin module is loaded (unlike `validateManifest`, which only ever
 * sees the manifest JSON, before any code runs).
 */
export function validateWizardDataSources(plugin: {
  wizard: WizardStepDescriptor[];
  settingsPanel?: SettingsPanelDescriptor;
  resolveListData?: unknown;
}): ValidationResult {
  const steps = [...plugin.wizard, ...(plugin.settingsPanel?.steps ?? [])];
  const hasListStep = steps.some((step) => step.kind === 'list');

  if (hasListStep && typeof plugin.resolveListData !== 'function') {
    return {
      valid: false,
      errors: ['plugin declares a ListDescriptor wizard/settings-panel step but does not implement resolveListData'],
    };
  }

  return { valid: true, errors: [] };
}
