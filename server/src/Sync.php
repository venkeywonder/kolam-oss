<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Change-based sync, per space. Every board, card, line and trash entry is stored as its own row.
 * Each push bumps the space's revision counter; clients pull rows changed since the revision they last saw.
 * Pulls only return what the person can see, and every pushed change is checked against their role on the board it touches.
 */
final class Sync
{
    public const KINDS = ['board', 'item', 'line', 'trash', 'view'];

    public static function pull(array $u, string $spaceId, int $since, int $acl = -1, string $y = ''): array
    {
        $space = Access::space($spaceId);
        $boards = Access::boards($u['id'], $space);
        $blanket = Access::blanket(Access::spaceRole($u['id'], $space));
        $partial = $blanket === null;
        $rev = (int) $space['rev']; $aclRev = (int) $space['acl_rev'];
        $full = $since <= 0 || $since > $rev || ($partial && $acl !== $aclRev);
        $rows = $full
            ? Db::q("SELECT kind, id, parent, data, deleted FROM entities WHERE space_id = ? AND deleted = 0 AND kind <> 'view'", [$spaceId])
            : Db::q("SELECT kind, id, parent, data, deleted FROM entities WHERE space_id = ? AND rev > ? AND kind <> 'view'", [$spaceId, $since]);
        $changes = [];
        foreach ($rows as $r) {
            if ($r['deleted']) { $changes[] = ['k' => $r['kind'], 'id' => $r['id'], 'del' => 1]; continue; }
            $d = json_decode((string) $r['data'], true);
            $seen = $r['kind'] === 'trash' && $blanket === 'owner' ? is_array($d) : self::visible($boards, $r['kind'], $r['id'], $r['parent'], $d);
            if ($seen) $changes[] = ['k' => $r['kind'], 'id' => $r['id'], 'd' => self::out($d)];
            elseif (!$full) $changes[] = ['k' => $r['kind'], 'id' => $r['id'], 'del' => 1];   // moved somewhere this person can't see
        }
        $out = ['rev' => $rev, 'full' => $full, 'acl' => $aclRev, 'changes' => $changes];
        if ($full || $acl !== $aclRev) $out['access'] = self::accessInfo($u, $space, $boards);
        if ($y !== '') $out['y'] = (object) YText::since($spaceId, $y, $boards);   // read after the cards, so never older than them
        $c = Comments::since($spaceId, $since, $full, $boards);
        if ($c['comments'] || (array) $c['threads']) $out += $c;
        return $out;
    }

    private static function visible(array $boards, string $kind, string $id, ?string $parent, mixed $d): bool
    {
        return match ($kind) {
            'board' => isset($boards[$id]),
            'item', 'line' => $parent !== null && isset($boards[$parent]),
            'trash' => is_array($d) && Access::atLeast($boards[(string) ($d['from'] ?? '')] ?? null, 'editor'),
            default => false,
        };
    }

    /** What the browser needs to know about access: roles per board, where access starts, and who sees what. */
    public static function accessInfo(array $u, array $space, array $boards): array
    {
        $spaceRole = Access::spaceRole($u['id'], $space);
        $info = [
            'space' => ['id' => $space['id'], 'kind' => $space['kind'], 'name' => $space['name']],
            'spaceRole' => $spaceRole,
            'boards' => (object) $boards,
            'roots' => Access::roots($boards, $space['id']),
            'aud' => new \stdClass(),
            'people' => new \stdClass(),
        ];
        // only people who can move things need the audience of each board (to warn before moving cards between audiences)
        if (array_filter($boards, fn($r) => Access::atLeast($r, 'editor'))) {
            $aud = array_intersect_key(Access::audience($space), $boards);
            $ids = [];
            foreach ($aud as $list) foreach ($list as $id) $ids[$id] = true;
            $info['aud'] = (object) $aud;
            $info['people'] = (object) array_map(fn($p) => $p['name'], Access::names(array_keys($ids)));
        }
        return $info;
    }

