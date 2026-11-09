# agent-email-guard for PHP

Blast-radius control for agents that send email: budgets, a rate ceiling, loop detection, a kill switch and approval holds. It runs in front of any provider: Symfony Mailer, Laravel Mail, PHPMailer, Resend, Postmark, SES, SMTP, or AgentiSend.

```bash
composer require agentisend/agent-email-guard
```

PHP 8.1 or later. No runtime dependencies. MIT.

## Twelve lines

```php
use AgentiSend\AgentEmailGuard\Guard;
use AgentiSend\AgentEmailGuard\GuardRefused;

$resend = Resend::client(getenv('RESEND_API_KEY'));   // or any other provider
$guard = Guard::create(['budgets' => ['perHour' => 50, 'perDay' => 500], 'rate' => ['perMinute' => 10]]);
$send = $guard->wrap(fn (array $email) => $resend->emails->send($email));

try {
    $send(['from' => 'agent@yourdomain.com', 'to' => $to, 'subject' => $subject, 'html' => $html]);
} catch (GuardRefused $e) {
    echo $e->getMessage();   // Key "default" has used its hourly budget of 50 emails; it resets at 2027-01-15T10:00:00Z.
}
```

`wrap()` checks the send, calls your function, and records the send once the provider accepts it. If the provider throws, the budget and rate slot are given back.

## What it decides

Every check returns a `Decision`: `allow`, `hold_for_approval` or `refuse`, a reason token, one sentence ending in a period, and the numbers behind it.

```php
$decision = $guard->check(['key' => 'support-agent', 'to' => 'ana@acme.com', 'subject' => 'Re: ticket 4411', 'text' => '...']);
$decision->outcome;   // 'refuse'
$decision->reason;    // 'rate_ceiling_exceeded'
$decision->message;   // 'Key "support-agent" reached its ceiling of 10 sends per minute; wait 42 seconds and try again.'
$decision->evidence;  // ['key' => 'support-agent', 'sends_in_window' => 10, 'ceiling_per_minute' => 10, 'retry_after_seconds' => 42]
```

Checks run in this order and stop at the first block:

| # | Check | Outcome | Reason token |
|---|---|---|---|
| 1 | Kill switch is paused | refuse | `kill_switch_active` |
| 2 | A recipient is on the suppression list | refuse | `recipient_suppressed` |
| 3 | 3 near-identical sends to the same To line already went out in 60 minutes | refuse | `loop_repetition_detected` |
| 3 | The last 20+ sends collapsed onto fewer than 3 effective recipients, and this one goes to one of them | refuse | `recipient_entropy_collapse` |
| 4 | An approval rule matches (listed recipient, a recipient this key never emailed, or your callback) | hold_for_approval | `recipient_requires_approval` |
| 5 | The per-minute ceiling is reached | refuse | `rate_ceiling_exceeded` |
| 6 | The hourly, daily or monthly budget is used up | refuse | `agent_budget_exceeded` |

Budgets count per key per UTC calendar hour, day and month. The rate ceiling is a sliding 60-second window. "Near-identical" means subject and body each score 0.85 or more on character-trigram similarity, so "your Q3 roadmap" and "my Q3 roadmap" still match. Entropy collapse holds only mail to the inboxes the loop keeps hitting: a key that pages its owner 30 times an hour still sends a sign-in code to a new user.

The thresholds are in `LoopConfig::DEFAULTS` and every one is configurable:

```php
Guard::create([
    'key'      => 'support-agent',                 // the key a send counts against when it names none
    'budgets'  => ['perHour' => 50, 'perDay' => 500, 'perMonth' => 10_000],
    'rate'     => ['perMinute' => 10],
    'loop'     => ['mode' => 'full', 'windowMs' => 3_600_000, 'maxIdenticalSends' => 3],  // full | repetition_only | off
    'approval' => [
        'recipients'    => ['@bigcustomer.com', 'cfo@yourdomain.com'],
        'newRecipients' => true,
        'requireFor'    => fn (array $send) => str_contains($send['subject'] ?? '', 'refund') ? 'Refunds need a person.' : false,
    ],
    'suppress' => ['regulator@gov.example'],
    'store'    => new RedisStore($redis),
]);
```

Keys may also be written in snake_case (`per_hour`, `new_recipients`), which is what the Laravel config file uses.

The declarative part can live in `agent-email-guard.json`, the same file the Node, Python and Go packages read:

```json
{ "key": "support-agent", "budgets": { "per_hour": 50 }, "rate": { "per_minute": 10 }, "approval": { "new_recipients": true } }
```

```php
$guard = Guard::fromPolicy();   // ./agent-email-guard.json; pass a path, plus overrides for the store or a requireFor callback
```

## Holds and the kill switch

A held send throws `ApprovalRequired`. Keep it where a person will see it; `approve()` runs every other check again and sends.

```php
try {
    $send($email);
} catch (ApprovalRequired $held) {
    $queue->park($held);      // your queue
}
// later, once a person said yes:
$held->approve();
```

The kill switch stops every send through the guard, on every key that shares the store:

```php
$guard->killSwitch()->pause('Agent looped on one customer.', 'ops@yourdomain.com');
$guard->killSwitch()->resume('ops@yourdomain.com');   // the only way back
```

There is no timer and no expiry. A paused guard is still paused a year later.

## Stores

The default `MemoryStore` lives for one PHP process. Under PHP-FPM that is one request, so budgets start at zero on every request. For anything that serves more than one request, share a store:

```php
use AgentiSend\AgentEmailGuard\Store\RedisStore;
use AgentiSend\AgentEmailGuard\Store\PdoStore;

new RedisStore($redis);          // \Redis (phpredis), \RedisCluster or Predis\Client
$store = new PdoStore($pdo);     // Postgres or SQLite (MySQL/MariaDB: written, not yet in the test run)
$store->createSchema();          // once; or run schemaSql() from your migrations
```

