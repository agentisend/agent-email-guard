<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Store;

final class CounterResult
{
    public function __construct(
        /** True when the increment was applied. */
        public readonly bool $ok,
        /** The counter after the increment when ok, otherwise its unchanged value. */
        public readonly int $value,
    ) {
    }
}
