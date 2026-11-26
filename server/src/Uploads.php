<?php
declare(strict_types=1);

namespace Kolam;

use Kolam\Storage\S3Storage;

/**
 * Chunked uploads (POST assets/uploads and friends): a browser declares a file, PUTs it in 8 MiB parts (and
 * optionally pre-made thumbnail variants), then completes it into a normal assets row. Replaces the old single
 * multipart POST, which couldn't resume and loaded whole files into PHP's memory. With ASSET_DRIVER=s3 and
 * S3_DIRECT_UPLOADS=true the parts go straight from the browser to the bucket with presigned URLs instead.
 */
final class Uploads
{
    public const PART_SIZE = 8 * 1024 * 1024;
    private const MAX_VARIANT_BYTES = 4 * 1024 * 1024;

    private static function dir(string $id): string { return Config::get('storage') . '/uploads/' . $id; }

    /** The upload row, only for the browser that started it. */
    private static function own(array $u, string $id): array
    {
        $up = Db::one('SELECT * FROM uploads WHERE id = ? AND user_id = ?', [$id, $u['id']]);
        return $up ?? Http::fail(404, 'No upload like that');
    }

    private static function cleanName(string $name): string
    {
        return mb_substr(preg_replace('/[\x00-\x1f"\\\\\/]/u', '', $name) ?: 'file', 0, 200);
    }

    private static function rmdir(string $dir): void
    {
        if (!is_dir($dir)) return;
        foreach (scandir($dir) ?: [] as $f) if ($f !== '.' && $f !== '..') @unlink("$dir/$f");
        @rmdir($dir);
    }

    /** POST assets/uploads */
    public static function init(array $u, array $in): array
    {
        Auth::requireVerified($u);
        RateLimit::hit('upload:' . $u['id'], 2000, 3600);
        $name = self::cleanName((string) ($in['name'] ?? 'file'));
        $type = mb_substr((string) ($in['type'] ?? 'application/octet-stream'), 0, 120);
        $size = (int) ($in['size'] ?? 0);
        if ($size <= 0) Http::fail(400, 'Missing size');
        if ($size > Config::get('max_upload_mb') * 1024 * 1024) Http::fail(413, 'That file is too large');

        // same space resolution as the old single-shot upload: the space param, falling back to the home workspace
        $sid = is_string($in['space'] ?? null) ? $in['space'] : '';
        $space = $sid !== '' && preg_match('/^[uw]_[a-f0-9]{16,24}$/', $sid) ? (Db::one('SELECT * FROM spaces WHERE id = ? AND deleted_at IS NULL', [$sid]) ?: null) : null;
        if (!$space || !Access::boards($u['id'], $space)) $space = Spaces::home($u['id']);

        $id = 'up_' . bin2hex(random_bytes(12));
        $assetId = 'a_' . bin2hex(random_bytes(12));
        $parts = max(1, (int) ceil($size / self::PART_SIZE));
        $target = Config::get('asset_driver') === 's3' && Config::get('s3_direct_uploads') ? 's3' : 'local';
        $declared = is_array($in['variants'] ?? null) ? array_intersect_key($in['variants'], Variants::TIERS) : [];

        $s3UploadId = null;
        if ($target === 's3' && $parts > 1) $s3UploadId = Assets::storage()->createMultipartUpload($assetId, $type);
        if ($target === 'local') @mkdir(self::dir($id), 0775, true);

        $row = ['id' => $id, 'user_id' => $u['id'], 'space_id' => $space['id'], 'asset_id' => $assetId, 'name' => $name,
                'type' => $type, 'size' => $size, 'part_size' => self::PART_SIZE, 'parts' => $parts, 'target' => $target,
                's3_upload_id' => $s3UploadId, 'variants' => json_encode($declared), 'created_at' => time()];
        Db::q('INSERT INTO uploads (id, user_id, space_id, asset_id, name, type, size, part_size, parts, target, s3_upload_id, variants, created_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)', array_values($row));

        return ['id' => $id, 'asset' => $assetId, 'partSize' => self::PART_SIZE, 'parts' => $parts, 'target' => $target] + self::urls($row);
    }

    /** Fresh presigned URLs for an S3-direct upload; empty for local (the browser PUTs to our own routes below). */
    private static function urls(array $up): array
    {
        if ($up['target'] !== 's3') return [];
        $storage = Assets::storage();
        $urls = [];
        if ((int) $up['parts'] > 1) {
            for ($n = 1; $n <= (int) $up['parts']; $n++) $urls[] = $storage->presignPut($up['asset_id'], 3600, (string) $up['s3_upload_id'], $n);
        } else {
            $urls[] = $storage->presignPut($up['asset_id']);
        }
        $variantUrls = [];
        foreach (array_keys(json_decode((string) $up['variants'], true) ?: []) as $tier) {
            $variantUrls[$tier] = $storage->presignPut("{$up['asset_id']}.$tier");
        }
        return ['urls' => $urls, 'variantUrls' => $variantUrls];
    }

