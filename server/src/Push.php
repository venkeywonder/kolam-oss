<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Web Push: system notifications on the devices where someone switched them on, for everything the bell shows
 * (Notify::add queues each one; App sends them once the response is on its way, see flush()).
 * No libraries: each request is signed with this server's VAPID key (RFC 8292, a P-256 key made on first use and kept
 * in nk_meta), and the message is encrypted for the browser (RFC 8291, aes128gcm), so the push service in between
 * (Google, Mozilla, Apple, Microsoft) can't read it.
 * A subscription belongs to the session that made it: signing out, or "sign out other devices", stops it.
 */
final class Push
{
    /** Push services browsers use. Other endpoints are refused, so the server only ever posts to these. */
    private const HOSTS = ['fcm.googleapis.com', 'android.googleapis.com', '.push.services.mozilla.com', '.push.apple.com', '.notify.windows.com'];
    private const KEEP = 20;            // subscriptions per person (one per browser)
    private const TTL = 86400;          // how long a push service keeps trying a device that's offline

    private static array $queue = [];   // notification ids to send after the response
    private static array $jwt = [];     // push service origin => signed VAPID header, per request

    private static function b64(string $s): string { return rtrim(strtr(base64_encode($s), '+/', '-_'), '='); }
    private static function unb64(mixed $s): string { return is_string($s) ? (string) base64_decode(strtr($s, '-_', '+/'), true) : ''; }
    private static function pad(string $n): string { return str_pad($n, 32, "\0", STR_PAD_LEFT); }

    private static function newKey(): array
    {
        $k = openssl_pkey_new(['private_key_type' => OPENSSL_KEYTYPE_EC, 'curve_name' => 'prime256v1'])
            ?: throw new \RuntimeException('Could not make a P-256 key: ' . openssl_error_string());
        $ec = openssl_pkey_get_details($k)['ec'];
        return [$k, self::pad($ec['d']), "\x04" . self::pad($ec['x']) . self::pad($ec['y'])];
    }

    /** This server's VAPID key pair: [private scalar, public point 0x04‖x‖y]. */
    private static function keys(): array
    {
        $r = Db::one("SELECT v FROM nk_meta WHERE k = 'vapid'");
        if (!$r) {
            [, $d, $pub] = self::newKey();
            try { Db::q("INSERT INTO nk_meta (k, v) VALUES ('vapid', ?)", [self::b64($d) . '.' . self::b64($pub)]); } catch (\PDOException) {}   // a parallel request won
            $r = Db::one("SELECT v FROM nk_meta WHERE k = 'vapid'");
        }
        [$d, $pub] = explode('.', $r['v']);
        return [self::unb64($d), self::unb64($pub)];
    }

    /** What browsers subscribe with (the applicationServerKey). */
    public static function publicKey(): string
    {
        return self::b64(self::keys()[1]);
    }

    private static function pem(string $label, string $der): string
    {
        return "-----BEGIN $label-----\n" . chunk_split(base64_encode($der), 64, "\n") . "-----END $label-----\n";
    }

    /** A P-256 public point as a PEM key (SubjectPublicKeyInfo). */
    private static function publicPem(string $point): string
    {
        return self::pem('PUBLIC KEY', hex2bin('3059301306072a8648ce3d020106082a8648ce3d030107034200') . $point);
    }

    private static function allowed(mixed $endpoint): bool
    {
        if (!is_string($endpoint) || strlen($endpoint) > 1000 || !str_starts_with($endpoint, 'https://') || !filter_var($endpoint, FILTER_VALIDATE_URL)) return false;
        $host = strtolower((string) parse_url($endpoint, PHP_URL_HOST));
        foreach (self::HOSTS as $h) if ($h[0] === '.' ? str_ends_with($host, $h) : $host === $h) return true;
        return false;
    }

