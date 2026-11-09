<?php

/**
 * Prints the composer.json that goes at the ROOT of github.com/agentisend/agent-email-guard,
 * built from php/composer.json with every path moved under php/. Packagist only
 * reads a composer.json at the repository root. See PUBLISH.md.
 *
 *   php php/bin/root-composer.php > composer.json
 */

declare(strict_types=1);

$source = json_decode((string) file_get_contents(dirname(__DIR__) . '/composer.json'), true, 512, JSON_THROW_ON_ERROR);
if (!is_array($source)) {
    fwrite(STDERR, "php/composer.json is not an object\n");
    exit(1);
}

foreach (['autoload', 'autoload-dev'] as $section) {
    $psr4 = $source[$section]['psr-4'] ?? null;
    if (is_array($psr4)) {
        foreach ($psr4 as $namespace => $path) {
            $source[$section]['psr-4'][$namespace] = 'php/' . (is_string($path) ? $path : '');
        }
    }
}
$source['scripts'] = [
    'test' => 'phpunit -c php/phpunit.xml.dist',
    'stan' => 'phpstan analyse -c php/phpstan.neon.dist --memory-limit=1G',
];
$source['support']['docs'] = 'https://github.com/agentisend/agent-email-guard/tree/main/php';

echo json_encode($source, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE | JSON_THROW_ON_ERROR), "\n";