The budget step is one conditional upsert (Postgres, SQLite) or one Lua script (Redis); the rate window runs under a lock on its name. The test suite forks 20 processes that make 200 checks against a budget of 50, and exactly 50 are allowed, on SQLite, Postgres and Redis. Store names follow the shared spec, so guards in Node, Python, PHP and Go on one Redis or Postgres share one budget.

## Laravel

The service provider is auto-discovered. Publish the config, then put a guarded mailer in front of the mailer you already use:

```bash
php artisan vendor:publish --tag=agent-email-guard-config
php artisan vendor:publish --tag=agent-email-guard-migrations   # for the database store
```

```php
// config/mail.php
'mailers' => [
    'resend'  => ['transport' => 'resend'],
    'guarded' => ['transport' => 'agent-email-guard', 'mailer' => 'resend', 'key' => 'support-agent'],
],
```

```bash
MAIL_MAILER=guarded
AGENT_EMAIL_GUARD_PER_HOUR=50
AGENT_EMAIL_GUARD_PER_MINUTE=10
AGENT_EMAIL_GUARD_STORE=redis
```

`mailer` can name any configured mailer: `smtp`, `ses`, `postmark`, `resend` (Resend's Laravel driver), `log`, or your own. Mailables, notifications and `Mail::raw()` all pass through the guard; a refusal throws `GuardRefused` from `Mail::send()`. Use `Mail::mailer('guarded')` to guard only the agent's mail and leave the rest of the app alone. The `AgentEmailGuard` facade and `app(Guard::class)` give you `check()`, `killSwitch()` and the rest.

## Symfony

Wrap the transport, keep the Mailer:

```php
use AgentiSend\AgentEmailGuard\Symfony\GuardedTransport;
use Symfony\Component\Mailer\{Mailer, Transport};

$mailer = new Mailer(new GuardedTransport($guard, Transport::fromDsn($_ENV['MAILER_DSN'])));
```

In a Symfony app, decorate the transport service:

```yaml
# config/services.yaml
services:
    AgentiSend\AgentEmailGuard\Guard:
        factory: ['AgentiSend\AgentEmailGuard\Guard', 'create']
        arguments: [{ budgets: { perHour: 50 }, rate: { perMinute: 10 }, store: '@AgentiSend\AgentEmailGuard\Store\RedisStore' }]
    AgentiSend\AgentEmailGuard\Store\RedisStore:
        arguments: ['@Redis']
    AgentiSend\AgentEmailGuard\Symfony\GuardedTransport:
        decorates: mailer.transports
        arguments: ['@AgentiSend\AgentEmailGuard\Guard', '@.inner']
```

Set the `X-Agent-Email-Guard-Key` header on a message to count it against a specific agent's key; the header is removed before the message is sent.

## Advisory here, enforced at AgentiSend

agent-email-guard runs inside the agent's process. That makes it fast and provider-neutral, and it also means code the agent controls can remove it, or a second process can keep its own count. It is a seatbelt, not a lock.

AgentiSend runs the same rules at its API, on the API key itself: one budget and rate ceiling per key across every process, the loop guard, a kill switch only a person can undo, and an approval queue in the console. The agent cannot raise its own limits or resume itself. The hosted adapter talks to it:

```php
use AgentiSend\AgentEmailGuard\Hosted\AgentiSendGuard;

$hosted = new AgentiSendGuard(getenv('AGENTISEND_API_KEY'), keyId: getenv('AGENTISEND_KEY_ID'));
$hosted->check($email);                    // POST /emails/preflight: every send gate, nothing sent
$hosted->send($email);                     // POST /emails; throws GuardRefused / ApprovalRequired
$hosted->setLimits(['budget' => 200, 'period' => 'day', 'perMinute' => 10]);  // a key may only lower its own
$hosted->killSwitch()->pause('Looping.');  // resuming is a person's action in the console
$hosted->pendingApprovals();               // held sends waiting for a person
```

Use both: the library refuses early and cheaply in the agent's process, and the API holds the line if the library is removed.

## Integrations

Runnable examples, each tested against a stub of its provider:

| Provider | Example |
|---|---|
| AgentiSend PHP SDK (`agentisend/agentisend-php`) | [examples/agentisend-sdk.php](examples/agentisend-sdk.php) |
| Laravel Mail (any mailer, Resend's driver included) | [examples/laravel.php](examples/laravel.php) |
| Symfony Mailer (any transport) | [examples/symfony-mailer.php](examples/symfony-mailer.php) |
| Resend PHP SDK (`resend/resend-php`) | [examples/resend-php.php](examples/resend-php.php) |
| PHPMailer over SMTP | [examples/phpmailer.php](examples/phpmailer.php) |

A provider call that does not take a send array needs a mapper: `$guard->wrap($send, fn ($to, $subject, $text) => ['to' => $to, 'subject' => $subject, 'text' => $text])`.

## Same behaviour in every language

agent-email-guard ships for Node, Python, PHP and Go from one specification ([../spec/SPEC.md](../spec/SPEC.md)). Every port runs the same conformance vectors, so reason tokens and messages are byte-identical across languages.

## Development

```bash
composer install
vendor/bin/phpunit
vendor/bin/phpstan analyse
```

Redis and Postgres tests run when `AGENT_GUARD_REDIS=host:port` and `AGENT_GUARD_PG_DSN` (plus `AGENT_GUARD_PG_USER`, `AGENT_GUARD_PG_PASSWORD`) are set; the Postgres tests create a schema of their own and drop it afterwards.

## License

MIT, copyright AgentiSend. See [LICENSE](LICENSE).
