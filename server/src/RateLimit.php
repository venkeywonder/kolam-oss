<?php
declare(strict_types=1);

namespace Kolam;

/** Fixed-window counters stored in the database (works across several app servers). */
final class RateLimit
{
    public static function hit(string $key, int $max, int $window): void
    {
        $now = time();
        $row = Db::one('SELECT hits, reset_at FROM rate_limits WHERE k = ?', [$key]);
        if (!$row || $row['reset_at'] < $now) {
            Db::upsert('rate_limits', ['k' => $key, 'hits' => 1, 'reset_at' => $now + $window], ['k']);
            return;
        }
        if ($row['hits'] >= $max) Http::fail(429, 'Too many attempts. Try again in a few minutes.');
        Db::q('UPDATE rate_limits SET hits = hits + 1 WHERE k = ?', [$key]);
    }

    public static function clear(string $key): void { Db::q('DELETE FROM rate_limits WHERE k = ?', [$key]); }
}
