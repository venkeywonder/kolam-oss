<?php
declare(strict_types=1);

namespace Kolam;

/** "Send feedback" from the help menu: a short note from inside the app, emailed to whoever supports Kolam. */
final class Feedback
{
    private const KINDS = ['idea', 'problem', 'question', 'praise'];

    public static function create(array $u, array $in): array
    {
        RateLimit::hit('feedback:' . $u['id'], 10, 3600);

        $kind = Http::str($in, 'kind', 16);
        if (!in_array($kind, self::KINDS, true)) Http::fail(400, 'Choose a kind of feedback');
        $body = Http::str($in, 'body', 5000);
        if ($body === '') Http::fail(400, "Tell us what's on your mind");
        $page = Http::str($in, 'page', 500);
        $ua = substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255);

        $id = 'f_' . bin2hex(random_bytes(10));
        Db::q('INSERT INTO feedback (id, user_id, email, kind, body, page, ua, created_at) VALUES (?,?,?,?,?,?,?,?)',
            [$id, $u['id'], $u['email'], $kind, $body, $page ?: null, $ua ?: null, time()]);

        self::notify($u, $kind, $body, $page);

        return ['ok' => true];
    }

    /** Emails the feedback to SUPPORT_EMAIL (or ALERT_EMAIL if that's not set); never blocks the request on mail failure. */
    private static function notify(array $u, string $kind, string $body, string $page): void
    {
        $to = Config::get('support_email') ?: Config::get('alert_email');
        if (!$to) return;
        $subject = 'Feedback (' . $kind . ') from ' . $u['email'];
        $text = "From: {$u['email']} ({$u['name']})\nKind: $kind\n" . ($page !== '' ? "Page: $page\n" : '') . "\n$body";
        $html = '<p><b>From:</b> ' . htmlspecialchars($u['email'], ENT_QUOTES, 'UTF-8') . ' (' . htmlspecialchars($u['name'], ENT_QUOTES, 'UTF-8') . ')</p>'
            . '<p><b>Kind:</b> ' . htmlspecialchars($kind, ENT_QUOTES, 'UTF-8') . '</p>'
            . ($page !== '' ? '<p><b>Page:</b> ' . htmlspecialchars($page, ENT_QUOTES, 'UTF-8') . '</p>' : '')
            . '<p style="white-space:pre-wrap">' . htmlspecialchars($body, ENT_QUOTES, 'UTF-8') . '</p>';
        try { Mailer::send($to, $subject, $text, $html); } catch (\Throwable) {}
    }
}
