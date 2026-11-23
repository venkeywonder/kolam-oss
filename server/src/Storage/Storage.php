<?php
declare(strict_types=1);

namespace Kolam\Storage;

interface Storage
{
    public function put(string $key, string $tmpFile, string $mime): void;
    /** Stream the object to the client (headers already sent by the caller). */
    public function output(string $key): bool;
    public function delete(string $key): void;
}
