<?php
declare(strict_types=1);

namespace Kolam;

/** Email + password accounts with database-backed session cookies. */
final class Auth
{
    private const COOKIE = 'nk_sid';
    private const SUSPENDED = 'This account is suspended. Contact support if you think this is a mistake.';
    private static ?array $user = null;

    public static function user(): ?array
    {
        if (self::$user) return self::$user;
        $tok = $_COOKIE[self::COOKIE] ?? '';
        if (!is_string($tok) || !preg_match('/^[a-f0-9]{64}$/', $tok)) return null;
        $hash = hash('sha256', $tok);
        $row = Db::one('SELECT u.id, u.email, u.name, u.rev, u.email_verified_at, s.expires_at, s.seen_at FROM sessions s JOIN users u ON u.id = s.user_id
                        WHERE s.token_hash = ? AND s.expires_at > ? AND u.suspended_at IS NULL', [$hash, time()]);
        if (!$row) return null;
        // slide the expiry forward once a day
        $ttl = Config::get('session_days') * 86400;
        if ($row['expires_at'] - time() < $ttl - 86400) {
            Db::q('UPDATE sessions SET expires_at = ? WHERE token_hash = ?', [time() + $ttl, $hash]);
            self::cookie($tok, time() + $ttl);
        }
        // "last active" for the devices list and the admin page, at most every 5 minutes
        if ((int) $row['seen_at'] < time() - 300) {
            Db::q('UPDATE sessions SET seen_at = ?, ip = ? WHERE token_hash = ?', [time(), Http::ip(), $hash]);
            Db::q('UPDATE users SET seen_at = ? WHERE id = ?', [time(), $row['id']]);
        }
        unset($row['expires_at'], $row['seen_at']);
        return self::$user = $row;
    }

    public static function require(): array
    {
        return self::user() ?? Http::fail(401, 'Please sign in');
    }

    /** Inviting people, making share links and uploading need a verified email address (when EMAIL_VERIFICATION is on). */
    public static function requireVerified(array $u): void
    {
        if (Config::get('email_verification') && empty($u['email_verified_at'])) {
            Http::fail(403, 'Verify your email address first. We sent you a link; you can send it again from the banner at the top.');
        }
    }

    /** Clears the session cookie for this browser (the account deletion flow signs out everywhere server-side first). */
    public static function clearCookie(): void
    {
        self::cookie('', time() - 3600);
    }

    /**
     * Access token sent as "Authorization: Bearer nkt_…" (MCP clients). Tokens come from signing in through
     * the browser (OAuth, see OAuth.php) or from a personal access key created in the Connect your AI panel.
     */
    public static function bearer(): array
    {
        $h = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
        if ($h === '' && function_exists('getallheaders')) {
            foreach (getallheaders() as $k => $v) if (strcasecmp($k, 'Authorization') === 0) $h = $v;
        }
        // tells MCP clients where to sign in (RFC 9728), so they can link themselves without a pasted key
        $challenge = 'Bearer resource_metadata="' . Http::apiUrl() . '/oauth/resource"';
        if (!preg_match('/^Bearer\s+(nkt_[a-f0-9]{48})$/', trim((string) $h), $m)) {
            header("WWW-Authenticate: $challenge");
            Http::fail(401, 'Missing or invalid access token');
        }
        $hash = hash('sha256', $m[1]);
        $row = Db::one('SELECT u.id, u.email, u.name, u.rev, u.email_verified_at, t.last_used_at FROM api_tokens t JOIN users u ON u.id = t.user_id
                        WHERE t.token_hash = ? AND u.suspended_at IS NULL', [$hash]);
        if (!$row) {
            header("WWW-Authenticate: $challenge, error=\"invalid_token\"");
            Http::fail(401, 'This access was revoked. Connect again from Connect AI in Kolam.');
        }
        if ((int) $row['last_used_at'] < time() - 300) Db::q('UPDATE api_tokens SET last_used_at = ? WHERE token_hash = ?', [time(), $hash]);
        unset($row['last_used_at']);
        return self::$user = $row;
    }

    /** Replace the user's personal access key; the plain key is only ever shown once. Browser-linked apps are kept. */
    public static function newToken(array $u): string
    {
        return Db::tx(function () use ($u) {
            Db::q("DELETE FROM api_tokens WHERE user_id = ? AND kind = 'key'", [$u['id']]);
            return self::issueToken($u['id'], 'key', 'Access key');
        });
    }

    /** kind: "key" (personal access key) or "app" (MCP client signed in with OAuth). */
    public static function issueToken(string $userId, string $kind, string $name): string
    {
        $tok = 'nkt_' . bin2hex(random_bytes(24));
        Db::q('INSERT INTO api_tokens (token_hash, user_id, name, kind, created_at) VALUES (?,?,?,?,?)',
            [hash('sha256', $tok), $userId, mb_substr($name, 0, 120), $kind, time()]);
        // keep the newest 20 links per user
        $old = Db::q('SELECT token_hash FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC', [$userId])->fetchAll(\PDO::FETCH_COLUMN);
        foreach (array_slice($old, 20) as $h) Db::q('DELETE FROM api_tokens WHERE token_hash = ?', [$h]);
        return $tok;
    }

    /** The apps and keys that can reach the user's boards (ids are a prefix of the token hash, never the token). */
    public static function tokens(array $u): array
    {
        $rows = Db::q('SELECT token_hash, name, kind, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC', [$u['id']])->fetchAll();
        return array_map(fn ($r) => [
            'id' => substr($r['token_hash'], 0, 16), 'name' => $r['name'], 'kind' => $r['kind'],
            'created' => (int) $r['created_at'], 'used' => $r['last_used_at'] ? (int) $r['last_used_at'] : null,
        ], $rows);
    }

    public static function revokeToken(array $u, string $id): void
    {
        Db::q('DELETE FROM api_tokens WHERE user_id = ? AND token_hash LIKE ?', [$u['id'], $id . '%']);
    }

    public static function publicUser(array $u): array
    {
        return ['id' => $u['id'], 'email' => $u['email'], 'name' => $u['name'],
                'verified' => !empty($u['email_verified_at']), 'admin' => Admin::is($u)];
    }

    /** The browsers signed in to this account, most recently active first (ids are a prefix of the session hash). */
    public static function sessions(array $u): array
    {
        $current = hash('sha256', (string) ($_COOKIE[self::COOKIE] ?? ''));
        $rows = Db::q('SELECT token_hash, ua, ip, created_at, seen_at FROM sessions WHERE user_id = ? AND expires_at > ?
                       ORDER BY COALESCE(seen_at, created_at) DESC', [$u['id'], time()])->fetchAll();
        return ['sessions' => array_map(fn ($r) => [
            'id' => substr($r['token_hash'], 0, 16), 'ua' => (string) $r['ua'], 'ip' => (string) $r['ip'],
            'created' => (int) $r['created_at'], 'seen' => (int) ($r['seen_at'] ?: $r['created_at']), 'current' => $r['token_hash'] === $current,
        ], $rows)];
    }

    /** Signs out one device ($id from sessions()), or every device except this one ($id = null). */
    public static function endSessions(array $u, ?string $id): array
    {
        $current = hash('sha256', (string) ($_COOKIE[self::COOKIE] ?? ''));
        if ($id === null) {
            $n = Db::q('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [$u['id'], $current])->rowCount();
        } else {
            if (str_starts_with($current, $id)) Http::fail(400, 'Use "Sign out" in the account menu to sign out of this device');
            $n = Db::q('DELETE FROM sessions WHERE user_id = ? AND token_hash LIKE ?', [$u['id'], $id . '%'])->rowCount();
        }
        return ['ok' => true, 'signedOut' => $n];
    }

    /**
     * New account. An invitation token lets its email address sign up even when sign-ups are closed, and so does a
     * join link (with its password key, if it has one).
     */
    public static function signup(array $in): array
    {
        $first = !Db::one('SELECT id FROM users LIMIT 1');
        RateLimit::hit('signup:' . Http::ip(), 10, 3600);
        Bot::check($in, 'signup');
        $email = strtolower(Http::str($in, 'email', 255));
        $invited = (is_string($in['invite'] ?? null) && Invites::allowsSignup($in['invite'], $email))
            || (isset($in['join']) && Shares::allowsSignup($in['join'], $in['k'] ?? ''));
        if (!$first && !Config::get('allow_signup') && !$invited) {
            Http::fail(403, is_string($in['invite'] ?? null) ? 'Use the email address the invitation was sent to' : 'Sign-ups are closed on this server');
        }
        $name = Http::str($in, 'name', 120);
        $pass = (string) ($in['password'] ?? '');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) Http::fail(422, 'Enter a valid email address');
        if (strlen($pass) < 8) Http::fail(422, 'Use at least 8 characters for your password');
        if (strlen($pass) > 200) Http::fail(422, 'That password is too long');
        if (Db::one('SELECT id FROM users WHERE email = ?', [$email])) Http::fail(409, 'An account with that email already exists');
        Bot::checkEmail($email);
        $id = 'u_' . bin2hex(random_bytes(10));
        // an invited address proved inbox access already (and so has the first account on a server);
        // otherwise, unverified when verification is on, verified right away when it's off
        $verified = $first || $invited || !Config::get('email_verification');
        Db::q('INSERT INTO users (id, email, name, pass_hash, rev, created_at, email_verified_at) VALUES (?,?,?,?,0,?,?)',
            [$id, $email, $name !== '' ? $name : explode('@', $email)[0], password_hash($pass, PASSWORD_DEFAULT), time(), $verified ? time() : null]);
        Spaces::personal($id);
        if ($first) Legacy::importInto($id);
        self::startSession($id);
        if ($verified) {
            if (Mailer::configured()) Emails::welcome($email, $name);
        } elseif (Config::get('email_verification')) {
            self::sendVerification($id, $email, $name);
        }
        return self::publicUser(Db::one('SELECT * FROM users WHERE id = ?', [$id]));
    }

    public static function login(array $in): array
    {
        $email = strtolower(Http::str($in, 'email', 255));
        $pass = (string) ($in['password'] ?? '');
        RateLimit::hit('login-ip:' . Http::ip(), 30, 900);
        RateLimit::hit('login:' . $email, 10, 900);
        $u = Db::one('SELECT * FROM users WHERE email = ?', [$email]);
        if (!$u || !password_verify($pass, $u['pass_hash'])) Http::fail(401, 'Wrong email or password');
        if ($u['suspended_at']) Http::fail(403, self::SUSPENDED);
        if (password_needs_rehash($u['pass_hash'], PASSWORD_DEFAULT)) {
            Db::q('UPDATE users SET pass_hash = ? WHERE id = ?', [password_hash($pass, PASSWORD_DEFAULT), $u['id']]);
        }
        RateLimit::clear('login:' . $email);
        self::startSession($u['id']);
        $restored = Account::cancelDeletion($u['id']);
        $out = self::publicUser($u);
        if ($restored) $out['restored'] = true;
        return $out;
    }

    /** Always answers the same neutral message, whether or not the address has an account (no account enumeration). */
    public static function forgot(array $in): array
    {
        RateLimit::hit('forgot-ip:' . Http::ip(), 10, 3600);
        Bot::check($in, 'forgot');
        $email = strtolower(Http::str($in, 'email', 255));
        if (filter_var($email, FILTER_VALIDATE_EMAIL)) {
            RateLimit::hit('forgot:' . $email, 5, 3600);
            $u = Db::one('SELECT id, name FROM users WHERE email = ?', [$email]);
            if ($u) {
                $tok = self::issueEmailToken($u['id'], 'reset', $email, 3600);
                Emails::reset($email, $u['name'], $tok);
            }
        }
        return ['ok' => true, 'message' => "If an account exists for that address, we've sent a link to reset the password."];
    }

    /** {token, password}. Invalidates every other session, signs the account in fresh, and counts as proving the address. */
    public static function reset(array $in): array
    {
        $token = (string) ($in['token'] ?? '');
        $pass = (string) ($in['password'] ?? '');
        if (!preg_match('/^[a-f0-9]{64}$/', $token)) Http::fail(422, 'This link is no longer valid');
        if (strlen($pass) < 8) Http::fail(422, 'Use at least 8 characters for your password');
        if (strlen($pass) > 200) Http::fail(422, 'That password is too long');
        $row = Db::one("SELECT * FROM email_tokens WHERE token_hash = ? AND kind = 'reset' AND expires_at > ?",
            [hash('sha256', $token), time()]);
        if (!$row) Http::fail(422, 'This link is no longer valid. Request a new one.');
        Db::q('DELETE FROM email_tokens WHERE token_hash = ?', [$row['token_hash']]);
        $u = Db::one('SELECT * FROM users WHERE id = ?', [$row['user_id']]);
        if (!$u) Http::fail(422, 'This link is no longer valid');
        if ($u['suspended_at']) Http::fail(403, self::SUSPENDED);
        Db::tx(function () use ($u, $pass) {
            Db::q('UPDATE users SET pass_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?',
                [password_hash($pass, PASSWORD_DEFAULT), time(), $u['id']]);
            Db::q('DELETE FROM sessions WHERE user_id = ?', [$u['id']]);
        });
        self::startSession($u['id']);
        $restored = Account::cancelDeletion($u['id']);
        $out = self::publicUser(Db::one('SELECT * FROM users WHERE id = ?', [$u['id']]));
        if ($restored) $out['restored'] = true;
        return $out;
    }

    /** {token}. Works signed in or out; single use. */
    public static function verify(array $in): array
    {
        $token = (string) ($in['token'] ?? '');
        if (!preg_match('/^[a-f0-9]{64}$/', $token)) Http::fail(422, 'This link is no longer valid');
        $row = Db::one("SELECT * FROM email_tokens WHERE token_hash = ? AND kind = 'verify' AND expires_at > ?",
            [hash('sha256', $token), time()]);
        if (!$row) Http::fail(422, 'This link is no longer valid. Request a new one from the account menu.');
        Db::q('DELETE FROM email_tokens WHERE token_hash = ?', [$row['token_hash']]);
        $u = Db::one('SELECT * FROM users WHERE id = ?', [$row['user_id']]);
        if (!$u) Http::fail(422, 'This link is no longer valid');
        if (empty($u['email_verified_at'])) {
            Db::q('UPDATE users SET email_verified_at = ? WHERE id = ?', [time(), $u['id']]);
            Emails::welcome($u['email'], $u['name']);
        }
        return ['ok' => true, 'email' => $row['email']];
    }

    /** Rate limited so someone can't be bombarded with verification emails. */
    public static function resendVerification(array $u): array
    {
        if (!empty($u['email_verified_at'])) return ['ok' => true, 'message' => 'Your email is already verified'];
        RateLimit::hit('verify-resend:' . $u['id'], 5, 3600);
        self::sendVerification($u['id'], $u['email'], $u['name']);
        return ['ok' => true, 'message' => "We've sent a new link to " . $u['email']];
    }

    private static function sendVerification(string $userId, string $email, string $name): void
    {
        $tok = self::issueEmailToken($userId, 'verify', $email, 3 * 86400);
        Emails::verify($email, $name, $tok);
    }

    /** One active token per user+kind; a new one replaces the old. Returns the plain token; only its hash is stored. */
    private static function issueEmailToken(string $userId, string $kind, string $email, int $ttlSeconds): string
    {
        Db::q('DELETE FROM email_tokens WHERE user_id = ? AND kind = ?', [$userId, $kind]);
        $tok = bin2hex(random_bytes(32));
        Db::q('INSERT INTO email_tokens (token_hash, user_id, kind, email, created_at, expires_at) VALUES (?,?,?,?,?,?)',
            [hash('sha256', $tok), $userId, $kind, $email, time(), time() + $ttlSeconds]);
        return $tok;
    }

    public static function logout(): void
    {
        $tok = $_COOKIE[self::COOKIE] ?? '';
        if (is_string($tok) && $tok !== '') Db::q('DELETE FROM sessions WHERE token_hash = ?', [hash('sha256', $tok)]);
        self::cookie('', time() - 3600);
    }

    public static function update(array $u, array $in): array
    {
        if (array_key_exists('notifyOff', $in)) Notify::setOff($u['id'], $in['notifyOff']);
        if (array_key_exists('styles', $in)) Styles::set($u['id'], $in['styles']);
        if (isset($in['name'])) {
            $name = Http::str($in, 'name', 120);
            if ($name !== '') Db::q('UPDATE users SET name = ? WHERE id = ?', [$name, $u['id']]);
        }
        if (isset($in['newPassword'])) {
            $row = Db::one('SELECT pass_hash FROM users WHERE id = ?', [$u['id']]);
            if (!password_verify((string) ($in['password'] ?? ''), $row['pass_hash'])) Http::fail(403, 'Your current password is wrong');
            $np = (string) $in['newPassword'];
            if (strlen($np) < 8) Http::fail(422, 'Use at least 8 characters for your password');
            Db::q('UPDATE users SET pass_hash = ? WHERE id = ?', [password_hash($np, PASSWORD_DEFAULT), $u['id']]);
            // sign out every other device
            $keep = hash('sha256', (string) ($_COOKIE[self::COOKIE] ?? ''));
            Db::q('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?', [$u['id'], $keep]);
        }
        return self::publicUser(Db::one('SELECT * FROM users WHERE id = ?', [$u['id']]));
    }

    private static function startSession(string $userId): void
    {
        $tok = bin2hex(random_bytes(32));
        $exp = time() + Config::get('session_days') * 86400;
        Db::q('INSERT INTO sessions (token_hash, user_id, expires_at, created_at, ua, ip, seen_at) VALUES (?,?,?,?,?,?,?)',
            [hash('sha256', $tok), $userId, $exp, time(), substr((string) ($_SERVER['HTTP_USER_AGENT'] ?? ''), 0, 255), Http::ip(), time()]);
        Db::q('UPDATE users SET seen_at = ? WHERE id = ?', [time(), $userId]);
        if (random_int(1, 50) === 1) Db::q('DELETE FROM sessions WHERE expires_at < ?', [time()]);
        self::cookie($tok, $exp);
    }

    private static function cookie(string $value, int $exp): void
    {
        setcookie(self::COOKIE, $value, [
            'expires' => $exp, 'path' => '/', 'secure' => Http::https(), 'httponly' => true, 'samesite' => 'Lax',
        ]);
    }
}
