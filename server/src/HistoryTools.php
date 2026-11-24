<?php
declare(strict_types=1);

namespace Kolam;

/** MCP tools: Board activity, card versions and restoring them, and the board the person has open (board_activity, card_versions, restore_version, current_board). */
final class HistoryTools
{
    public static function definitions(): array
    {
        $space = ['type' => 'string', 'description' => 'Space id from list_boards; omit for your own boards'];
        $obj = fn(array $props, array $req = []) => ['type' => 'object', 'properties' => (object) (['space' => $space] + $props)] + ($req ? ['required' => $req] : []);

        return [
            ['name' => 'board_activity', 'title' => 'Board activity',
             'description' => 'Recent changes on a board, newest first: who created, edited, moved, locked or deleted which card (or the board itself), and comments. '
                . 'Pass the "cursor" of the oldest entry as "before" to page back further.',
             'inputSchema' => $obj([
                 'board_id' => ['type' => 'string', 'description' => 'Board id; "home" for the top board, "__unsorted" for the inbox'],
                 'before' => ['type' => 'integer', 'description' => 'Page back from this cursor (an entry\'s "cursor" value); omit for the newest'],
             ], ['board_id']),
             'annotations' => ['readOnlyHint' => true]],
            ['name' => 'card_versions', 'title' => 'Card version history',
             'description' => 'A card\'s past states over the last 90 days, newest first, each with who changed it, when, what changed, and (when still kept) '
                . 'a summary of its content at that point, as "ref" for restore_version.',
             'inputSchema' => $obj(['card_id' => ['type' => 'string']], ['card_id']),
             'annotations' => ['readOnlyHint' => true]],
            ['name' => 'restore_version', 'title' => 'Restore a card version',
             'description' => 'Put a card\'s content, colour and size back to an earlier version (a "ref" from card_versions); it stays where it is now on the board. '
                . 'A deleted card comes back onto the board it was on (or the top board, if that\'s gone) and leaves the Trash. Needs edit access to that board.',
             'inputSchema' => $obj(['card_id' => ['type' => 'string'], 'ref' => ['type' => 'string', 'description' => 'A version\'s "ref" from card_versions']], ['card_id', 'ref'])],
            ['name' => 'current_board', 'title' => 'The board open right now',
             'description' => 'Which board (and space) the person has open in Kolam right now, so you can act on "this board" without asking. '
                . 'Says clearly when they have no Kolam tab open, or it has gone stale.',
             'inputSchema' => ['type' => 'object', 'properties' => (object) []],
             'annotations' => ['readOnlyHint' => true]],
        ];
    }

    public static function call(array $u, string $name, array $a): array
    {
        if ($name === 'current_board') return self::currentBoard($u);
        $w = Workspace::load($u, BoardTools::spaceArg($a));
        $r = match ($name) {
            'board_activity' => self::boardActivity($w, $u, $a),
            'card_versions' => self::cardVersions($w, $u, $a),
            'restore_version' => self::restoreVersion($w, $u, $a),
            default => throw new ToolError("Unknown tool $name"),
        };
        if ($name === 'restore_version') BoardTools::save($w);
        return $r;
    }

    private static function boardActivity(Workspace $w, array $u, array $a): array
    {
        $bid = BoardTools::boardArg($w, $a['board_id'] ?? '');
        $before = isset($a['before']) && is_numeric($a['before']) ? (int) $a['before'] : 0;
        $feed = History::feed($u, $w->spaceId, $bid, $before);
        $names = (array) $feed['names'];
        $out = [];
        foreach ($feed['entries'] as $e) {
            $by = $e['by'] ?? null;
            $out[] = array_filter([
                'kind' => $e['k'],
                'card_id' => $e['k'] !== 'board' ? ($e['item'] ?? null) : null,
                'action' => $e['act'],
                'fields' => $e['f'] ?? null,
                'type' => $e['type'] ?? null,
                'label' => $e['label'] ?? null,
                'by' => $by ? ($names[$by] ?? 'Someone') : (!empty($e['guest']) ? ($e['name'] ?? 'A guest') . ' (guest)' : null),
                'changes' => ($e['n'] ?? 1) > 1 ? $e['n'] : null,
                'at' => date('c', (int) round($e['at'] / 1000)),
                'cursor' => $e['at'],
            ], fn($v) => $v !== null);
        }
        return ['board_id' => $bid, 'entries' => $out, 'more' => $feed['more']];
    }

