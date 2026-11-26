<?php
declare(strict_types=1);

namespace Kolam\Storage;

/** Files on the server's disk, under STORAGE_PATH/assets. */
final class LocalStorage implements Storage
{
    public function __construct(private string $dir) {}

    private function path(string $key): string
    {
        return $this->dir . '/' . substr($key, 2, 2) . '/' . $key;   // shard by id to keep folders small
    }

    /** Absolute path on disk, for X-Sendfile (mod_xsendfile). */
    public function fullPath(string $key): string { return $this->path($key); }

    /** Path under this store's folder, for an X-Accel-Redirect to an internal Nginx location aliasing it (deploy/nginx.conf). */
    public function relativePath(string $key): string { return substr($key, 2, 2) . '/' . $key; }

    public function put(string $key, string $tmpFile, string $mime): void
    {
        $p = $this->path($key);
        if (!is_dir(dirname($p))) mkdir(dirname($p), 0775, true);
        if (!(is_uploaded_file($tmpFile) ? move_uploaded_file($tmpFile, $p) : rename($tmpFile, $p))) {
            throw new \RuntimeException('Could not store file');
        }
    }

    public function output(string $key): bool
    {
        $p = $this->path($key);
        if (!is_file($p)) return false;
        $size = filesize($p);
        header('Accept-Ranges: bytes');
        // byte ranges let browsers seek inside audio and video
        if (preg_match('/^bytes=(\d*)-(\d*)$/', $_SERVER['HTTP_RANGE'] ?? '', $m) && ($m[1] !== '' || $m[2] !== '')) {
            $start = $m[1] === '' ? max(0, $size - (int) $m[2]) : (int) $m[1];
            $end = $m[1] !== '' && $m[2] !== '' ? min((int) $m[2], $size - 1) : $size - 1;
            if ($start > $end || $start >= $size) { http_response_code(416); header("Content-Range: bytes */$size"); return true; }
            http_response_code(206);
            header("Content-Range: bytes $start-$end/$size");
            header('Content-Length: ' . ($end - $start + 1));
            $fh = fopen($p, 'rb'); fseek($fh, $start);
            $left = $end - $start + 1;
            while ($left > 0 && !feof($fh)) { $chunk = fread($fh, min(65536, $left)); echo $chunk; $left -= strlen($chunk); }
            fclose($fh);
            return true;
        }
        header('Content-Length: ' . $size);
        readfile($p);
        return true;
    }

    public function read(string $key, \Closure $sink): bool
    {
        $fh = @fopen($this->path($key), 'rb');
        if (!$fh) return false;
        while (!feof($fh)) { $chunk = fread($fh, 1 << 20); if ($chunk === false) break; $sink($chunk); }
        fclose($fh);
        return true;
    }

    public function delete(string $key): void { @unlink($this->path($key)); }
}
