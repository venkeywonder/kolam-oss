<?php
declare(strict_types=1);

namespace Kolam;

/** Finds free space for new cards (a row to the right of what is already on the board), and estimates how much room a card takes. */
final class Placer
{
    private const DEFAULT_W = 260;
    // heights for cards whose h isn't stored: the browser sizes them by their content (src/cards, src/styles/cards.css)
    private const DEFAULT_H = [
        'text' => 40, 'note' => 160, 'todo' => 160, 'link' => 110, 'column' => 360, 'board' => 110,
        'shortcut' => 60, 'table' => 160, 'doc' => 220, 'comment' => 90, 'swatch' => 90, 'image' => 220,
        'file' => 70, 'sketch' => 220, 'drawing' => 220, 'icon' => 90, 'group' => 320, 'poll' => 220,
    ];

    private int $x0; private int $x; private int $y; private int $rowH = 0; private int $n = 0;

    public function __construct(Workspace $w, string $board)
    {
        $top = array_filter($w->itemsOf($board), fn($i) => empty($i['col']));
        if (!$top) { $this->x0 = $this->x = 40; $this->y = 40; return; }
        $right = max(array_map(function ($i) use ($w) { $b = self::box($w, $i); return $b['x'] + $b['w']; }, $top));
        $this->y = (int) min(array_map(fn($i) => $i['y'] ?? 0, $top));
        $this->x0 = $this->x = (int) $right + 60;
    }

    public function next(int $w, int $h): array
    {
        if ($this->n > 0 && $this->n % 4 === 0) { $this->x = $this->x0; $this->y += $this->rowH + 40; $this->rowH = 0; }
        $p = [$this->x, $this->y];
        $this->x += $w + 30; $this->rowH = max($this->rowH, $h); $this->n++;
        return $p;
    }

    /** A card's box in pixels on its board, estimating what the browser sizes by content (h when not stored, a horizontal column's width). */
    public static function box(Workspace $w, array $it): array
    {
        $row = $it['type'] === 'column' && ($it['data']['dir'] ?? '') === 'row';
        $wd = $row ? self::rowColumnWidth(count($w->childrenOf($it['id']))) : (int) ($it['w'] ?? self::DEFAULT_W);
        $h = $it['h'] ?? null;
        if ($h === null) {
            $h = $row ? 230 : (self::DEFAULT_H[$it['type']] ?? 160);
            if ($it['type'] === 'todo') $h = max($h, 70 + 34 * count($it['data']['tasks'] ?? []));
            if ($it['type'] === 'table') $h = max($h, 40 + 40 * count($it['data']['rows'] ?? []));
        }
        return ['x' => (int) ($it['x'] ?? 0), 'y' => (int) ($it['y'] ?? 0), 'w' => $wd, 'h' => (int) $h];
    }

    /** A horizontal column is as wide as its cards side by side: 240px each, 7px apart, 7px padding (cards.css .col-row). */
    public static function rowColumnWidth(int $cards): int
    {
        return max(200, $cards * 247 - 7) + 14;
    }
}
