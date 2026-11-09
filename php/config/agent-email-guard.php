<?php

declare(strict_types=1);

/*
 * agent-email-guard for Laravel. Publish with:
 *   php artisan vendor:publish --tag=agent-email-guard-config
 *
 * Then put it in front of any mailer in config/mail.php:
 *   'mailers' => [
 *       'guarded' => ['transport' => 'agent-email-guard', 'mailer' => 'resend', 'key' => 'support-agent'],
 *   ],
 * and set MAIL_MAILER=guarded (or Mail::mailer('guarded') where the agent sends).
 */

return [
    // The key a send counts against when it names none. One key per agent.
    'key' => env('AGENT_EMAIL_GUARD_KEY', 'default'),

    // Emails per key per UTC hour, day and month. null = no budget.
    'budgets' => [
        'per_hour' => env('AGENT_EMAIL_GUARD_PER_HOUR'),
        'per_day' => env('AGENT_EMAIL_GUARD_PER_DAY'),
        'per_month' => env('AGENT_EMAIL_GUARD_PER_MONTH'),
    ],

    // Emails per key per sliding minute. null = no ceiling.
    'rate' => [
        'per_minute' => env('AGENT_EMAIL_GUARD_PER_MINUTE'),
    ],

    // full | repetition_only | off. Thresholds default to LoopConfig::DEFAULTS.
    'loop' => [
        'mode' => env('AGENT_EMAIL_GUARD_LOOP_MODE', 'full'),
    ],

    'approval' => [
        // Addresses or whole domains ('@bigco.com') that always wait for a person.
        'recipients' => [],
        // Hold a send to anyone this key has never emailed.
        'new_recipients' => false,
        // An invokable class name: fn (array $send): bool|string|null. A string becomes evidence.detail.
        'require_for' => null,
    ],

    // Addresses or whole domains this guard never sends to.
    'suppress' => [],

    // memory: one PHP process only (each web request starts at zero).
    // redis: a connection from config/database.php. database: a connection, tables from the published migration.
    'store' => [
        'driver' => env('AGENT_EMAIL_GUARD_STORE', 'memory'),
        'connection' => env('AGENT_EMAIL_GUARD_STORE_CONNECTION'),
        'table_prefix' => 'agent_email_guard',
    ],

    'namespace' => 'agent-email-guard',
];
