<?php

/**
 * agent-email-guard in front of the AgentiSend PHP SDK (agentisend/agentisend-php),
 * plus the hosted adapter that enforces the same limits at the API.
 *
 *   composer require agentisend/agent-email-guard agentisend/agentisend-php
 *   AGENTISEND_API_KEY=as_... php examples/agentisend-sdk.php you@yourdomain.com
 */

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Examples;

use AgentiSend\Client;
use AgentiSend\AgentEmailGuard\Guard;

/**
 * @param array{from: string, to: string|list<string>, subject: string, text?: string, html?: string} $email
 * @return array<array-key, mixed>
 */
function sendWithAgentiSend(Guard $guard, Client $client, array $email): array
{
    // The guard checks in this process; AgentiSend checks the key's own limits again at the API.
    $send = $guard->wrap(static fn (array $email): array => $client->postEmails($email));
    $result = $send($email);
    return is_array($result) ? $result : [];
}

if (is_string($_SERVER['SCRIPT_FILENAME'] ?? null) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    require __DIR__ . '/../vendor/autoload.php';
    $guard = Guard::create(['key' => 'onboarding-agent', 'budgets' => ['perHour' => 20], 'rate' => ['perMinute' => 5]]);
    $result = sendWithAgentiSend($guard, new Client(), [
        'from' => 'Onboarding <onboarding@yourdomain.com>',
        'to' => $argv[1] ?? 'you@yourdomain.com',
        'subject' => 'Your workspace is ready',
        'text' => 'Sign in at https://app.yourdomain.com to finish setup.',
    ]);
    echo 'Sent: ', json_encode($result), PHP_EOL;
}
