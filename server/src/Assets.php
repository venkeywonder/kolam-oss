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

    /** Called by server-side uploaders (BoardTools, the import ZIP) that already have a whole file on disk; the chunked
     *  browser protocol is Uploads::init()/complete(). Variants for these are always generated lazily, on first ?v= request. */
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
        $ids = array_values(array_filter($ids, fn($id) => is_string($id) && preg_match('/^a_[a-z0-9]{6,40}$/', $id)));
        if (!$ids) return [];
        $in = implode(',', array_fill(0, count($ids), '?'));
        $out = [];
        foreach (Db::q("SELECT id, size FROM assets WHERE user_id = ? AND id IN ($in)", array_merge([$u['id']], $ids)) as $r) {
            $out[$r['id']] = (int) $r['size'];
        }
        return $out;
    }

    /**
     * Deletes these files for good if no card, board or trash entry in any space still uses them (a card that moved
     * to another space keeps its file). Old card versions in the history may still name them; those show as missing.
     * Call it after the transaction that dropped the references has committed. Returns the bytes freed.
     */
    public static function release(array $ids): int
    {
        $freed = 0;
        $storage = self::storage();
        foreach (array_unique($ids) as $id) {
            if (!is_string($id) || !preg_match('/^a_[a-z0-9]{6,40}$/', $id)) continue;
            if (AssetRefs::exists($id)) continue;
            $a = Db::one('SELECT size, variants FROM assets WHERE id = ?', [$id]);
            $storage->delete($id);
            foreach (array_keys(Variants::TIERS) as $tier) $storage->delete("$id.$tier");
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

    /** GET assets/{id}[?v=t|s|m][&dl=1]. */
    public static function serve(string $id): never
    {
        if (!preg_match('/^a_[a-z0-9]{6,40}$/', $id)) Http::fail(404, 'Not found');
        $a = Db::one('SELECT * FROM assets WHERE id = ?', [$id]);
        if (!$a) Http::fail(404, 'Not found');
        $dl = !empty($_GET['dl']);
        $tier = $_GET['v'] ?? '';
        $key = $id; $mime = $a['mime'];
        if (in_array($tier, ['t', 's', 'm'], true)) {
            $variants = Variants::ensure($a);
            if (!empty($variants[$tier])) { $key = "$id.$tier"; $mime = $variants[$tier]; }
            else $tier = '';   // 0 = no variant: fall back to the original
        } else $tier = '';
        $inline = in_array($mime, self::INLINE, true) && !$dl;
        $disposition = ($inline ? 'inline' : 'attachment') . "; filename*=UTF-8''" . rawurlencode($a['name'] ?: 'file');
        $etag = '"' . $key . '"';

        $storage = self::storage();
        if ($storage instanceof S3Storage) {
            header('Cache-Control: private, max-age=86400');
            header('Location: ' . $storage->presignGet($key, 7 * 86400, [
                'content-type' => $inline ? $mime : 'application/octet-stream',
                'content-disposition' => $disposition,
                'cache-control' => 'private, max-age=31536000, immutable',
            ]));
            http_response_code(302);
            exit;
        }

        header('Cache-Control: private, max-age=31536000, immutable');
        header('ETag: ' . $etag);
        if (($_SERVER['HTTP_IF_NONE_MATCH'] ?? '') === $etag) { http_response_code(304); exit; }
        header('Content-Type: ' . ($inline ? $mime : 'application/octet-stream'));
        // user files never run as pages on our origin (an SVG's scripts stay off too); data: images and fonts inside SVGs still show
        header("Content-Security-Policy: default-src 'none'; img-src 'self' data:; font-src data:; media-src 'self'; style-src 'unsafe-inline'; sandbox");
        header('Content-Disposition: ' . $disposition);

        $sendfile = Config::get('asset_sendfile');
        if ($sendfile === 'x-accel' && $storage instanceof LocalStorage) {
            header('X-Accel-Redirect: /_kolam-assets/' . $storage->relativePath($key));
            exit;
        }
        if ($sendfile === 'x-sendfile' && $storage instanceof LocalStorage) {
            $path = $storage->fullPath($key);
            if (!is_file($path)) Http::fail(404, 'Not found');
            header('Content-Length: ' . filesize($path));
            header('X-Sendfile: ' . $path);
            exit;
        }
        if (!$storage->output($key)) Http::fail(404, 'Not found');
        exit;
    }
}
