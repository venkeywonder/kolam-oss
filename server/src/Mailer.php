<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Sends invitation emails over raw SMTP (no mail(), no libraries).
 * Until SMTP is set up in .env, emails are written to storage/mail/ instead (a placeholder outbox: one .eml file per
 * message, openable in any mail app), and the person inviting gets the link to send themselves.
 */
final class Mailer
{
    public static function configured(): bool
    {
        $smtp = Config::get('smtp');
        return $smtp && $smtp['host'] !== '' && $smtp['from'] !== '';
    }

    /** Returns true only when an SMTP server accepted the message. */
    public static function send(string $to, string $subject, string $text, string $html): bool
    {
        $to = str_replace(["\r", "\n"], '', $to);
        $subject = str_replace(["\r", "\n"], '', $subject);
        if (!filter_var($to, FILTER_VALIDATE_EMAIL)) return false;
        if (!self::configured()) { self::outbox($to, $subject, $text, $html); return false; }

        $smtp = Config::get('smtp');
        $sock = null;
        try {
            $sock = self::connect($smtp);
            $host = gethostname() ?: 'localhost';
            $caps = self::ehlo($sock, $host);

            if ($smtp['secure'] === 'tls') {
                self::cmd($sock, "STARTTLS\r\n", 220);
                if (!stream_socket_enable_crypto($sock, true, STREAM_CRYPTO_METHOD_TLSv1_2_CLIENT | STREAM_CRYPTO_METHOD_TLSv1_3_CLIENT)) {
                    throw new \RuntimeException('STARTTLS handshake failed');
                }
                $caps = self::ehlo($sock, $host);
            }

            if ($smtp['user'] !== '') {
                self::auth($sock, $smtp['user'], $smtp['pass'], $caps);
            }

            self::cmd($sock, 'MAIL FROM:<' . self::addrOnly($smtp['from']) . ">\r\n", 250);
            self::cmd($sock, "RCPT TO:<$to>\r\n", 250);
            self::cmd($sock, "DATA\r\n", 354);

            $msg = self::buildMessage($smtp, $to, $subject, $text, $html);
            fwrite($sock, self::dotStuff($msg) . "\r\n.\r\n");
            self::readReply($sock, 250);

            self::cmd($sock, "QUIT\r\n", 221);
            fclose($sock);
            return true;
        } catch (\Throwable $e) {
            error_log('[kolam] mail: ' . $e->getMessage());
            if (is_resource($sock)) fclose($sock);
            return false;
        }
    }

    /** The placeholder outbox: storage/mail/<time>-<random>.eml. Files older than 30 days are removed. */
    private static function outbox(string $to, string $subject, string $text, string $html): void
    {
        $dir = Config::get('storage') . '/mail';
        if (!is_dir($dir) && !@mkdir($dir, 0775, true)) return;
        $msg = self::buildMessage(['from' => 'kolam@localhost', 'from_name' => 'Kolam'], $to, $subject, $text, $html);
        @file_put_contents($dir . '/' . date('Ymd-His') . '-' . bin2hex(random_bytes(3)) . '.eml', $msg);
        foreach (glob($dir . '/*.eml') ?: [] as $f) if (filemtime($f) < time() - 30 * 86400) @unlink($f);
    }

    private static function connect(array $smtp): mixed
    {
        $transport = $smtp['secure'] === 'ssl' ? 'ssl' : 'tcp';
        $ctx = stream_context_create(['ssl' => ['verify_peer' => true, 'verify_peer_name' => true]]);
        $sock = @stream_socket_client(
            "$transport://{$smtp['host']}:{$smtp['port']}",
            $errno, $errstr, 10,
            STREAM_CLIENT_CONNECT, $ctx
        );
        if (!$sock) throw new \RuntimeException("Connect failed: $errstr ($errno)");
        stream_set_timeout($sock, 15);
        self::readReply($sock, 220);
        return $sock;
    }

