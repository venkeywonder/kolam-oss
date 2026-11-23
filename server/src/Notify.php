<?php
declare(strict_types=1);

namespace Kolam;

/**
 * In-app notifications: someone @mentioned you, replied in a thread you're in, a guest commented through your link,
 * invited you, or changed your role. Each person can switch off each kind ("mention", "reply", "guest",
 * "access" = invitations, role changes and people joining through a link).
 * Open browsers learn about new ones from the realtime server (or the presence poll) and then fetch the list.
 */
final class Notify
{
    public const PREFS = ['mention', 'reply', 'guest', 'access'];
    private const KEEP_DAYS = 90;

    private static function ms(): int { return (int) (microtime(true) * 1000); }

    /** Switched-off kinds, from the users.notify_off column. */
    public static function off(?string $v): array
    {
        return array_values(array_intersect(self::PREFS, explode(',', (string) $v)));
    }

    public static function setOff(string $uid, mixed $list): void
    {
        if (!is_array($list)) Http::fail(422, 'Invalid notification settings');
        Db::q('UPDATE users SET notify_off = ? WHERE id = ?', [implode(',', array_intersect(self::PREFS, $list)), $uid]);
    }

    /** Store a notification for $to unless they switched that kind off (or it's their own doing). */
    public static function add(string $to, string $kind, array $f): void
    {
        if ($to === ($f['actor'] ?? null)) return;
        $u = Db::one('SELECT notify_off FROM users WHERE id = ?', [$to]);
        if (!$u) return;
        $pref = in_array($kind, ['invite', 'role', 'join'], true) ? 'access' : $kind;
        if (in_array($pref, self::off($u['notify_off']), true)) return;
        Db::q('INSERT INTO notifications (id, user_id, kind, space_id, board_id, item_id, ref, actor_id, actor_name, text, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
            'n_' . bin2hex(random_bytes(8)), $to, $kind, $f['space'] ?? null, $f['board'] ?? null, $f['item'] ?? null, $f['ref'] ?? null,
            $f['actor'] ?? null, isset($f['actorName']) ? mb_substr((string) $f['actorName'], 0, 120) : null,
            mb_substr((string) ($f['text'] ?? ''), 0, 400), self::ms(),
        ]);
        if (random_int(1, 100) === 1) Db::q('DELETE FROM notifications WHERE created_at < ?', [(time() - self::KEEP_DAYS * 86400) * 1000]);
    }

    /**
     * A comment was written ($old = null) or edited: notify people newly @mentioned, and — for new comments — everyone
     * else who already commented on the card, and the person whose comment link a guest used ($linkOwner).
     * Only people who can see the board hear about it.
     * $u: the author; a guest on a comment link has no id, only a name.
     */
    public static function comment(array $u, array $space, string $board, string $item, string $commentId, string $body, ?string $old, ?string $linkOwner = null): void
    {
        $sees = fn(string $uid) => Access::role($uid, $space, $board) !== null;
        $mentioned = array_diff(Comments::mentions($body), $old === null ? [] : Comments::mentions($old));
        $f = ['space' => $space['id'], 'board' => $board, 'item' => $item, 'ref' => $commentId, 'actor' => $u['id'],
              'actorName' => $u['id'] === null ? $u['name'] . ' (guest)' : null, 'text' => Comments::plain($body)];
        foreach ($mentioned as $to) if ($sees($to)) self::add($to, 'mention', $f);
        if ($old !== null) return;
        $earlier = Db::q('SELECT DISTINCT author_id FROM comments WHERE space_id = ? AND item_id = ? AND deleted = 0 AND id <> ? AND author_id IS NOT NULL',
            [$space['id'], $item, $commentId])->fetchAll();
        foreach (array_column($earlier, 'author_id') as $to) {
            if (!in_array($to, $mentioned, true) && $to !== $linkOwner && $sees($to)) self::add($to, 'reply', $f);
        }
        if ($linkOwner !== null && !in_array($linkOwner, $mentioned, true) && $sees($linkOwner)) self::add($linkOwner, 'guest', $f);
    }

    /** When the newest notification for this person arrived (ms; 0 = none), so browsers know when to fetch. */
    public static function latest(string $uid): int
    {
        return (int) (Db::one('SELECT MAX(created_at) m FROM notifications WHERE user_id = ?', [$uid])['m'] ?? 0);
    }

    /** The latest 50, newest first, with names of who and where. */
    public static function list(array $u): array
    {
        $rows = Db::q('SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 50', [$u['id']])->fetchAll();
        $actors = Access::names(array_column($rows, 'actor_id'));
        $spaces = []; $boards = [];
        foreach ($rows as $r) if ($r['space_id']) { $spaces[$r['space_id']] = true; if ($r['board_id']) $boards[$r['space_id']][] = $r['board_id']; }
        $sp = [];
        foreach (array_keys($spaces) as $sid) {
            $s = Db::one('SELECT kind, name, owner_id, deleted_at FROM spaces WHERE id = ?', [$sid]);
            $sp[$sid] = ['name' => $s && $s['kind'] === 'workspace' ? $s['name'] : null, 'gone' => !$s || $s['deleted_at'] !== null,
                         'titles' => isset($boards[$sid]) ? Spaces::titles($sid, array_unique($boards[$sid])) : []];
        }
        $items = [];
        foreach ($rows as $r) {
            $s = $r['space_id'] ? $sp[$r['space_id']] : null;
            $items[] = ['id' => $r['id'], 'kind' => $r['kind'], 'space' => $r['space_id'], 'board' => $r['board_id'], 'item' => $r['item_id'],
                        'ref' => $r['ref'], 'by' => $r['actor_id'], 'actor' => $actors[$r['actor_id']]['name'] ?? $r['actor_name'], 'text' => $r['text'],
                        'where' => $s ? ($s['titles'][$r['board_id']] ?? $s['name']) : null, 'at' => (int) $r['created_at'],
                        'read' => $r['read_at'] !== null];
        }
        $unread = (int) Db::one('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', [$u['id']])['n'];
        $off = self::off(Db::one('SELECT notify_off FROM users WHERE id = ?', [$u['id']])['notify_off'] ?? null);
        return ['items' => $items, 'unread' => $unread, 'latest' => self::latest($u['id']), 'off' => $off];
    }

    /** Mark some ($in['ids']) or all as read. */
    public static function read(array $u, array $in): array
    {
        $now = self::ms();
        if (!empty($in['all'])) Db::q('UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL', [$now, $u['id']]);
        elseif (is_array($in['ids'] ?? null) && $in['ids']) {
            $ids = array_slice(array_values(array_filter($in['ids'], 'is_string')), 0, 200);
            if ($ids) {
                $q = implode(',', array_fill(0, count($ids), '?'));
                Db::q("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL AND id IN ($q)", [$now, $u['id'], ...$ids]);
            }
        }
        return ['unread' => (int) Db::one('SELECT COUNT(*) n FROM notifications WHERE user_id = ? AND read_at IS NULL', [$u['id']])['n']];
    }
}
