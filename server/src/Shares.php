<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Links to a board (and the boards inside it). A board can have several, each with a label, an optional expiry date and
 * an optional password. Only the board's owner manages them.
 * - view: anyone with the link can look, without an account.
 * - comment: the same, and they can comment under a name they give (no account; their browser keeps a key so they can
 *   edit and delete their own comments).
 * - join: people sign in (or create an account) and are added to the board with the link's role. Editing always needs
 *   an account, so this is the only kind of link that can give edit access.
 */
final class Shares
{
    public const KINDS = ['view', 'comment', 'join'];
    private const JOIN_ROLES = ['editor', 'commenter', 'viewer'];
    private const MAX_LINKS = 20;

    private static function row(string $token): ?array
    {
        return preg_match('/^[a-f0-9]{24}$/', $token) ? Db::one('SELECT * FROM shares WHERE token = ?', [$token]) : null;
    }

    private static function out(array $r): array
    {
        return ['token' => $r['token'], 'kind' => $r['kind'], 'role' => $r['role'], 'label' => (string) $r['label'],
                'expires' => $r['expires_at'] === null ? null : (int) $r['expires_at'], 'password' => $r['pass_hash'] !== null,
                'uses' => (int) $r['uses'], 'created' => (int) $r['created_at']];
    }

    /** The links of a board, oldest first (for its owner). */
    public static function list(string $spaceId, string $board): array
    {
        return array_map([self::class, 'out'], Db::q('SELECT * FROM shares WHERE space_id = ? AND board_id = ? ORDER BY created_at, token', [$spaceId, $board])->fetchAll());
    }

    /** Validated column values from the dialog's input; $old: the link being changed. */
    private static function fields(array $in, ?array $old): array
    {
        $f = [];
        $kind = $old['kind'] ?? 'view';
        if (array_key_exists('kind', $in) || !$old) {
            $kind = (string) ($in['kind'] ?? 'view');
            if (!in_array($kind, self::KINDS, true)) Http::fail(422, 'Pick what the link lets people do');
            $f['kind'] = $kind;
        }
        if ($kind === 'join') {
            if (array_key_exists('role', $in) || !$old || $old['role'] === null) {
                $role = (string) ($in['role'] ?? 'editor');
                if (!in_array($role, self::JOIN_ROLES, true)) Http::fail(422, 'Pick a role for people who join');
                $f['role'] = $role;
            }
        } else $f['role'] = null;
        if (array_key_exists('label', $in)) $f['label'] = Http::str($in, 'label', 120);
        if (array_key_exists('expires', $in)) {
            $e = $in['expires'];
            if ($e !== null && (!is_int($e) || $e <= time() || $e > time() + 5 * 365 * 86400)) Http::fail(422, 'Pick an expiry date in the future');
            $f['expires_at'] = $e;
        }
        if (array_key_exists('password', $in)) {
            $p = $in['password'];
            if ($p !== null && (!is_string($p) || mb_strlen($p) < 4 || mb_strlen($p) > 200)) Http::fail(422, 'Use a password of at least 4 characters');
            $f['pass_hash'] = $p === null ? null : password_hash($p, PASSWORD_DEFAULT);
        }
        return $f;
    }

    public static function create(array $u, string $spaceId, string $board, array $in): array
    {
        if (!preg_match('/^[\w.-]{1,64}$/', $board) || $board === Access::UNSORTED) Http::fail(400, 'Invalid board');
        Access::need($u['id'], Access::space($spaceId), $board, 'owner');
        $n = (int) Db::one('SELECT COUNT(*) n FROM shares WHERE space_id = ? AND board_id = ?', [$spaceId, $board])['n'];
        if ($n >= self::MAX_LINKS) Http::fail(422, 'A board can have at most ' . self::MAX_LINKS . ' links');
        $row = array_merge(['token' => bin2hex(random_bytes(12)), 'user_id' => $u['id'], 'space_id' => $spaceId, 'board_id' => $board,
                            'created_at' => time(), 'label' => '', 'kind' => 'view', 'role' => null, 'expires_at' => null, 'pass_hash' => null, 'uses' => 0],
                           self::fields($in, null));
        Db::q('INSERT INTO shares (' . implode(',', array_keys($row)) . ') VALUES (' . implode(',', array_fill(0, count($row), '?')) . ')', array_values($row));
        return self::out($row);
    }

    /** The link and its board, for its owner. */
    private static function managed(array $u, string $token): array
    {
        $r = self::row($token) ?? Http::fail(404, 'Link not found');
        Access::need($u['id'], Access::space($r['space_id']), $r['board_id'], 'owner');
        return $r;
    }

    public static function update(array $u, string $token, array $in): array
    {
        $r = self::managed($u, $token);
        $f = self::fields($in, $r);
        if ($f) {
            Db::q('UPDATE shares SET ' . implode(', ', array_map(fn($c) => "$c = ?", array_keys($f))) . ' WHERE token = ?', [...array_values($f), $token]);
        }
        return self::out(self::row($token));
    }

    public static function remove(array $u, string $token): void
    {
        self::managed($u, $token);
        Db::q('DELETE FROM shares WHERE token = ?', [$token]);
    }

    /** What a password unlocks: a key the browser sends back with each request (changes when the password does). */
    private static function key(array $s): string
    {
        return hash_hmac('sha256', $s['token'], (string) $s['pass_hash']);
    }

