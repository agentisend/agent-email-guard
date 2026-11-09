<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/**
 * Every sentence the guard can say (SPEC §4.2), byte for byte the same as the
 * Node, Python and Go packages. Change one here and the vectors break.
 */
final class Messages
{
    public const PERIOD_ADJECTIVE = ['hour' => 'hourly', 'day' => 'daily', 'month' => 'monthly'];

    private function __construct()
    {
    }

    public static function ok(): string
    {
        return 'No limit, loop or approval rule blocks this send.';
    }

    public static function killSwitchActive(): string
    {
        return 'Sending is paused by the kill switch, so nothing sends until a person resumes it.';
    }

    public static function recipientSuppressed(string $recipient, string $rule): string
    {
        return "{$recipient} is on the suppression list (rule: {$rule}), so this guard never sends to it.";
    }

    public static function loopRepetition(int $matches, string $toLine, int $minutes): string
    {
        return 'Blocked: ' . Format::plural($matches, 'near-identical email') . " already went to {$toLine} within "
            . Format::plural($minutes, 'minute') . ', which matches a retry or script loop; review the agent before sending more.';
    }

    public static function loopBothSignals(int $matches, string $toLine, float $effective): string
    {
        return 'Blocked: this key shows both a repetition loop (' . Format::plural($matches, 'near-identical email')
            . " to {$toLine}) and collapsed recipient diversity (about " . Format::plural($effective, 'effective recipient')
            . '); review the agent before sending more.';
    }

    public static function entropyCollapse(int $windowSize, float $effective): string
    {
        return 'Blocked: the last ' . Format::plural($windowSize, 'email') . ' went to about '
            . Format::plural($effective, 'effective recipient')
            . ', and this one goes to the same inbox again, which looks like a loop; mail to other recipients still sends.';
    }

    public static function approvalRecipientRule(string $recipient, string $rule): string
    {
        return "{$recipient} matches the approval rule {$rule}, so this email waits for a person to approve it.";
    }

    public static function approvalCustom(): string
    {
        return 'Your approval rule matched this email, so it waits for a person to approve it.';
    }

    public static function approvalNewRecipient(string $recipient, string $key): string
    {
        return "{$recipient} has not received email from key \"{$key}\" before, so this email waits for a person to approve it.";
    }

    public static function rateCeilingExceeded(string $key, int $ceiling, int $retryAfterSeconds): string
    {
        return "Key \"{$key}\" reached its ceiling of " . Format::plural($ceiling, 'send') . ' per minute; wait '
            . Format::plural($retryAfterSeconds, 'second') . ' and try again.';
    }

    /** @param 'hour'|'day'|'month' $period */
    public static function budgetExceeded(string $key, string $period, int $budget, int $resetsAt): string
    {
        return "Key \"{$key}\" has used its " . self::PERIOD_ADJECTIVE[$period] . ' budget of '
            . Format::plural($budget, 'email') . '; it resets at ' . Format::instant($resetsAt) . '.';
    }
}
