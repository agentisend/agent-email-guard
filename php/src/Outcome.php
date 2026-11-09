<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/** The three outcomes a decision can have (SPEC §2.3). */
final class Outcome
{
    public const ALLOW = 'allow';
    public const HOLD_FOR_APPROVAL = 'hold_for_approval';
    public const REFUSE = 'refuse';

    public const ALL = [self::ALLOW, self::HOLD_FOR_APPROVAL, self::REFUSE];

    private function __construct()
    {
    }
}
