<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Spaces: each person's own boards (personal space, id = their user id) and team workspaces (id "w_…").
 * Also the server-side operations that move or remove whole groups of records.
 */
final class Spaces
{
    public const WS_ROLES = ['owner', 'admin', 'member', 'guest'];
    private const TRASH_DAYS = 30;

    /** The person's own space, created on first use. */
    public static function personal(string $uid): array
    {
        $s = Db::one('SELECT * FROM spaces WHERE id = ?', [$uid]);
        if ($s) return $s;
        $u = Db::one('SELECT name FROM users WHERE id = ?', [$uid]) ?? Http::fail(404, 'Not found');
        try {
            Db::q('INSERT INTO spaces (id, kind, name, owner_id, rev, acl_rev, created_at) VALUES (?,?,?,?,0,0,?)', [$uid, 'personal', $u['name'], $uid, time()]);
        } catch (\PDOException) {}   // created by a parallel request
        return Db::one('SELECT * FROM spaces WHERE id = ?', [$uid]);
    }

    /** Everywhere the person can go: own boards, workspaces, boards shared with them, and invitations waiting for them. */
    public static function contexts(array $u): array
    {
        $uid = $u['id'];
        $own = self::personal($uid);
        $workspaces = [];
        foreach (Db::q("SELECT s.id, s.name, m.role FROM space_members m JOIN spaces s ON s.id = m.space_id
                        WHERE m.user_id = ? AND m.left_at IS NULL AND s.deleted_at IS NULL AND m.role <> 'guest' ORDER BY s.name", [$uid]) as $r) {
            $n = (int) Db::one("SELECT COUNT(*) AS n FROM space_members WHERE space_id = ? AND left_at IS NULL AND role <> 'guest'", [$r['id']])['n'];
            $workspaces[] = ['id' => $r['id'], 'name' => $r['name'], 'role' => $r['role'], 'members' => $n];
        }
        $shared = [];
        $spaceIds = array_column(Db::q('SELECT DISTINCT space_id FROM board_members WHERE user_id = ? AND left_at IS NULL', [$uid])->fetchAll(), 'space_id');
        foreach ($spaceIds as $sid) {
            $s = Db::one('SELECT * FROM spaces WHERE id = ? AND deleted_at IS NULL', [$sid]);
            if (!$s || Access::blanket(Access::spaceRole($uid, $s)) !== null) continue;
            $boards = Access::boards($uid, $s);
            $roots = Access::roots($boards, $sid);
            if (!$roots) continue;
            $titles = self::titles($sid, $roots);
            $from = $s['kind'] === 'personal' ? (Db::one('SELECT name FROM users WHERE id = ?', [$s['owner_id']])['name'] ?? 'Someone') : $s['name'];
            foreach ($roots as $b) $shared[] = ['space' => $sid, 'board' => $b, 'title' => $titles[$b] ?? 'Untitled board',
                                                'role' => $boards[$b], 'from' => $from, 'kind' => $s['kind']];
        }
        usort($shared, fn($a, $b) => strcasecmp($a['title'], $b['title']));
        return ['personal' => ['id' => $own['id'], 'name' => 'My boards'], 'workspaces' => $workspaces, 'shared' => $shared,
                'invites' => Invites::pendingFor($u)];
    }

    /** Board titles: id => title. */
    public static function titles(string $spaceId, array $ids): array
    {
        $out = [];
        foreach (array_chunk(array_values(array_unique($ids)), 500) as $chunk) {
            if (!$chunk) continue;
            $in = implode(',', array_fill(0, count($chunk), '?'));
            foreach (Db::q("SELECT id, data FROM entities WHERE space_id = ? AND kind = 'board' AND deleted = 0 AND id IN ($in)", array_merge([$spaceId], $chunk)) as $r) {
                $out[$r['id']] = json_decode((string) $r['data'], true)['title'] ?? 'Untitled board';
            }
        }
        return $out;
    }

    /* ---------- workspaces ---------- */

    public static function create(array $u, array $in): array
    {
        $name = Http::str($in, 'name', 120);
        if ($name === '') Http::fail(422, 'Give the workspace a name');
        RateLimit::hit('ws-create:' . $u['id'], 30, 3600);
        $id = 'w_' . bin2hex(random_bytes(8));
        Db::tx(function () use ($u, $id, $name) {
            Db::q('INSERT INTO spaces (id, kind, name, owner_id, rev, acl_rev, created_at) VALUES (?,?,?,?,0,0,?)', [$id, 'workspace', $name, $u['id'], time()]);
            Db::q('INSERT INTO space_members (space_id, user_id, role, created_at) VALUES (?,?,?,?)', [$id, $u['id'], 'owner', time()]);
            Sync::put($id, Sync::bump($id), 'board', 'home', ['id' => 'home', 'title' => $name, 'parent' => null], null, $u['id'], false);
        });
        return ['id' => $id, 'name' => $name, 'role' => 'owner', 'members' => 1];
    }

    /** A workspace the person belongs to (any role), with their role. */
    private static function ws(array $u, string $id, bool $allowDeleted = false): array
    {
        if (!preg_match('/^w_[a-f0-9]{16}$/', $id)) Http::fail(404, 'Workspace not found');
        $s = Db::one("SELECT * FROM spaces WHERE id = ? AND kind = 'workspace'", [$id]);
        if (!$s || (!$allowDeleted && $s['deleted_at'] !== null)) Http::fail(404, 'Workspace not found');
        $s['me'] = $s['deleted_at'] === null ? Access::spaceRole($u['id'], $s) : ($s['owner_id'] === $u['id'] ? 'owner' : null);
        if ($s['me'] === null) Http::fail(404, 'Workspace not found');
        return $s;
    }

    private static function manage(array $s): void
    {
        if (!in_array($s['me'], ['owner', 'admin'], true)) Http::fail(403, 'Only the workspace owner and admins can do that');
    }

    public static function info(array $u, string $id): array
    {
        $s = self::ws($u, $id);
        $manage = in_array($s['me'], ['owner', 'admin'], true);
        $members = []; $former = [];
        foreach (Db::q('SELECT m.user_id, m.role, m.created_at, m.left_at, u.name, u.email FROM space_members m JOIN users u ON u.id = m.user_id
                        WHERE m.space_id = ? ORDER BY u.name', [$id]) as $r) {
            $p = ['id' => $r['user_id'], 'name' => $r['name'], 'email' => $manage ? $r['email'] : null, 'role' => $r['role']];
            if ($r['left_at'] === null) $members[] = $p + ['since' => (int) $r['created_at']];
            elseif ($manage) $former[] = $p + ['left' => (int) $r['left_at'], 'cards' => self::cardCount($id, $r['user_id'], null)];
        }
        $order = array_flip(self::WS_ROLES);
        usort($members, fn($a, $b) => [$order[$a['role']], strtolower($a['name'])] <=> [$order[$b['role']], strtolower($b['name'])]);
        return ['id' => $id, 'name' => $s['name'], 'role' => $s['me'], 'canManage' => $manage, 'members' => $members,
                'former' => $former, 'invites' => $manage ? Invites::listFor($id, null) : [], 'mail' => Mailer::configured()];
    }

    public static function rename(array $u, string $id, array $in): array
    {
        $s = self::ws($u, $id);
        self::manage($s);
        $name = Http::str($in, 'name', 120);
        if ($name === '') Http::fail(422, 'Give the workspace a name');
        Db::q('UPDATE spaces SET name = ? WHERE id = ?', [$name, $id]);
        Access::changed($id);
        return self::info($u, $id);
    }

    public static function setRole(array $u, string $id, string $target, array $in): array
    {
        $s = self::ws($u, $id);
        self::manage($s);
        $role = (string) ($in['role'] ?? '');
        if (!in_array($role, self::WS_ROLES, true)) Http::fail(422, 'Pick a role');
        $m = Db::one('SELECT role FROM space_members WHERE space_id = ? AND user_id = ? AND left_at IS NULL', [$id, $target]) ?? Http::fail(404, 'Not a member');
        if ($m['role'] === 'owner') Http::fail(403, 'The owner’s role can only change by transferring ownership');
        $ownerOnly = $role === 'owner' || $role === 'admin' || $m['role'] === 'admin';
        if ($ownerOnly && $s['me'] !== 'owner') Http::fail(403, 'Only the workspace owner can do that');
        Db::tx(function () use ($id, $target, $role, $u, $m, $s) {
            if ($role === 'owner') {   // transfer ownership; the previous owner stays on as an admin
                Db::q("UPDATE space_members SET role = 'admin' WHERE space_id = ? AND user_id = ?", [$id, $u['id']]);
                Db::q('UPDATE spaces SET owner_id = ? WHERE id = ?', [$target, $id]);
            }
            Db::q('UPDATE space_members SET role = ? WHERE space_id = ? AND user_id = ?', [$role, $id, $target]);
            Access::changed($id);
            if ($role !== $m['role']) Notify::add($target, 'role', ['space' => $id, 'actor' => $u['id'],
                'text' => ($role === 'owner' ? 'made you the owner of' : 'made you ' . Invites::roleName($role) . ' of') . " the workspace “{$s['name']}”"]);
        });
        return self::info($u, $id);
    }

    /** Remove someone; $cards = 'keep' leaves what they made, 'delete' moves their cards to the trash. */
    public static function removeMember(array $u, string $id, string $target, string $cards): array
    {
        $s = self::ws($u, $id);
        self::manage($s);
        $m = Db::one('SELECT role FROM space_members WHERE space_id = ? AND user_id = ? AND left_at IS NULL', [$id, $target]) ?? Http::fail(404, 'Not a member');
        if ($m['role'] === 'owner') Http::fail(403, 'The owner can’t be removed');
        if ($m['role'] === 'admin' && $s['me'] !== 'owner') Http::fail(403, 'Only the workspace owner can remove an admin');
        Db::tx(function () use ($id, $target, $cards, $u) {
            self::depart($id, $target);
            if ($cards === 'delete') self::deleteCardsBy($id, $target, null, $u);
        });
        return self::info($u, $id);
    }

    public static function leave(array $u, string $id): array
    {
        $s = self::ws($u, $id);
        if ($s['me'] === 'owner') Http::fail(409, 'Transfer ownership to someone else before leaving');
        Db::tx(fn() => self::depart($id, $u['id']));
        return ['ok' => true];
    }

    /** Someone stops being a member (their cards stay); their board shares in the workspace end too. */
    private static function depart(string $id, string $uid): void
    {
        Db::q('UPDATE space_members SET left_at = ? WHERE space_id = ? AND user_id = ?', [time(), $id, $uid]);
        Db::q('UPDATE board_members SET left_at = ? WHERE space_id = ? AND user_id = ? AND left_at IS NULL', [time(), $id, $uid]);
        Access::changed($id);
    }

    public static function deleteFormerCards(array $u, string $id, string $target): array
    {
        $s = self::ws($u, $id);
        self::manage($s);
        Db::one('SELECT user_id FROM space_members WHERE space_id = ? AND user_id = ? AND left_at IS NOT NULL', [$id, $target]) ?? Http::fail(404, 'Not a former member');
        Db::tx(fn() => self::deleteCardsBy($id, $target, null, $u));
        return self::info($u, $id);
    }

    public static function dismissFormer(array $u, string $id, string $target): array
    {
        $s = self::ws($u, $id);
        self::manage($s);
        Db::q('DELETE FROM space_members WHERE space_id = ? AND user_id = ? AND left_at IS NOT NULL', [$id, $target]);
        return self::info($u, $id);
    }

    /** Owner only, after typing the name. The workspace waits in the owner's trash for 30 days. */
    public static function delete(array $u, string $id, array $in): array
    {
        $s = self::ws($u, $id);
        if ($s['me'] !== 'owner') Http::fail(403, 'Only the workspace owner can delete it');
        if (trim((string) ($in['name'] ?? '')) !== $s['name']) Http::fail(422, 'Type the workspace’s name to confirm');
        Db::tx(function () use ($u, $id, $s) {
            Db::q('UPDATE spaces SET deleted_at = ? WHERE id = ?', [time(), $id]);
            $own = self::personal($u['id'])['id'];
            $t = ['id' => 'ws-' . $id, 'at' => (int) (microtime(true) * 1000), 'from' => 'home', 'type' => 'workspace', 'space' => $id,
                  'label' => 'Workspace “' . $s['name'] . '”', 'items' => [], 'boards' => [], 'lines' => [],
                  'by' => ['id' => $u['id'], 'name' => $u['name']], 'purgeAt' => (time() + self::TRASH_DAYS * 86400) * 1000];
            $exists = (bool) Db::one("SELECT id FROM entities WHERE space_id = ? AND kind = 'trash' AND id = ?", [$own, $t['id']]);
            Sync::put($own, Sync::bump($own), 'trash', $t['id'], $t, null, $u['id'], $exists);
            Access::changed($id);
        });
        return ['ok' => true];
    }

    public static function restore(array $u, string $id): array
    {
        $s = self::ws($u, $id, true);
        if ($s['me'] !== 'owner' || $s['deleted_at'] === null) Http::fail(404, 'Workspace not found');
        Db::tx(function () use ($u, $id) {
            Db::q('UPDATE spaces SET deleted_at = NULL WHERE id = ?', [$id]);
            self::dropTrashEntry($u['id'], $id);
            Access::changed($id);
        });
        return ['id' => $id, 'name' => $s['name']];
    }

    /** Delete a workspace in the trash for good (owner only), or one whose 30 days are up (from the cleanup command). */
    public static function purge(?array $u, string $id): array
    {
        $s = $u ? self::ws($u, $id, true) : Db::one('SELECT * FROM spaces WHERE id = ?', [$id]);
        if (!$s || $s['deleted_at'] === null || ($u && $s['me'] !== 'owner')) Http::fail(404, 'Workspace not found');
        Db::tx(function () use ($s, $id) {
            foreach (['entities', 'space_members', 'board_members', 'board_access', 'invites', 'shares', 'history'] as $t) Db::q("DELETE FROM $t WHERE space_id = ?", [$id]);
            Db::q('DELETE FROM spaces WHERE id = ?', [$id]);
            self::dropTrashEntry($s['owner_id'], $id);
        });
        return ['ok' => true];
    }

    private static function dropTrashEntry(string $ownerId, string $wsId): void
    {
        $own = self::personal($ownerId)['id'];
        if (Db::one("SELECT id FROM entities WHERE space_id = ? AND kind = 'trash' AND id = ? AND deleted = 0", [$own, 'ws-' . $wsId])) {
            Sync::put($own, Sync::bump($own), 'trash', 'ws-' . $wsId, null, null, $ownerId, true);
        }
    }

    /** Workspaces deleted more than 30 days ago, for the cleanup command. */
    public static function purgeExpired(): int
    {
        $n = 0;
        foreach (Db::q("SELECT id FROM spaces WHERE kind = 'workspace' AND deleted_at IS NOT NULL AND deleted_at < ?", [time() - self::TRASH_DAYS * 86400])->fetchAll() as $r) {
            self::purge(null, $r['id']); $n++;
        }
        return $n;
    }

    /* ---------- bulk operations ---------- */

    /** Cards someone made (not board cards), optionally only on some boards. */
    public static function cardCount(string $spaceId, string $uid, ?array $boards): int
    {
        $n = 0;
        foreach (Db::q("SELECT parent, data FROM entities WHERE space_id = ? AND created_by = ? AND kind = 'item' AND deleted = 0", [$spaceId, $uid]) as $r) {
            if ($boards !== null && !in_array($r['parent'], $boards, true)) continue;
            if ((json_decode((string) $r['data'], true)['type'] ?? '') !== 'board') $n++;
        }
        return $n;
    }

    /**
     * Move the cards someone made to the trash of the boards they were on (so they can be restored).
     * Board cards stay (they hold other people's work); cards left in a deleted column are placed where the column was.
     */
    public static function deleteCardsBy(string $spaceId, string $uid, ?array $boards, array $actor): int
    {
        $items = [];
        foreach (Db::q("SELECT id, parent, data FROM entities WHERE space_id = ? AND created_by = ? AND kind = 'item' AND deleted = 0", [$spaceId, $uid]) as $r) {
            if ($boards !== null && !in_array($r['parent'], $boards, true)) continue;
            $d = json_decode((string) $r['data'], true);
            if (!is_array($d) || ($d['type'] ?? '') === 'board') continue;
            $items[$r['id']] = $d;
        }
        if (!$items) return 0;
        $byBoard = [];
        foreach ($items as $id => $d) $byBoard[(string) ($d['board'] ?? '')][$id] = $d;
        $name = Db::one('SELECT name FROM users WHERE id = ?', [$uid])['name'] ?? 'a former member';
        $rev = Sync::bump($spaceId);
        foreach ($byBoard as $board => $its) {
            $lines = []; $orphans = [];
            foreach (Db::q("SELECT kind, id, data FROM entities WHERE space_id = ? AND parent = ? AND kind IN ('item','line') AND deleted = 0", [$spaceId, $board]) as $r) {
                $d = json_decode((string) $r['data'], true);
                if (!is_array($d)) continue;
                if ($r['kind'] === 'line' && (isset($its[$d['a']['item'] ?? '']) || isset($its[$d['b']['item'] ?? '']))) $lines[$r['id']] = $d;
                if ($r['kind'] === 'item' && !isset($its[$r['id']]) && isset($its[$d['col'] ?? ''])) $orphans[$r['id']] = $d;
            }
            foreach ($orphans as $id => $d) {
                $col = $its[$d['col']];
                $d['col'] = null; $d['x'] = (int) ($col['x'] ?? 0); $d['y'] = (int) ($col['y'] ?? 0) + 60 * (int) ($d['order'] ?? 0);
                Sync::put($spaceId, $rev, 'item', $id, $d, $board, $actor['id'], true);
            }
            $n = count($its);
            $t = ['id' => 'tr' . bin2hex(random_bytes(5)), 'at' => (int) (microtime(true) * 1000), 'from' => $board,
                  'label' => $n . ' card' . ($n === 1 ? '' : 's') . ' by ' . $name, 'items' => array_values($its), 'boards' => [],
                  'lines' => array_values($lines), 'by' => ['id' => $actor['id'], 'name' => $actor['name']]];
            Sync::put($spaceId, $rev, 'trash', $t['id'], $t, null, $actor['id'], false);
            foreach ($lines as $id => $_) Sync::put($spaceId, $rev, 'line', $id, null, $board, $actor['id'], true);
            foreach ($its as $id => $_) Sync::put($spaceId, $rev, 'item', $id, null, $board, $actor['id'], true);
        }
        return count($items);
    }

    /**
     * Move a board, everything inside it, and the people it's shared with to another space (a workspace, or a new owner's
     * own boards). The board's card moves with it, onto $toParent.
     */
    public static function moveBoard(array $u, string $fromId, string $board, string $toId, string $toParent): void
    {
        if ($board === 'home') Http::fail(422, 'The top board can’t be moved');
        if ($fromId === $toId) Http::fail(422, 'The board is already there');
        $sub = Access::subtree($fromId, $board);
        $parent = Access::tree($fromId)[$board] ?? null;
        $rows = [];
        foreach (array_chunk($sub, 400) as $chunk) {
            $in = implode(',', array_fill(0, count($chunk), '?'));
            foreach (Db::q("SELECT kind, id, parent, data, created_by FROM entities WHERE space_id = ? AND deleted = 0
                            AND ((kind = 'board' AND id IN ($in)) OR (kind IN ('item','line') AND parent IN ($in)))",
                         array_merge([$fromId], $chunk, $chunk)) as $r) $rows["{$r['kind']}:{$r['id']}"] = $r;
        }
        // the card that opens the board
        if ($parent !== null) foreach (Db::q("SELECT kind, id, parent, data, created_by FROM entities WHERE space_id = ? AND kind = 'item' AND parent = ? AND deleted = 0", [$fromId, $parent]) as $r) {
            $d = json_decode((string) $r['data'], true);
            if (($d['type'] ?? '') === 'board' && ($d['data']['target'] ?? '') === $board) $rows["item:{$r['id']}"] = $r;
        }
        $taken = [];
        foreach (array_chunk(array_keys($rows), 400) as $chunk) {
            $ids = array_map(fn($k) => explode(':', $k, 2)[1], $chunk);
            $in = implode(',', array_fill(0, count($ids), '?'));
            foreach (Db::q("SELECT kind, id, deleted FROM entities WHERE space_id = ? AND id IN ($in)", array_merge([$toId], $ids)) as $r) {
                if (isset($rows["{$r['kind']}:{$r['id']}"])) {
                    if (!$r['deleted']) Http::fail(409, 'Something with the same id already exists there. Copy the board instead.');
                    $taken["{$r['kind']}:{$r['id']}"] = true;
                }
            }
        }
        // place the board card below what's already on the destination board
        $maxY = 40; $maxZ = 0;
        foreach (Db::q("SELECT data FROM entities WHERE space_id = ? AND kind = 'item' AND parent = ? AND deleted = 0", [$toId, $toParent]) as $r) {
            $d = json_decode((string) $r['data'], true);
            if (!empty($d['col'])) continue;
            $maxY = max($maxY, (int) ($d['y'] ?? 0) + (int) ($d['h'] ?? 200) + 40); $maxZ = max($maxZ, (int) ($d['z'] ?? 0));
        }
        $revFrom = Sync::bump($fromId); $revTo = Sync::bump($toId);
        $cardFound = false;
        foreach ($rows as $key => $r) {
            $d = json_decode((string) $r['data'], true);
            $p = $r['parent'];
            if ($r['kind'] === 'board' && $r['id'] === $board) { $d['parent'] = $toParent; $p = $toParent; }
            if ($r['kind'] === 'item' && ($d['type'] ?? '') === 'board' && ($d['data']['target'] ?? '') === $board) {
                $d['board'] = $toParent; $d['col'] = null; $d['x'] = 40; $d['y'] = $maxY; $d['z'] = $maxZ + 1; $p = $toParent; $cardFound = true;
            }
            Sync::put($toId, $revTo, $r['kind'], $r['id'], $d, $p, $u['id'], isset($taken[$key]));
            Db::q('UPDATE entities SET created_by = ? WHERE space_id = ? AND kind = ? AND id = ?', [$r['created_by'], $toId, $r['kind'], $r['id']]);
            Sync::put($fromId, $revFrom, $r['kind'], $r['id'], null, $r['parent'], $u['id'], true);
        }
        if (!$cardFound) {   // a board without a card (shouldn't happen): give it one so it can be opened
            $title = Spaces::titles($toId, [$board])[$board] ?? 'Board';
            $card = ['id' => 'mv' . bin2hex(random_bytes(5)), 'board' => $toParent, 'type' => 'board', 'x' => 40, 'y' => $maxY, 'w' => 150,
                     'z' => $maxZ + 1, 'col' => null, 'order' => 0, 'color' => null, 'data' => ['target' => $board, 'title' => $title]];
            Sync::put($toId, $revTo, 'item', $card['id'], $card, $toParent, $u['id'], false);
        }
        foreach (array_chunk($sub, 400) as $chunk) {
            $in = implode(',', array_fill(0, count($chunk), '?'));
            foreach (['board_members', 'board_access', 'shares', 'invites'] as $t) {
                Db::q("UPDATE $t SET space_id = ? WHERE space_id = ? AND board_id IN ($in)", array_merge([$toId, $fromId], $chunk));
            }
        }
        Access::changed($fromId); Access::changed($toId);
    }
}
