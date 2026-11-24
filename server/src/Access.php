<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Who can do what on which board.
 *
 * A space is a workspace: the Owner and Admins own every board, Members edit every board, Guests only see boards shared
 * with them. Every person owns at least one, their home workspace (Spaces::home).
 * - single boards can be shared with people (board_members). A grant covers the board and the boards inside it,
 *   until an inner board has its own grant for that person (which wins, higher or lower) or is "restricted"
 *   (only people added to it directly, plus the space's owners and members, can open it).
 *
 * Board roles, lowest to highest: viewer, commenter, editor, owner.
 */
final class Access
{
    public const RANK = ['viewer' => 1, 'commenter' => 2, 'editor' => 3, 'owner' => 4];
    public const BOARD_ROLES = ['editor', 'commenter', 'viewer'];
    public const SPACE_ROLES = ['owner', 'admin', 'member', 'guest'];
    public const UNSORTED = '__unsorted';

    private static array $cache = [];

    public static function forget(?string $spaceId = null): void
    {
        if ($spaceId === null) self::$cache = [];
        else foreach (array_keys(self::$cache) as $k) if (str_starts_with($k, $spaceId . '|')) unset(self::$cache[$k]);
    }

    public static function atLeast(?string $role, string $need): bool
    {
        return $role !== null && (self::RANK[$role] ?? 0) >= self::RANK[$need];
    }

    /** The space row, or a 404 when it doesn't exist or was deleted. */
    public static function space(string $id): array
    {
        if (!preg_match('/^[uw]_[a-f0-9]{16,24}$/', $id)) Http::fail(404, 'Not found');
        $s = Db::one('SELECT * FROM spaces WHERE id = ?', [$id]);
        if (!$s || $s['deleted_at'] !== null) Http::fail(404, 'Not found');
        return $s;
    }

    /** owner | admin | member | guest | null — the person's place in the space as a whole. */
    public static function spaceRole(string $uid, array $space): ?string
    {
        $r = Db::one('SELECT role FROM space_members WHERE space_id = ? AND user_id = ? AND left_at IS NULL', [$space['id'], $uid]);
        return $r['role'] ?? null;
    }

    /** Board role every board in the space gets from the space role alone (null: only shared boards). */
    public static function blanket(?string $spaceRole): ?string
    {
        return match ($spaceRole) { 'owner', 'admin' => 'owner', 'member' => 'editor', default => null };
    }

    /** Board tree of a space: id => parent. */
    public static function tree(string $spaceId): array
    {
        $k = "$spaceId|tree";
        if (isset(self::$cache[$k])) return self::$cache[$k];
        $t = [];
        foreach (Db::q("SELECT id, parent FROM entities WHERE space_id = ? AND kind = 'board' AND deleted = 0", [$spaceId]) as $r) $t[$r['id']] = $r['parent'];
        return self::$cache[$k] = $t;
    }

    public static function restricted(string $spaceId): array
    {
        $k = "$spaceId|restricted";
        if (isset(self::$cache[$k])) return self::$cache[$k];
        $out = [];
        foreach (Db::q('SELECT board_id FROM board_access WHERE space_id = ? AND restricted = 1', [$spaceId]) as $r) $out[$r['board_id']] = true;
        return self::$cache[$k] = $out;
    }

    /** Direct board grants in a space: user id => [board id => role]. */
    public static function grants(string $spaceId): array
    {
        $k = "$spaceId|grants";
        if (isset(self::$cache[$k])) return self::$cache[$k];
        $out = [];
        foreach (Db::q('SELECT user_id, board_id, role FROM board_members WHERE space_id = ? AND left_at IS NULL', [$spaceId]) as $r) {
            $out[$r['user_id']][$r['board_id']] = $r['role'];
        }
        return self::$cache[$k] = $out;
    }

    /**
     * Every board this person can open in the space: board id => role.
     * '__unsorted' (the owner's inbox) is included for the space's owner only.
     */
    public static function boards(string $uid, array $space): array
    {
        $k = "{$space['id']}|boards|$uid";
        if (isset(self::$cache[$k])) return self::$cache[$k];
        $tree = self::tree($space['id']);
        $all = self::blanket(self::spaceRole($uid, $space));
        if ($all !== null) {
            $out = array_fill_keys(array_keys($tree), $all);
            if ($space['owner_id'] === $uid) $out[self::UNSORTED] = 'owner';
            return self::$cache[$k] = $out;
        }
        return self::$cache[$k] = self::resolve($tree, self::grants($space['id'])[$uid] ?? [], self::restricted($space['id']));
    }

    /** Roles from board grants alone: nearest grant up the tree wins; a restricted board stops inheritance. */
    public static function resolve(array $tree, array $grants, array $restricted): array
    {
        if (!$grants) return [];
        $memo = [];
        $role = function (string $b, int $depth = 0) use (&$role, &$memo, $tree, $grants, $restricted): ?string {
            if (array_key_exists($b, $memo)) return $memo[$b];
            if ($depth > 100 || !array_key_exists($b, $tree)) return null;
            $r = $grants[$b] ?? (isset($restricted[$b]) || $tree[$b] === null ? null : $role($tree[$b], $depth + 1));
            return $memo[$b] = $r;
        };
        $out = [];
        foreach (array_keys($tree) as $b) if (($r = $role((string) $b)) !== null) $out[$b] = $r;
        return $out;
    }

    public static function role(string $uid, array $space, string $board): ?string
    {
        return self::boards($uid, $space)[$board] ?? null;
    }

    /** Fails unless the person has at least $need on the board. */
    public static function need(string $uid, array $space, string $board, string $need): string
    {
        $r = self::role($uid, $space, $board);
        if ($r === null) Http::fail(404, 'Board not found');
        if (!self::atLeast($r, $need)) Http::fail(403, $need === 'owner' ? 'Only the owner can do that' : 'You don’t have permission to do that');
        return $r;
    }

    /**
     * Boards where this person's access starts (their parent is not visible to them): what "Shared with me" lists.
     * For people with access to the whole space this is just the top board.
     */
    public static function roots(array $boards, string $spaceId): array
    {
        $tree = self::tree($spaceId);
        $out = [];
        foreach ($boards as $b => $_) {
            if ($b === self::UNSORTED) continue;
            $p = $tree[$b] ?? null;
            if ($p === null || !isset($boards[$p])) $out[] = (string) $b;
        }
        return $out;
    }

    /**
     * Who can see each board: board id => list of user ids. Used to warn before moving cards to a board
     * with a different audience, and to list people with access.
     */
    public static function audience(array $space): array
    {
        $tree = self::tree($space['id']);
        $full = array_column(Db::q('SELECT user_id FROM space_members WHERE space_id = ? AND left_at IS NULL AND role <> ?', [$space['id'], 'guest'])->fetchAll(), 'user_id');
        $aud = array_fill_keys(array_keys($tree), $full);
        $restricted = self::restricted($space['id']);
        foreach (self::grants($space['id']) as $uid => $g) {
            if (in_array($uid, $full, true)) continue;
            foreach (self::resolve($tree, $g, $restricted) as $b => $_) $aud[$b][] = $uid;
        }
        return $aud;
    }

    /** Everyone with any access to the space's boards (full members and people with board grants). */
    public static function people(array $space): array
    {
        $ids = array_column(Db::q('SELECT user_id FROM space_members WHERE space_id = ? AND left_at IS NULL', [$space['id']])->fetchAll(), 'user_id');
        $ids = array_values(array_unique(array_merge($ids, array_keys(self::grants($space['id'])))));
        return self::names($ids);
    }

    /** user id => ['name' => …, 'email' => …] */
    public static function names(array $ids): array
    {
        $ids = array_values(array_unique(array_filter($ids)));
        if (!$ids) return [];
        $out = [];
        foreach (array_chunk($ids, 500) as $chunk) {
            $in = implode(',', array_fill(0, count($chunk), '?'));
            foreach (Db::q("SELECT id, name, email FROM users WHERE id IN ($in)", $chunk) as $r) $out[$r['id']] = ['name' => $r['name'], 'email' => $r['email']];
        }
        return $out;
    }

    /** Bump the space's access revision so clients refresh what they can see. */
    public static function changed(string $spaceId): void
    {
        Db::q('UPDATE spaces SET acl_rev = acl_rev + 1 WHERE id = ?', [$spaceId]);
        self::forget($spaceId);
    }

    /** All boards inside $root (including it), using the space's tree. */
    public static function subtree(string $spaceId, string $root): array
    {
        $tree = self::tree($spaceId);
        $kids = [];
        foreach ($tree as $id => $p) $kids[(string) $p][] = (string) $id;
        $out = []; $stack = [$root];
        while ($stack) {
            $b = array_pop($stack);
            if (isset($out[$b])) continue;
            $out[$b] = true;
            foreach ($kids[$b] ?? [] as $k) $stack[] = $k;
        }
        return array_keys($out);
    }
}
