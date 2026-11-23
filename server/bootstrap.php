<?php
declare(strict_types=1);

define('NK_ROOT', dirname(__DIR__));

spl_autoload_register(static function (string $class): void {
    if (!str_starts_with($class, 'Kolam\\')) return;
    $file = __DIR__ . '/src/' . str_replace('\\', '/', substr($class, strlen('Kolam\\'))) . '.php';
    if (is_file($file)) require $file;
});

Kolam\Config::load(NK_ROOT . '/.env');
