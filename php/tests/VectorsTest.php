<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests;

use AgentiSend\AgentEmailGuard\Decision;
use AgentiSend\AgentEmailGuard\Guard;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/**
 * The cross-language conformance vectors (SPEC §9): every step of every case
 * in ../spec/vectors/*.json, compared byte for byte.
 */
final class VectorsTest extends TestCase
{
    public static function vectorDir(): string
    {
        $env = getenv('AGENT_GUARD_VECTORS');
        return is_string($env) && $env !== '' ? $env : dirname(__DIR__, 2) . '/spec/vectors';
    }

    /** @return iterable<string, array{0: array<string, mixed>}> */
    public static function cases(): iterable
    {
        $files = glob(self::vectorDir() . '/*.json') ?: [];
        foreach ($files as $file) {
            if (str_ends_with($file, 'vector.schema.json')) {
                continue;
            }
            $data = json_decode((string) file_get_contents($file), true, 512, JSON_THROW_ON_ERROR);
            if (!is_array($data) || !is_array($data['cases'] ?? null)) {
                continue;
            }
            $vectorName = is_string($data['name'] ?? null) ? $data['name'] : basename($file, '.json');
            foreach ($data['cases'] as $case) {
                if (!is_array($case)) {
                    continue;
                }
                $caseName = is_string($case['name'] ?? null) ? $case['name'] : '?';
                yield "{$vectorName}: {$caseName}" => [self::map($case)];
            }
        }
    }

    public function testTheVectorsArePresent(): void
    {
        $count = 0;
        foreach (self::cases() as $_) {
            $count++;
        }
        self::assertGreaterThan(0, $count, 'No vectors found in ' . self::vectorDir() . '; merge origin/main or set AGENT_GUARD_VECTORS.');
    }

    /** @param array<string, mixed> $case */
    #[DataProvider('cases')]
    public function testVectorCase(array $case): void
    {
        $now = 0;
        $config = self::runnerConfig(self::map($case['config'] ?? null));
        $config['clock'] = static function () use (&$now): int {
            return $now;
        };
        $guard = Guard::create($config);

        /** @var array<int, Decision> $decisions */
        $decisions = [];
        $steps = is_array($case['steps'] ?? null) ? $case['steps'] : [];
        foreach ($steps as $index => $step) {
            self::assertIsArray($step);
            $now = self::int($step['at'] ?? 0);
            $send = self::map($step['send'] ?? null);
            $op = is_string($step['op'] ?? null) ? $step['op'] : '';
            $label = "step {$index} ({$op})";
            switch ($op) {
                case 'check':
                case 'send':
                    $decision = $guard->check($send, ['approved' => ($step['approved'] ?? false) === true]);
                    if ($op === 'send' && $decision->isAllowed()) {
                        $guard->record($send);
                    }
                    $decisions[(int) $index] = $decision;
                    self::assertDecision($step['expect'] ?? null, $decision, $label);
                    break;
                case 'record':
                    $repeat = self::int($step['repeat'] ?? 1);
                    $every = self::int($step['every_ms'] ?? 0);
                    for ($i = 0; $i < $repeat; $i++) {
                        $guard->record($send);
                        $now += $every;
                    }
                    break;
                case 'release':
                    $target = self::int($step['step'] ?? -1);
                    self::assertArrayHasKey($target, $decisions, "{$label}: no decision at step {$target}");
                    $guard->release($decisions[$target]);
                    break;
                case 'pause':
                    $reason = is_string($step['reason'] ?? null) ? $step['reason'] : '';
                    if (is_string($step['by'] ?? null)) {
                        $guard->killSwitch()->pause($reason, $step['by']);
                    } else {
                        $guard->killSwitch()->pause($reason);
                    }
                    break;
                case 'resume':
                    $by = is_string($step['by'] ?? null) ? $step['by'] : 'agent-email-guard';
                    $resumed = $guard->killSwitch()->resume($by);
                    $expect = is_array($step['expect'] ?? null) ? $step['expect'] : [];
                    self::assertSame($expect['resumed'] ?? null, $resumed, $label);
                    break;
                case 'read_state':
                    $name = is_string($step['name'] ?? null) ? $step['name'] : '';
                    $raw = $guard->store()->getState($name);
                    $expect = is_array($step['expect'] ?? null) ? $step['expect'] : [];
                    self::assertEquals($expect['state'] ?? null, $raw === null ? null : json_decode($raw, true, 64, JSON_THROW_ON_ERROR), $label);
                    break;
                default:
                    self::fail("{$label}: unknown op");
            }
        }
    }

    /**
     * Vector config keys are snake_case (Guard::create accepts those);
     * require_for becomes the runner callback of SPEC §9.
     *
     * @param array<string, mixed> $config
     * @return array<string, mixed>
     */
    private static function runnerConfig(array $config): array
    {
        $approval = is_array($config['approval'] ?? null) ? self::map($config['approval']) : null;
        if ($approval !== null && is_array($approval['require_for'] ?? null)) {
            $rule = $approval['require_for'];
            $needle = is_string($rule['subject_contains'] ?? null) ? $rule['subject_contains'] : '';
            $detail = is_string($rule['detail'] ?? null) ? $rule['detail'] : null;
            $approval['require_for'] = static function (array $send) use ($needle, $detail): string|bool {
                $subject = is_string($send['subject'] ?? null) ? $send['subject'] : '';
                if (!str_contains($subject, $needle)) {
                    return false;
                }
                return $detail ?? true;
            };
            $config['approval'] = $approval;
        }
        return $config;
    }

    private static function assertDecision(mixed $expect, Decision $actual, string $label): void
    {
        self::assertIsArray($expect, "{$label}: no expect");
        self::assertSame($expect['outcome'] ?? null, $actual->outcome, "{$label}: outcome");
        self::assertSame($expect['reason'] ?? null, $actual->reason, "{$label}: reason");
        self::assertSame($expect['message'] ?? null, $actual->message, "{$label}: message");
        $evidence = is_array($expect['evidence'] ?? null) ? $expect['evidence'] : [];
        $expectedKeys = array_keys($evidence);
        $actualKeys = array_keys($actual->evidence);
        sort($expectedKeys);
        sort($actualKeys);
        self::assertSame($expectedKeys, $actualKeys, "{$label}: evidence keys");
        foreach ($evidence as $k => $v) {
            $a = $actual->evidence[$k];
            if ((is_int($v) || is_float($v)) && (is_int($a) || is_float($a))) {
                self::assertEqualsWithDelta((float) $v, (float) $a, 0.0, "{$label}: evidence.{$k}");
            } else {
                self::assertSame($v, $a, "{$label}: evidence.{$k}");
            }
        }
        self::assertTrue($actual->isValid(), "{$label}: decision contract");
    }

    /**
     * JSON objects as string-keyed arrays.
     *
     * @return array<string, mixed>
     */
    private static function map(mixed $value): array
    {
        $out = [];
        foreach (is_array($value) ? $value : [] as $k => $v) {
            $out[(string) $k] = $v;
        }
        return $out;
    }

    private static function int(mixed $v): int
    {
        return is_int($v) ? $v : (is_numeric($v) ? (int) $v : 0);
    }
}
