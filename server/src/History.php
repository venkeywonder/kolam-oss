<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Who changed which card or board, for each board's activity feed and each card's version history.
 * - every pushed change to a card or board is a row: what happened (create, edit, delete, restore), the fields that
 *   changed, and the record as it was just before ("prev"; none for a creation or a restore).
 * - one person's edits to the same record within 2 minutes of their first one are a single row: the row is extended,
 *   and only the state before the first edit is kept. So a card's versions are the states between its rows.
 * - rows are kept 90 days (server/bin/kolam cleanup).
 */
final class History
{
    public const KEEP_DAYS = 90;
    private const GROUP_MS = 120000;
    private const PAGE = 60;

    private static function ms(): int { return (int) (microtime(true) * 1000); }

    /**
     * The changes of one push to cards and boards, as [kind, id, parent board, record before (null: wasn't there or
     * was deleted), record after (null: deleted), whether a deleted row with this id existed].
     */
    public static function record(string $spaceId, string $uid, array $changes): void
    {
        $changes = array_values(array_filter($changes, fn($c) => $c[0] === 'item' || $c[0] === 'board'));
        if (!$changes) return;
        $now = self::ms();
        // the newest recent row of each record: the same person editing again within the window extends it
        $last = [];
        foreach (array_chunk(array_values(array_unique(array_column($changes, 1))), 500) as $chunk) {
            $in = implode(',', array_fill(0, count($chunk), '?'));
            foreach (Db::q("SELECT id, kind, entity_id, board_id, user_id, act, fields, n, started_at, at FROM history
                            WHERE space_id = ? AND entity_id IN ($in) AND at >= ? ORDER BY at", [$spaceId, ...$chunk, $now - self::GROUP_MS]) as $r) {
                $last[$r['kind'] . ':' . $r['entity_id']] = $r;
            }
        }
        foreach ($changes as [$k, $id, $parent, $old, $new, $existed]) {
            $act = $old === null ? ($existed ? 'restore' : 'create') : ($new === null ? 'delete' : 'edit');
            $fields = $act === 'edit' ? Merge::patchOf($old, $new)['f'] : [];
            if ($act === 'edit' && !$fields) continue;
            $board = $k === 'board' ? $id : $parent;   // a board's own changes show in its own feed
            $d = $new ?? $old;
            $type = $k === 'board' ? 'board' : mb_substr((string) ($d['type'] ?? ''), 0, 16);
            $label = self::label($k, $d);
            $l = $last["$k:$id"] ?? null;
            if ($act === 'edit' && $l && $l['user_id'] === $uid && $l['act'] !== 'delete' && $l['board_id'] === $board
                && (int) $l['started_at'] >= $now - self::GROUP_MS) {
                $f = array_values(array_unique(array_merge(array_filter(explode(',', $l['fields'])), $fields)));
                Db::q('UPDATE history SET fields = ?, label = ?, type = ?, n = n + 1, at = ? WHERE id = ?',
                    [self::fieldList($f), $label, $type, $now, $l['id']]);
                $last["$k:$id"]['fields'] = implode(',', $f);
                continue;
            }
            $hid = 'h_' . bin2hex(random_bytes(8));
            Db::q('INSERT INTO history (id, space_id, kind, entity_id, board_id, user_id, act, fields, type, label, n, prev, started_at, at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,1,?,?,?)', [
                $hid, $spaceId, $k, $id, $board, $uid, $act, self::fieldList($fields), $type, $label,
                $old === null ? null : json_encode($old, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $now, $now,
            ]);
            $last["$k:$id"] = ['id' => $hid, 'board_id' => $board, 'user_id' => $uid, 'act' => $act, 'fields' => implode(',', $fields), 'started_at' => $now];
        }
    }

    private static function fieldList(array $f): string
    {
        $s = implode(',', $f);
        return strlen($s) > 400 ? substr($s, 0, strrpos(substr($s, 0, 400), ',') ?: 400) : $s;
    }

    /** A short text for a card or board: its title or the start of its text. */
    public static function label(string $kind, array $d): string
    {
        if ($kind === 'board') return mb_substr(trim((string) ($d['title'] ?? '')), 0, 120);
        $x = is_array($d['data'] ?? null) ? $d['data'] : [];
        $str = fn($k) => is_string($x[$k] ?? null) ? $x[$k] : '';
        $t = match ($d['type'] ?? '') {
            'note', 'text', 'image' => Text::plain($str($d['type'] === 'image' ? 'caption' : 'html')),
            'todo' => $str('title') ?: implode(', ', array_map(fn($t) => is_array($t) ? (string) ($t['t'] ?? '') : '', array_slice((array) ($x['tasks'] ?? []), 0, 3))),
            'link' => $str('title') ?: $str('url'),
            'file' => $str('name'),
            'column', 'board' => $str('title'),
            'doc' => $str('title') ?: Text::plain($str('html')),
            'table' => implode(' · ', array_map('strval', array_slice((array) (((array) ($x['rows'] ?? []))[0] ?? []), 0, 4))),
            'swatch' => $str('hex'),
            'icon' => $str('label'),
            'group' => $str('title'),
            default => '',
        };
        $t = trim(preg_replace('/\s+/u', ' ', $t) ?? '');
        return mb_strlen($t) > 120 ? mb_substr($t, 0, 119) . '…' : $t;
    }

    /**
     * The activity on a board, newest first: changes to its cards and to the board itself, and comments on its cards.
     * $before: page back from this time (ms).
     */
    public static function feed(array $u, string $spaceId, string $board, int $before): array
    {
        $space = Access::space($spaceId);
        Access::need($u['id'], $space, $board, 'viewer');
        $before = $before > 0 ? $before : PHP_INT_MAX;
        $rows = Db::q('SELECT id, kind, entity_id, user_id, act, fields, type, label, n, started_at, at FROM history
                       WHERE space_id = ? AND board_id = ? AND at < ? ORDER BY at DESC LIMIT ' . (self::PAGE + 1), [$spaceId, $board, $before])->fetchAll();
        $out = []; $ids = [];
        foreach ($rows as $r) {
            $out[] = ['id' => $r['id'], 'k' => $r['kind'], 'item' => $r['entity_id'], 'by' => $r['user_id'], 'act' => $r['act'],
                      'f' => array_values(array_filter(explode(',', $r['fields']))), 'type' => $r['type'], 'label' => $r['label'],
                      'n' => (int) $r['n'], 'start' => (int) $r['started_at'], 'at' => (int) $r['at']];
            if ($r['user_id']) $ids[$r['user_id']] = true;
        }
        $cm = Db::q("SELECT c.id, c.item_id, c.author_id, c.author_name, c.anon, c.body, c.created_at FROM comments c
                     JOIN entities e ON e.space_id = c.space_id AND e.kind = 'item' AND e.id = c.item_id AND e.deleted = 0 AND e.parent = ?
                     WHERE c.space_id = ? AND c.deleted = 0 AND c.created_at < ? ORDER BY c.created_at DESC LIMIT " . (self::PAGE + 1),
            [$board, $spaceId, $before])->fetchAll();
        foreach ($cm as $c) {
            $out[] = ['id' => $c['id'], 'k' => 'comment', 'item' => $c['item_id'], 'by' => $c['author_id'], 'name' => $c['author_name'],
                      'guest' => $c['anon'] !== null, 'act' => 'comment', 'label' => Comments::plain($c['body']), 'at' => (int) $c['created_at']];
            if ($c['author_id']) $ids[$c['author_id']] = true;
        }
        usort($out, fn($a, $b) => $b['at'] <=> $a['at']);
        $more = count($out) > self::PAGE;
        $out = array_slice($out, 0, self::PAGE);
        $names = [];
        foreach (Access::names(array_keys($ids)) as $id => $p) $names[$id] = $p['name'];
        return ['entries' => $out, 'names' => (object) $names, 'more' => $more];
    }

    /** Where a card is (or was last), and the person's role there; fails unless they can see it. */
    private static function itemBoard(array $u, array $space, string $item): string
    {
        $e = Db::one("SELECT parent, deleted FROM entities WHERE space_id = ? AND kind = 'item' AND id = ?", [$space['id'], $item]);
        $board = $e && !$e['deleted'] ? $e['parent']
            : (Db::one('SELECT board_id FROM history WHERE space_id = ? AND entity_id = ? AND kind = ? ORDER BY at DESC LIMIT 1', [$space['id'], $item, 'item'])['board_id'] ?? null);
        if ($board === null) Http::fail(404, 'Card not found');
        Access::need($u['id'], $space, (string) $board, 'viewer');
        return (string) $board;
    }

    /**
     * A card's versions, newest first. Each is the card as it was after a row's changes: "ref" says where that state is
     * stored (the next row's "prev"), "current" for the card as it is now, or null after a deletion.
     */
    public static function versions(array $u, string $spaceId, string $item): array
    {
        $space = Access::space($spaceId);
        self::itemBoard($u, $space, $item);
        $rows = Db::q("SELECT id, user_id, act, fields, n, started_at, at, CASE WHEN prev IS NULL THEN 0 ELSE 1 END AS has_prev FROM history
                       WHERE space_id = ? AND kind = 'item' AND entity_id = ? ORDER BY at, started_at", [$spaceId, $item])->fetchAll();
        $out = []; $ids = [];
        if ($rows && $rows[0]['has_prev']) $out[] = ['ref' => $rows[0]['id'], 'act' => 'earlier', 'by' => null, 'at' => null];
        foreach ($rows as $i => $r) {
            $next = $rows[$i + 1] ?? null;
            $ref = $r['act'] === 'delete' ? null : ($next ? ($next['has_prev'] ? $next['id'] : null) : 'current');
            $out[] = ['ref' => $ref, 'act' => $r['act'], 'by' => $r['user_id'], 'f' => array_values(array_filter(explode(',', $r['fields']))),
                      'n' => (int) $r['n'], 'start' => (int) $r['started_at'], 'at' => (int) $r['at']];
            if ($r['user_id']) $ids[$r['user_id']] = true;
        }
        $names = [];
        foreach (Access::names(array_keys($ids)) as $id => $p) $names[$id] = $p['name'];
        return ['versions' => array_reverse($out), 'names' => (object) $names];
    }

    /** The card as it was before a history row. */
    public static function data(array $u, string $spaceId, string $ref): array
    {
        $space = Access::space($spaceId);
        $r = Db::one("SELECT entity_id, prev FROM history WHERE id = ? AND space_id = ? AND kind = 'item'", [$ref, $spaceId]);
        if (!$r || $r['prev'] === null) Http::fail(404, 'That version isn’t kept any more');
        self::itemBoard($u, $space, $r['entity_id']);
        return ['item' => json_decode($r['prev'], true)];
    }

    /** Rows older than 90 days. */
    public static function prune(): int
    {
        return Db::q('DELETE FROM history WHERE at < ?', [(time() - self::KEEP_DAYS * 86400) * 1000])->rowCount();
    }
}
