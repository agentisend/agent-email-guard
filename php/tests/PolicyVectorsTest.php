<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard\Tests;

use AgentiSend\AgentEmailGuard\Policy;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

/** spec/vectors/policy/validation.json (SPEC §2.9): the exact problem sentences, in file order. */
final class PolicyVectorsTest extends TestCase
{
    /** @return iterable<string, array{mixed, list<string>}> */
    public static function cases(): iterable
    {
        $file = VectorsTest::vectorDir() . '/policy/validation.json';
        if (!is_file($file)) {
            return;
        }
        // Decoded as objects so a JSON {} and [] stay different.
        $data = json_decode((string) file_get_contents($file), false, 512, JSON_THROW_ON_ERROR);
        $cases = $data instanceof \stdClass && is_array($data->cases ?? null) ? $data->cases : [];
        foreach ($cases as $case) {
            if (!$case instanceof \stdClass) {
                continue;
            }
            $problems = [];
            $expect = $case->expect ?? null;
            foreach ($expect instanceof \stdClass && is_array($expect->problems ?? null) ? $expect->problems : [] as $p) {
                $problems[] = is_string($p) ? $p : '';
            }
            $name = is_string($case->name ?? null) ? $case->name : '?';
            yield $name => [$case->policy ?? null, $problems];
        }
    }

    public function testThePolicyVectorsArePresent(): void
    {
        $count = 0;
        foreach (self::cases() as $_) {
            $count++;
        }
        self::assertGreaterThan(0, $count, 'No policy vectors in ' . VectorsTest::vectorDir() . '/policy.');
    }

    /** @param list<string> $problems */
    #[DataProvider('cases')]
    public function testPolicyCase(mixed $policy, array $problems): void
    {
        self::assertSame($problems, Policy::validate($policy));
    }
}
