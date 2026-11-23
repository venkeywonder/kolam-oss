<?php
declare(strict_types=1);

namespace Kolam;

/** Converts between card rich text (a small HTML subset, see src/core/sanitize.js) and Markdown/plain text. */
final class Text
{
    /** Card HTML → readable plain text. */
    public static function plain(?string $html): string
    {
        $h = (string) $html;
        $h = preg_replace('~<br\s*/?>~i', "\n", $h);
        $h = preg_replace('~<li[^>]*>~i', "\n- ", $h);
        $h = preg_replace('~</(p|div|h[1-6]|blockquote|pre|ul|ol)>~i', "\n", $h);
        $t = html_entity_decode(strip_tags($h), ENT_QUOTES | ENT_HTML5, 'UTF-8');
        $t = preg_replace("/[ \t]+\n/", "\n", $t);
        $t = preg_replace("/\n{3,}/", "\n\n", $t);
        return trim($t);
    }

    /** Markdown (headings, lists, quotes, code, bold, italic, links) → card HTML. */
    public static function html(string $md): string
    {
        $md = trim(str_replace("\r\n", "\n", $md));
        if ($md === '') return '';
        $out = ''; $para = []; $list = null; $code = null;
        $flush = function () use (&$out, &$para) {
            if ($para) $out .= '<p>' . implode('<br>', array_map([self::class, 'inline'], $para)) . '</p>';
            $para = [];
        };
        $close = function () use (&$out, &$list) { if ($list) $out .= "</$list>"; $list = null; };
        foreach (explode("\n", $md) as $line) {
            if ($code !== null) {
                if (preg_match('/^\s*```/', $line)) { $out .= '<pre><code>' . htmlspecialchars(implode("\n", $code)) . '</code></pre>'; $code = null; }
                else $code[] = $line;
                continue;
            }
            if (preg_match('/^\s*```/', $line)) { $flush(); $close(); $code = []; continue; }
            if (trim($line) === '') { $flush(); $close(); continue; }
            if (preg_match('/^(#{1,6})\s+(.*)$/', $line, $m)) {
                $flush(); $close();
                $n = min(3, strlen($m[1]));
                $out .= "<h$n>" . self::inline($m[2]) . "</h$n>";
            } elseif (preg_match('/^\s*([-*•]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*)$/u', $line, $m)) {
                $tag = ctype_digit($m[1][0]) ? 'ol' : 'ul';
                $flush();
                if ($list !== $tag) { $close(); $out .= "<$tag>"; $list = $tag; }
                $out .= '<li>' . self::inline($m[2]) . '</li>';
            } elseif (preg_match('/^>\s?(.*)$/', $line, $m)) {
                $flush(); $close();
                $out .= '<blockquote>' . self::inline($m[1]) . '</blockquote>';
            } else {
                $close();
                $para[] = $line;
            }
        }
        if ($code !== null) $out .= '<pre><code>' . htmlspecialchars(implode("\n", $code)) . '</code></pre>';
        $flush(); $close();
        return $out;
    }

    private static function inline(string $s): string
    {
        $s = htmlspecialchars(trim($s), ENT_QUOTES);
        $s = preg_replace('/`([^`]+)`/', '<code>$1</code>', $s);
        $s = preg_replace('/\*\*(.+?)\*\*|__(.+?)__/', '<b>$1$2</b>', $s);
        $s = preg_replace('/(?<![*\w])\*(?!\s)(.+?)(?<!\s)\*(?!\*)|(?<![\w])_(?!\s)(.+?)(?<!\s)_(?![\w])/', '<i>$1$2</i>', $s);
        $s = preg_replace('/~~(.+?)~~/', '<s>$1</s>', $s);
        return preg_replace('/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/', '<a href="$2">$1</a>', $s);
    }
}
