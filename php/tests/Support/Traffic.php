<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests\Support;

use AgentiSend\AgentEmailGuard\LoopConfig;
use AgentiSend\AgentEmailGuard\LoopDetector;
use AgentiSend\AgentEmailGuard\LoopResult;
use AgentiSend\AgentEmailGuard\SendRecord;

/** Helpers shared by the loop tests ported from packages/agent-guard/test. */
final class Traffic
{
    public const NOW = 1_800_000_000_000;

    /** @param array<string, mixed> $send */
    public static function record(array $send, int $at): SendRecord
    {
        return SendRecord::fromSend($send, $at);
    }

    /**
     * @param list<SendRecord> $window
     * @param array<string, mixed> $candidate
     * @param array<string, mixed> $loop
     */
    public static function detect(array $window, array $candidate, array $loop = []): LoopResult
    {
        return LoopDetector::detect($window, SendRecord::fromSend($candidate, self::NOW), self::NOW, LoopConfig::fromArray($loop));
    }

    /**
     * Deterministic LCG so the "legitimate traffic" is stable across runs and languages.
     *
     * @return \Closure(): float
     */
    public static function lcg(int $seed): \Closure
    {
        $state = $seed & 0xFFFFFFFF;
        return static function () use (&$state): float {
            $state = ($state * 1664525 + 1013904223) & 0xFFFFFFFF;
            return $state / 0xFFFFFFFF;
        };
    }

    /**
     * @param list<string> $list
     * @param \Closure(): float $rand
     */
    public static function pick(array $list, \Closure $rand): string
    {
        return $list[(int) floor($rand() * count($list))];
    }
}
