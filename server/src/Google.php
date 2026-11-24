<?php
declare(strict_types=1);

namespace Kolam;

/** Why a Google sign-in didn't finish; the message is a short code the app turns into words (see src/ui/auth.js). */
final class GoogleSignInError extends \RuntimeException {}

/**
 * "Continue with Google": OpenID Connect's authorization code flow with PKCE, state and nonce, run by the server, so the
 * page loads nothing from Google. The browser comes back to auth/google/callback with a code that the server trades
 * with Google directly over TLS, authenticated with the client secret; the ID token in that reply is therefore taken as
 * Google's without checking its signature (OpenID Connect Core 3.1.3.7), and its issuer, audience, expiry, nonce and
 * verified email are checked. The state is bound to this browser by a cookie and is single use, so nobody can finish a
 * sign-in they didn't start (login CSRF).
 *
 * The Google account is found by its stable subject id. Failing that, it links to the account with the same address
 * (Google has verified it), or a new account is made with no password (pass_hash ''). Linking an account whose address
 * was never verified first drops its password, sessions and AI connections, since whoever chose that password may not
 * own the address.
 */
final class Google
{
    private const COOKIE = 'nk_google';
    private const FLOW_SECS = 600;
    private const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
    private const TOKEN_URL = 'https://oauth2.googleapis.com/token';
    private const ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

    public static function enabled(): bool
    {
        $g = Config::get('google');
        return $g['id'] !== '' && $g['secret'] !== '';
    }

    /**
     * Starts a sign-in and returns the Google address to send the browser to.
     * $in: invite, or join and k (signing up through an invitation or a join link); link (connect Google to $u, the
     * signed-in account). $mcp: the query string of an "Allow" page (OAuth.php) to return to instead of the app.
     */
    public static function start(array $in, ?array $u, string $mcp = ''): string
    {
        if (!self::enabled()) Http::fail(404, 'Google sign-in isn’t set up on this server');
        RateLimit::hit('google-start:' . Http::ip(), 30, 600);
        $intent = [];
        if (!empty($in['link'])) {
            if (!$u) Http::fail(401, 'Please sign in');
            $intent['link'] = $u['id'];
        }
        foreach (['invite' => '/^[a-f0-9]{48}$/', 'join' => '/^[a-f0-9]{24}$/', 'k' => '/^[a-f0-9]{64}$/'] as $k => $re) {
            if (is_string($in[$k] ?? null) && preg_match($re, $in[$k])) $intent[$k] = $in[$k];
        }
        if ($mcp !== '' && strlen($mcp) <= 4000) $intent['mcp'] = $mcp;

        $state = bin2hex(random_bytes(32));
        $verifier = self::b64(random_bytes(48));
        $nonce = bin2hex(random_bytes(16));
        Db::q('DELETE FROM google_flows WHERE expires_at < ?', [time()]);
        Db::q('INSERT INTO google_flows (state_hash, verifier, nonce, intent, expires_at) VALUES (?,?,?,?,?)',
            [hash('sha256', $state), $verifier, $nonce, json_encode($intent), time() + self::FLOW_SECS]);
        self::cookie($state, time() + self::FLOW_SECS);
        return self::AUTH_URL . '?' . http_build_query([
            'client_id' => Config::get('google')['id'],
            'redirect_uri' => self::redirectUri(),
            'response_type' => 'code',
            'scope' => 'openid email profile',
            'state' => $state,
            'nonce' => $nonce,
            'code_challenge' => self::b64(hash('sha256', $verifier, true)),
            'code_challenge_method' => 'S256',
            'prompt' => 'select_account',
        ]);
    }

    /** GET auth/google/callback: finishes the sign-in, then sends the browser back to the app (or the "Allow" page). */
    public static function callback(): never
    {
        $state = $_GET['state'] ?? '';
        $cookie = $_COOKIE[self::COOKIE] ?? '';
        self::cookie('', time() - 3600);
        $flow = null;
        if (is_string($state) && is_string($cookie) && preg_match('/^[a-f0-9]{64}$/', $state) && hash_equals($cookie, $state)) {
            $flow = Db::one('SELECT * FROM google_flows WHERE state_hash = ?', [hash('sha256', $state)]);
            if ($flow) Db::q('DELETE FROM google_flows WHERE state_hash = ?', [$flow['state_hash']]);   // single use
        }
        if (!$flow || $flow['expires_at'] < time()) self::back([], ['gerr' => 'expired']);
        $intent = json_decode($flow['intent'], true) ?: [];
        if (isset($_GET['error'])) self::back($intent, ['gerr' => 'cancelled']);
        try {
            $claims = self::exchange((string) ($_GET['code'] ?? ''), $flow['verifier'], $flow['nonce']);
            self::back($intent, self::signIn($claims, $intent));
        } catch (GoogleSignInError $e) {
            self::back($intent, ['gerr' => $e->getMessage()]);
        } catch (HttpError $e) {
            self::back($intent, ['gerr' => $e->getCode() === 429 ? 'busy' : 'failed']);
        } catch (\Throwable $e) {
            error_log('[kolam] ' . $e);
            Alerts::exception($e);
            self::back($intent, ['gerr' => 'failed']);
        }
    }

