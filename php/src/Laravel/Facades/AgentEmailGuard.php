<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Laravel\Facades;

use AgentiSend\AgentEmailGuard\Guard;
use Illuminate\Support\Facades\Facade;

/**
 * @method static \AgentiSend\AgentEmailGuard\Decision check(array<string, mixed> $send, array{approved?: bool} $options = [])
 * @method static void record(array<string, mixed> $send)
 * @method static void release(\AgentiSend\AgentEmailGuard\Decision $decision)
 * @method static \Closure wrap(callable $send, ?callable $toGuardSend = null)
 * @method static \AgentiSend\AgentEmailGuard\KillSwitch killSwitch()
 *
 * @see Guard
 */
final class AgentEmailGuard extends Facade
{
    protected static function getFacadeAccessor(): string
    {
        return Guard::class;
    }
}
