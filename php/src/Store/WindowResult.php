<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Store;

final class WindowResult
{
    public function __construct(
        public readonly bool $ok,
        /** Members inside the window after the call (including the new one when ok). */
        public readonly int $count,
        /** Time of the oldest member still inside the window, or null when empty. */
        public readonly ?int $oldestAt,
    ) {
    }
}
