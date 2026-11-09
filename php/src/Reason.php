<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/**
 * Reason tokens (SPEC §4.2). Machines switch on these; they are identical in
 * every language agent-email-guard ships in.
 */
final class Reason
{
    public const OK = 'ok';
    public const KILL_SWITCH_ACTIVE = 'kill_switch_active';
    public const RECIPIENT_SUPPRESSED = 'recipient_suppressed';
    public const LOOP_REPETITION_DETECTED = 'loop_repetition_detected';
    public const RECIPIENT_ENTROPY_COLLAPSE = 'recipient_entropy_collapse';
    public const RECIPIENT_REQUIRES_APPROVAL = 'recipient_requires_approval';
    public const RATE_CEILING_EXCEEDED = 'rate_ceiling_exceeded';
    public const AGENT_BUDGET_EXCEEDED = 'agent_budget_exceeded';

    /** In SPEC order. */
    public const TOKENS = [
        self::OK,
        self::KILL_SWITCH_ACTIVE,
        self::RECIPIENT_SUPPRESSED,
        self::LOOP_REPETITION_DETECTED,
        self::RECIPIENT_ENTROPY_COLLAPSE,
        self::RECIPIENT_REQUIRES_APPROVAL,
        self::RATE_CEILING_EXCEEDED,
        self::AGENT_BUDGET_EXCEEDED,
    ];

    private function __construct()
    {
    }
}