    /** PUT assets/uploads/{id}/parts/{n}: raw body, local target only. */
    public static function putPart(array $u, string $id, int $n): array
    {
        $up = self::own($u, $id);
        if ($up['target'] !== 'local') Http::fail(400, 'This upload goes straight to the bucket');
        if ($n < 1 || $n > (int) $up['parts']) Http::fail(400, 'Bad part number');
        $expected = $n < (int) $up['parts'] ? (int) $up['part_size'] : (int) $up['size'] - (int) $up['part_size'] * ((int) $up['parts'] - 1);
        @mkdir(self::dir($id), 0775, true);
        $tmp = self::dir($id) . "/part-$n.tmp";
        $in = fopen('php://input', 'rb');
        $out = fopen($tmp, 'wb');
        $total = 0;
        while (!feof($in)) {
            $chunk = fread($in, 1 << 20);
            if ($chunk === false) break;
            $total += strlen($chunk);
            if ($total > $expected) break;   // stop reading an oversized body rather than buffering it all
            fwrite($out, $chunk);
        }
        fclose($in); fclose($out);
        if ($total !== $expected) { @unlink($tmp); Http::fail(400, 'Wrong part size'); }
        rename($tmp, self::dir($id) . "/part-$n");
        return ['ok' => true];
    }

    /** PUT assets/uploads/{id}/variants/{t|s|m}: raw body (<=4 MiB), local target only. */
    public static function putVariant(array $u, string $id, string $tier): array
    {
        $up = self::own($u, $id);
        if ($up['target'] !== 'local') Http::fail(400, 'This upload goes straight to the bucket');
        if (!isset(Variants::TIERS[$tier])) Http::fail(400, 'Bad tier');
        $raw = file_get_contents('php://input', false, null, 0, self::MAX_VARIANT_BYTES + 1);
        if ($raw === false || strlen($raw) === 0 || strlen($raw) > self::MAX_VARIANT_BYTES) Http::fail(413, 'Variant too large');
        @mkdir(self::dir($id), 0775, true);
        file_put_contents(self::dir($id) . "/variant-$tier", $raw);
        return ['ok' => true];
    }

    /** GET assets/uploads/{id}: what already arrived, plus fresh URLs, so a dropped connection can resume. */
    public static function status(array $u, string $id): array
    {
        $up = self::own($u, $id);
        $parts = []; $variants = [];
        if ($up['target'] === 's3') {
            if ((int) $up['parts'] > 1) $parts = Assets::storage()->listParts($up['asset_id'], (string) $up['s3_upload_id']);
            foreach (array_keys(json_decode((string) $up['variants'], true) ?: []) as $tier) {
                if (Assets::storage()->headSize("{$up['asset_id']}.$tier") !== null) $variants[] = $tier;
            }
        } else {
            for ($n = 1; $n <= (int) $up['parts']; $n++) {
                $p = self::dir($id) . "/part-$n";
                if (is_file($p)) $parts[] = ['n' => $n, 'size' => filesize($p)];
            }
            foreach (array_keys(Variants::TIERS) as $tier) {
                if (is_file(self::dir($id) . "/variant-$tier")) $variants[] = $tier;
            }
        }
        return ['parts' => $parts, 'variants' => $variants] + self::urls($up);
    }

