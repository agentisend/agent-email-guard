<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Hosted;

use AgentiSend\AgentEmailGuard\KillSwitchState;

/** The kill switch on the AgentiSend key itself: every process using the key stops at the API. */
final class HostedKillSwitch
{
    public function __construct(private readonly AgentiSendGuard $client)
    {
    }

    /** POST /limits/keys/{keyId}/kill. Takes effect on the key's next request, in every process. */
    public function pause(string $reason): KillSwitchState
    {
        $view = $this->client->request('POST', '/limits/keys/' . rawurlencode($this->client->keyId()) . '/kill', ['reason' => $reason]);
        return self::toState($view);
    }

    /** Not available to a key: a person resumes it in the console (POST /limits/keys/{id}/resume is human-only). */
    public function resume(string $by = ''): never
    {
        throw new HumanActionRequired('A killed key is resumed by a person signed in to the AgentiSend console; the key cannot resume itself.');
    }

    public function state(): KillSwitchState
    {
        return self::toState($this->client->limits());
    }

    /** @param array<string, mixed> $view */
    private static function toState(array $view): KillSwitchState
    {
        $paused = ($view['paused'] ?? false) === true;
        $at = is_string($view['paused_at'] ?? null) ? strtotime($view['paused_at']) : false;
        return new KillSwitchState(
            $paused,
            $paused && $at !== false ? $at * 1000 : null,
            null,
            $paused && is_string($view['paused_reason'] ?? null) ? $view['paused_reason'] : null,
        );
    }
}
