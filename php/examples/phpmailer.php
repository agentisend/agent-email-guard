<?php

/**
 * agent-email-guard in front of PHPMailer over any SMTP server.
 *
 *   composer require agentisend/agent-email-guard phpmailer/phpmailer
 *   SMTP_HOST=smtp.yourprovider.com SMTP_USER=... SMTP_PASS=... php examples/phpmailer.php you@yourdomain.com
 */

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Examples;

use AgentiSend\AgentEmailGuard\Guard;
use PHPMailer\PHPMailer\PHPMailer;

function sendWithPhpMailer(Guard $guard, PHPMailer $mail, string $to, string $subject, string $text): void
{
    $send = $guard->wrap(
        static function (string $to, string $subject, string $text) use ($mail): bool {
            $mail->clearAllRecipients();
            $mail->addAddress($to);
            $mail->Subject = $subject;
            $mail->Body = $text;
            return $mail->send(); // throws on failure: the guard gives the budget back
        },
        // The provider call does not take a send array, so say how to read one from its arguments.
        static fn (string $to, string $subject, string $text): array => ['to' => $to, 'subject' => $subject, 'text' => $text],
    );
    $send($to, $subject, $text);
}

if (is_string($_SERVER['SCRIPT_FILENAME'] ?? null) && realpath($_SERVER['SCRIPT_FILENAME']) === __FILE__) {
    require __DIR__ . '/../vendor/autoload.php';
    $mail = new PHPMailer(true);
    $mail->isSMTP();
    $mail->Host = (string) getenv('SMTP_HOST');
    $mail->SMTPAuth = true;
    $mail->Username = (string) getenv('SMTP_USER');
    $mail->Password = (string) getenv('SMTP_PASS');
    $mail->Port = 587;
    $mail->setFrom('agent@yourdomain.com', 'Agent');
    $guard = Guard::create(['budgets' => ['perHour' => 30], 'rate' => ['perMinute' => 5]]);
    sendWithPhpMailer($guard, $mail, $argv[1] ?? 'you@yourdomain.com', 'Report ready', 'Your weekly report is ready in the app.');
    echo 'Sent', PHP_EOL;
}