    /** POST assets/uploads/{id}/complete */
    public static function complete(array $u, string $id): array
    {
        $up = self::own($u, $id);
        $assetId = $up['asset_id'];
        if ($up['target'] === 's3') {
            if ((int) $up['parts'] > 1) {
                // the parts as the bucket has them (not ETags from the browser: reading those needs the bucket's CORS to
                // expose them, and the browser could send anything)
                $parts = Assets::storage()->listParts($assetId, (string) $up['s3_upload_id']);
                if (count(array_unique(array_column($parts, 'n'))) !== (int) $up['parts']) Http::fail(400, 'Missing parts');
                Assets::storage()->completeMultipartUpload($assetId, (string) $up['s3_upload_id'], $parts);
            }
            $size = Assets::storage()->headSize($assetId);
            if ($size === null || $size !== (int) $up['size']) {
                Assets::storage()->delete($assetId);
                Db::q('DELETE FROM uploads WHERE id = ?', [$id]);
                Http::fail(400, 'Size mismatch');
            }
            $head = Assets::storage()->readRange($assetId, 65536);
            $mime = self::sniff($head, (string) $up['type'], $up['name']);
            Db::upsert('assets', ['id' => $assetId, 'user_id' => $u['id'], 'space_id' => $up['space_id'], 'mime' => $mime,
                'size' => $size, 'name' => $up['name'], 'created_at' => time()], ['id']);
            $variants = [];
            foreach (array_keys(json_decode((string) $up['variants'], true) ?: []) as $tier) {
                $key = "$assetId.$tier";
                $vsize = Assets::storage()->headSize($key);
                $vhead = $vsize !== null && $vsize > 0 && $vsize <= self::MAX_VARIANT_BYTES ? Assets::storage()->readRange($key, $vsize) : null;
                $vmime = $vhead !== null ? self::sniffTmp($vhead) : null;
                if (in_array($vmime, ['image/webp', 'image/jpeg', 'image/png'], true)) $variants[$tier] = $vmime;
                else Assets::storage()->delete($key);
            }
            if ($variants) Db::q('UPDATE assets SET variants = ? WHERE id = ?', [json_encode($variants), $assetId]);
        } else {
            $total = 0;
            for ($n = 1; $n <= (int) $up['parts']; $n++) {
                $p = self::dir($id) . "/part-$n";
                if (!is_file($p)) { self::rmdir(self::dir($id)); Db::q('DELETE FROM uploads WHERE id = ?', [$id]); Http::fail(400, "Missing part $n"); }
                $total += filesize($p);
            }
            if ($total !== (int) $up['size']) {
                self::rmdir(self::dir($id)); Db::q('DELETE FROM uploads WHERE id = ?', [$id]); Http::fail(400, 'Size mismatch');
            }
            $tmp = tempnam(sys_get_temp_dir(), 'ku');
            $out = fopen($tmp, 'wb');
            for ($n = 1; $n <= (int) $up['parts']; $n++) {
                $in2 = fopen(self::dir($id) . "/part-$n", 'rb');
                stream_copy_to_stream($in2, $out);
                fclose($in2);
            }
            fclose($out);
            Assets::store($u['id'], $tmp, $up['name'], (int) $up['size'], $assetId, $up['space_id']);
            $arrived = [];
            foreach (array_keys(Variants::TIERS) as $tier) {
                $vf = self::dir($id) . "/variant-$tier";
                if (is_file($vf)) $arrived[$tier] = $vf;
            }
            $variants = Variants::fromUpload($assetId, $arrived);
            if ($variants) Db::q('UPDATE assets SET variants = ? WHERE id = ?', [json_encode($variants), $assetId]);
            self::rmdir(self::dir($id));
        }
        Db::q('DELETE FROM uploads WHERE id = ?', [$id]);
        $a = Db::one('SELECT id, mime, size, name FROM assets WHERE id = ?', [$assetId]);
        return $a ?? Http::fail(500, 'Upload did not complete');
    }

    /** DELETE assets/uploads/{id} */
    public static function abort(array $u, string $id): array
    {
        $up = self::own($u, $id);
        if ($up['target'] === 's3') {
            if ($up['s3_upload_id']) Assets::storage()->abortMultipartUpload($up['asset_id'], (string) $up['s3_upload_id']);
            else Assets::storage()->delete($up['asset_id']);
            foreach (array_keys(Variants::TIERS) as $tier) Assets::storage()->delete("{$up['asset_id']}.$tier");
        } else {
            self::rmdir(self::dir($id));
        }
        Db::q('DELETE FROM uploads WHERE id = ?', [$id]);
        return ['ok' => true];
    }

    /** Uploads nobody finished in 24h (server/bin/kolam cleanup): abort them and free whatever arrived. */
    public static function pruneStale(): int
    {
        $rows = Db::q('SELECT * FROM uploads WHERE created_at < ?', [time() - 86400])->fetchAll();
        foreach ($rows as $up) {
            if ($up['target'] === 's3') {
                if ($up['s3_upload_id']) {
                    try { Assets::storage()->abortMultipartUpload($up['asset_id'], (string) $up['s3_upload_id']); } catch (\Throwable) {}
                } else {
                    try { Assets::storage()->delete($up['asset_id']); } catch (\Throwable) {}
                }
                foreach (array_keys(Variants::TIERS) as $tier) { try { Assets::storage()->delete("{$up['asset_id']}.$tier"); } catch (\Throwable) {} }
            } else {
                self::rmdir(self::dir($up['id']));
            }
        }
        return Db::q('DELETE FROM uploads WHERE created_at < ?', [time() - 86400])->rowCount();
    }

    /** First-bytes mime sniff for bytes already in hand (the SVG rule mirrors Assets::store). */
    private static function sniffTmp(string $bytes): ?string
    {
        $tmp = tempnam(sys_get_temp_dir(), 'ks');
        file_put_contents($tmp, $bytes);
        $mime = (new \finfo(FILEINFO_MIME_TYPE))->file($tmp) ?: null;
        @unlink($tmp);
        return $mime;
    }

    private static function sniff(?string $head, string $declared, string $name): string
    {
        $mime = $head !== null ? (self::sniffTmp($head) ?: $declared) : $declared;
        if ($mime !== 'image/svg+xml' && preg_match('~^(image/svg|text/(xml|plain|html)|application/xml)$~', $mime)
            && preg_match('/\.svg$/i', $name) && $head !== null && preg_match('/<svg[\s>]/i', $head)) {
            $mime = 'image/svg+xml';
        }
        return $mime ?: 'application/octet-stream';
    }
}
