<?php
declare(strict_types=1);

namespace Kolam;

/**
 * "Sign in with Kolam", so MCP clients (Claude Code, Codex, …) link themselves to an account in the browser instead of
 * using a pasted key: OAuth 2.1 authorization code + PKCE with dynamic client registration, found through the
 * WWW-Authenticate header the MCP endpoint sends (RFC 9728, RFC 8414, RFC 7591). It ends in an ordinary access token
 * (api_tokens), listed and revocable in the Connect your AI panel.
 */
final class OAuth
{
    private const CODE_SECS = 600;
    /** Google's "G" for the Continue with Google button (the same as in src/ui/auth.js). */
    private const GOOGLE_G = '<svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>';

    public static function route(string $m, string $p): never
    {
        if ($m === 'GET' && in_array($p, ['oauth/resource', '.well-known/oauth-protected-resource', '.well-known/oauth-protected-resource/mcp'], true)) {
            $api = Http::apiUrl();
            Http::json(['resource' => "$api/mcp", 'authorization_servers' => [$api], 'scopes_supported' => ['boards'],
                'bearer_methods_supported' => ['header'], 'resource_name' => 'Kolam']);
        }
        if ($m === 'GET' && in_array($p, ['.well-known/oauth-authorization-server', '.well-known/openid-configuration'], true)) Http::json(self::metadata());
        if ($p === 'oauth/register' && $m === 'POST') self::register();
        if ($m === 'GET' && $p === 'oauth/jwks') Http::json(['keys' => []]);
        if ($p === 'oauth/authorize' && ($m === 'GET' || $m === 'POST')) self::authorize($m);
        if ($p === 'oauth/token' && $m === 'POST') self::token();
        Http::fail(404, 'Not found');
    }

    /**
     * Served at {api}/.well-known/oauth-authorization-server and {api}/.well-known/openid-configuration. MCP clients look for the
     * latter when Kolam lives in a sub-folder (they can't reach the domain-root well-known URLs), and validate it as OpenID
     * metadata, so it carries the three OpenID fields too. No ID tokens are ever issued: "openid" isn't an offered scope.
     */
    private static function metadata(): array
    {
        $api = Http::apiUrl();
        return [
            'issuer' => $api,
            'authorization_endpoint' => "$api/oauth/authorize",
            'token_endpoint' => "$api/oauth/token",
            'registration_endpoint' => "$api/oauth/register",
            'response_types_supported' => ['code'],
            'grant_types_supported' => ['authorization_code'],
            'code_challenge_methods_supported' => ['S256'],
            'token_endpoint_auth_methods_supported' => ['none'],
            'scopes_supported' => ['boards'],
            'jwks_uri' => "$api/oauth/jwks",
            'subject_types_supported' => ['public'],
            'id_token_signing_alg_values_supported' => ['RS256'],
        ];
    }

    /* ---------- MCP clients: dynamic registration + authorization code with PKCE ---------- */

    private static function register(): never
    {
        RateLimit::hit('oauth-reg:' . Http::ip(), 30, 3600);
        $in = Http::input(32 * 1024);
        $uris = $in['redirect_uris'] ?? null;
        if (!is_array($uris) || !$uris || count($uris) > 10) self::err('invalid_redirect_uri', 'redirect_uris is required');
        foreach ($uris as $r) {
            if (!is_string($r) || strlen($r) > 500 || !self::validRedirect($r)) {
                self::err('invalid_redirect_uri', 'Redirect URIs must be https, or http on localhost');
            }
        }
        $name = is_string($in['client_name'] ?? null) ? trim(preg_replace('/\s+/u', ' ', $in['client_name'])) : '';
        $name = mb_substr($name !== '' ? $name : 'MCP client', 0, 80);
        $id = 'nkc_' . bin2hex(random_bytes(16));
        Db::q('INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?,?,?,?)', [$id, $name, json_encode(array_values($uris)), time()]);
        Http::json([
            'client_id' => $id, 'client_id_issued_at' => time(), 'client_name' => $name, 'redirect_uris' => array_values($uris),
            'grant_types' => ['authorization_code'], 'response_types' => ['code'], 'token_endpoint_auth_method' => 'none',
        ], 201);
    }

