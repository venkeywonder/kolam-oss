<?php
declare(strict_types=1);

namespace Kolam;

/** Keeps automated sign-ups and password-reset spam off the sign-up and forgot-password forms. */
final class Bot
{
    private static ?array $disposable = null;

    /**
     * $action is 'signup' or 'forgot', used only to label the Turnstile check.
     * Fails the request (never returns) when the submission looks automated.
     */
    public static function check(array $in, string $action): void
    {
        // honeypot: a hidden field real browsers never fill in
        if (trim((string) ($in['website'] ?? '')) !== '') Http::fail(422, 'Something went wrong. Please try again.');

        // the form reports how long it was open, in milliseconds; bots submit almost instantly
        $opened = (int) ($in['ms'] ?? 0);
        if ($opened > 0 && $opened < 2000) Http::fail(422, 'Please take a moment and try again.');

        $secret = Config::get('turnstile')['secret'] ?? '';
        if ($secret !== '') {
            $token = (string) ($in['cf-turnstile-response'] ?? $in['turnstile'] ?? '');
            if ($token === '' || !self::verifyTurnstile($secret, $token)) {
                Http::fail(422, "We couldn't verify you're human. Please try again.");
            }
        }
    }

    /** Disposable-email check for sign-up; only enforced when BLOCK_DISPOSABLE_EMAILS is on. */
    public static function checkEmail(string $email): void
    {
        if (!Config::get('block_disposable')) return;
        $domain = strtolower(substr(strrchr($email, '@') ?: '', 1));
        if ($domain === '') return;
        $list = self::disposableDomains();
        // match the domain itself and any of its parent domains (sub.mailinator.com -> mailinator.com)
        $parts = explode('.', $domain);
        for ($i = 0; $i < count($parts) - 1; $i++) {
            if (isset($list[implode('.', array_slice($parts, $i))])) {
                Http::fail(422, 'Please use a permanent email address');
            }
        }
    }

    private static function disposableDomains(): array
    {
        if (self::$disposable !== null) return self::$disposable;
        $lines = @file(__DIR__ . '/disposable-domains.txt', FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) ?: [];
        $map = [];
        foreach ($lines as $line) {
            $line = strtolower(trim($line));
            if ($line !== '' && $line[0] !== '#') $map[$line] = true;
        }
        return self::$disposable = $map;
    }

    private static function verifyTurnstile(string $secret, string $token): bool
    {
        $ch = curl_init('https://challenges.cloudflare.com/turnstile/v0/siteverify');
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => http_build_query(['secret' => $secret, 'response' => $token, 'remoteip' => Http::ip()]),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 8,
        ]);
        $res = curl_exec($ch);
        $err = curl_errno($ch);
        curl_close($ch);
        if ($err || $res === false) return false;
        $data = json_decode($res, true);
        return is_array($data) && !empty($data['success']);
    }
}
