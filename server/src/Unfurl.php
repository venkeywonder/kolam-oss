<?php
declare(strict_types=1);

namespace Kolam;

/** Fetches a page's title, description and preview image. Refuses private and local addresses. */
final class Unfurl
{
    public static function fetch(string $url): array
    {
        if (!preg_match('~^https?://~i', $url) || !filter_var($url, FILTER_VALIDATE_URL)) Http::fail(400, 'Invalid URL');
        $out = ['url' => $url, 'site' => preg_replace('/^www\./', '', (string) parse_url($url, PHP_URL_HOST))];
        $html = '';
        for ($hop = 0; $hop < 4; $hop++) {
            $p = parse_url($url);
            $host = $p['host'] ?? '';
            $port = $p['port'] ?? (strtolower($p['scheme']) === 'https' ? 443 : 80);
            $ip = gethostbyname($host);
            if (!filter_var($ip, FILTER_VALIDATE_IP, FILTER_FLAG_NO_PRIV_RANGE | FILTER_FLAG_NO_RES_RANGE)) return $out;
            $ch = curl_init($url);
            curl_setopt_array($ch, [
                CURLOPT_RETURNTRANSFER => true, CURLOPT_FOLLOWLOCATION => false, CURLOPT_TIMEOUT => 6,
                CURLOPT_RESOLVE => ["$host:$port:$ip"],   // pin the checked address
                CURLOPT_PROTOCOLS => CURLPROTO_HTTP | CURLPROTO_HTTPS,
                CURLOPT_USERAGENT => 'Mozilla/5.0 (compatible; KolamPreview/1.0)',
                CURLOPT_HTTPHEADER => ['Accept: text/html,application/xhtml+xml', 'Accept-Language: en'],
                CURLOPT_RANGE => '0-800000', CURLOPT_ENCODING => '',
            ]);
            $body = curl_exec($ch);
            $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            $next = curl_getinfo($ch, CURLINFO_REDIRECT_URL);
            if ($code >= 300 && $code < 400 && $next && preg_match('~^https?://~i', $next)) { $url = $next; continue; }
            $html = is_string($body) ? substr($body, 0, 800000) : '';
            break;
        }
        if (!$html) return $out;
        $meta = function (array $names) use ($html): string {
            foreach ($names as $n) {
                $q = preg_quote($n, '~');
                if (preg_match('~<meta[^>]+(?:property|name)=["\']' . $q . '["\'][^>]*content=["\']([^"\']*)["\']~i', $html, $m)) return $m[1];
                if (preg_match('~<meta[^>]+content=["\']([^"\']*)["\'][^>]*(?:property|name)=["\']' . $q . '["\']~i', $html, $m)) return $m[1];
            }
            return '';
        };
        $dec = fn($s) => trim(html_entity_decode($s, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
        $title = $meta(['og:title', 'twitter:title']);
        if (!$title && preg_match('~<title[^>]*>(.*?)</title>~is', $html, $m)) $title = $m[1];
        $out['title'] = mb_substr($dec($title), 0, 200);
        $out['desc'] = mb_substr($dec($meta(['og:description', 'twitter:description', 'description'])), 0, 300);
        $img = $dec($meta(['og:image', 'og:image:url', 'twitter:image']));
        if ($img && !preg_match('~^https?://~i', $img)) {
            $p = parse_url($url);
            $base = $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
            $img = str_starts_with($img, '//') ? $p['scheme'] . ':' . $img : $base . '/' . ltrim($img, '/');
        }
        if ($img) $out['img'] = $img;
        if ($site = $dec($meta(['og:site_name']))) $out['siteName'] = $site;
        return $out;
    }
}
