<?php
declare(strict_types=1);

namespace Kolam;

/** Lets anyone viewing a public share link flag it for abuse, without an account. */
final class Reports
{
    private const REASONS = ['spam', 'phishing', 'malware', 'illegal', 'harassment', 'copyright', 'other'];

    /** Anyone viewing a link can report it; expired links are still reportable. */
    public static function create(string $token, array $in): array
    {
        if (!preg_match('/^[a-f0-9]{24}$/', $token)) Http::fail(404, 'Not found');
        $row = Db::one('SELECT space_id, board_id FROM shares WHERE token = ?', [$token]);
        if (!$row) Http::fail(404, 'Not found');

        RateLimit::hit('report:' . Http::ip(), 5, 3600);

        $reason = Http::str($in, 'reason', 32);
        if (!in_array($reason, self::REASONS, true)) Http::fail(400, 'Choose a reason');
        $details = Http::str($in, 'details', 2000);
        $email = Http::str($in, 'email', 255);
        if ($email !== '' && !filter_var($email, FILTER_VALIDATE_EMAIL)) Http::fail(400, 'That email address looks wrong');

        $id = 'r_' . bin2hex(random_bytes(10));
        Db::q('INSERT INTO reports (id, share_token, space_id, board_id, reason, details, email, ip, status, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
            [$id, $token, $row['space_id'], $row['board_id'], $reason, $details ?: null, $email ?: null, Http::ip(), 'open', time()]);

        $body = "A share link was reported.\n\nReason: $reason\nLink: $token\nBoard: {$row['space_id']}:{$row['board_id']}\n"
            . ($email !== '' ? "From: $email\n" : '') . "IP: " . Http::ip() . "\n\n" . ($details !== '' ? "Details:\n$details\n" : '');
        Alerts::send('Share link reported: ' . $reason, $body);
        $support = Config::get('support_email');
        if ($support) Mailer::send($support, 'Share link reported', $body, '<pre>' . htmlspecialchars($body) . '</pre>');

        return ['ok' => true];
    }
}
