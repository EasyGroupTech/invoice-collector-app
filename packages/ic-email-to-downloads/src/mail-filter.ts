import type { MailFieldRule } from './mail-field-rules.js';

/** The plugin's own persisted config (§5's "plugin-owned JSON, non-secret, non-session config
 * only") — deliberately no date range: the actual collect period always comes from core's own job
 * runner (§14, `discover()`'s own `period` argument), never from anything captured once at
 * onboarding. `fieldRules` is §14.3's manual field-rule capture (see mail-field-rules.ts) —
 * additive; a source created before this field existed simply has it undefined, same as any other
 * unset optional field. */
export interface MailSourceConfig {
  subjectContains?: string;
  senderContains?: string;
  hasAttachmentsOnly?: boolean;
  fieldRules?: MailFieldRule[];
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