    private static function authorize(string $m): never
    {
        $q = $_POST + $_GET;    // the consent form posts back to this same URL, query string included
        $client = Db::one('SELECT * FROM oauth_clients WHERE id = ?', [(string) ($q['client_id'] ?? '')]);
        if (!$client) self::page('Unknown app', '<h1>Unknown app</h1><p>Kolam doesn’t recognise the app that sent you here. Start connecting again from the app.</p>', 400);
        $uris = json_decode($client['redirect_uris'], true) ?: [];
        $redirect = (string) ($q['redirect_uri'] ?? (count($uris) === 1 ? $uris[0] : ''));
        if (!self::redirectAllowed($redirect, $uris)) self::page('Invalid link', '<h1>Invalid sign-in link</h1><p>The app asked to return to an address it didn’t register. Start connecting again from the app.</p>', 400);

        $back = function (array $params) use ($redirect, $q): never {
            if (isset($q['state']) && is_string($q['state'])) $params['state'] = $q['state'];
            header('Location: ' . $redirect . (str_contains($redirect, '?') ? '&' : '?') . http_build_query($params), true, 302);
            exit;
        };
        if (($q['response_type'] ?? '') !== 'code') $back(['error' => 'unsupported_response_type']);
        $challenge = (string) ($q['code_challenge'] ?? '');
        if (($q['code_challenge_method'] ?? '') !== 'S256' || !preg_match('/^[A-Za-z0-9_-]{43,128}$/', $challenge)) {
            $back(['error' => 'invalid_request', 'error_description' => 'PKCE with S256 is required']);
        }

        $u = Auth::user();
        $err = isset($q['gerr']) ? 'Signing in with Google didn’t work. Try again, or use your email and password.' : '';
        if ($m === 'POST') {
            self::sameOrigin();
            // "Continue with Google": sign in there, then come back to this page signed in
            if (($q['decision'] ?? '') === 'google' && !$u) {
                header('Location: ' . Google::start([], null, (string) ($_SERVER['QUERY_STRING'] ?? '')), true, 302);
                exit;
            }
            if (($q['decision'] ?? '') !== 'allow') $back(['error' => 'access_denied']);
            try { $u ??= self::signIn($q); } catch (HttpError $e) { $err = $e->getMessage(); }
            if ($u) {
                $code = bin2hex(random_bytes(32));
                Db::q('DELETE FROM oauth_codes WHERE expires_at < ?', [time()]);
                Db::q('INSERT INTO oauth_codes (code_hash, kind, client_id, user_id, redirect_uri, challenge, name, status, expires_at)
                       VALUES (?,?,?,?,?,?,?,?,?)',
                    [hash('sha256', $code), 'code', $client['id'], $u['id'], $redirect, $challenge, $client['name'], 'approved', time() + self::CODE_SECS]);
                $back(['code' => $code, 'iss' => Http::apiUrl()]);
            }
        }
        $host = (string) parse_url($redirect, PHP_URL_HOST);
        $name = self::h($client['name']);
        $from = self::loopback($host) ? 'on this computer' : 'at <b>' . self::h($host) . '</b>';
        self::consent("Connect $name", "<b>$name</b> $from wants to read and change your Kolam boards.", $u, $err);
    }

    /* ---------- token endpoint ---------- */

    private static function token(): never
    {
        $q = $_POST;
        $grant = (string) ($q['grant_type'] ?? '');
        if ($grant === 'authorization_code') {
            $code = (string) ($q['code'] ?? '');
            $row = $code === '' ? null : Db::one("SELECT * FROM oauth_codes WHERE code_hash = ? AND kind = 'code'", [hash('sha256', $code)]);
            if ($row) Db::q('DELETE FROM oauth_codes WHERE code_hash = ?', [$row['code_hash']]);   // single use
            if (!$row || $row['expires_at'] < time()) self::err('invalid_grant', 'The sign-in code is invalid or has expired');
            if (isset($q['client_id']) && $q['client_id'] !== $row['client_id']) self::err('invalid_grant', 'The code belongs to another app');
            if (isset($q['redirect_uri']) && $q['redirect_uri'] !== $row['redirect_uri']) self::err('invalid_grant', 'redirect_uri doesn’t match');
            $hash = rtrim(strtr(base64_encode(hash('sha256', (string) ($q['code_verifier'] ?? ''), true)), '+/', '-_'), '=');
            if (!hash_equals($row['challenge'], $hash)) self::err('invalid_grant', 'PKCE verification failed');
            self::issue($row['user_id'], 'app', $row['name']);
        }
        self::err('unsupported_grant_type', 'Unsupported grant_type');
    }

    private static function issue(string $userId, string $kind, string $name): never
    {
        Http::json(['access_token' => Auth::issueToken($userId, $kind, $name), 'token_type' => 'Bearer', 'scope' => 'boards']);
    }

    /* ---------- helpers ---------- */

    private static function err(string $code, string $desc, int $status = 400): never
    {
        Http::json(['error' => $code, 'error_description' => $desc], $status);
    }

    private static function signIn(array $q): array
    {
        return Auth::login(['email' => $q['email'] ?? '', 'password' => $q['password'] ?? '']);
    }

