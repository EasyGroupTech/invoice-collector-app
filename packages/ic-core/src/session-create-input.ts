import type { DestinationPlugin, SourcePlugin } from 'invoice-collector-plugin-sdk';

/**
 * Resolves what `input` to actually pass into `SessionsApi.create()` for a wizard's "create a new
 * session" step. An explicitly-supplied input (a custom, `confirmsBuiltIn: false` session type's
 * own collected input) always wins; otherwise, for a `confirmsBuiltIn: true` requirement, falls
 * back to the plugin's own `BuiltInSessionInputProvider.builtInSessionCreateInput()` — see that
 * interface's doc comment for why a built-in type's create() input can't come from a generic form.
 */
export function resolveSessionCreateInput(
  plugin: SourcePlugin | DestinationPlugin,
  sessionTypeId: string,
  suppliedInput: unknown,
): unknown {
  if (suppliedInput !== undefined) return suppliedInput;

  const requirement = plugin.sessionRequirements.find((r) => r.sessionTypeId === sessionTypeId);
  if (!requirement) {
    throw new Error(`Plugin "${plugin.manifest.id}" does not declare a sessionRequirement for "${sessionTypeId}"`);
  }

  if (!plugin.builtInSessionCreateInput) {
    throw new Error(
      `Plugin "${plugin.manifest.id}" supplied no input for session type "${sessionTypeId}" and has no builtInSessionCreateInput to fall back to`,
    );
  }

  return plugin.builtInSessionCreateInput(requirement);
}
