<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Comments on cards. Every card has one thread (a comment card's thread is its own), which can be resolved and reopened;
 * comments carry @mentions ("<@u_…>" in the text) and reactions from a fixed set.
 * - commenters and up can comment, react and resolve; authors edit their own comments; authors and the board's owner delete.
 * - writes go through this API rather than sync, so the rules hold on the server. Each write moves the space's revision,
 *   and pulls bring the comments that changed (Sync::pull → since()), so they show up live like any other change.
 */
final class Comments
{
    public const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '✅'];
    private const MAX = 5000;
    public const MENTION = '/<@(u_[a-f0-9]{20})>/';

    private static function ms(): int { return (int) (microtime(true) * 1000); }

    private static function id(mixed $v): string
    {
        return is_string($v) && preg_match('/^[\w.-]{1,64}$/', $v) ? $v : Http::fail(400, 'Invalid card');
    }

    private static function body(mixed $v): string
    {
        $s = is_string($v) ? trim(preg_replace('/[^\P{C}\n\t]/u', '', str_replace("\r\n", "\n", $v)) ?? '') : '';
        if ($s === '') Http::fail(422, 'Write something first');
        if (mb_strlen($s) > self::MAX) Http::fail(422, 'That comment is too long');
        return $s;
    }

    /** The card's board, and the person's role there; fails unless it's at least $need. */
    private static function card(array $u, array $space, string $item, string $need): array
    {
        $r = Db::one("SELECT parent FROM entities WHERE space_id = ? AND kind = 'item' AND id = ? AND deleted = 0", [$space['id'], $item])
            ?? Http::fail(404, 'Card not found');
        $board = (string) $r['parent'];
        return ['board' => $board, 'role' => Access::need($u['id'], $space, $board, $need)];
    }

    private static function row(string $id): array
    {
        return Db::one('SELECT * FROM comments WHERE id = ? AND deleted = 0', [$id]) ?? Http::fail(404, 'Comment not found');
    }

    public static function mentions(string $body): array
    {
        preg_match_all(self::MENTION, $body, $m);
        return array_values(array_unique($m[1]));
    }

    /** The comment as the browser gets it from a pull. */
    private static function out(string $spaceId, string $id): array
    {
        return self::since($spaceId, -1, false, null, [$id])['comments'][0] ?? [];
    }

    public static function add(array $u, array $in): array
    {
        $space = Access::space((string) ($in['space'] ?? ''));
        $item = self::id($in['item'] ?? null);
        $body = self::body($in['body'] ?? null);
        RateLimit::hit('comment:' . $u['id'], 120, 600);
        $id = Db::tx(fn() => self::insert($space, self::card($u, $space, $item, 'commenter')['board'], $item, $u, $body));
        Realtime::nudge();
        return ['comment' => self::out($space['id'], $id)];
    }

    /**
     * Store a new comment by $author (a person, or a guest on a comment link: no id, an "anon" key). Returns its id.
     * $linkOwner: who made the comment link a guest wrote through.
     */
    private static function insert(array $space, string $board, string $item, array $author, string $body, ?string $linkOwner = null): string
    {
        $rev = Sync::bump($space['id']);
        $id = 'c_' . bin2hex(random_bytes(8));
        Db::q('INSERT INTO comments (id, space_id, item_id, author_id, author_name, anon, body, created_at, deleted, rev) VALUES (?,?,?,?,?,?,?,?,0,?)',
            [$id, $space['id'], $item, $author['id'], $author['name'], $author['anon'] ?? null, $body, self::ms(), $rev]);
        // a new comment reopens a resolved thread
        Db::q('UPDATE comment_threads SET resolved_at = NULL, resolved_by = NULL, rev = ? WHERE space_id = ? AND item_id = ? AND resolved_at IS NOT NULL',
            [$rev, $space['id'], $item]);
        Notify::comment($author, $space, $board, $item, $id, $body, null, $linkOwner);
        return $id;
    }

    /** Comment text on one line with mentions as @Name, shortened (notifications, the activity feed). */
    public static function plain(string $body, int $max = 160): string
    {
        $names = Access::names(self::mentions($body));
        $s = preg_replace_callback(self::MENTION, fn($m) => '@' . ($names[$m[1]]['name'] ?? 'someone'), $body);
        $s = trim(preg_replace('/\s+/u', ' ', $s) ?? '');
        return mb_strlen($s) > $max ? mb_substr($s, 0, $max - 1) . '…' : $s;
    }

    public static function edit(array $u, string $id, array $in): array
    {
        $body = self::body($in['body'] ?? null);
        $c = self::row($id);
        if ($c['author_id'] !== $u['id']) Http::fail(403, 'You can only edit your own comments');
        $space = Access::space($c['space_id']);
        Db::tx(function () use ($u, $space, $c, $body) {
            $card = self::card($u, $space, $c['item_id'], 'commenter');
            self::rewrite($u, $space, $card['board'], $c, $body);
        });
        Realtime::nudge();
        return ['comment' => self::out($space['id'], $id)];
    }

    private static function rewrite(array $author, array $space, string $board, array $c, string $body): void
    {
        if ($body === $c['body']) return;
        $rev = Sync::bump($space['id']);
        Db::q('UPDATE comments SET body = ?, edited_at = ?, rev = ? WHERE id = ?', [$body, self::ms(), $rev, $c['id']]);
        Notify::comment($author, $space, $board, $c['item_id'], $c['id'], $body, $c['body']);
    }

    public static function delete(array $u, string $id): array
    {
        $c = self::row($id);
        $space = Access::space($c['space_id']);
        Db::tx(function () use ($u, $space, $c) {
            $card = self::card($u, $space, $c['item_id'], 'viewer');
            if ($c['author_id'] !== $u['id'] && $card['role'] !== 'owner') Http::fail(403, 'Only the author and the board’s owner can delete a comment');
            self::erase($space, $c);
        });
        Realtime::nudge();
        return ['ok' => true];
    }

    private static function erase(array $space, array $c): void
    {
        $rev = Sync::bump($space['id']);
        Db::q("UPDATE comments SET deleted = 1, body = '', edited_at = ?, rev = ? WHERE id = ?", [self::ms(), $rev, $c['id']]);
        Db::q('DELETE FROM comment_reactions WHERE comment_id = ?', [$c['id']]);
        Db::q('DELETE FROM notifications WHERE ref = ?', [$c['id']]);
    }

    private static function emoji(array $in): string
    {
        $emoji = (string) ($in['emoji'] ?? '');
        return in_array($emoji, self::REACTIONS, true) ? $emoji : Http::fail(422, 'Pick one of the reactions');
    }

    /** Add or take back a reaction. */
    public static function react(array $u, string $id, array $in): array
    {
        $emoji = self::emoji($in);
        $c = self::row($id);
        $space = Access::space($c['space_id']);
        Db::tx(function () use ($u, $space, $c, $emoji, $in) {
            self::card($u, $space, $c['item_id'], 'commenter');
            self::toggle($space, $c, $u['id'], $emoji, $in);
        });
        Realtime::nudge();
        return ['comment' => self::out($space['id'], $id)];
    }

    /** $who: a person's id, or "a_" + a guest's public id. */
    private static function toggle(array $space, array $c, string $who, string $emoji, array $in): void
    {
        $has = (bool) Db::one('SELECT who FROM comment_reactions WHERE comment_id = ? AND who = ? AND emoji = ?', [$c['id'], $who, $emoji]);
        $on = isset($in['on']) ? (bool) $in['on'] : !$has;
        if ($on === $has) return;
        if ($on) Db::q('INSERT INTO comment_reactions (comment_id, who, emoji, at) VALUES (?,?,?,?)', [$c['id'], $who, $emoji, self::ms()]);
        else Db::q('DELETE FROM comment_reactions WHERE comment_id = ? AND who = ? AND emoji = ?', [$c['id'], $who, $emoji]);
        Db::q('UPDATE comments SET rev = ? WHERE id = ?', [Sync::bump($space['id']), $c['id']]);
    }

    /** Resolve or reopen a card's thread. */
    public static function resolve(array $u, array $in): array
    {
        $space = Access::space((string) ($in['space'] ?? ''));
        $item = self::id($in['item'] ?? null);
        $on = !empty($in['resolved']);
        Db::tx(function () use ($u, $space, $item, $on) {
            self::card($u, $space, $item, 'commenter');
            $rev = Sync::bump($space['id']);
            Db::upsert('comment_threads', ['space_id' => $space['id'], 'item_id' => $item, 'resolved_at' => $on ? self::ms() : null,
                                           'resolved_by' => $on ? $u['id'] : null, 'rev' => $rev], ['space_id', 'item_id']);
        });
        Realtime::nudge();
        return ['ok' => true];
    }

    /* ---------- guests on a comment link: no account, a name, and a key kept in their browser ---------- */

    /**
     * A guest's identity from the request: a public id ("aid", shown with their comments so their browser knows which
     * are theirs), a secret only that browser knows (its hash is stored with each comment), and — to comment — a name.
     */
    private static function guest(array $in, bool $named): array
    {
        $aid = $in['aid'] ?? ''; $secret = $in['secret'] ?? '';
        if (!is_string($aid) || !preg_match('/^[a-f0-9]{16}$/', $aid) || !is_string($secret) || !preg_match('/^[a-f0-9]{32}$/', $secret)) {
            Http::fail(400, 'Invalid guest key');
        }
        $name = '';
        if ($named) {
            $name = trim(preg_replace('/\s+/u', ' ', Http::str($in, 'name', 60)) ?? '');
            if ($name === '') Http::fail(422, 'Add your name first');
        }
        return ['id' => null, 'aid' => $aid, 'anon' => $aid . ':' . hash('sha256', $secret), 'name' => $name];
    }

    /** The space, the card's board and who made the link; fails unless the link lets guests comment and the card is on a board it shows. */
    private static function linkCard(string $token, array $in, string $item): array
    {
        $s = Shares::usable($token, (string) ($in['k'] ?? ''));
        if ($s['kind'] !== 'comment') Http::fail(403, 'This link doesn’t allow comments');
        $r = Db::one("SELECT parent FROM entities WHERE space_id = ? AND kind = 'item' AND id = ? AND deleted = 0", [$s['space_id'], $item]);
        if (!$r || !in_array((string) $r['parent'], Access::subtree($s['space_id'], $s['board_id']), true)) Http::fail(404, 'Card not found');
        return ['space' => Access::space($s['space_id']), 'board' => (string) $r['parent'], 'owner' => (string) $s['user_id']];
    }

    /** A comment on a card the link shows. */
    private static function guestComment(string $token, array $in, string $id): array
    {
        $c = self::row($id);
        $card = self::linkCard($token, $in, $c['item_id']);
        if ($c['space_id'] !== $card['space']['id']) Http::fail(404, 'Comment not found');
        return [$c, $card];
    }

    private static function own(array $c, array $g): void
    {
        if ($c['anon'] === null || !hash_equals($c['anon'], $g['anon'])) Http::fail(403, 'You can only change your own comments');
    }

    public static function guestAdd(string $token, array $in): array
    {
        $g = self::guest($in, true);
        $item = self::id($in['item'] ?? null);
        $body = self::body($in['body'] ?? null);
        RateLimit::hit('comment-guest:' . Http::ip(), 60, 600);
        $card = self::linkCard($token, $in, $item);
        $id = Db::tx(fn() => self::insert($card['space'], $card['board'], $item, $g, $body, $card['owner']));
        Realtime::nudge();
        return ['comment' => self::out($card['space']['id'], $id)];
    }

    public static function guestEdit(string $token, string $id, array $in): array
    {
        $g = self::guest($in, false);
        $body = self::body($in['body'] ?? null);
        [$c, $card] = self::guestComment($token, $in, $id);
        self::own($c, $g);
        Db::tx(fn() => self::rewrite(['id' => null, 'name' => $c['author_name']], $card['space'], $card['board'], $c, $body));
        Realtime::nudge();
        return ['comment' => self::out($card['space']['id'], $id)];
    }

    public static function guestDelete(string $token, string $id, array $in): array
    {
        $g = self::guest($in, false);
        [$c, $card] = self::guestComment($token, $in, $id);
        self::own($c, $g);
        Db::tx(fn() => self::erase($card['space'], $c));
        Realtime::nudge();
        return ['ok' => true];
    }

    public static function guestReact(string $token, string $id, array $in): array
    {
        $g = self::guest($in, false);
        $emoji = self::emoji($in);
        RateLimit::hit('comment-guest:' . Http::ip(), 60, 600);
        [$c, $card] = self::guestComment($token, $in, $id);
        Db::tx(fn() => self::toggle($card['space'], $c, 'a_' . $g['aid'], $emoji, $in));
        Realtime::nudge();
        return ['comment' => self::out($card['space']['id'], $id)];
    }

    /** People who can see a board, for @mentions. */
    public static function people(array $u, string $spaceId, string $board): array
    {
        $space = Access::space($spaceId);
        Access::need($u['id'], $space, $board, 'commenter');
        $ids = $board === Access::UNSORTED ? [$space['owner_id']] : (Access::audience($space)[$board] ?? []);
        $out = [];
        foreach (Access::names($ids) as $id => $p) $out[] = ['id' => $id, 'name' => $p['name'], 'email' => $p['email']];
        usort($out, fn($a, $b) => strcasecmp($a['name'], $b['name']));
        return ['people' => $out];
    }

    /**
     * Comments and threads that changed after revision $since, on cards this person can see ($boards; null = no check),
     * plus names for authors, mentions and reactions. $full: everything (deleted comments left out).
     */
    public static function since(string $spaceId, int $since, bool $full, ?array $boards, ?array $only = null): array
    {
        $join = "LEFT JOIN entities e ON e.space_id = c.space_id AND e.kind = 'item' AND e.id = c.item_id AND e.deleted = 0";
        if ($only !== null) {
            $in = implode(',', array_fill(0, count($only), '?'));
            $rows = Db::q("SELECT c.*, e.parent FROM comments c $join WHERE c.id IN ($in)", $only)->fetchAll();
        } else {
            $rows = Db::q("SELECT c.*, e.parent FROM comments c $join WHERE c.space_id = ? AND c.rev > ?" . ($full ? ' AND c.deleted = 0' : ''),
                [$spaceId, $full ? -1 : $since])->fetchAll();
        }
        $seen = fn($parent) => $parent !== null && ($boards === null || isset($boards[$parent]));
        $comments = []; $live = []; $ids = []; $guests = [];   // guests: public id => name
        foreach ($rows as $r) {
            if ($r['deleted'] || !$seen($r['parent'])) { if (!$full) $comments[] = ['id' => $r['id'], 'del' => 1]; continue; }
            $live[$r['id']] = count($comments);
            $comments[] = ['id' => $r['id'], 'item' => $r['item_id'], 'by' => $r['author_id'], 'name' => $r['author_name'], 'body' => $r['body'],
                           'at' => (int) $r['created_at'], 'ed' => $r['edited_at'] === null ? null : (int) $r['edited_at'], 'r' => []]
                + ($r['anon'] !== null ? ['g' => substr($r['anon'], 0, 16)] : []);
            if ($r['author_id'] !== null) $ids[$r['author_id']] = true;
            else $guests[substr((string) $r['anon'], 0, 16)] = $r['author_name'];
            foreach (self::mentions($r['body']) as $m) $ids[$m] = true;
        }
        if ($live) {
            foreach (array_chunk(array_keys($live), 500) as $chunk) {
                $in = implode(',', array_fill(0, count($chunk), '?'));
                foreach (Db::q("SELECT comment_id, who, emoji FROM comment_reactions WHERE comment_id IN ($in) ORDER BY at", $chunk) as $x) {
                    $comments[$live[$x['comment_id']]]['r'][$x['emoji']][] = $x['who'];
                    if (str_starts_with($x['who'], 'a_')) $guests[substr($x['who'], 2)] ??= null;
                    else $ids[$x['who']] = true;
                }
            }
        }
        $threads = [];
        if ($only === null) {
            $tr = Db::q("SELECT t.*, e.parent FROM comment_threads t LEFT JOIN entities e ON e.space_id = t.space_id AND e.kind = 'item' AND e.id = t.item_id AND e.deleted = 0
                         WHERE t.space_id = ? AND t.rev > ?" . ($full ? ' AND t.resolved_at IS NOT NULL' : ''), [$spaceId, $full ? -1 : $since]);
            foreach ($tr as $t) {
                if (!$seen($t['parent'])) continue;
                $threads[$t['item_id']] = $t['resolved_at'] === null ? null : ['at' => (int) $t['resolved_at'], 'by' => $t['resolved_by']];
                if ($t['resolved_by']) $ids[$t['resolved_by']] = true;
            }
        }
        $names = [];
        foreach (Access::names(array_keys($ids)) as $id => $p) $names[$id] = $p['name'];
        // guests (on comment links), by the name they last commented with
        foreach ($guests as $aid => $name) {
            $name ??= Db::one('SELECT author_name FROM comments WHERE space_id = ? AND anon LIKE ? ORDER BY created_at DESC LIMIT 1', [$spaceId, $aid . ':%'])['author_name'] ?? null;
            $names['a_' . $aid] = $name === null ? 'A guest' : $name . ' (guest)';
        }
        // authors' current names win over the name saved with the comment
        foreach ($comments as &$c) {
            if (isset($c['by'], $names[$c['by']])) $c['name'] = $names[$c['by']];
            if (isset($c['r'])) $c['r'] = (object) $c['r'];
        }
        unset($c);
        return ['comments' => $comments, 'threads' => (object) $threads, 'names' => (object) $names];
    }

    /** Comments and resolve state of these cards go out again with the next pull (a card came back from the trash or moved boards). */
    public static function touch(string $spaceId, array $items, int $rev): void
    {
        foreach (array_chunk($items, 500) as $chunk) {
            $in = implode(',', array_fill(0, count($chunk), '?'));
            Db::q("UPDATE comments SET rev = ? WHERE space_id = ? AND item_id IN ($in)", [$rev, $spaceId, ...$chunk]);
            Db::q("UPDATE comment_threads SET rev = ? WHERE space_id = ? AND item_id IN ($in)", [$rev, $spaceId, ...$chunk]);
        }
    }

    /** Cards of a space that have comments: item id => true. */
    public static function cards(string $spaceId): array
    {
        $out = [];
        foreach (Db::q('SELECT DISTINCT item_id FROM comments WHERE space_id = ?', [$spaceId]) as $r) $out[$r['item_id']] = true;
        foreach (Db::q('SELECT item_id FROM comment_threads WHERE space_id = ?', [$spaceId]) as $r) $out[$r['item_id']] = true;
        return $out;
    }

    /**
     * Replies written the old way, inside a comment card ("data.thread": [{text, at, name?}]) — by older browsers,
     * backups, the AI tools — become comments by $author. Ones already imported (same card, time and text) are skipped.
     */
    public static function importThread(string $spaceId, string $item, array $thread, string $authorId, string $authorName, int $rev): void
    {
        foreach ($thread as $t) {
            if (!is_array($t)) continue;
            $text = trim((string) ($t['text'] ?? ''));
            if ($text === '') continue;
            $text = mb_substr($text, 0, self::MAX);
            $at = (int) ($t['at'] ?? 0) ?: self::ms();
            if (Db::one('SELECT id FROM comments WHERE space_id = ? AND item_id = ? AND created_at = ? AND body = ?', [$spaceId, $item, $at, $text])) continue;
            Db::q('INSERT INTO comments (id, space_id, item_id, author_id, author_name, body, created_at, deleted, rev) VALUES (?,?,?,?,?,?,?,0,?)',
                ['c_' . bin2hex(random_bytes(8)), $spaceId, $item, $authorId, mb_substr($authorName, 0, 120), $text, $at, $rev]);
        }
    }

    /** Migration 10: move replies out of comment cards into comments, by whoever created the card. */
    public static function migrateThreads(): void
    {
        $bumped = [];
        foreach (Db::q("SELECT space_id, id, data, created_by FROM entities WHERE kind = 'item' AND data LIKE ?", ['%"thread"%'])->fetchAll() as $r) {
            $d = json_decode((string) $r['data'], true);
            if (!is_array($d) || !array_key_exists('thread', $d['data'] ?? [])) continue;
            $sid = $r['space_id'];
            $bumped[$sid] ??= Sync::bump($sid);
            $by = $r['created_by'] ?: (Db::one('SELECT owner_id FROM spaces WHERE id = ?', [$sid])['owner_id'] ?? null);
            $name = $by ? (Db::one('SELECT name FROM users WHERE id = ?', [$by])['name'] ?? '') : '';
            if (is_array($d['data']['thread'])) self::importThread($sid, $r['id'], $d['data']['thread'], (string) $by, $name, $bumped[$sid]);
            unset($d['data']['thread']);
            Db::q("UPDATE entities SET data = ?, rev = ? WHERE space_id = ? AND kind = 'item' AND id = ?",
                [json_encode($d, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $bumped[$sid], $sid, $r['id']]);
        }
    }

    /** Comment texts per card of a space, for the AI tools: item id => ["Name: text", …]. */
    public static function texts(string $spaceId): array
    {
        $rows = Db::q('SELECT item_id, author_id, author_name, body FROM comments WHERE space_id = ? AND deleted = 0 ORDER BY created_at', [$spaceId])->fetchAll();
        $ids = [];
        foreach ($rows as $r) { $ids[$r['author_id']] = true; foreach (self::mentions($r['body']) as $m) $ids[$m] = true; }
        $names = Access::names(array_keys($ids));
        $out = [];
        foreach ($rows as $r) {
            $text = preg_replace_callback(self::MENTION, fn($m) => '@' . ($names[$m[1]]['name'] ?? 'someone'), $r['body']);
            $out[$r['item_id']][] = ($names[$r['author_id']]['name'] ?? $r['author_name']) . ': ' . $text;
        }
        return $out;
    }

    /** Comments of deleted cards that are gone for good, and deletion markers older than 30 days. */
    public static function prune(): int
    {
        $n = 0;
        $old = Db::q("SELECT c.id FROM comments c LEFT JOIN entities e ON e.space_id = c.space_id AND e.kind = 'item' AND e.id = c.item_id
                      WHERE e.id IS NULL OR (c.deleted = 1 AND c.edited_at < ?)", [(time() - 30 * 86400) * 1000])->fetchAll();
        foreach (array_chunk(array_column($old, 'id'), 500) as $chunk) {
            $in = implode(',', array_fill(0, count($chunk), '?'));
            Db::q("DELETE FROM comment_reactions WHERE comment_id IN ($in)", $chunk);
            $n += Db::q("DELETE FROM comments WHERE id IN ($in)", $chunk)->rowCount();
        }
        Db::q("DELETE FROM comment_threads WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.space_id = comment_threads.space_id AND e.kind = 'item' AND e.id = comment_threads.item_id)");
        return $n;
    }
}