    /** Remember this browser's subscription (PushSubscription.toJSON()) for the signed-in session. */
    public static function subscribe(array $u, array $in): array
    {
        $endpoint = $in['endpoint'] ?? null;
        $key = self::unb64($in['keys']['p256dh'] ?? null);
        $auth = self::unb64($in['keys']['auth'] ?? null);
        if (!self::allowed($endpoint) || strlen($key) !== 65 || $key[0] !== "\x04" || strlen($auth) !== 16) {
            Http::fail(422, 'This browser’s notification subscription can’t be used');
        }
        $session = Auth::sessionHash() ?? Http::fail(401, 'Please sign in');
        Db::upsert('push_subscriptions', ['id' => hash('sha256', $endpoint), 'user_id' => $u['id'], 'session_hash' => $session,
            'endpoint' => $endpoint, 'p256dh' => self::b64($key), 'auth' => self::b64($auth),
            'ua' => mb_substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255), 'created_at' => time()], ['id']);
        $old = Db::q('SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY created_at DESC', [$u['id']])->fetchAll(\PDO::FETCH_COLUMN);
        foreach (array_slice($old, self::KEEP) as $id) Db::q('DELETE FROM push_subscriptions WHERE id = ?', [$id]);
        return ['ok' => true];
    }

    public static function unsubscribe(array $u, array $in): array
    {
        if (is_string($in['endpoint'] ?? null)) Db::q('DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?', [hash('sha256', $in['endpoint']), $u['id']]);
        return ['ok' => true];
    }

    /** Send notification $id to its person's devices after this request (only if it was committed by then). */
    public static function queue(string $id): void
    {
        self::$queue[$id] = true;
    }

    /** Sends what was queued, to every device at once. Never throws: App calls it after the response. */
    public static function flush(): void
    {
        $ids = array_keys(self::$queue);
        self::$queue = [];
        if (!$ids) return;
        try {
            self::send($ids);
        } catch (\Throwable $e) {
            error_log('[kolam] push: ' . $e);
        }
    }

    private static function send(array $ids): void
    {
        $in = implode(',', array_fill(0, count($ids), '?'));
        // a notification that isn't there was rolled back with the change that made it
        $rows = Db::q("SELECT * FROM notifications WHERE id IN ($in) ORDER BY created_at", $ids)->fetchAll();
        if (!$rows) return;
        $users = array_values(array_unique(array_column($rows, 'user_id')));
        $uin = implode(',', array_fill(0, count($users), '?'));
        $subs = [];
        foreach (Db::q("SELECT p.* FROM push_subscriptions p JOIN sessions s ON s.token_hash = p.session_hash
                        WHERE s.expires_at > ? AND p.user_id IN ($uin)", [time(), ...$users]) as $s) $subs[$s['user_id']][] = $s;
        if (!$subs) return;
        $unread = [];
        foreach (Db::q("SELECT user_id, COUNT(*) n FROM notifications WHERE read_at IS NULL AND user_id IN ($uin) GROUP BY user_id", $users) as $r) {
            $unread[$r['user_id']] = (int) $r['n'];
        }
        $mh = curl_multi_init();
        $sent = [];   // curl handle id => subscription
        foreach (Notify::describe($rows) as $i => $n) {
            $uid = $rows[$i]['user_id'];
            $msg = json_encode(Notify::headline($n) + ['id' => $n['id'], 'at' => $n['at'], 'unread' => $unread[$uid] ?? 0],
                JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            foreach ($subs[$uid] ?? [] as $s) {
                $body = self::encrypt($msg, self::unb64($s['p256dh']), self::unb64($s['auth']));
                if ($body === null) { self::forget($s['id']); continue; }
                $ch = curl_init($s['endpoint']);
                curl_setopt_array($ch, [
                    CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true,
                    CURLOPT_TIMEOUT => 6, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_FOLLOWLOCATION => false, CURLOPT_PROTOCOLS => CURLPROTO_HTTPS,
                    CURLOPT_HTTPHEADER => ['Content-Type: application/octet-stream', 'Content-Encoding: aes128gcm', 'TTL: ' . self::TTL,
                                           'Urgency: high', 'Authorization: ' . self::vapid($s['endpoint'])],
                ]);
                curl_multi_add_handle($mh, $ch);
                $sent[spl_object_id($ch)] = [$ch, $s];
            }
        }
        do {
            $status = curl_multi_exec($mh, $running);
            if ($running) curl_multi_select($mh, 1.0);
        } while ($running && $status === CURLM_OK);
        foreach ($sent as [$ch, $s]) {
            $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
            // gone (404, 410) or no longer ours to use (403: the key it was made with changed): the browser subscribes again
            if (in_array($code, [403, 404, 410], true)) self::forget($s['id']);
            if ($code === 0 || ($code >= 300 && $code !== 404 && $code !== 410)) {
                error_log('[kolam] push to ' . parse_url($s['endpoint'], PHP_URL_HOST) . ' answered ' . ($code ?: curl_error($ch)) . ': ' . substr((string) curl_multi_getcontent($ch), 0, 200));
            }
            curl_multi_remove_handle($mh, $ch);
        }
        curl_multi_close($mh);
    }

    private static function forget(string $id): void
    {
        Db::q('DELETE FROM push_subscriptions WHERE id = ?', [$id]);
    }

    /** The Authorization header for a push service (RFC 8292), signed once per service and request. */
    private static function vapid(string $endpoint): string
    {
        $p = parse_url($endpoint);
        $aud = $p['scheme'] . '://' . $p['host'];
        if (isset(self::$jwt[$aud])) return self::$jwt[$aud];
        [$d, $pub] = self::keys();
        $mail = (string) (Config::get('support_email') ?: Config::get('smtp')['from']);
        $claims = ['aud' => $aud, 'exp' => time() + 12 * 3600, 'sub' => filter_var($mail, FILTER_VALIDATE_EMAIL) ? 'mailto:' . $mail : Invites::appUrl()];
        $data = self::b64('{"typ":"JWT","alg":"ES256"}') . '.' . self::b64(json_encode($claims, JSON_UNESCAPED_SLASHES));
        // ECPrivateKey (RFC 5915) for the stored scalar and point
        $key = self::pem('EC PRIVATE KEY', hex2bin('30770201010420') . $d . hex2bin('a00a06082a8648ce3d030107a144034200') . $pub);
        if (!openssl_sign($data, $der, $key, OPENSSL_ALGO_SHA256)) throw new \RuntimeException('VAPID signing failed: ' . openssl_error_string());
        // DER (SEQUENCE of two INTEGERs) to the raw r‖s a JWT carries
        $rl = ord($der[3]);
        $r = substr($der, 4, $rl);
        $s = substr($der, 6 + $rl, ord($der[5 + $rl]));
        $sig = self::pad(ltrim($r, "\0")) . self::pad(ltrim($s, "\0"));
        return self::$jwt[$aud] = 'vapid t=' . $data . '.' . self::b64($sig) . ', k=' . self::b64($pub);
    }

    /** $plain encrypted for one browser: a single aes128gcm record (RFC 8188) keyed as RFC 8291 says. Null: its key is unusable. */
    private static function encrypt(string $plain, string $uaPub, string $auth): ?string
    {
        [$eph, , $asPub] = self::newKey();
        $secret = @openssl_pkey_derive(self::publicPem($uaPub), $eph, 32);
        if ($secret === false) return null;
        $ikm = hash_hkdf('sha256', $secret, 32, "WebPush: info\0" . $uaPub . $asPub, $auth);
        $salt = random_bytes(16);
        $cek = hash_hkdf('sha256', $ikm, 16, "Content-Encoding: aes128gcm\0", $salt);
        $nonce = hash_hkdf('sha256', $ikm, 12, "Content-Encoding: nonce\0", $salt);
        $ct = openssl_encrypt($plain . "\x02", 'aes-128-gcm', $cek, OPENSSL_RAW_DATA, $nonce, $tag);   // 0x02: the last (only) record
        return $salt . pack('N', 4096) . chr(65) . $asPub . $ct . $tag;
    }

    /** kolam cleanup: subscriptions whose session ended. */
    public static function prune(): int
    {
        return Db::q('DELETE FROM push_subscriptions WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.token_hash = push_subscriptions.session_hash)')->rowCount();
    }
}
