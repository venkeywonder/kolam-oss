<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Emails the operator (ALERT_EMAIL) about uncaught errors and failed backups. Off by default (empty ALERT_EMAIL).
 * Uncaught-exception alerts are throttled by a small file in storage/run/, so a recurring bug doesn't flood the inbox.
 */
final class Alerts
{
    private const MAX_PER_SIGNATURE_WINDOW = 3600; // one email per distinct error per hour
    private const MAX_PER_DAY = 20;                // overall cap on exception emails per day

    /** Sends one alert email. Never throws: a broken alert must not break the request that triggered it. */
    public static function send(string $subject, string $body): void
    {
        $to = Config::get('alert_email');
        if (!$to) return;
        try {
            Mailer::send($to, '[Kolam] ' . $subject, $body, '<pre style="white-space:pre-wrap">' . htmlspecialchars($body) . '</pre>');
        } catch (\Throwable) {
            // swallow: alerting must never throw
        }
    }

    /** Called from App::run() on every uncaught 500. */
    public static function exception(\Throwable $e): void
    {
        $to = Config::get('alert_email');
        if (!$to) return;
        try {
            $sig = md5(get_class($e) . '|' . $e->getFile() . '|' . $e->getLine());
            if (!self::allow($sig)) return;

            $u = null;
            try { $u = Auth::user(); } catch (\Throwable) {}
            $trace = explode("\n", $e->getTraceAsString());
            $trace = implode("\n", array_slice($trace, 0, 20));

            $body = "Method: " . ($_SERVER['REQUEST_METHOD'] ?? '?') . "\n"
                . "Path: " . ($_SERVER['REQUEST_URI'] ?? '?') . "\n"
                . "User: " . ($u['id'] ?? 'guest') . "\n"
                . "Error: " . get_class($e) . ': ' . $e->getMessage() . "\n"
                . "At: " . $e->getFile() . ':' . $e->getLine() . "\n\n"
                . "Trace:\n" . $trace;

            self::send('Server error: ' . $e->getMessage(), $body);
        } catch (\Throwable) {
            // never let alerting cause a second failure
        }
    }

    /**
     * File-based throttle in storage/run/alerts.json: at most one email per error signature per hour, and at most
     * MAX_PER_DAY exception emails overall per day. Fails open to "don't send" if the database or disk is unavailable,
     * since this runs from inside an exception/error-report path and must never throw itself.
     */
    private static function allow(string $sig): bool
    {
        $dir = Config::get('storage') . '/run';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) return false;
        $file = $dir . '/alerts.json';
        $fh = @fopen($file, 'c+');
        if (!$fh) return false;
        try {
            if (!flock($fh, LOCK_EX)) return false;
            $raw = stream_get_contents($fh);
            $data = $raw ? json_decode($raw, true) : null;
            if (!is_array($data)) $data = ['day' => '', 'count' => 0, 'seen' => []];

            $today = date('Y-m-d');
            if (($data['day'] ?? '') !== $today) { $data['day'] = $today; $data['count'] = 0; }

            $now = time();
            $seen = is_array($data['seen'] ?? null) ? $data['seen'] : [];
            // drop signatures older than the per-signature window so the file doesn't grow forever
            foreach ($seen as $k => $t) if (!is_int($t) || $t < $now - self::MAX_PER_SIGNATURE_WINDOW) unset($seen[$k]);

            $ok = ($data['count'] ?? 0) < self::MAX_PER_DAY && !isset($seen[$sig]);
            if ($ok) {
                $seen[$sig] = $now;
                $data['count'] = ($data['count'] ?? 0) + 1;
            }
            $data['seen'] = $seen;

            ftruncate($fh, 0);
            rewind($fh);
            fwrite($fh, json_encode($data));
            fflush($fh);
            return $ok;
        } finally {
            flock($fh, LOCK_UN);
            fclose($fh);
        }
    }
}
