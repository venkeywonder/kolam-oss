<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Live updates and presence.
 * - With REALTIME_URL set, browsers connect to server/bin/realtime (a WebSocket server) using a short-lived signed ticket
 *   from the API, since that process can't read the session cookie of another port or path reliably.
 * - Without it (e.g. shared hosting) browsers poll; the same presence table serves both, so everyone sees everyone.
 */
final class Realtime
{
    private const TICKET_SECS = 60;
    public const STALE = 25;        // seconds without a heartbeat before someone counts as gone

    private static function secret(): string
    {
        $r = Db::one("SELECT v FROM nk_meta WHERE k = 'rt_secret'");
        if ($r) return $r['v'];
        try { Db::q("INSERT INTO nk_meta (k, v) VALUES ('rt_secret', ?)", [bin2hex(random_bytes(32))]); } catch (\PDOException) {}   // a parallel request won
        return Db::one("SELECT v FROM nk_meta WHERE k = 'rt_secret'")['v'];
    }

    /** Tell the realtime server (if this server runs one) to look for changes now rather than at its next check. */
    public static function nudge(): void
    {
        if ((string) Config::get('realtime_url') === '') return;
        $s = @stream_socket_client('udp://' . Config::get('realtime_listen'), $errno, $err, 0);
        if ($s) { @fwrite($s, 'n'); fclose($s); }
    }

    private static function b64(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }

    /** What the browser needs to connect: the WebSocket URL (null = poll instead) and a ticket for it. */
    public static function ticket(array $u): array
    {
        $url = (string) Config::get('realtime_url');
        if ($url === '') return ['url' => null];
        $payload = self::b64(json_encode(['u' => $u['id'], 'exp' => time() + self::TICKET_SECS]));
        return ['url' => $url, 'ticket' => $payload . '.' . self::b64(hash_hmac('sha256', $payload, self::secret(), true))];
    }

    /** The user id a ticket was issued to, or null when it's forged or expired. */
    public static function verify(string $ticket): ?string
    {
        $parts = explode('.', $ticket);
        if (count($parts) !== 2) return null;
        if (!hash_equals(self::b64(hash_hmac('sha256', $parts[0], self::secret(), true)), $parts[1])) return null;
        $d = json_decode((string) base64_decode(strtr($parts[0], '-_', '+/')), true);
        return is_array($d) && is_string($d['u'] ?? null) && (int) ($d['exp'] ?? 0) >= time() ? $d['u'] : null;
    }

    private static function id(mixed $v): ?string
    {
        return is_string($v) && preg_match('/^[\w.-]{1,64}$/', $v) ? $v : null;
    }

    /** Record where a browser tab is: which board, and which card it's typing in. */
    public static function here(string $uid, array $space, string $client, mixed $board, mixed $editing): void
    {
        if (!preg_match('/^[\w-]{4,24}$/', $client)) Http::fail(400, 'Invalid client');
        $boards = Access::boards($uid, $space);
        if (!$boards) Http::fail(404, 'Not found');
        $board = self::id($board);
        if ($board !== null && !isset($boards[$board])) $board = null;
        $editing = $board !== null ? self::id($editing) : null;
        Db::upsert('presence', ['space_id' => $space['id'], 'client' => $client, 'user_id' => $uid, 'board' => $board,
                                'editing' => $editing, 'seen_at' => time()], ['space_id', 'client']);
        if (random_int(1, 50) === 1) Db::q('DELETE FROM presence WHERE seen_at < ?', [time() - 300]);
    }

    public static function leave(string $spaceId, string $client, string $uid): void
    {
        Db::q('DELETE FROM presence WHERE space_id = ? AND client = ? AND user_id = ?', [$spaceId, $client, $uid]);
    }

    /** Presence rows of a space that are still fresh. */
    public static function rows(string $spaceId): array
    {
        return Db::q('SELECT client, user_id, board, editing, seen_at FROM presence WHERE space_id = ? AND seen_at >= ? ORDER BY seen_at DESC',
            [$spaceId, time() - self::STALE])->fetchAll();
    }

    /**
     * Who's in the space, as $uid may see it: one entry per person (their most recent tab), with the board they're on
     * only when $uid can open that board too.
     */
    public static function who(string $uid, array $space, array $rows): array
    {
        $boards = Access::boards($uid, $space);
        $names = Access::names(array_column($rows, 'user_id'));
        $out = [];
        foreach ($rows as $r) {
            if (isset($out[$r['user_id']]) || !isset($names[$r['user_id']])) continue;
            $seen = $r['board'] !== null && isset($boards[$r['board']]);
            $out[$r['user_id']] = ['id' => $r['user_id'], 'name' => $names[$r['user_id']]['name'],
                                   'board' => $seen ? $r['board'] : null, 'editing' => $seen ? $r['editing'] : null];
        }
        return array_values($out);
    }

    /** Polling fallback: report where this tab is, get everyone back. */
    public static function poll(array $u, array $in): array
    {
        $space = Access::space((string) ($in['space'] ?? ''));
        self::here($u['id'], $space, (string) ($in['client'] ?? ''), $in['board'] ?? null, $in['editing'] ?? null);
        return ['people' => self::who($u['id'], $space, self::rows($space['id'])), 'rev' => (int) $space['rev'], 'note' => Notify::latest($u['id'])];
    }
}