    /** Sends EHLO, returns the set of capability keywords advertised (uppercase). */
    private static function ehlo(mixed $sock, string $host): array
    {
        fwrite($sock, "EHLO $host\r\n");
        $lines = self::readReply($sock, 250);
        $caps = [];
        foreach ($lines as $line) {
            // "250-AUTH LOGIN PLAIN" / "250 AUTH LOGIN"
            if (preg_match('/^250[- ](.+)$/', $line, $m)) $caps[] = strtoupper(trim($m[1]));
        }
        return $caps;
    }

    private static function auth(mixed $sock, string $user, string $pass, array $caps): void
    {
        $authLine = implode(' ', array_filter($caps, static fn($c) => str_starts_with($c, 'AUTH ')));
        $supportsLogin = str_contains($authLine, 'LOGIN') || $authLine === '';
        if ($supportsLogin) {
            self::cmd($sock, "AUTH LOGIN\r\n", 334);
            self::cmd($sock, base64_encode($user) . "\r\n", 334);
            self::cmd($sock, base64_encode($pass) . "\r\n", 235);
        } else {
            self::cmd($sock, "AUTH PLAIN " . base64_encode("\0$user\0$pass") . "\r\n", 235);
        }
    }

    private static function cmd(mixed $sock, string $line, int $expect): array
    {
        fwrite($sock, $line);
        return self::readReply($sock, $expect);
    }

    /** Reads an SMTP multi-line reply (lines continue while the 4th char is '-'); throws if the code doesn't match. */
    private static function readReply(mixed $sock, int $expect): array
    {
        $lines = [];
        do {
            $line = fgets($sock, 2048);
            if ($line === false) {
                $meta = stream_get_meta_data($sock);
                throw new \RuntimeException($meta['timed_out'] ?? false ? 'SMTP read timed out' : 'SMTP connection closed unexpectedly');
            }
            $line = rtrim($line, "\r\n");
            $lines[] = $line;
            $more = isset($line[3]) && $line[3] === '-';
        } while ($more);
        $code = (int) substr($lines[0], 0, 3);
        if ($code !== $expect) throw new \RuntimeException("Unexpected SMTP reply: " . implode(' ', $lines));
        return $lines;
    }

    private static function addrOnly(string $addr): string
    {
        if (preg_match('/<([^>]+)>/', $addr, $m)) return $m[1];
        return $addr;
    }

    private static function encodeHeader(string $s): string
    {
        return preg_match('/^[\x20-\x7E]*$/', $s) ? $s : '=?UTF-8?B?' . base64_encode($s) . '?=';
    }

    private static function buildMessage(array $smtp, string $to, string $subject, string $text, string $html): string
    {
        $fromAddr = $smtp['from'];
        $fromName = self::encodeHeader($smtp['from_name']);
        $domain = substr(strrchr($fromAddr, '@') ?: '@localhost', 1) ?: 'localhost';
        $msgId = bin2hex(random_bytes(16)) . '@' . $domain;
        $boundary = 'nk_' . bin2hex(random_bytes(12));

        $headers = [
            'Date: ' . date('r'),
            "From: \"$fromName\" <$fromAddr>",
            "To: <$to>",
            'Subject: ' . self::encodeHeader($subject),
            'MIME-Version: 1.0',
            "Message-ID: <$msgId>",
            "Content-Type: multipart/alternative; boundary=\"$boundary\"",
        ];

        // real line breaks must be CRLF in the message, or quoted-printable turns them into "=0A"
        $crlf = fn(string $s) => preg_replace("/\r?\n/", "\r\n", $s);
        $body = "--$boundary\r\n"
            . "Content-Type: text/plain; charset=utf-8\r\n"
            . "Content-Transfer-Encoding: quoted-printable\r\n\r\n"
            . quoted_printable_encode($crlf($text)) . "\r\n"
            . "--$boundary\r\n"
            . "Content-Type: text/html; charset=utf-8\r\n"
            . "Content-Transfer-Encoding: quoted-printable\r\n\r\n"
            . quoted_printable_encode($crlf($html)) . "\r\n"
            . "--$boundary--\r\n";

        return implode("\r\n", $headers) . "\r\n\r\n" . $body;
    }

    /** Lines starting with '.' are doubled, per RFC 5321, so the server doesn't mistake them for the end marker. */
    private static function dotStuff(string $msg): string
    {
        return preg_replace('/^\./m', '..', $msg);
    }
}
