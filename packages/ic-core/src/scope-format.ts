/**
 * §14.1's "scope is a user-typed prefix plus whatever accounts the plugin actually discovered"
 * convention (`PluginBackedRecord.scope`'s own doc comment, SDK) — a single persisted string
 * split into two logical halves by one marker, so no new field/migration is needed. This module
 * is the only code, anywhere, that ever splits or joins the two back apart: `collect-pipeline.ts`
 * recomputes the discovered half fresh on every run via `appendDiscoveredScope`; the Edit Flow
 * dialog (renderer) shows and edits only the prefix half via `splitScope`, then re-joins whatever
 * discovered half was already there via `joinScope` so saving a prefix edit doesn't blank out the
 * discovered half until the next real collect run recomputes it.
 *
 * Deliberately a plain, human-readable separator (not an invisible/control character) — this is
 * still a free-text field a user reads directly in the Collect page's history table. The real
 * trade-off this accepts: a user prefix that happens to already contain " · " would have that
 * literal text mistaken for the start of the discovered half on the *next* edit-dialog load. Rare
 * enough (an ASCII middle dot phrase) that self-hosted repos this small are trading a small,
 * visible-when-it-happens edge case for not needing a whole new persisted field.
 */
const DISCOVERED_SCOPE_MARKER = ' · ';

export interface SplitScope {
  /** The user's own text — what the Edit Flow dialog shows and lets them change. */
  prefix: string;
  /** Whatever was appended after the marker, if any — never shown as editable, only carried
   * forward until the next `appendDiscoveredScope` call replaces it. */
  discovered?: string;
}

export function splitScope(scope: string | undefined): SplitScope {
  if (!scope) return { prefix: '' };
  const idx = scope.lastIndexOf(DISCOVERED_SCOPE_MARKER);
  if (idx === -1) return { prefix: scope };
  return { prefix: scope.slice(0, idx), discovered: scope.slice(idx + DISCOVERED_SCOPE_MARKER.length) };
}

export function joinScope(prefix: string, discovered: string | undefined): string {
  if (!discovered) return prefix;
  return prefix ? `${prefix}${DISCOVERED_SCOPE_MARKER}${discovered}` : discovered;
}

/**
 * `ScopeDescriber.describeCollectionScope()`'s own labels, folded onto whatever the user actually
 * typed (recovered via `splitScope` — never onto a *previous* discovered half, which this
 * discards and replaces). Empty `labels` leaves `scope` untouched entirely, prefix included —
 * nothing to append, nothing to prove was recomputed.
 *
 * Deduplicates (preserving first-seen order) before joining — confirmed live against a real
 * Azure tenant with several billing profiles that all happen to share the exact same display
 * name: without this, `scope` read the same label repeated a dozen times, which is real
 * information (there really are that many billing scopes) but conveys nothing extra to a reader
 * past the first repeat.
 */
export function appendDiscoveredScope(scope: string | undefined, labels: string[]): string {
  if (labels.length === 0) return scope ?? '';
  const { prefix } = splitScope(scope);
  return joinScope(prefix, [...new Set(labels)].join(', '));
}
