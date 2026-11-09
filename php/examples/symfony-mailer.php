<?php

/**
 * agent-email-guard in front of Symfony Mailer: wrap the transport, keep the Mailer.
 * In a Symfony app, decorate the mailer.transports service the same way.
 *
 *   composer require agentisend/agent-email-guard symfony/mailer
 *   MAILER_DSN=smtp://user:pass@smtp.yourprovider.com:587 php examples/symfony-mailer.php you@yourdomain.com
 */

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Examples;

use AgentiSend\AgentEmailGuard\Guard;
use AgentiSend\AgentEmailGuard\Symfony\GuardedTransport;
use Symfony\Component\Mailer\Mailer;
use Symfony\Component\Mailer\Transport\TransportInterface;
use Symfony\Component\Mime\Email;

function guardedMailer(Guard $guard, TransportInterface $transport): Mailer
{
    return new Mailer(new GuardedTransport($guard, $transport));
}

if (is_string($_SERVER['SCRIPT_FILENAME'] ?? null) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    require __DIR__ . '/../vendor/autoload.php';
    $guard = Guard::create(['budgets' => ['perDay' => 500], 'approval' => ['recipients' => ['@bigcustomer.com']]]);
    $mailer = guardedMailer($guard, \Symfony\Component\Mailer\Transport::fromDsn((string) getenv('MAILER_DSN')));
    $mailer->send((new Email())
        ->from('agent@yourdomain.com')
        ->to($argv[1] ?? 'you@yourdomain.com')
        ->subject('Invoice 1042')
        ->text('Invoice 1042 is ready in your account.'));
    echo 'Sent', PHP_EOL;
}
