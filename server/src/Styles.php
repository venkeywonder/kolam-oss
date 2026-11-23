<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Each person's styles for new elements: the last style they picked for a kind of element (an arrow made curved,
 * a note coloured yellow, a board given a grid) becomes the default for the next one they — or the AI for them — create.
 * Stored per account (users.styles, JSON) so every device uses the same ones.
 *   line:   route, arrow, arrowStart, head, width, dash, color
 *   board:  bg, corners (new boards)
 *   sketch: pen (pen colour), color
 *   table:  header, color
 *   note, todo, column, comment, image (caption), table, doc: align (text alignment), color
 *   every other card type: color
 */
final class Styles
{
    public const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'dark'];
    private const CARDS = ['note', 'todo', 'link', 'image', 'file', 'board', 'shortcut', 'column', 'comment', 'table', 'doc', 'swatch', 'sketch', 'drawing'];
    public const ALIGNABLE = ['note', 'todo', 'column', 'comment', 'image', 'table', 'doc'];
    public const ALIGNS = ['left', 'center', 'right', 'justify'];
    private const FIELDS = [
        'line' => ['route' => ['straight', 'curved', 'elbow'], 'arrow' => 'bool', 'arrowStart' => 'bool',
                   'head' => ['triangle', 'open', 'dot', 'diamond'], 'width' => [1, 2, 3, 5], 'dash' => ['solid', 'dashed', 'dotted'], 'color' => self::COLORS],
        'board' => ['bg' => ['dots', 'grid', 'plain'], 'corners' => ['sharp', 'curved', 'rounded']],
        'sketch' => ['pen' => 'hex'],
        'table' => ['header' => 'bool'],
    ];

    public static function get(string $userId): array
    {
        $r = Db::one('SELECT styles FROM users WHERE id = ?', [$userId]);
        $s = json_decode((string) ($r['styles'] ?? ''), true);
        return is_array($s) ? self::clean($s) : [];
    }

    /** Replace the person's styles with $in (unknown kinds, fields and values are dropped). */
    public static function set(string $userId, mixed $in): array
    {
        if (!is_array($in)) Http::fail(422, 'Invalid styles');
        $s = self::clean($in);
        Db::q('UPDATE users SET styles = ? WHERE id = ?', [$s ? json_encode($s, JSON_UNESCAPED_SLASHES) : null, $userId]);
        return $s;
    }

    private static function clean(array $in): array
    {
        $out = [];
        foreach ($in as $kind => $fields) {
            if (!is_string($kind) || !is_array($fields)) continue;
            $allowed = (self::FIELDS[$kind] ?? []) + (in_array($kind, self::CARDS, true) ? ['color' => self::COLORS] : [])
                + (in_array($kind, self::ALIGNABLE, true) ? ['align' => self::ALIGNS] : []);
            foreach ($fields as $k => $v) {
                $rule = $allowed[$k] ?? null;
                $ok = match (true) {
                    $rule === null => false,
                    $rule === 'bool' => is_bool($v),
                    $rule === 'hex' => is_string($v) && preg_match('/^#[0-9a-f]{6}$/i', $v),
                    default => in_array($v, $rule, true),
                };
                if ($ok) $out[$kind][$k] = $v;
            }
        }
        return $out;
    }
}
