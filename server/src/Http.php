<?php
declare(strict_types=1);

namespace Kolam;

final class HttpError extends \RuntimeException {}

final class Http
{
    public static function json(mixed $data, int $code = 200): never
    {
        http_response_code($code);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        exit;
    }

    public static function fail(int $code, string $msg): never { throw new HttpError($msg, $code); }

    public static function input(int $maxBytes = 20 * 1024 * 1024): array
    {
        $len = (int) ($_SERVER['CONTENT_LENGTH'] ?? 0);
        if ($len > $maxBytes) self::fail(413, 'Request too large');
        $raw = file_get_contents('php://input', false, null, 0, $maxBytes + 1);
        if ($raw === '' || $raw === false) return [];
        $d = json_decode($raw, true);
        if (!is_array($d)) self::fail(400, 'Invalid JSON');
        return $d;
    }

    public static function method(): string { return $_SERVER['REQUEST_METHOD'] ?? 'GET'; }

    /** URL path of the app folder ("" at the domain root, "/kolam" in a sub-folder), taken from the /api/ request. */
    public static function basePath(): string
    {
        $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
        $pos = strpos($uri, '/api/');
        return $pos === false ? '' : substr($uri, 0, $pos);
    }

    /** Absolute URL of the API root, e.g. https://notes.example.com/api (OAuth metadata and MCP clients need full URLs). */
    public static function apiUrl(): string
    {
        $host = (string) ($_SERVER['HTTP_HOST'] ?? 'localhost');
        if (!preg_match('/^[A-Za-z0-9.\-]+(:\d+)?$|^\[[0-9a-fA-F:.]+\](:\d+)?$/', $host)) $host = 'localhost';
        return (self::https() ? 'https' : 'http') . '://' . $host . self::basePath() . '/api';
    }

    public static function https(): bool
    {
        if (!empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off') return true;
        return Config::get('trust_proxy') && strtolower($_SERVER['HTTP_X_FORWARDED_PROTO'] ?? '') === 'https';
    }

    public static function ip(): string
    {
        if (Config::get('trust_proxy') && !empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            return trim(explode(',', $_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
        }
        return $_SERVER['REMOTE_ADDR'] ?? '0.0.0.0';
    }

    /** The visitor's country: ?country=XX, else Cloudflare's CF-IPCountry header; '' when unknown (or Tor). */
    public static function country(): string
    {
        foreach ([$_GET['country'] ?? '', $_SERVER['HTTP_CF_IPCOUNTRY'] ?? ''] as $c) {
            $c = is_string($c) ? strtoupper(trim($c)) : '';
            if (preg_match('/^[A-Z]{2}$/', $c) && $c !== 'XX' && $c !== 'T1') return $c;
        }
        return '';
    }

    /** Countries whose law needs consent before analytics cookies: the EU, EEA, UK and Switzerland (with territories). */
    private const CONSENT_COUNTRIES = ['AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT',
        'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE', 'IS', 'LI', 'NO', 'GB', 'CH',
        'GF', 'GP', 'MQ', 'RE', 'YT', 'MF', 'AX', 'GI', 'JE', 'GG', 'IM'];

    /** Whether the visitor must agree before analytics runs; null when their country is unknown (the browser decides). */
    public static function consentRequired(): ?bool
    {
        $c = self::country();
        return $c === '' ? null : in_array($c, self::CONSENT_COUNTRIES, true);
    }

    /** State-changing requests must carry our custom header (blocks cross-site form posts). */
    public static function requireAjax(): void
    {
        if (($_SERVER['HTTP_X_REQUESTED_WITH'] ?? '') !== 'kolam') self::fail(403, 'Missing request header');
    }

    public static function str(array $in, string $k, int $max = 500): string
    {
        $v = $in[$k] ?? '';
        if (!is_string($v)) self::fail(400, "Invalid $k");
        $v = trim($v);
        if (mb_strlen($v) > $max) self::fail(400, "$k is too long");
        return $v;
    }
}
