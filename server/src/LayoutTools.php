<?php
declare(strict_types=1);

namespace Kolam;

/** MCP tools: Arranging cards on a board (arrange_cards). */
final class LayoutTools
{
    public static function definitions(): array
    {
        $space = ['type' => 'string', 'description' => 'Space id from list_boards; omit for your own boards'];
        return [[
            'name' => 'arrange_cards', 'title' => 'Arrange cards',
            'description' => 'Tidy cards on a board: lay them out as a grid, a row, a column, or a tree that follows the connection arrows '
                . '(roots on the left or top, children spread out, like a mind map or flowchart). Or, without "layout", just align a selection '
                . '(left/center/right/top/middle/bottom) or evenly distribute the spacing between the cards, without otherwise moving them. '
                . 'Moving a group card takes the cards inside its box along with it. Locked cards and cards inside a column are left where they are.',
            'inputSchema' => ['type' => 'object', 'properties' => (object) [
                'space' => $space,
                'board_id' => ['type' => 'string', 'description' => 'Board id (from list_boards)'],
                'card_ids' => ['type' => 'array', 'items' => ['type' => 'string'],
                               'description' => 'Cards to arrange; default: every top-level card on the board (not inside a column)'],
                'layout' => ['type' => 'string', 'enum' => ['grid', 'row', 'column', 'tree'],
                             'description' => 'Full re-layout; omit to only align or distribute the current positions'],
                'gap' => ['type' => 'number', 'minimum' => 0, 'maximum' => 2000, 'description' => 'Space between cards in pixels (default 40; 120 between tree levels, leaving room for arrows and their labels)'],
                'columns' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 50, 'description' => 'Columns for a grid layout (default: roughly square)'],
                'direction' => ['type' => 'string', 'enum' => ['right', 'down'],
                                'description' => 'Tree growth direction: roots on the left growing right (default), or on top growing down'],
                'align' => ['type' => 'string', 'enum' => ['left', 'center', 'right', 'top', 'middle', 'bottom'],
                            'description' => 'Align the selection on one axis; with a grid/row/column layout it aligns cards across their row or column'],
                'distribute' => ['type' => 'string', 'enum' => ['horizontal', 'vertical'],
                                  'description' => 'Evenly space the selection between its current first and last card on this axis'],
            ], 'required' => ['board_id']],
        ]];
    }

    public static function call(array $u, string $name, array $a): array
    {
        if ($name !== 'arrange_cards') throw new ToolError("Unknown tool $name");
        $w = Workspace::load($u, BoardTools::spaceArg($a));
        $r = self::arrange($w, $a);
        BoardTools::save($w);
        return $r;
    }

    private static function arrange(Workspace $w, array $a): array
    {
        $bid = BoardTools::editableBoard($w, $a['board_id'] ?? '');
        $layout = $a['layout'] ?? null;
        if ($layout !== null && !in_array($layout, ['grid', 'row', 'column', 'tree'], true)) {
            throw new ToolError('layout must be one of grid, row, column, tree');
        }
        $align = $a['align'] ?? null;
        if ($align !== null && !in_array($align, ['left', 'center', 'right', 'top', 'middle', 'bottom'], true)) {
            throw new ToolError('align must be one of left, center, right, top, middle, bottom');
        }
        $distribute = $a['distribute'] ?? null;
        if ($distribute !== null && !in_array($distribute, ['horizontal', 'vertical'], true)) {
            throw new ToolError('distribute must be horizontal or vertical');
        }
        if ($layout === null && $align === null && $distribute === null) throw new ToolError('Pass layout, align, or distribute');
        $gap = (int) (BoardTools::num($a['gap'] ?? ($layout === 'tree' ? 120 : 40), 0, 2000) ?? 40);

        $all = array_values(array_filter($w->itemsOf($bid), fn($i) => empty($i['col'])));
        $byId = [];
        foreach ($all as $i) $byId[$i['id']] = $i;

        if (isset($a['card_ids'])) {
            if (!is_array($a['card_ids']) || !$a['card_ids']) throw new ToolError('Pass a non-empty list of card_ids, or omit it for every top-level card');
            $ids = [];
            foreach ($a['card_ids'] as $id) {
                $it = BoardTools::card($w, $id);
                if (($it['board'] ?? '') !== $bid) throw new ToolError("Card $id is not on this board");
                if (!empty($it['col'])) throw new ToolError("Card $id is inside a column; take it out first");
                $ids[] = $it['id'];
            }
        } else {
            $ids = array_keys($byId);
        }

        // groups carry everything wholly inside their box along with them (mirrors contentsOf in src/cards/group.js)
        $groups = array_values(array_filter($all, fn($i) => $i['type'] === 'group'));
        usort($groups, fn($g1, $g2) => (Placer::box($w, $g1)['w'] * Placer::box($w, $g1)['h']) <=> (Placer::box($w, $g2)['w'] * Placer::box($w, $g2)['h']));
        $carries = [];
        foreach ($groups as $g) {
            $gr = Placer::box($w, $g);
            $inside = [];
            foreach ($all as $i) {
                if ($i['id'] === $g['id'] || !empty($i['locked'])) continue;
                $r = Placer::box($w, $i);
                if ($r['x'] >= $gr['x'] - 1 && $r['y'] >= $gr['y'] - 1 && $r['x'] + $r['w'] <= $gr['x'] + $gr['w'] + 1 && $r['y'] + $r['h'] <= $gr['y'] + $gr['h'] + 1) {
                    $inside[] = $i['id'];
                }
            }
            $carries[$g['id']] = $inside;
        }
        $selectedGroups = array_intersect($ids, array_keys($carries));
        $carried = [];
        foreach ($selectedGroups as $gid) foreach ($carries[$gid] as $cid) $carried[$cid] = $gid;

        $primaries = [];
        $skippedLocked = 0;
        foreach ($ids as $id) {
            $it = $byId[$id] ?? null;
            if (!$it || isset($carried[$id])) continue;
            if (!empty($it['locked'])) { $skippedLocked++; continue; }
            $primaries[] = $it;
        }
        if (!$primaries) throw new ToolError('Nothing to arrange (every card is locked, carried by a group, or inside a column)');

        $rects = [];
        foreach ($primaries as $it) $rects[$it['id']] = Placer::box($w, $it);
        usort($primaries, fn($p1, $p2) => [$rects[$p1['id']]['y'], $rects[$p1['id']]['x']] <=> [$rects[$p2['id']]['y'], $rects[$p2['id']]['x']]);

        $minX = min(array_map(fn($it) => $rects[$it['id']]['x'], $primaries));
        $minY = min(array_map(fn($it) => $rects[$it['id']]['y'], $primaries));

        if ($layout !== null) {
            $pos = match ($layout) {
                'grid' => self::layoutGrid($primaries, $rects, (int) ($a['columns'] ?? 0), $gap, $align),
                'row' => self::layoutRow($primaries, $rects, $gap, $align),
                'column' => self::layoutColumn($primaries, $rects, $gap, $align),
                'tree' => self::layoutTree($w, $bid, $rects, array_column($primaries, 'id'), $gap, (string) ($a['direction'] ?? 'right')),
            };
            // anchor the arranged block back at the selection's original top-left
            $bx = min(array_map(fn($p) => $p[0], $pos));
            $by = min(array_map(fn($p) => $p[1], $pos));
            $dx = $minX - $bx; $dy = $minY - $by;
            foreach ($pos as $id => [$x, $y]) $pos[$id] = [(int) round($x + $dx), (int) round($y + $dy)];
        } else {
            $pos = [];
            foreach ($primaries as $it) $pos[$it['id']] = [$rects[$it['id']]['x'], $rects[$it['id']]['y']];
            if ($align !== null) $pos = self::applyAlign($primaries, $rects, $pos, $align);
            if ($distribute !== null) $pos = self::applyDistribute($primaries, $rects, $pos, $distribute);
        }

        $moved = [];
        foreach ($primaries as $it) {
            [$x, $y] = $pos[$it['id']];
            $ox = $rects[$it['id']]['x']; $oy = $rects[$it['id']]['y'];
            $dx = $x - $ox; $dy = $y - $oy;
            $it['x'] = $x; $it['y'] = $y;
            $w->putItem($it);
            $moved[] = ['id' => $it['id'], 'x' => $x, 'y' => $y];
            if (($dx !== 0 || $dy !== 0) && isset($carries[$it['id']])) {
                foreach ($carries[$it['id']] as $cid) {
                    $c = $w->items[$cid] ?? null;
                    if (!$c) continue;
                    $c['x'] = (int) (($c['x'] ?? 0) + $dx); $c['y'] = (int) (($c['y'] ?? 0) + $dy);
                    $w->putItem($c);
                    $moved[] = ['id' => $cid, 'x' => $c['x'], 'y' => $c['y'], 'carried_by' => $it['id']];
                }
            }
        }

        return ['moved' => $moved, 'skipped_locked' => $skippedLocked];
    }

    /** Row-major grid; cell size is the tallest/widest card in that row/column, align places a card within its cell. */
    private static function layoutGrid(array $primaries, array $rects, int $columns, int $gap, ?string $align): array
    {
        $n = count($primaries);
        $cols = max(1, $columns > 0 ? min($columns, $n) : (int) ceil(sqrt($n)));
        $rows = (int) ceil($n / $cols);
        $colW = array_fill(0, $cols, 0); $rowH = array_fill(0, $rows, 0);
        foreach (array_values($primaries) as $n2 => $it) {
            $r = intdiv($n2, $cols); $c = $n2 % $cols;
            $colW[$c] = max($colW[$c], $rects[$it['id']]['w']);
            $rowH[$r] = max($rowH[$r], $rects[$it['id']]['h']);
        }
        $colX = []; $x = 0;
        foreach ($colW as $c => $wd) { $colX[$c] = $x; $x += $wd + $gap; }
        $rowY = []; $y = 0;
        foreach ($rowH as $r => $ht) { $rowY[$r] = $y; $y += $ht + $gap; }
        $pos = [];
        foreach (array_values($primaries) as $n2 => $it) {
            $r = intdiv($n2, $cols); $c = $n2 % $cols;
            $rr = $rects[$it['id']];
            $cx = $colX[$c] + match ($align) { 'center' => ($colW[$c] - $rr['w']) / 2, 'right' => $colW[$c] - $rr['w'], default => 0 };
            $cy = $rowY[$r] + match ($align) { 'middle' => ($rowH[$r] - $rr['h']) / 2, 'bottom' => $rowH[$r] - $rr['h'], default => 0 };
            $pos[$it['id']] = [$cx, $cy];
        }
        return $pos;
    }

    private static function layoutRow(array $primaries, array $rects, int $gap, ?string $align): array
    {
        $maxH = max(array_map(fn($it) => $rects[$it['id']]['h'], $primaries));
        $pos = []; $x = 0;
        foreach ($primaries as $it) {
            $r = $rects[$it['id']];
            $y = match ($align) { 'middle' => ($maxH - $r['h']) / 2, 'bottom' => $maxH - $r['h'], default => 0 };
            $pos[$it['id']] = [$x, $y];
            $x += $r['w'] + $gap;
        }
        return $pos;
    }

    private static function layoutColumn(array $primaries, array $rects, int $gap, ?string $align): array
    {
        $maxW = max(array_map(fn($it) => $rects[$it['id']]['w'], $primaries));
        $pos = []; $y = 0;
        foreach ($primaries as $it) {
            $r = $rects[$it['id']];
            $x = match ($align) { 'center' => ($maxW - $r['w']) / 2, 'right' => $maxW - $r['w'], default => 0 };
            $pos[$it['id']] = [$x, $y];
            $y += $r['h'] + $gap;
        }
        return $pos;
    }

    /** Layers nodes by longest path from a root along the board's connection arrows, then spreads each layer along the other axis. */
    private static function layoutTree(Workspace $w, string $bid, array $rects, array $ids, int $gap, string $direction): array
    {
        if (!in_array($direction, ['right', 'down'], true)) throw new ToolError('direction must be right or down');
        $set = array_flip($ids);
        $out = []; $indeg = [];
        foreach ($ids as $id) { $out[$id] = []; $indeg[$id] = 0; }
        foreach ($w->lines as $l) {
            if (($l['board'] ?? '') !== $bid) continue;
            $from = $l['a']['item'] ?? null; $to = $l['b']['item'] ?? null;
            if ($from !== null && $to !== null && $from !== $to && isset($set[$from]) && isset($set[$to])) { $out[$from][] = $to; $indeg[$to]++; }
        }
        $order = fn($id) => $direction === 'down' ? $rects[$id]['x'] : $rects[$id]['y'];

        $layer = [];
        $queue = array_values(array_filter($ids, fn($id) => $indeg[$id] === 0));
        usort($queue, fn($a, $b) => $order($a) <=> $order($b));
        $visited = [];
        while ($queue) {
            $id = array_shift($queue);
            if (isset($visited[$id])) continue;
            $visited[$id] = true;
            $layer[$id] ??= 0;
            $ready = [];
            foreach ($out[$id] as $c) {
                $layer[$c] = max($layer[$c] ?? 0, $layer[$id] + 1);
                if (--$indeg[$c] <= 0 && !isset($visited[$c])) $ready[] = $c;
            }
            usort($ready, fn($a, $b) => $order($a) <=> $order($b));
            array_splice($queue, 0, 0, $ready);
        }
        foreach ($ids as $id) if (!isset($layer[$id])) $layer[$id] = 0;   // a cycle: fall back to the first layer

        $byLayer = [];
        foreach ($ids as $id) $byLayer[$layer[$id]][] = $id;
        ksort($byLayer);

        $pos = []; $mainOffset = 0;
        foreach ($byLayer as $layerIds) {
            usort($layerIds, fn($a, $b) => $order($a) <=> $order($b));
            $maxMain = max(array_map(fn($id) => $direction === 'down' ? $rects[$id]['h'] : $rects[$id]['w'], $layerIds));
            $perp = 0;
            foreach ($layerIds as $id) {
                $r = $rects[$id];
                if ($direction === 'down') { $pos[$id] = [$perp, $mainOffset]; $perp += $r['w'] + $gap; }
                else { $pos[$id] = [$mainOffset, $perp]; $perp += $r['h'] + $gap; }
            }
            $mainOffset += $maxMain + $gap;
        }
        return $pos;
    }

    /** Align the selection on one axis, keeping every card's position on the other. */
    private static function applyAlign(array $primaries, array $rects, array $pos, string $align): array
    {
        $minX = min(array_map(fn($it) => $rects[$it['id']]['x'], $primaries));
        $maxX = max(array_map(fn($it) => $rects[$it['id']]['x'] + $rects[$it['id']]['w'], $primaries));
        $minY = min(array_map(fn($it) => $rects[$it['id']]['y'], $primaries));
        $maxY = max(array_map(fn($it) => $rects[$it['id']]['y'] + $rects[$it['id']]['h'], $primaries));
        foreach ($primaries as $it) {
            $r = $rects[$it['id']];
            [$x, $y] = $pos[$it['id']];
            switch ($align) {
                case 'left': $x = $minX; break;
                case 'right': $x = $maxX - $r['w']; break;
                case 'center': $x = (int) round(($minX + $maxX) / 2 - $r['w'] / 2); break;
                case 'top': $y = $minY; break;
                case 'bottom': $y = $maxY - $r['h']; break;
                case 'middle': $y = (int) round(($minY + $maxY) / 2 - $r['h'] / 2); break;
            }
            $pos[$it['id']] = [(int) $x, (int) $y];
        }
        return $pos;
    }

    /** Evenly space the selection between its current first and last card on one axis; keeps those two ends fixed. */
    private static function applyDistribute(array $primaries, array $rects, array $pos, string $distribute): array
    {
        if (count($primaries) < 3) return $pos;
        $axis = $distribute === 'horizontal' ? 'x' : 'y';
        $size = $distribute === 'horizontal' ? 'w' : 'h';
        $items = $primaries;
        usort($items, fn($a, $b) => $rects[$a['id']][$axis] <=> $rects[$b['id']][$axis]);
        $first = $rects[$items[0]['id']];
        $last = $rects[$items[count($items) - 1]['id']];
        $span = ($last[$axis] + $last[$size]) - $first[$axis];
        $sumSize = array_sum(array_map(fn($it) => $rects[$it['id']][$size], $items));
        $gap = (count($items) > 1) ? ($span - $sumSize) / (count($items) - 1) : 0;
        $cursor = (float) $first[$axis];
        foreach ($items as $it) {
            $r = $rects[$it['id']];
            [$x, $y] = $pos[$it['id']];
            if ($axis === 'x') $x = (int) round($cursor); else $y = (int) round($cursor);
            $pos[$it['id']] = [$x, $y];
            $cursor += $r[$size] + $gap;
        }
        return $pos;
    }
}
