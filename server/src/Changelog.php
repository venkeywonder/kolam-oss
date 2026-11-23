<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Parses CHANGELOG.md (project root) into [{date, items:[html...]}], newest first, for the "What's new" dialog.
 * Deliberately tiny: `## YYYY-MM-DD` headings and `- ` bullets only, with **bold**, `code` and [text](url) links inside
 * a bullet; everything else is escaped. Cached in storage/run until the file's mtime changes.
 */
final class Changelog
{
    public static function entries(): array
    {
        $path = NK_ROOT . '/CHANGELOG.md';
        if (!is_file($path)) return [];
        $mtime = (int) filemtime($path);

        $cacheFile = Config::get('storage') . '/run/changelog-cache.json';
        $cached = @file_get_contents($cacheFile);
        if ($cached !== false) {
            $data = json_decode($cached, true);
            if (is_array($data) && ($data['mtime'] ?? null) === $mtime) return $data['entries'];
        }

        $entries = self::parse((string) file_get_contents($path));

        $dir = dirname($cacheFile);
        if (is_dir($dir) || @mkdir($dir, 0775, true)) {
            @file_put_contents($cacheFile, json_encode(['mtime' => $mtime, 'entries' => $entries]));
        }
        return $entries;
    }

    private static function parse(string $md): array
    {
        $entries = [];
        $date = null;
        $items = [];
        foreach (explode("\n", $md) as $line) {
            if (preg_match('/^##\s+(\d{4}-\d{2}-\d{2})\s*$/', $line, $m)) {
                if ($date !== null) $entries[] = ['date' => $date, 'items' => $items];
                $date = $m[1];
                $items = [];
                continue;
            }
            if ($date !== null && preg_match('/^-\s+(.+)$/', $line, $m)) {
                $items[] = self::inline(trim($m[1]));
            }
        }
        if ($date !== null) $entries[] = ['date' => $date, 'items' => $items];
        usort($entries, fn($a, $b) => strcmp($b['date'], $a['date']));
        return $entries;
    }

    /** Escapes everything, then turns **bold**, `code` and [text](url) back into the matching HTML tags. */
    private static function inline(string $s): string
    {
        $s = htmlspecialchars($s, ENT_QUOTES, 'UTF-8');
        $s = preg_replace('/\*\*(.+?)\*\*/', '<b>$1</b>', $s);
        $s = preg_replace('/`(.+?)`/', '<code>$1</code>', $s);
        $s = preg_replace_callback('/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/', function (array $m): string {
            return '<a href="' . $m[2] . '" target="_blank" rel="noopener">' . $m[1] . '</a>';
        }, $s);
        return $s;
    }
}