    public static function push(array $u, string $spaceId, array $in): array
    {
        $ops = $in['ops'] ?? null;
        if (!is_array($ops) || count($ops) > 5000) Http::fail(400, 'Invalid ops');
        foreach ($ops as $op) {
            $k = $op['k'] ?? ''; $id = $op['id'] ?? '';
            if (!in_array($k, self::KINDS, true) || !is_string($id) || !preg_match('/^[\w.-]{1,64}$/', $id)) Http::fail(400, 'Invalid op');
        }
        $y = is_array($in['y'] ?? null) ? $in['y'] : [];
        // boards first, so cards can land on a board created in the same push
        usort($ops, fn($a, $b) => ($a['k'] !== 'board') <=> ($b['k'] !== 'board'));
        $dropped = [];   // files of trash entries deleted for good in this push: freed once it's committed
        $out = Db::tx(function () use ($u, $spaceId, $ops, $y, &$dropped) {
            $space = Access::space($spaceId);
            Db::q('UPDATE spaces SET rev = rev + 1 WHERE id = ?', [$spaceId]);   // also serialises pushes to this space
            $rev = (int) Db::one('SELECT rev FROM spaces WHERE id = ?', [$spaceId])['rev'];
            Access::forget($spaceId);
            $vis = Access::boards($u['id'], $space);
            if (!$vis) Http::fail(404, 'Not found');
            $owner = Access::blanket(Access::spaceRole($u['id'], $space)) === 'owner';
            $old = self::existing($spaceId, $ops);
            $tree = Access::tree($spaceId);
            $now = time();
            $fixed = [];
            $legacy = [];      // replies written into comment cards the old way: item id => thread
            $arrived = [];     // cards that are new here (created, back from the trash, moved boards): their comments go out again
            $hist = [];        // changes to cards and boards, for the history
            $aclChanged = false;
            $boardsDone = false;
            $vis0 = $vis;
            foreach ($ops as $op) {
                $k = $op['k']; $id = $op['id'];
                if ($k !== 'board' && !$boardsDone) {
                    $boardsDone = true;
                    if ($aclChanged) { Access::forget($spaceId); $vis = Access::boards($u['id'], $space) + $vis; }
                }
                $del = !empty($op['del']);
                $d = $del ? null : (is_array($op['d'] ?? null) ? $op['d'] : Http::fail(400, 'Invalid op'));
                $o = $old["$k:$id"] ?? null;
                if ($o && $o['deleted']) $o = null;
                if ($del && !$o) continue;   // already gone
                $od = $o ? json_decode((string) $o['data'], true) : null;
                // an edit of something deleted meanwhile: the deletion wins
                if (!$del && !$o && isset($op['f'], $old["$k:$id"])) { $fixed[] = ['k' => $k, 'id' => $id, 'd' => null]; continue; }
                $sent = $d;
                // only the fields this browser changed: whatever else changed on the server meanwhile stays
                if (!$del && $o && is_array($op['f'] ?? null)) $d = Merge::patch(is_array($od) ? $od : [], $d, $op['f'], is_array($op['b'] ?? null) ? $op['b'] : []);
                $parent = match ($k) {
                    'item', 'line' => is_string($d['board'] ?? null) ? $d['board'] : null,
                    'board' => is_string($d['parent'] ?? null) ? $d['parent'] : null,
                    default => null,
                };
                if ($del) $parent = $o['parent'];
                if ($k === 'item' && !$del && is_array($d['data'] ?? null) && array_key_exists('thread', $d['data'])) {
                    if (is_array($d['data']['thread']) && $parent !== null && ($owner || self::can($vis, $parent, 'commenter'))) $legacy[$id] = $d['data']['thread'];
                    unset($d['data']['thread']);
                    if ($o && is_array($od) && Merge::eq($d, $od)) { $fixed[] = ['k' => $k, 'id' => $id, 'd' => self::out($od)]; continue; }
                }
                if (!$owner) {
                    $check = match ($k) {
                        'board' => self::checkBoard($vis0, $vis, $tree, $id, $o, $d, $del),
                        'item' => self::checkItem($vis0, $vis, $o, $od, $d, $del, $u['id']),
                        'line' => self::checkLine($vis0, $vis, $o, $d, $del),
                        'trash' => self::checkTrash($vis0, $od, $d, $del),
                        'view' => 'skip',
                    };
                    if ($check === 'skip') continue;
                    if ($check !== true) Http::fail(403, $check);
                }
                if ($k === 'board' && !$del && !$o && $parent !== null) $vis[$id] ??= $vis[$parent] ?? null;
                if ($k === 'board' && ($del || ($o && $o['parent'] !== $parent))) $aclChanged = true;
                if (!$del) {
                    $d = self::stamp($k, $d, $od, $u);
                    if (!Merge::eq($d, $sent)) $fixed[] = ['k' => $k, 'id' => $id, 'd' => self::out($d)];
                    if ($k === 'item' && !isset($y[$id])) YText::plainWrites($spaceId, $id, $od, $d, $u['id']);
                }
                self::put($spaceId, $rev, $k, $id, $d, $parent, $u['id'], isset($old["$k:$id"]));
                if ($k === 'trash' && $del && is_array($od)) array_push($dropped, ...Assets::inTrashEntry($od));
                if ($k === 'item' && !$del && (!$o || $o['parent'] !== $parent)) $arrived[] = $id;
                if ($k === 'item' || $k === 'board') $hist[] = [$k, $id, $parent, is_array($od) ? $od : null, $del ? null : $d, isset($old["$k:$id"])];
            }
            foreach ($legacy as $id => $thread) Comments::importThread($spaceId, (string) $id, $thread, $u['id'], (string) ($u['name'] ?? ''), $rev);
            History::record($spaceId, $u['id'], $hist);
            if ($arrived && ($has = Comments::cards($spaceId))) {
                $arrived = array_values(array_filter($arrived, fn($i) => isset($has[$i])));
                if ($arrived) Comments::touch($spaceId, $arrived, $rev);
            }
            if ($aclChanged) Access::changed($spaceId);
            $res = ['rev' => $rev, 'fixed' => $fixed];
            if ($legacy || $arrived) $res['more'] = true;   // comments changed too: the browser pulls them
            if ($y) $res['y'] = (object) YText::exchange($u, $spaceId, $y, $vis);
            return $res;
        });
        if (!Db::pdo()->inTransaction()) {
            if ($dropped) Assets::release($dropped);
            Realtime::nudge();   // open browsers pull right away
        }
        return $out;
    }

