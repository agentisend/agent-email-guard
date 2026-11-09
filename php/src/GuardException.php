<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/** Thrown by a wrapped send when the guard blocked it. Nothing was sent. */
abstract class GuardException extends \RuntimeException
{
    public readonly string $reason;

    public function __construct(public readonly Decision $decision)
    {
        parent::__construct($decision->message);
        $this->reason = $decision->reason;
    }
}
