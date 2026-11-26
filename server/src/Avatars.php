<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Profile pictures. users.avatar is null (initials), "p:NN" (one of the illustrations in src/assets/avatars/NN.webp)
 * or the id of an uploaded picture: a square WebP the browser cropped and edited, re-encoded here at SIDE × SIDE when
 * GD can write WebP (see upload() for servers or browsers that can't). Uploaded pictures are assets in the
 * pseudo-space "avatar", so they don't count towards anyone's storage.
 */
final class Avatars
{
    /** How many illustrations src/assets/avatars/ holds (01.webp …). */
    public const PRESETS = 24;
    /** Stored size of an uploaded picture, in px. */
    public const SIDE = 256;
    /** What the browser may send: a square between these sizes, at most this many bytes. */
    private const MIN = 128, MAX = 1024, MAX_BYTES = 2 * 1048576;
    private const TYPES = ['image/webp', 'image/png', 'image/jpeg'];

    /** "p:07" style values that name an illustration. */
    public static function isPreset(mixed $v): bool
    {
        return is_string($v) && preg_match('/^p:(\d\d)$/', $v, $m) === 1 && (int) $m[1] >= 1 && (int) $m[1] <= self::PRESETS;
    }

    /** PATCH auth/me {avatar}: an illustration ("p:NN") or null for initials. Uploads go through upload(). */
    public static function set(string $userId, mixed $v): void
    {
        if ($v !== null && !self::isPreset($v)) Http::fail(422, 'Pick one of the illustrations');
        self::replace($userId, $v);
    }

    /** POST account/avatar (multipart "file"): the cropped picture. Returns the account with its new avatar. */
    public static function upload(array $u): array
    {
        Auth::requireVerified($u);
        RateLimit::hit('avatar:' . $u['id'], 30, 3600);
        $f = $_FILES['file'] ?? null;
        if (!is_array($f) || ($f['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file((string) $f['tmp_name'])) {
            Http::fail(400, 'No picture arrived. Try again.');
        }
        $tmp = (string) $f['tmp_name'];
        $size = (int) filesize($tmp);
        if ($size > self::MAX_BYTES) Http::fail(413, 'That picture is too large');
        $mime = (new \finfo(FILEINFO_MIME_TYPE))->file($tmp) ?: '';
        if (!in_array($mime, self::TYPES, true)) Http::fail(415, 'Use a PNG, JPG or WebP picture');
        $dim = @getimagesize($tmp);
        [$w, $h] = $dim ? [(int) $dim[0], (int) $dim[1]] : [0, 0];
        if (abs($w - $h) > 1 || $w < self::MIN || $w > self::MAX) {
            Http::fail(422, 'The picture must be square, between ' . self::MIN . ' and ' . self::MAX . ' px');
        }
        // WebP re-encoded here when GD can write it; otherwise the browser's WebP as it came, or (a browser that can't
        // write WebP either) a PNG re-encoded here
        $webp = function_exists('imagewebp');
        [$out, $type] = $mime === 'image/webp' && !$webp ? [$tmp, $mime] : self::encode($tmp, $w, $h, $webp ? 'image/webp' : 'image/png');
        try {
            $a = Assets::store($u['id'], $out, $type === 'image/webp' ? 'avatar.webp' : 'avatar.png', (int) filesize($out), null, 'avatar');
        } finally {
            if ($out !== $tmp) @unlink($out);
        }
        self::replace($u['id'], $a['id']);
        return Auth::publicUser(Db::one('SELECT * FROM users WHERE id = ?', [$u['id']]));
    }

    /**
     * GET avatars?ids=…: id => avatar for the people you work with (anyone in a workspace or on a board you're in,
     * including former members, whose comments stay). People without a picture are left out.
     */
    public static function lookup(array $u, string $ids): array
    {
        $ids = array_slice(array_values(array_unique(array_filter(explode(',', $ids), fn($id) => preg_match('/^u_[a-f0-9]{20}$/', $id) === 1))), 0, 200);
        if (!$ids) return [];
        $in = implode(',', array_fill(0, count($ids), '?'));
        $mine = "SELECT space_id FROM space_members WHERE user_id = ? AND left_at IS NULL
                 UNION SELECT space_id FROM board_members WHERE user_id = ? AND left_at IS NULL";
        $rows = Db::q("SELECT id, avatar FROM users WHERE id IN ($in) AND avatar IS NOT NULL AND (id = ?
                         OR id IN (SELECT user_id FROM space_members WHERE space_id IN ($mine))
                         OR id IN (SELECT user_id FROM board_members WHERE space_id IN ($mine)))",
            array_merge($ids, [$u['id'], $u['id'], $u['id'], $u['id'], $u['id']]))->fetchAll();
        $out = [];
        foreach ($rows as $r) $out[$r['id']] = $r['avatar'];
        return $out;
    }

    /** Sets the avatar and deletes the uploaded picture it replaces. */
    private static function replace(string $userId, ?string $v): void
    {
        $old = Db::one('SELECT avatar FROM users WHERE id = ?', [$userId])['avatar'] ?? null;
        Db::q('UPDATE users SET avatar = ? WHERE id = ?', [$v, $userId]);
        if (is_string($old) && $old !== $v && str_starts_with($old, 'a_')) Assets::release([$old]);
    }

    /** [file, mime]: the picture re-encoded as a SIDE × SIDE $type (WebP or PNG), metadata dropped. */
    private static function encode(string $tmp, int $w, int $h, string $type): array
    {
        if (!function_exists('imagecreatefromstring')) Http::fail(500, 'This server can’t read pictures');
        $src = @imagecreatefromstring((string) file_get_contents($tmp));
        if (!$src) Http::fail(422, 'That picture can’t be read');
        $dst = imagecreatetruecolor(self::SIDE, self::SIDE);
        imagealphablending($dst, false);
        imagesavealpha($dst, true);
        imagecopyresampled($dst, $src, 0, 0, 0, 0, self::SIDE, self::SIDE, $w, $h);
        $out = tempnam(sys_get_temp_dir(), 'kav');
        $ok = $type === 'image/webp' ? imagewebp($dst, $out, 82) : imagepng($dst, $out, 9);
        imagedestroy($src); imagedestroy($dst);
        if (!$ok) { @unlink($out); Http::fail(500, 'That picture can’t be saved'); }
        return [$out, $type];
    }
}