    /** DELETE auth/google: stop signing in with Google. Needs a password to fall back on, and that password. */
    public static function disconnect(array $u, array $in): array
    {
        $row = Db::one('SELECT pass_hash FROM users WHERE id = ?', [$u['id']]) ?? Http::fail(404, 'Account not found');
        if ($row['pass_hash'] === '') Http::fail(409, 'Choose a password first, so you can still sign in without Google');
        RateLimit::hit('google-unlink:' . $u['id'], 10, 3600);
        if (!password_verify((string) ($in['password'] ?? ''), $row['pass_hash'])) Http::fail(403, 'Your password is wrong');
        Db::q('UPDATE users SET google_sub = NULL, google_email = NULL WHERE id = ?', [$u['id']]);
        return Auth::publicUser(Db::one('SELECT * FROM users WHERE id = ?', [$u['id']]));
    }

    /** Trades the code for Google's ID token and returns its checked claims. */
    private static function exchange(string $code, string $verifier, string $nonce): array
    {
        if ($code === '' || strlen($code) > 2048) throw new GoogleSignInError('failed');
        $g = Config::get('google');
        $ch = curl_init(self::TOKEN_URL);
        curl_setopt_array($ch, [
            CURLOPT_POST => true,
            CURLOPT_POSTFIELDS => http_build_query([
                'code' => $code, 'client_id' => $g['id'], 'client_secret' => $g['secret'], 'redirect_uri' => self::redirectUri(),
                'grant_type' => 'authorization_code', 'code_verifier' => $verifier,
            ]),
            CURLOPT_RETURNTRANSFER => true,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 10,
            CURLOPT_SSL_VERIFYPEER => true,
            CURLOPT_SSL_VERIFYHOST => 2,
        ]);
        $res = curl_exec($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $data = is_string($res) ? json_decode($res, true) : null;
        if ($status !== 200 || !is_string($data['id_token'] ?? null)) {
            error_log('[kolam] Google token exchange failed: HTTP ' . $status . ' ' . (is_string($res) ? substr($res, 0, 300) : 'no response'));
            throw new GoogleSignInError('failed');
        }
        return self::claims($data['id_token'], $nonce);
    }

    /** The checked claims of an ID token that came straight from Google's token endpoint: {sub, email, name}. */
    private static function claims(string $idToken, string $nonce): array
    {
        $id = Config::get('google')['id'];
        $parts = explode('.', $idToken);
        $c = count($parts) === 3 ? json_decode(self::unb64($parts[1]), true) : null;
        $aud = $c['aud'] ?? null;
        $now = time();
        $ok = is_array($c)
            && in_array($c['iss'] ?? null, self::ISSUERS, true)
            && ($aud === $id || (is_array($aud) && in_array($id, $aud, true) && ($c['azp'] ?? null) === $id))
            && (int) ($c['exp'] ?? 0) > $now - 60
            && (int) ($c['iat'] ?? 0) < $now + 300
            && is_string($c['nonce'] ?? null) && hash_equals($nonce, $c['nonce'])
            && is_string($c['sub'] ?? null) && preg_match('/^[A-Za-z0-9_-]{1,255}$/', $c['sub']);
        if (!$ok) {
            error_log('[kolam] Google ID token rejected');
            throw new GoogleSignInError('failed');
        }
        $email = is_string($c['email'] ?? null) ? strtolower(trim($c['email'])) : '';
        $verified = ($c['email_verified'] ?? false) === true || ($c['email_verified'] ?? '') === 'true';
        if (!$verified || strlen($email) > 255 || !filter_var($email, FILTER_VALIDATE_EMAIL)) throw new GoogleSignInError('unverified');
        return ['sub' => $c['sub'], 'email' => $email, 'name' => is_string($c['name'] ?? null) ? mb_substr(trim($c['name']), 0, 120) : ''];
    }

    /** Signs in (or links, or makes) the account for these claims. Returns the query to land on the app with. */
    private static function signIn(array $c, array $intent): array
    {
        ['sub' => $sub, 'email' => $email, 'name' => $name] = $c;

        // Account settings → Connect Google: the account signed in on this browser when it started
        if (isset($intent['link'])) {
            $u = Auth::user();
            if (!$u || $u['id'] !== $intent['link']) throw new GoogleSignInError('relink');
            $other = Db::one('SELECT id FROM users WHERE google_sub = ?', [$sub]);
            if ($other && $other['id'] !== $u['id']) throw new GoogleSignInError('taken');
            if (!$other) {
                Db::q('UPDATE users SET google_sub = ?, google_email = ? WHERE id = ?', [$sub, $email, $u['id']]);
                Emails::googleConnected($u['email'], $u['name'], $email);
            }
            return ['google' => 'linked'];
        }

        $how = 'login';
        $u = Db::one('SELECT * FROM users WHERE google_sub = ?', [$sub]);
        if ($u && $u['google_email'] !== $email) Db::q('UPDATE users SET google_email = ? WHERE id = ?', [$email, $u['id']]);
        if (!$u && ($u = Db::one('SELECT * FROM users WHERE email = ?', [$email]))) {
            if ($u['google_sub'] !== null) throw new GoogleSignInError('other');
            if ($u['suspended_at']) throw new GoogleSignInError('suspended');
            self::attach($u, $sub, $email);
        }
        if (!$u) {
            [$first, , $allowed] = Auth::admission($intent, $email);
            if (!$allowed) throw new GoogleSignInError(isset($intent['invite']) ? 'invite' : 'closed');
            RateLimit::hit('signup:' . Http::ip(), 10, 3600);
            try { Bot::checkEmail($email); } catch (HttpError) { throw new GoogleSignInError('disposable'); }
            $id = Auth::createUser($email, $name, '', true, $first, $sub);
            if (Mailer::configured()) Emails::welcome($email, $name);
            $u = Db::one('SELECT * FROM users WHERE id = ?', [$id]);
            $how = 'signup';
        }
        if ($u['suspended_at']) throw new GoogleSignInError('suspended');
        Auth::startSession($u['id']);
        $out = ['google' => $how];
        if (Account::cancelDeletion($u['id'])) $out['restored'] = '1';
        return $out;
    }

    /** Links Google to an existing account with the same address (and tells its owner by email). */
    private static function attach(array $u, string $sub, string $email): void
    {
        Db::tx(function () use ($u, $sub, $email) {
            if (empty($u['email_verified_at'])) {
                // nobody had proved this address, so the password may belong to someone else: it stops working,
                // and so does everything signed in with it
                Db::q("UPDATE users SET pass_hash = '' WHERE id = ?", [$u['id']]);
                Db::q('DELETE FROM sessions WHERE user_id = ?', [$u['id']]);
                Db::q('DELETE FROM api_tokens WHERE user_id = ?', [$u['id']]);
                Db::q('DELETE FROM email_tokens WHERE user_id = ?', [$u['id']]);
            }
            Db::q('UPDATE users SET google_sub = ?, google_email = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?',
                [$sub, $email, time(), $u['id']]);
        });
        Emails::googleConnected($u['email'], $u['name'], $email);
    }

    /**
     * Back to the app (Account settings when connecting Google from there), or to the "Allow" page that started it
     * (which shows the sign-in form again on an error).
     */
    private static function back(array $intent, array $params): never
    {
        if (isset($intent['mcp'])) {
            parse_str($intent['mcp'], $q);
            $url = Http::apiUrl() . '/oauth/authorize?' . http_build_query($q + (isset($params['gerr']) ? ['gerr' => 1] : []));
        } else {
            foreach (['invite', 'join'] as $k) if (isset($intent[$k])) $params[$k] = $intent[$k];
            $hash = isset($intent['link']) ? '#/account/security' : '';
            $url = substr(Http::apiUrl(), 0, -4) . '/?' . http_build_query($params) . $hash;
        }
        header('Location: ' . $url, true, 302);
        exit;
    }

    /** The address registered in Google Cloud: https://<app>/api/auth/google/callback. */
    private static function redirectUri(): string
    {
        return Http::apiUrl() . '/auth/google/callback';
    }

    private static function cookie(string $value, int $exp): void
    {
        // Lax: sent on Google's top-level redirect back to the callback
        setcookie(self::COOKIE, $value, ['expires' => $exp, 'path' => '/', 'secure' => Http::https(), 'httponly' => true, 'samesite' => 'Lax']);
    }

    private static function b64(string $bin): string { return rtrim(strtr(base64_encode($bin), '+/', '-_'), '='); }

    private static function unb64(string $s): string { return (string) base64_decode(strtr($s, '-_', '+/'), true); }
}
