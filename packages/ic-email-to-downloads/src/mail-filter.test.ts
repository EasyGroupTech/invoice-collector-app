import { describe, expect, it } from 'vitest';
import { matchesMailFilter } from './mail-filter.js';

const base = { subject: 'Your Invoice from Acme Corp', from: 'billing@acme.example.com', hasAttachments: true };

describe('matchesMailFilter', () => {
  it('matches everything when no filter fields are set', () => {
    expect(matchesMailFilter(base, {})).toBe(true);
  });

  it('matches subjectContains case-insensitively', () => {
    expect(matchesMailFilter(base, { subjectContains: 'invoice' })).toBe(true);
    expect(matchesMailFilter(base, { subjectContains: 'INVOICE' })).toBe(true);
    expect(matchesMailFilter(base, { subjectContains: 'receipt' })).toBe(false);
  });

  it('matches senderContains case-insensitively against the from address', () => {
    expect(matchesMailFilter(base, { senderContains: 'acme.example.com' })).toBe(true);
    expect(matchesMailFilter(base, { senderContains: 'other.example.com' })).toBe(false);
  });

  it('treats a missing from address as never matching a senderContains filter', () => {
    expect(matchesMailFilter({ ...base, from: undefined }, { senderContains: 'acme' })).toBe(false);
  });

  it('rejects a message with no attachments when hasAttachmentsOnly is set', () => {
    expect(matchesMailFilter({ ...base, hasAttachments: false }, { hasAttachmentsOnly: true })).toBe(false);
  });

  it('requires every set filter field to match, not just one', () => {
    const filter = { subjectContains: 'invoice', senderContains: 'wrong-domain.com' };
    expect(matchesMailFilter(base, filter)).toBe(false);
  });
});