    private static function cardVersions(Workspace $w, array $u, array $a): array
    {
        $item = (string) ($a['card_id'] ?? '');
        if ($item === '') throw new ToolError('Pass card_id');
        $r = History::versions($u, $w->spaceId, $item);
        $names = (array) $r['names'];
        $out = [];
        foreach ($r['versions'] as $v) {
            $by = $v['by'] ?? null;
            $row = array_filter([
                'ref' => $v['ref'] ?? null,
                'action' => $v['act'],
                'by' => $by ? ($names[$by] ?? 'Someone') : null,
                'fields' => $v['f'] ?? null,
                'changes' => ($v['n'] ?? 1) > 1 ? $v['n'] : null,
                'at' => !empty($v['at']) ? date('c', (int) round($v['at'] / 1000)) : null,
            ], fn($x) => $x !== null);
            if (($v['ref'] ?? null) === 'current') {
                if (isset($w->items[$item])) $row['card'] = BoardTools::describe($w, $w->items[$item]);
            } elseif (is_string($v['ref'] ?? null)) {
                try { $row['card'] = BoardTools::describe($w, History::data($u, $w->spaceId, $v['ref'])['item']); } catch (\Throwable) {}
            }
            $out[] = $row;
        }
        return ['card_id' => $item, 'versions' => $out];
    }

    /** Restore a card's content/colour/size from a kept version, exactly as the browser's "Restore this version" does. */
    private static function restoreVersion(Workspace $w, array $u, array $a): array
    {
        $item = (string) ($a['card_id'] ?? '');
        $ref = $a['ref'] ?? null;
        if ($item === '' || !is_string($ref) || $ref === '') throw new ToolError('Pass card_id and ref (from card_versions)');
        $stored = History::data($u, $w->spaceId, $ref)['item'];
        if (($stored['id'] ?? null) !== $item) throw new ToolError('That version isn’t for this card');
        $now = $w->items[$item] ?? null;
        if (!$now && ($stored['type'] ?? '') === 'board') throw new ToolError('Restore this board from the Trash (restore_from_trash), not from its version history');
        $out = $stored;
        if ($now) {
            BoardTools::requireEditor($w, $now['board'] ?? '');
            foreach (['board', 'col', 'x', 'y', 'z', 'order', 'locked', 'lockedBy'] as $k) {
                if (array_key_exists($k, $now)) $out[$k] = $now[$k]; else unset($out[$k]);
            }
        } else {
            $target = (string) ($out['board'] ?? '');
            if (!isset($w->boards[$target]) && $target !== BoardTools::UNSORTED) $target = '';
            if ($target === '' || !Access::atLeast($w->roles[$target] ?? null, 'editor')) $target = BoardTools::defaultBoard($w);
            BoardTools::requireEditor($w, $target);
            $out['board'] = $target;
        }
        if (!empty($out['col'])) {
            $col = $w->items[$out['col']] ?? null;
            if (!$col || $col['board'] !== $out['board']) $out['col'] = null;
        }
        $w->putItem($out);
        if (!$now) self::leaveTrash($w, $item);
        return ['restored' => BoardTools::describe($w, $w->items[$item])];
    }

    /** A restored card leaves whichever Trash entry still lists it (the rest of that entry, if any, stays). */
    private static function leaveTrash(Workspace $w, string $itemId): void
    {
        foreach ($w->trash as $tid => $t) {
            if (!is_array($t['items'] ?? null)) continue;
            if (!array_any($t['items'], fn($i) => ($i['id'] ?? null) === $itemId)) continue;
            $t['items'] = array_values(array_filter($t['items'], fn($i) => ($i['id'] ?? null) !== $itemId));
            if (!$t['items'] && empty($t['boards'])) $w->delTrash($tid); else $w->putTrash($t);
        }
    }

    /** Which board (and space) the person has a Kolam tab open on right now. */
    private static function currentBoard(array $u): array
    {
        $row = Db::one('SELECT space_id, board, editing, seen_at FROM presence WHERE user_id = ? ORDER BY seen_at DESC LIMIT 1', [$u['id']]);
        if (!$row) return ['open' => false, 'message' => 'They have no Kolam tab open (or none recently).'];
        $ago = time() - (int) $row['seen_at'];
        $fresh = $ago <= Realtime::STALE;
        if ($row['board'] === null) {
            return ['open' => $fresh, 'seconds_ago' => $ago,
                    'message' => $fresh ? 'A Kolam tab is open, but not on a particular board.' : 'No recent Kolam tab (last seen ' . $ago . 's ago, not on a board).'];
        }
        $space = Access::space((string) $row['space_id']);
        $w = Workspace::load($u, $space['id']);
        $bid = (string) $row['board'];
        if (!isset($w->boards[$bid]) && $bid !== BoardTools::UNSORTED) {
            return ['open' => false, 'seconds_ago' => $ago, 'message' => 'Their last board there is no longer available.'];
        }
        $out = [
            'open' => $fresh,
            'seconds_ago' => $ago,
            'space' => $space['id'],
            'space_name' => $space['name'],
            'board_id' => $bid,
            'board_title' => $bid === BoardTools::UNSORTED ? 'Unsorted' : ($w->boards[$bid]['title'] ?? ''),
            'path' => $bid === BoardTools::UNSORTED ? 'Unsorted' : $w->path($bid),
            'message' => $fresh ? null : 'Not open right now; last seen ' . $ago . 's ago.',
        ];
        if ($fresh && $row['editing'] !== null && isset($w->items[$row['editing']])) {
            $out['editing_card'] = BoardTools::describe($w, $w->items[$row['editing']]);
        }
        return array_filter($out, fn($v) => $v !== null);
    }
}
