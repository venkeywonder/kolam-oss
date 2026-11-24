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
        // the space the file goes into; anywhere you can't reach counts as your home workspace
        $sid = is_string($_POST['space'] ?? null) ? $_POST['space'] : '';
        $space = $sid !== '' && preg_match('/^[uw]_[a-f0-9]{16,24}$/', $sid) ? (Db::one('SELECT * FROM spaces WHERE id = ? AND deleted_at IS NULL', [$sid]) ?: null) : null;
        if (!$space || !Access::boards($u['id'], $space)) $space = Spaces::home($u['id']);
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

    /** POST assets/size {ids}: bytes of these files that count toward your storage (ones you uploaded). */
    public static function size(array $u, array $ids): array
    {
        $ids = array_values(array_unique(array_filter($ids, fn($id) => is_string($id) && preg_match('/^a_[a-z0-9]{6,40}$/', $id))));
        if (!$ids) return ['bytes' => 0];
        $ids = array_slice($ids, 0, 2000);
        $sql = 'SELECT COALESCE(SUM(size), 0) s FROM assets WHERE user_id = ? AND id IN (' . implode(',', array_fill(0, count($ids), '?')) . ')';
        return ['bytes' => (int) (Db::one($sql, array_merge([(string) $u['id']], $ids))['s'] ?? 0)];
    }

    /**
     * Deletes these files for good if no card, board or trash entry in any space still uses them (a card that moved
     * to another space keeps its file). Old card versions in the history may still name them; those show as missing.
     * Call it after the transaction that dropped the references has committed. Returns the bytes freed.
     */
    public static function release(array $ids): int
    {
        $freed = 0;
        foreach (array_unique($ids) as $id) {
            if (!is_string($id) || !preg_match('/^a_[a-z0-9]{6,40}$/', $id)) continue;
            if (Db::one('SELECT 1 AS x FROM entities WHERE deleted = 0 AND data LIKE ?', ['%' . $id . '%'])) continue;
            $a = Db::one('SELECT size FROM assets WHERE id = ?', [$id]);
            self::storage()->delete($id);
            Db::q('DELETE FROM assets WHERE id = ?', [$id]);
            $freed += (int) ($a['size'] ?? 0);
        }
        return $freed;
    }

    /** Asset ids used by the cards of a trash entry. */
    public static function inTrashEntry(?array $t): array
    {
        $ids = [];
        foreach (is_array($t['items'] ?? null) ? $t['items'] : [] as $it) {
            $id = is_array($it) ? ($it['data']['asset'] ?? null) : null;
            if (is_string($id) && $id !== '') $ids[] = $id;
        }
        return $ids;
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
