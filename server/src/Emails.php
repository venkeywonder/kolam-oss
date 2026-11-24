<?php
declare(strict_types=1);

namespace Kolam;

/** One shared, plain HTML layout for every transactional email Kolam sends. */
final class Emails
{
    /** Verify-email link, valid for 3 days. */
    public static function verify(string $to, string $name, string $token): void
    {
        $url = Invites::appUrl() . '/?verify=' . $token;
        $body = "<p>Hi " . self::safeName($name) . ",</p>"
            . "<p>Click the button below to confirm this is your email address.</p>"
            . self::button('Confirm email', $url)
            . "<p>This link works for 3 days. If you didn't create a Kolam account, you can ignore this email.</p>";
        $text = "Hi {$name},\n\nConfirm your email address by opening this link:\n{$url}\n\n"
            . "This link works for 3 days. If you didn't create a Kolam account, you can ignore this email.";
        Mailer::send($to, 'Confirm your email address', $text, self::layout('Confirm your email', $body));
    }

    /** Password-reset link, valid for 1 hour. $first: the account has no password yet (made with Google) and asked to set one. */
    public static function reset(string $to, string $name, string $token, bool $first = false): void
    {
        $url = Invites::appUrl() . '/?reset=' . $token;
        if ($first) {
            $body = "<p>Hi " . self::safeName($name) . ",</p>"
                . "<p>Click the button below to choose a password for your Kolam account, so you can also sign in with your email address and password.</p>"
                . self::button('Choose a password', $url)
                . "<p>This link works for 1 hour. Choosing a password signs you out on your other devices.</p>";
            $text = "Hi {$name},\n\nChoose a password for your Kolam account by opening this link:\n{$url}\n\n"
                . "This link works for 1 hour. Choosing a password signs you out on your other devices.";
            Mailer::send($to, 'Choose a password', $text, self::layout('Choose a password', $body));
            return;
        }
        $body = "<p>Hi " . self::safeName($name) . ",</p>"
            . "<p>Someone asked to reset the password for this Kolam account. Click the button below to choose a new one.</p>"
            . self::button('Choose a new password', $url)
            . "<p>This link works for 1 hour. If you didn't ask for this, you can ignore this email; your password stays the same.</p>";
        $text = "Hi {$name},\n\nReset your Kolam password by opening this link:\n{$url}\n\n"
            . "This link works for 1 hour. If you didn't ask for this, you can ignore this email; your password stays the same.";
        Mailer::send($to, 'Reset your password', $text, self::layout('Reset your password', $body));
    }

    /** Security notice: a Google account can now sign in to this Kolam account. */
    public static function googleConnected(string $to, string $name, string $googleEmail): void
    {
        $g = htmlspecialchars($googleEmail, ENT_QUOTES, 'UTF-8');
        $settings = Invites::appUrl() . '/#/account/security';
        $body = "<p>Hi " . self::safeName($name) . ",</p>"
            . "<p>The Google account <b>{$g}</b> can now sign in to your Kolam account.</p>"
            . "<p>If this wasn't you, open Account settings, disconnect Google and sign out your other devices.</p>"
            . self::button('Open Account settings', $settings);
        $text = "Hi {$name},\n\nThe Google account {$googleEmail} can now sign in to your Kolam account.\n\n"
            . "If this wasn't you, open Account settings, disconnect Google and sign out your other devices:\n{$settings}";
        Mailer::send($to, 'Google sign-in connected', $text, self::layout('Google sign-in connected', $body));
    }

    /** Sent once, after the address is confirmed (or right away when verification is off and SMTP is set up). */
    public static function welcome(string $to, string $name): void
    {
        $appUrl = Invites::appUrl();
        $site = Config::get('site_url');
        $helpLine = $site ? "<p>Need a hand? Visit <a href=\"{$site}/help\" style=\"color:#f4511c\">our help page</a>.</p>" : '';
        $helpText = $site ? "\nNeed a hand? {$site}/help\n" : '';
        $body = "<p>Hi " . self::safeName($name) . ",</p>"
            . "<p>Welcome to Kolam, a visual board for your notes, files and ideas, organised the way you think.</p>"
            . self::button('Open Kolam', $appUrl)
            . $helpLine;
        $text = "Hi {$name},\n\nWelcome to Kolam, a visual board for your notes, files and ideas, organised the way you think.\n\nOpen Kolam: {$appUrl}\n{$helpText}";
        Mailer::send($to, 'Welcome to Kolam', $text, self::layout('Welcome to Kolam', $body));
    }

    private static function safeName(string $name): string
    {
        return htmlspecialchars($name !== '' ? $name : 'there', ENT_QUOTES, 'UTF-8');
    }

    private static function button(string $label, string $url): string
    {
        $href = htmlspecialchars($url, ENT_QUOTES, 'UTF-8');
        $label = htmlspecialchars($label, ENT_QUOTES, 'UTF-8');
        return "<table role=\"presentation\" cellpadding=\"0\" cellspacing=\"0\" style=\"margin:24px 0\"><tr><td style=\"border-radius:6px;background:#1b2536\">"
            . "<a href=\"{$href}\" style=\"display:inline-block;padding:12px 24px;color:#ffffff;font-weight:600;font-size:15px;text-decoration:none;border-radius:6px;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif\">{$label}</a>"
            . "</td></tr></table>"
            . "<p style=\"font-size:12px;color:#8d929a;word-break:break-all\">Or paste this link into your browser:<br>{$href}</p>";
    }

    /** Inline-styled table layout with the Kolam emblem; renders consistently in Gmail and Outlook. */
    public static function layout(string $title, string $bodyHtml): string
    {
        $title = htmlspecialchars($title, ENT_QUOTES, 'UTF-8');
        $support = Config::get('support_email');
        $footer = $support
            ? "Questions? Write to <a href=\"mailto:" . htmlspecialchars($support, ENT_QUOTES, 'UTF-8') . "\" style=\"color:#8d929a\">{$support}</a>"
            : 'Kolam';
        // a PNG made by brand/generate.py (mail apps block SVG), served by the app; versioned by its content so
        // a new emblem is never hidden behind a cached copy of the old one
        $png = '/src/assets/email-emblem.png';
        $emblem = htmlspecialchars(Invites::appUrl() . $png . '?v=' . substr(md5_file(dirname(__DIR__, 2) . $png), 0, 8), ENT_QUOTES, 'UTF-8');
        return <<<HTML
<!doctype html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{$title}</title></head>
<body style="margin:0;padding:0;background:#ebedee;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#ebedee;padding:32px 16px">
<tr><td align="center">
<table role="presentation" width="100%" style="max-width:480px;background:#ffffff;border-radius:8px;padding:32px" cellpadding="0" cellspacing="0">
<tr><td style="padding-bottom:20px"><table role="presentation" cellpadding="0" cellspacing="0"><tr>
<td style="padding-right:10px;vertical-align:middle"><img src="{$emblem}" width="32" height="32" alt="" style="display:block;border:0;border-radius:8px"></td>
<td style="font-size:20px;font-weight:700;color:#1b2536;vertical-align:middle;font-family:Georgia,'Times New Roman',serif">Kolam</td>
</tr></table></td></tr>
<tr><td style="font-size:15px;line-height:1.55;color:#323b4a">{$bodyHtml}</td></tr>
</table>
<table role="presentation" width="100%" style="max-width:480px" cellpadding="0" cellspacing="0">
<tr><td style="font-size:12px;color:#8d929a;padding:16px 4px;text-align:center">{$footer}</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
HTML;
    }
}
