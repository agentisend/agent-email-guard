<?php

/**
 * agent-email-guard in front of Resend's PHP SDK. The send array Resend takes is
 * the send array the guard reads, so wrap() needs no mapper.
 *
 *   composer require agentisend/agent-email-guard resend/resend-php
 *   RESEND_API_KEY=re_... php examples/resend-php.php you@yourdomain.com
 */

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Examples;

use AgentiSend\AgentEmailGuard\Guard;
use Resend\Client;
use Resend\Email;

/** @param array{from: string, to: string|list<string>, subject: string, text?: string, html?: string} $email */
function sendWithResend(Guard $guard, Client $resend, array $email): string
{
    $send = $guard->wrap(static fn (array $email): Email => $resend->emails->send($email));
    $sent = $send($email);
    return $sent instanceof Email ? $sent->id : '';
}

if (is_string($_SERVER['SCRIPT_FILENAME'] ?? null) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    require __DIR__ . '/../vendor/autoload.php';
    $guard = Guard::create(['key' => 'support-agent', 'budgets' => ['perDay' => 200], 'loop' => ['mode' => 'full']]);
    $id = sendWithResend($guard, \Resend::client((string) getenv('RESEND_API_KEY')), [
        'from' => 'Support <support@yourdomain.com>',
        'to' => $argv[1] ?? 'you@yourdomain.com',
        'subject' => 'We fixed the export bug',
        'html' => '<p>The CSV export works again. Thanks for reporting it.</p>',
    ]);
    echo "Sent {$id}", PHP_EOL;
}
