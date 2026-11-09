<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

final class KillSwitchState
{
    public function __construct(
        public readonly bool $paused,
        /** Epoch ms. */
        public readonly ?int $pausedAt = null,
        public readonly ?string $pausedBy = null,
        public readonly ?string $reason = null,
    ) {
    }
}
