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
        $sink = fopen('php://memory', 'w+b');
        $r = Fetch::get($url, $sink, 800000, ['agent' => 'Mozilla/5.0 (compatible; KolamPreview/1.0)',
                                              'headers' => ['Accept: text/html,application/xhtml+xml', 'Accept-Language: en']]);
        $html = $r['code'] ? (string) stream_get_contents($sink, -1, 0) : '';
        fclose($sink);
        $url = $r['url'];   // after redirects, for relative image paths
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
