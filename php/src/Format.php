<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/**
 * Number and time formatting (SPEC §4.1). The sentences are byte-identical
 * across languages only if every port formats numbers exactly like this.
 */
final class Format
{
    private function __construct()
    {
    }

    /** Round half up to 3 decimals: floor(x * 1000 + 0.5) / 1000. */
    public static function round3(float $x): float
    {
        return floor($x * 1000 + 0.5) / 1000;
    }

    /**
     * Integral values print without a decimal point; any other number prints
     * as the shortest decimal that reads back as the same float. Independent
     * of the precision and serialize_precision ini settings.
     */
    public static function number(int|float $n): string
    {
        if (is_int($n)) {
            return (string) $n;
        }
        if (is_finite($n) && floor($n) === $n && abs($n) < 9.0e15) {
            return (string) (int) $n;
        }
        for ($digits = 1; $digits <= 17; $digits++) {
            $s = sprintf('%.' . $digits . 'G', $n);
            if ((float) $s === $n) {
                break;
            }
        }
        /** @var string $s */
        if (str_contains($s, 'E')) {
            // Out of the range the guard ever prints; keep it readable anyway.
            return strtolower($s);
        }
        return $s;
    }

    /** "1 email", "2 emails". */
    public static function plural(int|float $n, string $singular): string
    {
        $word = (float) $n === 1.0 ? $singular : $singular . "s";
        return self::number($n) . ' ' . $word;
    }

    /** Epoch ms to YYYY-MM-DDTHH:MM:SSZ (UTC, no fraction). */
    public static function instant(int $ms): string
    {
        $seconds = intdiv($ms, 1000);
        if ($ms < 0 && $ms % 1000 !== 0) {
            $seconds--;
        }
        return gmdate('Y-m-d\TH:i:s\Z', $seconds);
    }
}
