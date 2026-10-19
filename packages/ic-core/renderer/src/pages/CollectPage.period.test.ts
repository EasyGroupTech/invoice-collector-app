import { describe, expect, it } from 'vitest';
import { periodForMonth } from './CollectPage';

describe('periodForMonth', () => {
  it.each([
    [2026, 9, '2026-09-30'],
    [2026, 2, '2026-02-28'],
    [2028, 2, '2028-02-29'],
    [2026, 12, '2026-12-31'],
  ])('ends %i-%i on its real last day regardless of local timezone', (year, month, end) => {
    expect(periodForMonth(year, month)).toEqual({ start: `${year}-${String(month).padStart(2, '0')}-01`, end });
  });
});
