<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Each person's favorite tools: the floating bar at the bottom of the board (src/ui/favorites.js). A list of tool ids
 * from the left toolbar, in bar order, stored per account (users.favorites, JSON) so every device shows the same bar.
 * NULL until the person first changes it: the app then shows its starting bar and the "drag tools here" hint.
 */
final class Favorites
{
    public const TOOLS = ['text', 'note', 'link', 'todo', 'line', 'icon', 'group', 'board', 'shortcut', 'column',
        'comment', 'table', 'doc', 'sketch', 'swatch', 'image', 'upload', 'draw'];
    public const MAX = 8;

    /** The person's favorites, or null if they never changed the bar. */
    public static function get(string $userId): ?array
    {
        $r = Db::one('SELECT favorites FROM users WHERE id = ?', [$userId]);
        $v = json_decode((string) ($r['favorites'] ?? ''), true);
        return is_array($v) ? self::clean($v) : null;
    }

    public static function set(string $userId, mixed $in): array
    {
        if (!is_array($in)) Http::fail(422, 'Invalid favorites');
        $v = self::clean($in);
        Db::q('UPDATE users SET favorites = ? WHERE id = ?', [json_encode($v), $userId]);
        return $v;
    }

    /** Known tools only, each once, at most MAX. */
    private static function clean(array $in): array
    {
        $out = [];
        foreach ($in as $t) if (is_string($t) && in_array($t, self::TOOLS, true) && !in_array($t, $out, true)) $out[] = $t;
        return array_slice($out, 0, self::MAX);
    }
}
