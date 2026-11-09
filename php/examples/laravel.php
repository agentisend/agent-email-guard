<?php

/**
 * agent-email-guard in a Laravel app.
 *
 *   composer require agentisend/agent-email-guard
 *   php artisan vendor:publish --tag=agent-email-guard-config
 *
 * config/mail.php, next to the mailer you already use (resend, ses, smtp, postmark):
 *
 *   'guarded' => ['transport' => 'agent-email-guard', 'mailer' => 'resend', 'key' => 'support-agent'],
 *
 * .env:
 *
 *   AGENT_EMAIL_GUARD_PER_HOUR=50
 *   AGENT_EMAIL_GUARD_PER_MINUTE=10
 *   AGENT_EMAIL_GUARD_STORE=redis
 *
 * Then send from the agent's code through that mailer:
 */

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Examples;

use AgentiSend\AgentEmailGuard\ApprovalRequired;
use AgentiSend\AgentEmailGuard\GuardRefused;
use Illuminate\Mail\Message;
use Illuminate\Support\Facades\Mail;

/** Returns what happened, in words the agent can act on. */
function agentSendsOrderUpdate(string $to, string $orderId): string
{
    try {
        Mail::mailer('guarded')->raw("Order {$orderId} has shipped.", static function (Message $message) use ($to, $orderId): void {
            $message->to($to)->subject("Order {$orderId} shipped");
        });
        return 'sent';
    } catch (GuardRefused $e) {
        return "refused ({$e->reason}): {$e->getMessage()}";
    } catch (ApprovalRequired $e) {
        // Keep $e somewhere a person can see it; $e->approve() sends it.
        return "held: {$e->getMessage()}";
    }
}
