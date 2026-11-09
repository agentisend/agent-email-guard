/**
 * Address and text normalization (SPEC §3). ASCII-only on purpose: Unicode
 * case folding differs between runtimes, and the vectors must match in four
 * languages.
 */

/** Lowercase A–Z only. */
export function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));
}

/** Trim the ASCII whitespace characters space, \t, \n, \r, \f, \v. */
export function asciiTrim(s: string): string {
  return s.replace(/^[ \t\n\r\f\v]+|[ \t\n\r\f\v]+$/g, '');
}

export type AddressInput = string | { address?: string; email?: string; name?: string };
export type AddressField = AddressInput | readonly AddressInput[] | undefined | null;

/**
 * One address as the guard compares it: the part inside <…> when present,
 * trimmed, ASCII-lowercased. Empty string when nothing is left.
 */
export function normalizeAddress(raw: string): string {
  let s = asciiTrim(raw);
  const angle = /<([^<>]*)>[ \t\n\r\f\v]*$/.exec(s);
  if (angle) s = angle[1] ?? '';
  return asciiLower(asciiTrim(s));
}

/**
 * Every address in a To/Cc/Bcc field, in order, normalized, duplicates
 * dropped. A string splits on commas; objects read `address`, then `email`.
 */
export function addressList(field: AddressField): string[] {
  if (field === undefined || field === null) return [];
  const items = Array.isArray(field) ? (field as readonly AddressInput[]) : [field as AddressInput];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of items) {
    const parts =
      typeof item === 'string' ? item.split(',') : [typeof item?.address === 'string' ? item.address : (item?.email ?? '')];
    for (const part of parts) {
      const a = normalizeAddress(part);
      if (a === '' || seen.has(a)) continue;
      seen.add(a);
      out.push(a);
    }
  }
  return out;
}

/** How much normalized body text the similarity comparison reads. */
export const BODY_COMPARE_CHARS = 4096;

/** ASCII-lowercase, every run of characters outside [a-z0-9] becomes one space, trimmed. */
export function normalizeText(text: string): string {
  return asciiLower(text)
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^ +| +$/g, '');
}

/** Character trigrams of `"  " + text + " "`. Input is already normalized. */
export function trigrams(normalized: string): Set<string> {
  const padded = `  ${normalized} `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i++) grams.add(padded.slice(i, i + 3));
  return grams;
}

/** Jaccard similarity over trigram sets, 0..1. Equal normalized strings score 1. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let inter = 0;
  const [small, big] = a.size <= b.size ? [a, b] : [b, a];
  for (const g of small) if (big.has(g)) inter++;
  const union = a.size + b.size - inter;
  return union === 0 ? 1 : inter / union;
}

/** Similarity of two raw strings (normalize, trigram, Jaccard). */
export function textSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  return jaccard(trigrams(na), trigrams(nb));
}
