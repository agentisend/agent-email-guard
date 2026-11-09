<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/**
 * The policy file, agent-email-guard.json: the declarative part of a guard
 * config, in the snake_case keys every language reads. Callbacks
 * (requireFor), stores and clocks stay in code.
 *
 *   {
 *     "key": "support-agent",
 *     "budgets": {"per_hour": 50, "per_day": 500},
 *     "rate": {"per_minute": 10},
 *     "loop": {"mode": "full"},
 *     "approval": {"new_recipients": true, "recipients": ["@bigcustomer.com"]},
 *     "suppress": ["regulator@gov.example"]
 *   }
 */
final class Policy
{
    public const FILE = 'agent-email-guard.json';

    private const SHAPE = [
        '$schema' => 'any',
        '$comment' => 'any',
        'version' => 'one',
        'key' => 'str',
        'namespace' => 'str',
        'budgets' => ['per_hour' => 'int', 'per_day' => 'int', 'per_month' => 'int'],
        'rate' => ['per_minute' => 'int'],
        'loop' => [
            'mode' => 'mode',
            'window_ms' => 'int',
            'similarity_threshold' => 'num',
            'max_identical_sends' => 'int',
            'min_window_for_entropy' => 'int',
            'recipient_perplexity_floor' => 'num',
        ],
        'approval' => ['new_recipients' => 'bool', 'recipients' => 'strs'],
        'suppress' => 'strs',
    ];

    private function __construct()
    {
    }

    /**
     * Every problem with a decoded policy, as sentences. Empty means valid.
     *
     * @return list<string>
     */
    public static function validate(mixed $policy): array
    {
        if (!self::isObject($policy)) {
            return ['The policy must be a JSON object.'];
        }
        $problems = [];
        foreach (self::entries($policy) as $key => $value) {
            $key = (string) $key;
            $shape = self::SHAPE[$key] ?? null;
            if ($shape === null) {
                $problems[] = "Unknown key \"{$key}\".";
            } elseif (is_string($shape)) {
                if (!self::leaf($shape, $value)) {
                    $problems[] = "\"{$key}\" has the wrong type.";
                }
            } elseif (!self::isObject($value)) {
                $problems[] = "\"{$key}\" must be an object.";
            } else {
                foreach (self::entries($value) as $inner => $innerValue) {
                    $inner = (string) $inner;
                    $leaf = $shape[$inner] ?? null;
                    if ($leaf === null) {
                        $problems[] = "Unknown key \"{$key}.{$inner}\".";
                    } elseif (!self::leaf($leaf, $innerValue)) {
                        $problems[] = "\"{$key}.{$inner}\" has the wrong type.";
                    }
                }
            }
        }
        return $problems;
    }

    /**
     * A validated policy as Guard::create() config. Throws listing every problem.
     *
     * @return array<string, mixed>
     */
    public static function toConfig(mixed $policy): array
    {
        $problems = self::validate($policy);
        if ($problems !== []) {
            throw new \InvalidArgumentException('Invalid agent-email-guard policy: ' . implode(' ', $problems));
        }
        $config = [];
        foreach (self::entries($policy) as $key => $value) {
            if (!str_starts_with($key, '$') && $key !== 'version') {
                $config[$key] = self::plain($value);
            }
        }
        return $config;
    }

    /**
     * Read and validate a policy file. Default: ./agent-email-guard.json.
     *
     * @return array<string, mixed>
     */
    public static function load(?string $path = null): array
    {
        $path ??= self::FILE;
        $raw = is_file($path) ? file_get_contents($path) : false;
        if ($raw === false) {
            throw new \InvalidArgumentException("No policy file at {$path}. Create " . self::FILE . ' or pass a path.');
        }
        try {
            // Objects stay stdClass so {} and [] can be told apart.
            $decoded = json_decode($raw, false, 64, JSON_THROW_ON_ERROR);
        } catch (\JsonException $e) {
            throw new \InvalidArgumentException("{$path} is not valid JSON: {$e->getMessage()}", 0, $e);
        }
        return self::toConfig($decoded);
    }

    /**
     * A JSON object: stdClass (json_decode without assoc keeps {} apart from
     * []), or a non-empty PHP array with string keys. An empty PHP array is a
     * JSON [] and so not an object; pass new \stdClass() for an empty policy.
     */
    private static function isObject(mixed $v): bool
    {
        if ($v instanceof \stdClass) {
            return true;
        }
        return is_array($v) && $v !== [] && !array_is_list($v);
    }

    /** @return array<string, mixed> */
    private static function entries(mixed $v): array
    {
        $out = [];
        foreach (is_array($v) || $v instanceof \stdClass ? (array) $v : [] as $k => $item) {
            $out[(string) $k] = $item;
        }
        return $out;
    }

    /** stdClass trees as arrays, for Guard::create(). */
    private static function plain(mixed $v): mixed
    {
        if ($v instanceof \stdClass || is_array($v)) {
            $out = [];
            foreach ((array) $v as $k => $item) {
                $out[$k] = self::plain($item);
            }
            return $out;
        }
        return $v;
    }

    private static function leaf(string $kind, mixed $v): bool
    {
        return match ($kind) {
            'int' => is_int($v) && $v >= 0,
            'num' => (is_int($v) || is_float($v)) && is_finite((float) $v) && $v > 0,
            'bool' => is_bool($v),
            'str' => is_string($v) && $v !== '',
            'strs' => is_array($v) && array_is_list($v) && array_filter($v, 'is_string') === $v,
            'mode' => in_array($v, ['full', 'repetition_only', 'off'], true),
            'one' => $v === 1,
            default => true,
        };
    }
}