    /** Existing rows touched by the ops: "kind:id" => row. */
    private static function existing(string $spaceId, array $ops): array
    {
        $by = [];
        foreach ($ops as $op) $by[$op['k']][] = $op['id'];
        $out = [];
        foreach ($by as $k => $ids) foreach (array_chunk(array_values(array_unique($ids)), 500) as $chunk) {
            $in = implode(',', array_fill(0, count($chunk), '?'));
            foreach (Db::q("SELECT kind, id, parent, data, deleted, created_by FROM entities WHERE space_id = ? AND kind = ? AND id IN ($in)",
                         array_merge([$spaceId, $k], $chunk)) as $r) $out["{$r['kind']}:{$r['id']}"] = $r;
        }
        return $out;
    }

    /** A record for JSON: an empty "data" stays an object ({}), not a list ([]). */
    private static function out(mixed $d): mixed
    {
        if (is_array($d) && ($d['data'] ?? null) === []) $d['data'] = new \stdClass();
        return $d;
    }

    /** Write one row. $exists: a row (live or deleted) already has this id, so keep its creator. */
    public static function put(string $spaceId, int $rev, string $k, string $id, ?array $d, ?string $parent, string $uid, bool $exists): void
    {
        $data = $d === null ? null : json_encode(self::out($d), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($data !== null && strlen($data) > 4 * 1024 * 1024) Http::fail(413, 'A card is too large');
        $del = $d === null ? 1 : 0;
        if ($exists) {
            Db::q('UPDATE entities SET parent = ?, data = ?, rev = ?, deleted = ?, updated_at = ?, updated_by = ? WHERE space_id = ? AND kind = ? AND id = ?',
                [$parent, $data, $rev, $del, time(), $uid, $spaceId, $k, $id]);
        } else {
            Db::q('INSERT INTO entities (space_id, kind, id, parent, data, rev, deleted, updated_at, created_by, updated_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
                [$spaceId, $k, $id, $parent, $data, $rev, $del, time(), $uid, $uid]);
        }
        AssetRefs::sync($spaceId, $k, $id, $d);
    }

    /** Bump a space's revision for server-side writes; returns the new revision. */
    public static function bump(string $spaceId): int
    {
        Db::q('UPDATE spaces SET rev = rev + 1 WHERE id = ?', [$spaceId]);
        return (int) Db::one('SELECT rev FROM spaces WHERE id = ?', [$spaceId])['rev'];
    }

    /* ---------- permission checks for people without full access (true, 'skip', or an error message) ---------- */

    private static function can(array $vis, ?string $board, string $need): bool
    {
        return $board !== null && Access::atLeast($vis[$board] ?? null, $need);
    }

    private static function checkBoard(array $vis0, array $vis, array $tree, string $id, ?array $o, ?array $d, bool $del): bool|string
    {
        $no = 'You can’t change this board. Ask its owner for edit access.';
        if ($id === 'home' && ($del || !$o)) return $no;
        if ($del) {
            $p = $o['parent'];
            if ($p === null || !isset($vis0[$p])) return 'Only the owner can delete a shared board.';
            return self::can($vis0, $p, 'editor') && self::can($vis0, $id, 'editor') ? true : $no;
        }
        $p = is_string($d['parent'] ?? null) ? $d['parent'] : null;
        if (!$o) return self::can($vis, $p, 'editor') ? true : $no;
        if (!self::can($vis0, $id, 'editor')) return $no;
        if ($o['parent'] !== $p) {
            if ($o['parent'] === null || !isset($vis0[$o['parent']])) return 'Only the owner can move a shared board.';
            if (!self::can($vis0, $o['parent'], 'editor') || !self::can($vis, $p, 'editor')) return $no;
        }
        return true;
    }

    private static function checkItem(array $vis0, array $vis, ?array $o, ?array $od, ?array $d, bool $del, string $uid): bool|string
    {
        $no = 'You can’t edit cards on this board. Ask its owner for edit access.';
        $from = $o['parent'] ?? null;
        if ($del) return self::can($vis0, $from, 'editor') ? true : $no;
        $to = is_string($d['board'] ?? null) ? $d['board'] : null;
        if (!$o) {
            if (self::can($vis, $to, 'editor')) return true;
            // commenters may place a comment card (its comments go through the comments API)
            return ($d['type'] ?? '') === 'comment' && self::can($vis, $to, 'commenter') ? true : $no;
        }
        if (!self::can($vis0, $from, 'editor') || !self::can($vis, $to, 'editor')) return $no;
        if (!empty($od['locked']) && empty($d['locked']) && ($od['lockedBy'] ?? null) !== $uid) {
            return 'Only the owner can unlock a card someone else locked.';
        }
        return true;
    }

    private static function checkLine(array $vis0, array $vis, ?array $o, ?array $d, bool $del): bool|string
    {
        $no = 'You can’t edit this board. Ask its owner for edit access.';
        $from = $o['parent'] ?? null;
        if ($del) return self::can($vis0, $from, 'editor') ? true : $no;
        if ($o && !self::can($vis0, $from, 'editor')) return $no;
        return self::can($vis, is_string($d['board'] ?? null) ? $d['board'] : null, 'editor') ? true : $no;
    }

    private static function checkTrash(array $vis0, ?array $od, ?array $d, bool $del): bool|string
    {
        $from = (string) (($del ? $od : $d)['from'] ?? '');
        if ($od && (string) ($od['from'] ?? '') !== $from) return 'Invalid trash entry';
        return self::can($vis0, $from, 'editor') ? true : 'You can’t change the trash of this board.';
    }

    /** Server-owned fields: who locked a card, who deleted something, a poll's votes. */
    private static function stamp(string $k, array $d, ?array $od, array $u): array
    {
        if ($k === 'item') {
            if (!empty($d['locked'])) $d['lockedBy'] = !empty($od['locked']) ? ($od['lockedBy'] ?? null) : $u['id'];
            else unset($d['lockedBy']);
            if (($d['lockedBy'] ?? 0) === null) unset($d['lockedBy']);
            // votes change only through Polls::vote; a new card (a copy, or one back from the trash) keeps what it brings
            if (($d['type'] ?? '') === 'poll' && $od !== null && is_array($d['data'] ?? null)) {
                $v = $od['data']['votes'] ?? null;
                if ($v) $d['data']['votes'] = $v; else unset($d['data']['votes']);
            }
        }
        if ($k === 'trash') {
            $d['by'] = $od['by'] ?? ['id' => $u['id'], 'name' => $u['name'] ?? ''];
        }
        return $d;
    }

    /** Write a whole legacy state object into a person's own space (used by imports). */
    public static function writeState(string $userId, array $st): void
    {
        $ops = [];
        foreach (($st['boards'] ?? []) as $id => $b) $ops[] = ['k' => 'board', 'id' => (string) $id, 'd' => $b];
        foreach (($st['items'] ?? []) as $id => $i) $ops[] = ['k' => 'item', 'id' => (string) $id, 'd' => $i];
        foreach (($st['lines'] ?? []) as $id => $l) $ops[] = ['k' => 'line', 'id' => (string) $id, 'd' => $l];
        foreach (($st['trash'] ?? []) as $t) if (isset($t['id'])) $ops[] = ['k' => 'trash', 'id' => (string) $t['id'], 'd' => $t];
        $u = Db::one('SELECT id, name FROM users WHERE id = ?', [$userId]);
        foreach (array_chunk($ops, 4000) as $chunk) self::push($u, Spaces::home($userId)['id'], ['ops' => $chunk]);
    }
}
