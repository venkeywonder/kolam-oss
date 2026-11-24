<?php
declare(strict_types=1);

namespace Kolam;

use Kolam\Storage\{LocalStorage, S3Storage, Storage};

/** Uploaded images and files. Ids are long random strings, so a URL works like a capability link. */
final class Assets
{
    private const INLINE = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/bmp', 'image/svg+xml',
        'video/mp4', 'video/webm', 'video/quicktime', 'audio/mpeg', 'audio/mp4', 'audio/wav', 'audio/x-wav', 'audio/ogg', 'audio/webm',
        'application/pdf'];

    public static function storage(): Storage
    {
        return Config::get('asset_driver') === 's3'
            ? new S3Storage(Config::get('s3'))
            : new LocalStorage(Config::get('storage') . '/assets');
    }

    public static function upload(array $u): array
    {
        $f = $_FILES['file'] ?? null;
        if (!$f || ($f['error'] ?? 1) !== UPLOAD_ERR_OK) {
            $err = $f['error'] ?? -1;
            Http::fail(in_array($err, [UPLOAD_ERR_INI_SIZE, UPLOAD_ERR_FORM_SIZE], true) ? 413 : 400, 'Upload failed');
        }
        if ($f['size'] > Config::get('max_upload_mb') * 1024 * 1024) Http::fail(413, 'That file is too large');
        // the space the file goes into; anywhere you can't reach counts as your own
        $sid = is_string($_POST['space'] ?? null) ? $_POST['space'] : '';
        $space = $sid !== '' && preg_match('/^[uw]_[a-f0-9]{16,24}$/', $sid) ? (Db::one('SELECT * FROM spaces WHERE id = ? AND deleted_at IS NULL', [$sid]) ?: null) : null;
        if (!$space || !Access::boards($u['id'], $space)) $space = Spaces::personal($u['id']);
        return self::store($u['id'], $f['tmp_name'], (string) ($f['name'] ?? 'file'), (int) $f['size'], null, $space['id']);
    }

    public static function store(string $userId, string $tmp, string $name, int $size, ?string $id = null, ?string $spaceId = null): array
    {
        $mime = (new \finfo(FILEINFO_MIME_TYPE))->file($tmp) ?: 'application/octet-stream';
        // libmagic calls some SVGs (a comment or doctype first) XML or plain text
        if ($mime !== 'image/svg+xml' && preg_match('~^(image/svg|text/(xml|plain|html)|application/xml)$~', $mime)
            && preg_match('/\.svg$/i', $name) && preg_match('/<svg[\s>]/i', (string) file_get_contents($tmp, false, null, 0, 65536))) {
            $mime = 'image/svg+xml';
        }
        $id ??= 'a_' . bin2hex(random_bytes(12));
        self::storage()->put($id, $tmp, $mime);
        $name = mb_substr(preg_replace('/[\x00-\x1f"\\\\\/]/u', '', $name) ?: 'file', 0, 200);
        Db::upsert('assets', ['id' => $id, 'user_id' => $userId, 'space_id' => $spaceId ?? $userId, 'mime' => $mime, 'size' => $size, 'name' => $name, 'created_at' => time()], ['id']);
        return ['id' => $id, 'mime' => $mime, 'size' => $size, 'name' => $name];
    }

    public static function serve(string $id): never
    {
        if (!preg_match('/^a_[a-z0-9]{6,40}$/', $id)) Http::fail(404, 'Not found');
        $a = Db::one('SELECT * FROM assets WHERE id = ?', [$id]);
        if (!$a) Http::fail(404, 'Not found');
        $etag = '"' . $id . '"';
        header('Cache-Control: private, max-age=31536000, immutable');
        header('ETag: ' . $etag);
        if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); exit; }
        $inline = in_array($a['mime'], self::INLINE, true);
        header('Content-Type: ' . ($inline ? $a['mime'] : 'application/octet-stream'));
        // user files never run as pages on our origin (an SVG's scripts stay off too); data: images and fonts inside SVGs still show
        header("Content-Security-Policy: default-src 'none'; img-src 'self' data:; font-src data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
        $fn = rawurlencode($a['name'] ?: 'file');
        header('Content-Disposition: ' . ($inline ? 'inline' : 'attachment') . "; filename*=UTF-8''$fn");
        if (!self::storage()->output($id)) Http::fail(404, 'Not found');
        exit;
    }
}
