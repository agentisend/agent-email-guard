# Publishing agentisend/agent-email-guard to Packagist

Written for launch day. Nothing here has been run. Packagist has no upload step: it reads `composer.json` and the git tags of a public repository. The name `agentisend/agent-email-guard` was free on Packagist on 2026-11-09 (`https://repo.packagist.org/p2/agentisend/agent-email-guard.json` answered 404). The project was renamed from agent-guard to agent-email-guard on 2026-11-09; the monorepo directory is still `oss/agent-guard/php/`; the PHP namespace is `AgentiSend\AgentEmailGuard` (SPEC §2.0).

## The one structural fact

Packagist only reads a `composer.json` at the **root** of the repository. The public repo `github.com/agentisend/agent-email-guard` holds every language (`spec/`, `node/`, `python/`, `php/`, `go/`), so the PHP package needs a root `composer.json` whose paths point into `php/`. `php/bin/root-composer.php` generates it from `php/composer.json`, so the two cannot drift.

The alternative, a read-only split repo (`agentisend/agent-email-guard-php` updated by `git subtree split` on every tag), adds a second repository and a CI job to keep it in sync. The root manifest needs neither.

## Before the first tag

Run from a clone of `github.com/agentisend/agent-email-guard`, after the monorepo's `oss/agent-guard/` has been mirrored into it.

1. Generate the root manifest and commit it:

   ```bash
   php php/bin/root-composer.php > composer.json
   composer validate --strict composer.json
   ```

2. Add a root `.gitattributes` so the package Composer downloads holds only the PHP library (Composer builds its zip with `git archive`, which honours `export-ignore`):

   ```gitattributes
   /node export-ignore
   /python export-ignore
   /go export-ignore
   /spec export-ignore
   /.github export-ignore
   /php/tests export-ignore
   /php/bin export-ignore
   /php/phpunit.xml.dist export-ignore
   /php/phpstan.neon.dist export-ignore
   /php/PUBLISH.md export-ignore
   ```

   Check it: `git archive HEAD | tar -t | grep -v '^php/'` should print only `composer.json`, `.gitattributes`, `LICENSE` and the root `README.md`.

3. Check the install from the repo itself before Packagist knows about it, in an empty directory:

   ```bash
   composer init -n --name=tmp/check
   composer config repositories.guard vcs https://github.com/agentisend/agent-email-guard
   composer require agentisend/agent-email-guard:dev-main
   php -r 'require "vendor/autoload.php"; var_dump(AgentiSend\AgentEmailGuard\Guard::create()->check(["to" => "a@example.com"])->reason);'
   ```

   Expected output: `string(2) "ok"`.

4. CI for the public repo, `.github/workflows/php.yml`:

   ```yaml
   name: php
   on: [push, pull_request]
   jobs:
     test:
       runs-on: ubuntu-latest
       strategy:
         matrix:
           php: ['8.1', '8.2', '8.3', '8.4']
       services:
         redis:
           image: redis:7
           ports: ['6379:6379']
         postgres:
           image: postgres:16
           env: { POSTGRES_PASSWORD: postgres }
           ports: ['5432:5432']
           options: --health-cmd pg_isready --health-interval 5s --health-retries 10
       steps:
         - uses: actions/checkout@v4
         - uses: shivammathur/setup-php@v2
           with: { php-version: '${{ matrix.php }}', extensions: 'redis, pdo_pgsql, pdo_sqlite, pcntl' }
         - name: Core tests on every version
           working-directory: php
           run: |
             composer remove --dev --no-update orchestra/testbench symfony/mailer phpmailer/phpmailer resend/resend-php agentisend/agentisend-php phpstan/phpstan
             composer require --dev --no-update phpunit/phpunit:^10.5
             composer update --no-interaction --prefer-dist
             vendor/bin/phpunit --testsuite core
           env:
             AGENT_GUARD_REDIS: 127.0.0.1:6379
             AGENT_GUARD_PG_DSN: pgsql:host=127.0.0.1;port=5432;dbname=postgres
             AGENT_GUARD_PG_USER: postgres
             AGENT_GUARD_PG_PASSWORD: postgres
         - name: Framework glue, examples and PHPStan
           if: matrix.php == '8.4'
           working-directory: php
           run: |
             git checkout composer.json
             composer update --no-interaction --prefer-dist
             vendor/bin/phpunit
             vendor/bin/phpstan analyse --memory-limit=1G
   ```

   Why two steps: the Laravel and Symfony test dependencies (Laravel 13, PHPUnit 12) need PHP 8.3+. On 8.1 and 8.2 the `core` test suite runs with PHPUnit 10; the `framework` suite needs 8.3+. That is how it was verified locally (below).

## Tag and register

5. Tag the release. The spec says every port moves together on minor versions, so one tag serves Packagist, npm and PyPI. Go modules in `go/` need their own prefixed tag on the same commit:

   ```bash
   git tag -a v0.1.0 -m "agent-email-guard 0.1.0"
   git tag -a go/v0.1.0 -m "agent-email-guard Go 0.1.0"
   git push origin v0.1.0 go/v0.1.0
   ```

   Packagist reads `v0.1.0` and ignores `go/v0.1.0`, which is not a valid Composer version.

6. Sign in to `https://packagist.org` with the AgentiSend GitHub account that owns `github.com/agentisend` (owner step: password sign-in). Submit `https://github.com/agentisend/agent-email-guard` at `https://packagist.org/packages/submit`. Packagist reads the root `composer.json` and lists `agentisend/agent-email-guard` with version `0.1.0`. The `agentisend` vendor name is already registered on Packagist for `agentisend/agentisend-php`, so submit from the account that owns that vendor, or the name is refused.

7. Turn on auto-updates: on the package page Packagist shows whether the GitHub hook is active. With the Packagist GitHub app installed on the `agentisend` org, new tags appear within a minute. Without it, add a webhook in the repo settings: payload URL `https://packagist.org/api/github?username=<packagist-user>`, content type `application/json`, secret = that user's Packagist API token.

8. Check from a clean directory:

   ```bash
   composer require agentisend/agent-email-guard:^0.1
   ```

## What was verified before this was written

On 2026-11-09, on macOS arm64 (static PHP builds from static-php-cli, since Homebrew was not installed and Docker Desktop would not start):

- PHP 8.3.32: 136 tests, every spec vector, Laravel 13 via Orchestra Testbench 11, Symfony Mailer 7.4, all five examples; with Redis 7.4.12 (built from the redis.io source tarball) and the local Postgres.
- PHP 8.1.34: the `core` test suite with PHPUnit 10.5, Redis and Postgres included.
- PHPStan 2.3 at level max, `phpVersion: 80100`, over `src`, `tests`, `examples`, `config` and `database`: no errors.
- Not run against MySQL or MariaDB: PdoStore's MySQL path (`LAST_INSERT_ID` conditional update, `GET_LOCK` around the rate window) has no test run behind it yet. The CI matrix above does not include MySQL either; add a `mysql:8` service and an `AGENT_GUARD_MYSQL_DSN` case before claiming MySQL support in the README.
