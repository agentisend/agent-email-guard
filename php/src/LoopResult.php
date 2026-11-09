<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/** What loop detection saw: a verdict, a refusal when it found a loop, and the window numbers. */
final class LoopResult
{
    public const CLEAN = 'clean';
    public const REPETITION_LOOP = 'repetition_loop';
    public const ENTROPY_COLLAPSE = 'entropy_collapse';
    public const BOTH_SIGNALS = 'both_signals';

    /**
     * @param array{window_size: int, distinct_recipients: int, entropy_bits: float, effective_recipients: float} $stats
     */
    public function __construct(
        public readonly string $verdict,
        public readonly ?Decision $decision,
        public readonly array $stats,
        public readonly int $matches,
        public readonly bool $windowCollapsed,
        public readonly float $candidateShare,
        public readonly float $effectiveRecipients,
        public readonly bool $trustedSample,
    ) {
    }
}
