<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Small/medium/thumbnail copies of an uploaded image, by longest side. Stored under storage key "<assetId>.<tier>".
 * An upload that already declares them (variantUrls in the upload protocol) wins; anything still missing (old
 * uploads, server-side callers like BoardTools, assets stored straight on S3) is decoded and resized the first
 * time a browser asks for that tier.
 */
final class Variants
{
    public const TIERS = ['t' => 128, 's' => 512, 'm' => 1280];
    private const CONVERTIBLE = ['image/jpeg', 'image/png', 'image/webp', 'image/bmp', 'image/avif'];
    /** Decoding a bitmap needs roughly width*height*4 bytes; refuse past this many pixels so one request can't exhaust memory. */
    private const MAX_PIXELS = 40_000_000;

    /** The tier => mime map for an asset, generating whatever tiers aren't decided yet (0 = no variant, serve the original). */
    public static function ensure(array $asset): array
    {
        $known = is_string($asset['variants'] ?? null) ? (json_decode((string) $asset['variants'], true) ?: []) : [];
        $missing = array_values(array_diff(array_keys(self::TIERS), array_keys($known)));
        if (!$missing) return $known;
        $full = $known + self::generate($asset, $missing);
        Db::q('UPDATE assets SET variants = ? WHERE id = ?', [json_encode($full), $asset['id']]);
        return $full;
    }

    /** Upload complete: $arrived is tier => local tmp file path for whatever the browser PUT to its variant URL.
     *  Keeps only the ones that really sniff as one of our tier formats; the rest are left for lazy generation. */
    public static function fromUpload(string $assetId, array $arrived): array
    {
        $out = [];
        foreach ($arrived as $tier => $tmp) {
            if (!isset(self::TIERS[$tier])) { @unlink($tmp); continue; }
            $mime = (new \finfo(FILEINFO_MIME_TYPE))->file($tmp) ?: '';
            if (!in_array($mime, ['image/webp', 'image/jpeg', 'image/png'], true)) { @unlink($tmp); continue; }
            Assets::storage()->put("$assetId.$tier", $tmp, $mime);
            $out[$tier] = $mime;
        }
        return $out;
    }

    /** Decodes the original once (within the pixel cap) and writes every requested tier still missing. */
    private static function generate(array $asset, array $tiers): array
    {
        $zero = array_fill_keys($tiers, 0);
        if (!in_array($asset['mime'], self::CONVERTIBLE, true) || !function_exists('imagecreatefromstring')) return $zero;
        $tmp = tempnam(sys_get_temp_dir(), 'kv');
        $fh = fopen($tmp, 'wb');
        $got = $fh ? Assets::storage()->read($asset['id'], function (string $c) use ($fh): void { fwrite($fh, $c); }) : false;
        if ($fh) fclose($fh);
        if (!$got) { @unlink($tmp); return $zero; }
        [$w, $h] = @getimagesize($tmp) ?: [0, 0];
        if (!$w || !$h || $w * $h > self::MAX_PIXELS) { @unlink($tmp); return $zero; }
        // give this one request enough room to hold the decoded bitmap plus the resized copies
        $needMb = (int) ($w * $h * 4 * 2.5 / (1024 * 1024)) + 64;
        $curMb = self::iniMb((string) ini_get('memory_limit'));
        if ($curMb !== -1 && $curMb < $needMb) @ini_set('memory_limit', $needMb . 'M');
        $raw = file_get_contents($tmp);
        @unlink($tmp);
        $src = $raw === false ? false : @imagecreatefromstring($raw);
        unset($raw);
        if (!$src) return $zero;
        imagealphablending($src, true);
        $hasAlpha = self::hasAlpha($src, $w, $h);
        $longest = max($w, $h);
        $webp = function_exists('imagewebp');
        $out = [];
        foreach ($tiers as $tier) {
            $cap = self::TIERS[$tier];
            if ($cap >= $longest) { $out[$tier] = 0; continue; }
            $ratio = $cap / $longest;
            $tw = max(1, (int) round($w * $ratio)); $th = max(1, (int) round($h * $ratio));
            $dst = imagecreatetruecolor($tw, $th);
            imagealphablending($dst, false); imagesavealpha($dst, true);
            imagecopyresampled($dst, $src, 0, 0, 0, 0, $tw, $th, $w, $h);
            $vtmp = tempnam(sys_get_temp_dir(), 'kv');
            if ($webp) { imagewebp($dst, $vtmp, 82); $mime = 'image/webp'; }
            elseif ($hasAlpha) { imagepng($dst, $vtmp, 6); $mime = 'image/png'; }
            else { imagejpeg($dst, $vtmp, 85); $mime = 'image/jpeg'; }

            Assets::storage()->put("{$asset['id']}.$tier", $vtmp, $mime);
            $out[$tier] = $mime;
        }
        return $out;
    }

    /** A handful of sample pixels rather than scanning every one, just to pick PNG (alpha) vs JPEG when WebP isn't available. */
    private static function hasAlpha(\GdImage $im, int $w, int $h): bool
    {
        if (!imageistruecolor($im)) return false;
        for ($i = 0; $i < 12; $i++) {
            $x = min($w - 1, intdiv($w * $i, 12)); $y = min($h - 1, intdiv($h * $i, 12));
            if ((imagecolorat($im, $x, $y) >> 24) & 0x7F) return true;
        }
        return false;
    }

    private static function iniMb(string $v): int
    {
        if ($v === '-1' || $v === '') return -1;
        $n = (int) $v;
        return match (strtolower(substr($v, -1))) {
            'g' => $n * 1024,
            'k' => intdiv($n, 1024),
            default => $n,
        };
    }
}
