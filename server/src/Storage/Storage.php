<?php
declare(strict_types=1);

namespace Kolam\Storage;

interface Storage
{
    public function put(string $key, string $tmpFile, string $mime): void;
    /** Stream the object to the client (headers already sent by the caller). */
    public function output(string $key): bool;
    /** Hands the object to $sink(string $chunk) piece by piece, never whole in memory; false if it doesn't exist. */
    public function read(string $key, \Closure $sink): bool;
    public function delete(string $key): void;
}
