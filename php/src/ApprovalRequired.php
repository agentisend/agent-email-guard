<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/**
 * A person has to approve this send first. Nothing was sent. Keep it in your
 * own queue; when a person approves, call approve() to run every other check
 * again and send.
 */
final class ApprovalRequired extends GuardException
{
    /** @param \Closure(): mixed $approve */
    public function __construct(Decision $decision, private readonly \Closure $approve)
    {
        parent::__construct($decision);
    }

    /**
     * A person approved: re-check without the approval rules, then send.
     * Returns the provider's result, or throws GuardRefused when something
     * else now blocks it.
     */
    public function approve(): mixed
    {
        return ($this->approve)();
    }
}
