<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Laravel;

use AgentiSend\AgentEmailGuard\Guard;
use AgentiSend\AgentEmailGuard\Store\MemoryStore;
use AgentiSend\AgentEmailGuard\Store\PdoStore;
use AgentiSend\AgentEmailGuard\Store\RedisStore;
use AgentiSend\AgentEmailGuard\Store\Store;
use AgentiSend\AgentEmailGuard\Symfony\GuardedTransport;
use Illuminate\Contracts\Config\Repository;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Database\DatabaseManager;
use Illuminate\Mail\Mailer;
use Illuminate\Redis\RedisManager;
use Illuminate\Mail\MailManager;
use Illuminate\Support\ServiceProvider;

/**
 * Registers Guard as a singleton built from config/agent-email-guard.php and adds
 * the `agent-email-guard` mail transport, which wraps any other configured mailer
 * (smtp, ses, postmark, resend, log, ...).
 */
final class AgentEmailGuardServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->mergeConfigFrom(dirname(__DIR__, 2) . '/config/agent-email-guard.php', 'agent-email-guard');

        $this->app->singleton(Store::class, static function (Application $app): Store {
            return self::makeStore($app, self::config($app));
        });

        $this->app->singleton(Guard::class, static function (Application $app): Guard {
            $config = self::config($app);
            $approval = is_array($config['approval'] ?? null) ? $config['approval'] : [];
            $requireFor = $approval['require_for'] ?? null;
            if (is_string($requireFor) && $requireFor !== '') {
                $approval['require_for'] = $app->make($requireFor);
            }
            $config['approval'] = $approval;
            $config['store'] = $app->make(Store::class);
            return Guard::create($config);
        });
        $this->app->alias(Guard::class, 'agent-email-guard');
    }

    public function boot(): void
    {
        $this->publishes([dirname(__DIR__, 2) . '/config/agent-email-guard.php' => $this->app->configPath('agent-email-guard.php')], 'agent-email-guard-config');
        $this->publishes([
            dirname(__DIR__, 2) . '/database/migrations/create_agent_email_guard_tables.php' => $this->app->databasePath('migrations/' . date('Y_m_d_His') . '_create_agent_email_guard_tables.php'),
        ], 'agent-email-guard-migrations');

        $this->callAfterResolving('mail.manager', static function (MailManager $manager, Application $app): void {
            $manager->extend('agent-email-guard', static function (array $config) use ($manager, $app): GuardedTransport {
                $mailer = $config['mailer'] ?? null;
                if (!is_string($mailer) || $mailer === '' || $mailer === ($config['name'] ?? null)) {
                    throw new \InvalidArgumentException('The agent-email-guard mail transport needs a "mailer" option naming the mailer it wraps.');
                }
                $inner = $manager->mailer($mailer);
                if (!$inner instanceof Mailer) {
                    throw new \InvalidArgumentException("Mailer \"{$mailer}\" is not a Laravel mailer with a Symfony transport.");
                }
                $key = $config['key'] ?? null;
                return new GuardedTransport($app->make(Guard::class), $inner->getSymfonyTransport(), is_string($key) ? $key : null);
            });
        });
    }

    /** @return array<string, mixed> */
    private static function config(Application $app): array
    {
        $config = $app->make(Repository::class)->get('agent-email-guard', []);
        $out = [];
        foreach (is_array($config) ? $config : [] as $k => $v) {
            $out[(string) $k] = $v;
        }
        return $out;
    }

    /** @param array<string, mixed> $config */
    private static function makeStore(Application $app, array $config): Store
    {
        $store = is_array($config['store'] ?? null) ? $config['store'] : [];
        $driver = $store['driver'] ?? 'memory';
        $connection = is_string($store['connection'] ?? null) && $store['connection'] !== '' ? $store['connection'] : null;
        $prefix = is_string($store['table_prefix'] ?? null) ? $store['table_prefix'] : 'agent_email_guard';

        return match ($driver) {
            'memory' => new MemoryStore(),
            'redis' => new RedisStore(self::redisClient($app->make(RedisManager::class)->connection($connection)->client())),
            'database' => new PdoStore($app->make(DatabaseManager::class)->connection($connection)->getPdo(), $prefix),
            default => throw new \InvalidArgumentException('agent-email-guard.store.driver must be memory, redis or database.'),
        };
    }

    private static function redisClient(mixed $client): \Redis|\RedisCluster|\Predis\ClientInterface
    {
        if ($client instanceof \Redis || $client instanceof \RedisCluster || $client instanceof \Predis\ClientInterface) {
            return $client;
        }
        throw new \InvalidArgumentException('agent-email-guard needs a phpredis or Predis connection.');
    }
}
