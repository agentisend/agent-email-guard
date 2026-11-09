import { describe, expect, it } from 'vitest';
import { addressList, formatNumber, round3, textSimilarity, normalizeText } from '../src/index.js';
import { plural, formatInstant } from '../src/decisions.js';

describe('normalization and formatting (SPEC §3, §4.1)', () => {
  it('addresses: display names, commas, objects, case, duplicates', () => {
    expect(addressList('Ana <ANA@Example.com>, bo@example.com , ana@example.com')).toEqual(['ana@example.com', 'bo@example.com']);
    expect(addressList([{ address: 'X@Y.io', name: 'X' }, { email: 'z@y.io' }, ''])).toEqual(['x@y.io', 'z@y.io']);
    expect(addressList(undefined)).toEqual([]);
  });
  it('lowercases ASCII only', () => {
    expect(normalizeText('ÉCOLE Straße KELVIN')).toBe('cole stra e kelvin');
  });
  it('similarity is 1 for equal normalized text and Jaccard otherwise', () => {
    expect(textSimilarity('Hello, World!', 'hello world')).toBe(1);
    expect(textSimilarity('abc', 'xyz')).toBe(0);
  });
  it('round3 rounds half up and numbers print bare', () => {
    expect(round3(0.0005)).toBe(0.001);
    expect(round3(2.8284271)).toBe(2.828);
    expect(formatNumber(2)).toBe('2');
    expect(formatNumber(0.333)).toBe('0.333');
    expect(plural(1, 'email')).toBe('1 email');
    expect(plural(0, 'email')).toBe('0 emails');
    expect(formatInstant(Date.UTC(2027, 1, 1))).toBe('2027-02-01T00:00:00Z');
  });
});
