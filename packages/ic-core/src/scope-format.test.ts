import { describe, expect, it } from 'vitest';
import { appendDiscoveredScope, joinScope, splitScope } from './scope-format.js';

describe('splitScope', () => {
  it('treats a plain scope with no marker entirely as the prefix', () => {
    expect(splitScope('Finance')).toEqual({ prefix: 'Finance' });
  });

  it('returns an empty prefix for undefined', () => {
    expect(splitScope(undefined)).toEqual({ prefix: '' });
  });

  it('returns an empty prefix for an empty string', () => {
    expect(splitScope('')).toEqual({ prefix: '' });
  });

  it('splits a prefix and a discovered half at the marker', () => {
    expect(splitScope('Finance · acct-1, acct-2')).toEqual({ prefix: 'Finance', discovered: 'acct-1, acct-2' });
  });

  it('splits at the LAST marker, not the first, in case the prefix itself contains one', () => {
    expect(splitScope('Finance · EMEA · acct-1')).toEqual({ prefix: 'Finance · EMEA', discovered: 'acct-1' });
  });

  it('treats a bare discovered half (no prefix ever typed) as prefix-less', () => {
    expect(splitScope(' · acct-1')).toEqual({ prefix: '', discovered: 'acct-1' });
  });
});

describe('joinScope', () => {
  it('returns the bare prefix when there is nothing discovered', () => {
    expect(joinScope('Finance', undefined)).toBe('Finance');
  });

  it('joins prefix and discovered with the marker', () => {
    expect(joinScope('Finance', 'acct-1, acct-2')).toBe('Finance · acct-1, acct-2');
  });

  it('returns the discovered half alone when the prefix is empty', () => {
    expect(joinScope('', 'acct-1')).toBe('acct-1');
  });

  it('round-trips through splitScope', () => {
    const original = 'Finance · acct-1, acct-2';
    const { prefix, discovered } = splitScope(original);
    expect(joinScope(prefix, discovered)).toBe(original);
  });
});

describe('appendDiscoveredScope', () => {
  it('appends fresh labels onto a plain user prefix', () => {
    expect(appendDiscoveredScope('Finance', ['acct-1', 'acct-2'])).toBe('Finance · acct-1, acct-2');
  });

  it('replaces a stale discovered half rather than accumulating onto it', () => {
    expect(appendDiscoveredScope('Finance · old-acct', ['new-acct'])).toBe('Finance · new-acct');
  });

  it('leaves scope completely untouched when there are no labels to append', () => {
    expect(appendDiscoveredScope('Finance · old-acct', [])).toBe('Finance · old-acct');
  });

  it('returns an empty string when there is no scope and no labels', () => {
    expect(appendDiscoveredScope(undefined, [])).toBe('');
  });

  it('works with no prefix at all — just the discovered labels', () => {
    expect(appendDiscoveredScope(undefined, ['acct-1'])).toBe('acct-1');
  });

  it('is idempotent — appending the same labels twice in a row produces the same result', () => {
    const once = appendDiscoveredScope('Finance', ['acct-1', 'acct-2']);
    const twice = appendDiscoveredScope(once, ['acct-1', 'acct-2']);
    expect(twice).toBe(once);
  });

  it('deduplicates repeated labels, preserving first-seen order — confirmed live against a real tenant with several identically-named billing profiles', () => {
    expect(appendDiscoveredScope('Finance', ['Contoso', 'Contoso', 'Fabrikam', 'Contoso'])).toBe('Finance · Contoso, Fabrikam');
  });
});
