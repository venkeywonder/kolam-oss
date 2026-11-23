<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Character-level merging of rich text (a card's data.html / data.caption) with Yjs, without running Yjs on the server.
 *
 * Every card someone has edited text in gets a log, numbered 1, 2, 3… per card. An entry is one of:
 *   u  a Yjs update (base64) from a browser
 *   p  a plain write {"f": field, "v": text} — the AI, an import or an older browser set the text without Yjs.
 *      Every browser turns it into the same Yjs change (same client id and position), so nobody has to send it back.
 *   s  a snapshot (base64): a browser's merged state of entries 1…n, replacing them to keep the log short
 * Browsers replay the log in order; the merged text is also written to the card itself, which is what everything else reads.
 */
final class YText
{
    public const FIELDS = ['html', 'caption'];
    private const MAX = 4 * 1024 * 1024;

    /** GET ytext: the log of one card after entry $after, starting it from the card's current text if it has none. */
    public static function load(array $u, string $spaceId, string $itemId, int $after): array
    {
        $space = Access::space($spaceId);
        $item = self::item($spaceId, $itemId);
        if (!$item) return ['entries' => []];   // not saved yet: its log starts with the first update
        if (!Access::atLeast(Access::boards($u['id'], $space)[$item['parent']] ?? null, 'editor')) Http::fail(403, 'You can’t edit this card');
        if ($after === 0 && !self::has($spaceId, $itemId)) {
            $d = json_decode((string) $item['data'], true);
            try {
                Db::tx(function () use ($spaceId, $itemId, $d, $u) {
                    foreach (self::FIELDS as $f) {
                        $v = $d['data'][$f] ?? null;
                        if (is_string($v) && $v !== '') self::append($spaceId, $itemId, 'p', json_encode(['f' => $f, 'v' => $v], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $u['id']);
                    }
                });
            } catch (\PDOException) {}   // someone else started it at the same moment
        }
        return ['entries' => self::entries($spaceId, $itemId, $after)];
    }

    /** POST ytext/compact: replace entries 1…n with a snapshot of their merged state. */
    public static function compact(array $u, string $spaceId, array $in): array
    {
        $itemId = (string) ($in['id'] ?? ''); $upto = (int) ($in['n'] ?? 0); $s = (string) ($in['s'] ?? '');
        if ($upto < 2 || !self::valid($s)) Http::fail(400, 'Invalid snapshot');
        $space = Access::space($spaceId);
        $item = self::item($spaceId, $itemId);
        if (!$item || !Access::atLeast(Access::boards($u['id'], $space)[$item['parent']] ?? null, 'editor')) Http::fail(403, 'You can’t edit this card');
        Db::tx(function () use ($spaceId, $itemId, $upto, $s, $u) {
            Db::q('UPDATE spaces SET acl_rev = acl_rev WHERE id = ?', [$spaceId]);   // one writer per space at a time
            if (!Db::one('SELECT n FROM ylog WHERE space_id = ? AND item_id = ? AND n = ?', [$spaceId, $itemId, $upto])) return;
            Db::q('DELETE FROM ylog WHERE space_id = ? AND item_id = ? AND n <= ?', [$spaceId, $itemId, $upto]);
            Db::q('INSERT INTO ylog (space_id, item_id, n, kind, data, user_id, at) VALUES (?,?,?,?,?,?,?)', [$spaceId, $itemId, $upto, 's', $s, $u['id'], time()]);
        });
        return ['ok' => true];
    }

    /**
     * During a push (inside its transaction): store the browser's Yjs updates and return every card's entries it hasn't seen.
     * $y: card id => ['n' => last entry the browser has, 'u' => base64 update or absent]. $vis: the person's board roles.
     */
    public static function exchange(array $u, string $spaceId, array $y, array $vis): array
    {
        $out = [];
        foreach (array_slice($y, 0, 50, true) as $id => $e) {
            $id = (string) $id;
            if (!is_array($e) || !preg_match('/^[\w.-]{1,64}$/', $id)) continue;
            $item = self::item($spaceId, $id);
            if (!$item || !isset($vis[$item['parent']])) continue;
            if (isset($e['u']) && is_string($e['u']) && $e['u'] !== '') {
                if (!self::valid($e['u'])) Http::fail(400, 'Invalid text update');
                if (!Access::atLeast($vis[$item['parent']], 'editor')) Http::fail(403, 'You can’t edit this card');
                self::append($spaceId, $id, 'u', $e['u'], $u['id']);
            }
            $out[$id] = self::entries($spaceId, $id, (int) ($e['n'] ?? 0));
        }
        return $out;
    }

    /** Entries after the given ones, for cards a pulling browser has open: "id:n,id:n". */
    public static function since(string $spaceId, string $spec, array $vis): array
    {
        $out = [];
        foreach (array_slice(explode(',', $spec), 0, 50) as $pair) {
            if (!preg_match('/^([\w.-]{1,64}):(\d{1,9})$/', $pair, $m)) continue;
            $item = self::item($spaceId, $m[1]);
            if ($item && isset($vis[$item['parent']])) $out[$m[1]] = self::entries($spaceId, $m[1], (int) $m[2]);
        }
        return $out;
    }

    /** A card's rich text was set without Yjs (AI, import, older browser): log it so browsers merge it in. */
    public static function plainWrites(string $spaceId, string $itemId, ?array $old, array $new, string $uid): void
    {
        if (!$old) return;
        $changed = array_filter(self::FIELDS, fn($f) => ($old['data'][$f] ?? null) !== ($new['data'][$f] ?? null));
        if (!$changed || !self::has($spaceId, $itemId)) return;
        foreach ($changed as $f) {
            $v = $new['data'][$f] ?? '';
            self::append($spaceId, $itemId, 'p', json_encode(['f' => $f, 'v' => is_string($v) ? $v : ''], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), $uid);
        }
    }

    public static function entries(string $spaceId, string $itemId, int $after): array
    {
        return array_map(fn($r) => ['n' => (int) $r['n'], 'k' => $r['kind'], 'd' => $r['data']],
            Db::q('SELECT n, kind, data FROM ylog WHERE space_id = ? AND item_id = ? AND n > ? ORDER BY n', [$spaceId, $itemId, $after])->fetchAll());
    }

    private static function append(string $spaceId, string $itemId, string $kind, string $data, string $uid): void
    {
        $n = (int) (Db::one('SELECT MAX(n) AS n FROM ylog WHERE space_id = ? AND item_id = ?', [$spaceId, $itemId])['n'] ?? 0) + 1;
        Db::q('INSERT INTO ylog (space_id, item_id, n, kind, data, user_id, at) VALUES (?,?,?,?,?,?,?)', [$spaceId, $itemId, $n, $kind, $data, $uid, time()]);
    }

    private static function has(string $spaceId, string $itemId): bool
    {
        return (bool) Db::one('SELECT n FROM ylog WHERE space_id = ? AND item_id = ? LIMIT 1', [$spaceId, $itemId]);
    }

    private static function item(string $spaceId, string $itemId): ?array
    {
        return Db::one("SELECT parent, data FROM entities WHERE space_id = ? AND kind = 'item' AND id = ? AND deleted = 0", [$spaceId, $itemId]);
    }

    private static function valid(string $b64): bool
    {
        return strlen($b64) <= self::MAX && preg_match('~^[A-Za-z0-9+/]+=*$~', $b64) === 1;
    }

    /** Logs of cards that no longer exist (deleted, or moved to another space). */
    public static function prune(): int
    {
        return Db::q("DELETE FROM ylog WHERE NOT EXISTS (SELECT 1 FROM entities e WHERE e.space_id = ylog.space_id AND e.kind = 'item'
                      AND e.id = ylog.item_id AND e.deleted = 0)")->rowCount();
    }
}