    /**
     * A link that works right now; fails when it's gone, expired, made by a suspended account, or has a password that
     * $key doesn't unlock.
     */
    public static function usable(string $token, string $key): array
    {
        $s = self::row($token) ?? Http::fail(404, 'This link isn’t available');
        $space = Db::one('SELECT rev, deleted_at FROM spaces WHERE id = ?', [$s['space_id']]);
        if (!$space || $space['deleted_at'] !== null) Http::fail(404, 'This link isn’t available');
        if (Db::one('SELECT id FROM users WHERE id = ? AND suspended_at IS NOT NULL', [$s['user_id']])) Http::fail(404, 'This link isn’t available');
        if ($s['expires_at'] !== null && (int) $s['expires_at'] < time()) Http::fail(410, 'This link has expired');
        if ($s['pass_hash'] !== null && !hash_equals(self::key($s), $key)) Http::fail(423, 'This link needs a password');
        $s['rev'] = (int) $space['rev'];
        return $s;
    }

    /** Check a link's password; returns the key for later requests. */
    public static function unlock(string $token, array $in): array
    {
        RateLimit::hit('link-pass:' . Http::ip(), 20, 600);
        $s = self::row($token) ?? Http::fail(404, 'This link isn’t available');
        if ($s['expires_at'] !== null && (int) $s['expires_at'] < time()) Http::fail(410, 'This link has expired');
        if ($s['pass_hash'] === null) return ['key' => ''];
        if (!is_string($in['password'] ?? null) || !password_verify($in['password'], $s['pass_hash'])) Http::fail(403, 'That password isn’t right');
        return ['key' => self::key($s)];
    }

    private static function title(string $spaceId, string $board): string
    {
        return Spaces::titles($spaceId, [$board])[$board] ?? 'Untitled board';
    }

    /**
     * What the link shows. View and comment links: the board, the boards inside it, their cards and comments, and the
     * role ("viewer" or "commenter"). Join links: only what the person is joining.
     */
    public static function view(string $token, string $key): array
    {
        $s = self::usable($token, $key);
        $sid = $s['space_id']; $root = $s['board_id'];
        $owner = Db::one('SELECT name FROM users WHERE id = ?', [$s['user_id']])['name'] ?? '';
        if ($s['kind'] === 'join') {
            $space = Access::space($sid);
            return ['kind' => 'join', 'title' => self::title($sid, $root), 'by' => $owner, 'role' => $s['role'],
                    'workspace' => $space['kind'] === 'workspace' ? $space['name'] : null];
        }
        $boards = [];
        foreach (Db::q("SELECT id, data FROM entities WHERE space_id = ? AND kind = 'board' AND deleted = 0", [$sid]) as $r) {
            $boards[$r['id']] = json_decode($r['data'], true);
        }
        if (!isset($boards[$root])) Http::fail(404, 'Board missing');
        // walk down from the shared board
        $kids = [];
        foreach ($boards as $id => $b) $kids[$b['parent'] ?? ''][] = $id;
        $keep = []; $stack = [$root];
        while ($stack) { $id = array_pop($stack); $keep[$id] = $boards[$id]; foreach ($kids[$id] ?? [] as $k) $stack[] = $k; }
        $keep[$root]['parent'] = null;
        $ids = array_keys($keep);
        $items = []; $lines = [];
        foreach (array_chunk($ids, 500) as $chunk) {
            $in = implode(',', array_fill(0, count($chunk), '?'));
            foreach (Db::q("SELECT kind, id, data FROM entities WHERE space_id = ? AND kind IN ('item','line') AND deleted = 0 AND parent IN ($in)",
                         array_merge([$sid], $chunk)) as $r) {
                if ($r['kind'] === 'item') $items[$r['id']] = json_decode($r['data'], true);
                else $lines[$r['id']] = json_decode($r['data'], true);
            }
        }
        foreach ($items as &$it) if (is_array($it) && ($it['data'] ?? null) === []) $it['data'] = new \stdClass();
        unset($it);
        $c = Comments::since($sid, 0, true, array_fill_keys($ids, true));
        return ['kind' => $s['kind'], 'role' => $s['kind'] === 'comment' ? 'commenter' : 'viewer', 'root' => $root, 'owner' => $owner,
                'rev' => $s['rev'], 'boards' => $keep, 'items' => (object) $items, 'lines' => (object) $lines] + $c;
    }

    /** Whether this join link lets someone create an account while sign-ups are closed. */
    public static function allowsSignup(mixed $token, mixed $key): bool
    {
        if (!is_string($token) || !is_string($key)) return false;
        try { return self::usable($token, $key)['kind'] === 'join'; } catch (HttpError) { return false; }
    }

    /** Join a board through a join link. Returns where to go. */
    public static function join(array $u, string $token, array $in): array
    {
        RateLimit::hit('link-join:' . $u['id'], 30, 600);
        $s = self::usable($token, (string) ($in['k'] ?? ''));
        if ($s['kind'] !== 'join') Http::fail(404, 'This link isn’t for joining');
        $space = Access::space($s['space_id']);
        $board = $s['board_id'];
        if (!Db::one("SELECT id FROM entities WHERE space_id = ? AND kind = 'board' AND id = ? AND deleted = 0", [$space['id'], $board])) {
            Http::fail(410, 'The board was deleted');
        }
        $go = ['space' => $space['id'], 'board' => $board];
        $now = Access::role($u['id'], $space, $board);
        if ($now !== null && Access::atLeast($now, $s['role'])) return $go + ['already' => $now];
        // joining through a link makes a guest of that board
        Db::tx(function () use ($u, $s, $space, $board) {
            Invites::addToBoard($space, $board, $u['id'], $s['role']);
            Db::q('UPDATE shares SET uses = uses + 1 WHERE token = ?', [$s['token']]);
            Access::changed($space['id']);
            Notify::add($s['user_id'], 'join', ['space' => $space['id'], 'board' => $board, 'actor' => $u['id'],
                'text' => 'as ' . strtolower(Invites::roleName($s['role'])) . ($s['label'] !== null && $s['label'] !== '' ? ' (' . $s['label'] . ')' : '')]);
        });
        return $go;
    }
}
