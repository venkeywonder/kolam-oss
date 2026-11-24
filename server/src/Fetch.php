<?php
declare(strict_types=1);

namespace Kolam;

/**
 * GET a URL someone gave us, from the server: refuses private and local addresses (checked at every redirect and pinned,
 * so DNS can't swap in another address between the check and the request), and stops reading at $max bytes.
 */
final class Fetch
{
    /**
     * Streams the body into $sink. Returns ['code' => HTTP status, 'url' => final URL, 'bytes' => written, 'over' => cut at $max],
     * or code 0 with 'refused' => 'url' | 'private' | 'redirects' when nothing was fetched.
     * Options: https_only, timeout (s), agent, headers.
     */
    public static function get(string $url, $sink, int $max, array $o = []): array
    {
        $https = !empty($o['https_only']);
        for ($hop = 0; $hop < 5; $hop++) {
            if (!preg_match($https ? '~^https://~i' : '~^https?://~i', $url) || !filter_var($url, FILTER_VALIDATE_URL)) {
                return ['code' => 0, 'url' => $url, 'refused' => 'url'];
            }
            $p = parse_url($url);
            $host = $p['host'] ?? '';
            $port = $p['port'] ?? (strtolower($p['scheme']) === 'https' ? 443 : 80);
            $ip = gethostbyname($host);
            if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) {
                return ['code' => 0, 'url' => $url, 'refused' => 'private'];
            }
            ftruncate($sink, 0);
            rewind($sink);
            $bytes = 0; $over = false;
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => $o['timeout'] ?? 6, CURLOPT_CONNECTTIMEOUT => 5,
                CURLOPT_RESOLVE => ["$host:$port:$ip"],   // pin the checked address
                CURLOPT_PROTOCOLS => $https ? CURLPROTO_HTTPS : CURLPROTO_HTTP | CURLPROTO_HTTPS,
                CURLOPT_USERAGENT => $o['agent'] ?? 'Mozilla/5.0 (compatible; KolamBot/1.0)',
                CURLOPT_HTTPHEADER => $o['headers'] ?? [],
                CURLOPT_RANGE => '0-' . ($max - 1), CURLOPT_ENCODING => '',
                // servers may ignore the range: stop reading once $max bytes are in
                CURLOPT_WRITEFUNCTION => function ($ch, string $chunk) use ($sink, $max, &$bytes, &$over): int {
                    $room = $max - $bytes;
                    if (strlen($chunk) > $room) { $over = true; $chunk = substr($chunk, 0, $room); }
                    $bytes += (int) fwrite($sink, $chunk);
                    return $over ? 0 : strlen($chunk);   // 0 aborts the transfer
                },
            ]);
            curl_exec($ch);
            $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $next = curl_getinfo($ch, CURLINFO_REDIRECT_URL);
            if ($code >= 300 && $code < 400 && is_string($next) && $next !== '') { $url = $next; continue; }
            return ['code' => $code, 'url' => $url, 'bytes' => $bytes, 'over' => $over];
        }
        return ['code' => 0, 'url' => $url, 'refused' => 'redirects'];
    }
}
