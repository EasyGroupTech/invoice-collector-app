/** The plugin's own persisted config (§5's "plugin-owned JSON, non-secret, non-session config
 * only") — deliberately just these three fields, not a date range: the actual collect period
 * always comes from core's own job runner (§14, `discover()`'s own `period` argument), never
 * from anything captured once at onboarding. */
export interface MailSourceConfig {
  subjectContains?: string;
  senderContains?: string;
  hasAttachmentsOnly?: boolean;
}

export interface MailFilterCandidate {
  subject: string;
  from?: string;
  hasAttachments: boolean;
}

/** Client-side only, deliberately — Graph's own `$filter`'s `contains()` support for mail
 * properties is unreliable, and `$search` applies relevance ranking a deterministic scan
 * doesn't want (see graph-mail.ts's own doc comment). Substring matching is case-insensitive. */
export function matchesMailFilter(candidate: MailFilterCandidate, filter: MailSourceConfig): boolean {
  if (filter.hasAttachmentsOnly && !candidate.hasAttachments) return false;
  if (filter.subjectContains && !candidate.subject.toLowerCase().includes(filter.subjectContains.toLowerCase())) return false;
  if (filter.senderContains && !(candidate.from ?? '').toLowerCase().includes(filter.senderContains.toLowerCase())) return false;
  return true;
}
