<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/**
 * Address and text normalization (SPEC §3). ASCII-only on purpose: Unicode
 * case folding differs between runtimes, and the vectors must match in four
 * languages.
 */
final class Text
{
    /** How much normalized body text the similarity comparison reads. */
    public const BODY_COMPARE_CHARS = 4096;

    private const WHITESPACE = " \t\n\r\f\x0B";

    private function __construct()
    {
    }

    /** Lowercase A-Z only. */
    public static function asciiLower(string $s): string
    {
        return strtr($s, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz');
    }

    /** Trim space, \t, \n, \r, \f and \v. */
    public static function asciiTrim(string $s): string
    {
        return trim($s, self::WHITESPACE);
    }

    /**
     * One address as the guard compares it: the part inside <...> when
     * present, trimmed, ASCII-lowercased. Empty string when nothing is left.
     */
    public static function normalizeAddress(string $raw): string
    {
        $s = self::asciiTrim($raw);
        if (preg_match('/<([^<>]*)>[ \t\n\r\f\x0B]*\z/', $s, $m) === 1) {
            $s = $m[1];
        }
        return self::asciiLower(self::asciiTrim($s));
    }

    /**
     * Every address in a To/Cc/Bcc field, in order, normalized, duplicates
     * dropped. A string splits on commas; an array with `address` or `email`
     * is one address; a list holds any of those. Objects with getAddress()
     * (Symfony's Address) are read too.
     *
     * @return list<string>
     */
    public static function addressList(mixed $field): array
    {
        if ($field === null) {
            return [];
        }
        $items = (is_array($field) && array_is_list($field)) ? $field : [$field];
        $out = [];
        $seen = [];
        foreach ($items as $item) {
            foreach (self::addressParts($item) as $part) {
                $address = self::normalizeAddress($part);
                if ($address === '' || isset($seen[$address])) {
                    continue;
                }
                $seen[$address] = true;
                $out[] = $address;
            }
        }
        return $out;
    }

    /** @return list<string> */
    private static function addressParts(mixed $item): array
    {
        if (is_string($item)) {
            return explode(',', $item);
        }
        if (is_array($item)) {
            if (isset($item['address']) && is_string($item['address'])) {
                return [$item['address']];
            }
            return [isset($item['email']) && is_string($item['email']) ? $item['email'] : ''];
        }
        if (is_object($item) && method_exists($item, 'getAddress')) {
            $address = $item->getAddress();
            return [is_string($address) ? $address : ''];
        }
        return [];
    }

    /** ASCII-lowercase; every run of characters outside [a-z0-9] becomes one space; trimmed. */
    public static function normalizeText(string $text): string
    {
        $lower = self::asciiLower($text);
        $spaced = preg_replace('/[^a-z0-9]+/', ' ', $lower) ?? '';
        return trim($spaced, ' ');
    }

    /**
     * Character trigrams of "  " . $normalized . " ", as a set (keys).
     *
     * @return array<array-key, true>
     */
    public static function trigrams(string $normalized): array
    {
        $padded = '  ' . $normalized . ' ';
        $grams = [];
        $last = strlen($padded) - 2;
        for ($i = 0; $i < $last; $i++) {
            $grams[substr($padded, $i, 3)] = true;
        }
        return $grams;
    }

    /**
     * Jaccard similarity of two trigram sets, 0..1.
     *
     * @param array<array-key, true> $a
     * @param array<array-key, true> $b
     */
    public static function jaccard(array $a, array $b): float
    {
        $sizeA = count($a);
        $sizeB = count($b);
        if ($sizeA === 0 && $sizeB === 0) {
            return 1.0;
        }
        $intersection = count($sizeA <= $sizeB ? array_intersect_key($a, $b) : array_intersect_key($b, $a));
        $union = $sizeA + $sizeB - $intersection;
        return $union === 0 ? 1.0 : $intersection / $union;
    }

    /** Similarity of two raw strings: normalize, trigram, Jaccard. Equal normalized strings score 1. */
    public static function similarity(string $a, string $b): float
    {
        $na = self::normalizeText($a);
        $nb = self::normalizeText($b);
        if ($na === $nb) {
            return 1.0;
        }
        return self::jaccard(self::trigrams($na), self::trigrams($nb));
    }
}
