<?php

declare(strict_types=1);

namespace AgentiSend\AgentEmailGuard;

/** @internal Config value coercion with sentences that name the field. */
final class Config
{
    private function __construct()
    {
    }

    public static function int(mixed $value, string $field): int
    {
        if (is_int($value)) {
            return $value;
        }
        if (is_float($value) && floor($value) === $value) {
            return (int) $value;
        }
        if (is_string($value) && preg_match('/^-?\d+$/', $value) === 1) {
            return (int) $value;
        }
        throw new \InvalidArgumentException("{$field} must be an integer.");
    }

    public static function float(mixed $value, string $field): float
    {
        if (is_int($value) || is_float($value)) {
            return (float) $value;
        }
        if (is_string($value) && is_numeric($value)) {
            return (float) $value;
        }
        throw new \InvalidArgumentException("{$field} must be a number.");
    }

    /**
     * Read a key given in camelCase or snake_case.
     *
     * @param array<array-key, mixed> $config
     */
    public static function get(array $config, string $camel, mixed $default = null): mixed
    {
        if (array_key_exists($camel, $config)) {
            return $config[$camel];
        }
        $snake = strtolower((string) preg_replace('/[A-Z]/', '_$0', $camel));
        return array_key_exists($snake, $config) ? $config[$snake] : $default;
    }

    /**
     * @param array<array-key, mixed> $config
     * @return array<array-key, mixed>
     */
    public static function section(array $config, string $camel): array
    {
        $value = self::get($config, $camel, []);
        return is_array($value) ? $value : [];
    }

    /** @return list<string> */
    public static function stringList(mixed $value, string $field): array
    {
        if ($value === null) {
            return [];
        }
        if (is_string($value)) {
            $value = [$value];
        }
        if (!is_array($value)) {
            throw new \InvalidArgumentException("{$field} must be a list of strings.");
        }
        $out = [];
        foreach ($value as $item) {
            if (!is_string($item)) {
                throw new \InvalidArgumentException("{$field} must be a list of strings.");
            }
            $out[] = $item;
        }
        return $out;
    }
}