    /** Consent forms only accept posts from our own pages (on top of SameSite cookies and no framing). */
    private static function sameOrigin(): void
    {
        $o = $_SERVER['HTTP_ORIGIN'] ?? '';
        if ($o !== '' && preg_replace('~^https?://~', '', $o) !== ($_SERVER['HTTP_HOST'] ?? '')) Http::fail(403, 'Cross-site request refused');
    }

    private static function loopback(string $host): bool
    {
        return in_array(strtolower($host), ['localhost', '127.0.0.1', '[::1]', '::1'], true);
    }

    private static function validRedirect(string $r): bool
    {
        $u = parse_url($r);
        if (!$u || empty($u['host']) || isset($u['fragment'])) return false;
        $scheme = strtolower($u['scheme'] ?? '');
        return $scheme === 'https' || ($scheme === 'http' && self::loopback($u['host']));
    }

    /** Exact match, except that loopback redirects may use any port (RFC 8252), since CLIs pick a free one. */
    private static function redirectAllowed(string $r, array $uris): bool
    {
        if ($r === '' || !self::validRedirect($r)) return false;
        if (in_array($r, $uris, true)) return true;
        $a = parse_url($r);
        if (!self::loopback($a['host'])) return false;
        foreach ($uris as $reg) {
            $b = parse_url((string) $reg);
            if ($b && ($b['scheme'] ?? '') === $a['scheme'] && ($b['host'] ?? '') === $a['host']
                && ($b['path'] ?? '') === ($a['path'] ?? '') && ($b['query'] ?? '') === ($a['query'] ?? '')) return true;
        }
        return false;
    }

    private static function h(string $s): string { return htmlspecialchars($s, ENT_QUOTES); }

    private static function consent(string $title, string $text, ?array $u, string $err): never
    {
        // its own form, ahead of the sign-in form, so Enter in the password field still means "Sign in and allow"
        $google = !$u && Google::enabled()
            ? '<form method="post" class="auth-alt"><button class="auth-google" name="decision" value="google">' . self::GOOGLE_G . 'Continue with Google</button></form><p class="auth-or"><span>or</span></p>'
            : '';
        $fields = $u
            ? '<p class="oa-who">Signed in as ' . self::h($u['email']) . '</p>'
            : '<label>Email<input type="email" name="email" autocomplete="username" required autofocus></label>' .
              '<label>Password<input type="password" name="password" autocomplete="current-password" required></label>';
        self::page(strip_tags($title),
            "<h1>$title</h1><p class=\"auth-sub\">$text</p>" . $google .
            '<form method="post">' . $fields . '<p class="auth-err">' . self::h($err) . '</p>' .
            '<div class="oa-row"><button class="auth-btn" name="decision" value="allow">' . ($u ? 'Allow' : 'Sign in and allow') . '</button>' .
            '<button class="auth-btn oa-no" name="decision" value="deny" formnovalidate>Cancel</button></div></form>');
    }

    private static function page(string $title, string $body, int $status = 200): never
    {
        http_response_code($status);
        header('Content-Type: text/html; charset=utf-8');
        header('X-Frame-Options: DENY');
        header("Content-Security-Policy: frame-ancestors 'none'");
        $base = self::h(Http::basePath());
        $title = self::h($title);
        echo <<<HTML
            <!doctype html>
            <html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <title>$title · Kolam</title>
            <link rel="icon" href="$base/favicon.svg" type="image/svg+xml">
            <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Source+Serif+4:opsz,wght@8..60,600;8..60,700&display=swap" rel="stylesheet">
            <link rel="stylesheet" href="$base/src/styles/app.css">
            <script>try{var t=localStorage.getItem('nk-theme')||'system';document.documentElement.dataset.theme=t==='dark'||(t==='system'&&matchMedia('(prefers-color-scheme: dark)').matches)?'dark':'light'}catch(e){}</script>
            <style>
            .auth-sub b{color:var(--ink)}
            .oa-who{font-size:13px;color:var(--muted);margin:0}
            .oa-row{display:flex;flex-direction:row-reverse;gap:10px}
            .oa-row .auth-btn{flex:1}
            .auth-btn.oa-no{background:var(--hover);color:var(--ink)}
            </style>
            </head><body class="auth-mode"><div id="auth"><div class="auth-card">
            <div class="auth-logo"><img class="emblem emblem-light" src="$base/src/assets/emblem-light.svg" width="40" height="40" alt=""><img class="emblem emblem-dark" src="$base/src/assets/emblem-dark.svg" width="40" height="40" alt=""></div>
            $body
            </div></div></body></html>
            HTML;
        exit;
    }
}
