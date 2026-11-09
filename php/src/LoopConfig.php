<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/** Loop detection settings (SPEC §2.1), defaults filled in. */
final class LoopConfig
{
    public const MODE_FULL = 'full';
    public const MODE_REPETITION_ONLY = 'repetition_only';
    public const MODE_OFF = 'off';

    /** The numbers the guard runs with when you pass none. */
    public const DEFAULTS = [
        'mode' => self::MODE_FULL,
        'windowMs' => 3_600_000,
        'similarityThreshold' => 0.85,
        'maxIdenticalSends' => 3,
        'minWindowForEntropy' => 20,
        'recipientPerplexityFloor' => 3,
    ];

    /** @param string $mode full, repetition_only or off */
    public function __construct(
        public readonly string $mode = self::MODE_FULL,
        public readonly int $windowMs = 3_600_000,
        public readonly float $similarityThreshold = 0.85,
        public readonly int $maxIdenticalSends = 3,
        public readonly int $minWindowForEntropy = 20,
        public readonly float $recipientPerplexityFloor = 3.0,
    ) {
        if (!in_array($mode, [self::MODE_FULL, self::MODE_REPETITION_ONLY, self::MODE_OFF], true)) {
            throw new \InvalidArgumentException("loop.mode must be full, repetition_only or off, not \"{$mode}\".");
        }
    }

    /**
     * Accepts camelCase or snake_case keys.
     *
     * @param array<string, mixed> $config
     */
    public static function fromArray(array $config): self
    {
        $get = static function (string $camel, string $snake) use ($config): mixed {
            return $config[$camel] ?? $config[$snake] ?? self::DEFAULTS[$camel];
        };
        $mode = $get('mode', 'mode');
        if ($mode === 'repetition-only') {
            $mode = self::MODE_REPETITION_ONLY;
        }
        if (!is_string($mode) || !in_array($mode, [self::MODE_FULL, self::MODE_REPETITION_ONLY, self::MODE_OFF], true)) {
            throw new \InvalidArgumentException('loop.mode must be full, repetition_only or off.');
        }
        return new self(
            $mode,
            Config::int($get('windowMs', 'window_ms'), 'loop.windowMs'),
            Config::float($get('similarityThreshold', 'similarity_threshold'), 'loop.similarityThreshold'),
            Config::int($get('maxIdenticalSends', 'max_identical_sends'), 'loop.maxIdenticalSends'),
            Config::int($get('minWindowForEntropy', 'min_window_for_entropy'), 'loop.minWindowForEntropy'),
            Config::float($get('recipientPerplexityFloor', 'recipient_perplexity_floor'), 'loop.recipientPerplexityFloor'),
        );
    }
}
