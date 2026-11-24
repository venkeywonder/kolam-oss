<?php
declare(strict_types=1);

namespace Kolam;

/** Routes /api/* requests. */
final class App
{
    public static function run(): void
    {
        header('X-Content-Type-Options: nosniff');
        header('Referrer-Policy: same-origin');
        header('Cache-Control: no-store');
        try {
            self::dispatch(Http::method(), self::path());
        } catch (HttpError $e) {
            Http::json(['error' => $e->getMessage()], $e->getCode() ?: 400);
        } catch (\Throwable $e) {
            error_log('[kolam] ' . $e);
            Alerts::exception($e);
            Http::json(['error' => Config::dev() ? $e->getMessage() : 'Something went wrong on the server'], 500);
        }
    }

    /** Switches and links the browser needs before and after signing in (all from .env). */
    public static function publicConfig(): array
    {
        return [
            'verification' => Config::get('email_verification'),
            'turnstile' => Config::get('turnstile')['site'] ?: null,
            'site' => Config::get('site_url') ?: null,
            'support' => Config::get('support_email') ?: null,
            'google' => Google::enabled(),
            'graceDays' => Config::get('delete_grace_days'),
            // Google Analytics for Firebase: the web app config, or null when FIREBASE_* isn't set
            'analytics' => ($fb = Config::get('firebase'))['apiKey'] && $fb['appId'] && $fb['measurementId']
                ? $fb + ['authDomain' => $fb['projectId'] . '.firebaseapp.com'] : null,
            // analytics waits for the visitor's yes in the EU, EEA, UK and Switzerland (null: unknown country)
            'consent' => Http::consentRequired(),
        ];
    }

    /** The part of the URL after ".../api/" so the app works in any sub-folder. */
    private static function path(): string
    {
        $uri = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
        $pos = strpos($uri, '/api/');
        $p = $pos === false ? '' : substr($uri, $pos + 5);
        return trim($p, '/');
    }

    private static function dispatch(string $m, string $p): void
    {
        // token-authenticated MCP endpoint for MCP clients (no cookies, so no CSRF header needed)
        if ($p === 'mcp') Mcp::handle(Auth::bearer());
        // browser sign-in for MCP clients (OAuth; consent forms carry their own same-origin check)
        if (str_starts_with($p, 'oauth/') || str_starts_with($p, '.well-known/')) OAuth::route($m, $p);

        if ($m !== 'GET' && $m !== 'HEAD') Http::requireAjax();

        // public routes
        if ($p === 'health') {
            $db = null; $dbOk = true;
            try { Db::pdo(); $db = Db::$driver; } catch (\Throwable) { $dbOk = false; }
            $storageOk = is_dir(Config::get('storage')) && is_writable(Config::get('storage'));
            $ok = $dbOk && $storageOk;
            Http::json(['ok' => $ok, 'db' => $db, 'storage' => $storageOk], $ok ? 200 : 503);
        }
        if ($p === 'auth/me' && $m === 'GET') {
            $u = Auth::user();
            Http::json(['user' => $u ? Auth::publicUser($u) + ['space' => Spaces::personal($u['id'])['id'], 'styles' => (object) Styles::get($u['id']),
                                                                'onboarding' => Onboarding::get($u['id'])] : null,
                        'signup' => Config::get('allow_signup') || !Db::one('SELECT id FROM users LIMIT 1'),
                        'config' => self::publicConfig()]);
        }
        if ($p === 'auth/signup' && $m === 'POST') Http::json(['user' => Auth::signup(Http::input())]);
        if ($p === 'auth/login' && $m === 'POST') Http::json(['user' => Auth::login(Http::input())]);
        if ($p === 'auth/logout' && $m === 'POST') { Auth::logout(); Http::json(['ok' => true]); }
        // "Continue with Google": start (returns Google's address), and Google's redirect back
        if ($p === 'auth/google' && $m === 'POST') Http::json(['url' => Google::start(Http::input(), Auth::user())]);
        if ($p === 'auth/google/callback' && $m === 'GET') Google::callback();
        // forgotten password, and the links in verification / reset emails (they work in any browser, signed in or not)
        if ($p === 'auth/forgot' && $m === 'POST') Http::json(Auth::forgot(Http::input()));
        if ($p === 'auth/reset' && $m === 'POST') Http::json(['user' => Auth::reset(Http::input())]);
        if ($p === 'auth/verify' && $m === 'POST') Http::json(Auth::verify(Http::input()));
        // anyone viewing a link can report it (abuse, spam, illegal content)
        if (preg_match('~^shared/([a-f0-9]{24})/report$~', $p, $mm) && $m === 'POST') Http::json(Reports::create($mm[1], Http::input()));
        // links to boards: what they show, their password, and comments by guests on comment links
        if (preg_match('~^shared/([a-f0-9]{24})(?:/(unlock|comments)(?:/(c_[a-f0-9]{16})(/react)?)?)?$~', $p, $mm)) {
            [$tok, $act, $cid, $react] = [$mm[1], $mm[2] ?? '', $mm[3] ?? '', !empty($mm[4])];
            if ($act === '' && $m === 'GET') Http::json(Shares::view($tok, (string) ($_GET['k'] ?? '')));
            if ($act === 'unlock' && $m === 'POST') Http::json(Shares::unlock($tok, Http::input()));
            if ($act === 'comments' && $cid === '' && $m === 'POST') Http::json(Comments::guestAdd($tok, Http::input()));
            if ($act === 'comments' && $cid !== '' && $react && $m === 'POST') Http::json(Comments::guestReact($tok, $cid, Http::input()));
            if ($act === 'comments' && $cid !== '' && !$react && $m === 'PATCH') Http::json(Comments::guestEdit($tok, $cid, Http::input()));
            if ($act === 'comments' && $cid !== '' && !$react && $m === 'DELETE') Http::json(Comments::guestDelete($tok, $cid, Http::input()));
        }
        if (preg_match('~^assets/(a_[a-z0-9]{6,40})$~', $p, $mm) && $m === 'GET') Assets::serve($mm[1]);
        if (preg_match('~^invites/([a-f0-9]{48})$~', $p, $mm) && $m === 'GET') Http::json(Invites::info($mm[1]));
        // whether the website must ask before analytics cookies (the visitor's country decides)
        if ($p === 'consent' && $m === 'GET') {
            header('Access-Control-Allow-Origin: *');
            Http::json(['required' => Http::consentRequired()]);
        }

        // signed-in routes
        $u = Auth::require();
        $space = (string) ($_GET['space'] ?? '') ?: $u['id'];
        if ($p === 'auth/me' && $m === 'PATCH') Http::json(['user' => Auth::update($u, Http::input())]);
        // sign-in methods: stop using Google, or (no password yet) email a link to choose one
        if ($p === 'auth/google' && $m === 'DELETE') Http::json(['user' => Google::disconnect($u, Http::input())]);
        if ($p === 'auth/password/link' && $m === 'POST') Http::json(Auth::passwordLink($u));
        // the account: resend the verification email, export everything, schedule deletion
        if ($p === 'auth/verify/resend' && $m === 'POST') Http::json(Auth::resendVerification($u));
        if ($p === 'account/export' && $m === 'GET') Export::zip($u);
        if ($p === 'account/delete' && $m === 'POST') Http::json(Account::requestDeletion($u, Http::input()));
        // signed-in devices: list them, sign one out, or sign out every device but this one
        if ($p === 'account/sessions' && $m === 'GET') Http::json(Auth::sessions($u));
        if ($p === 'account/sessions' && $m === 'DELETE') Http::json(Auth::endSessions($u, null));
        if (preg_match('~^account/sessions/([a-f0-9]{16})$~', $p, $mm) && $m === 'DELETE') Http::json(Auth::endSessions($u, $mm[1]));
        // the operator's admin page (ADMIN_EMAILS)
        if (str_starts_with($p, 'admin/')) Admin::route($u, $m, $p);
        // first-run picker and checklist, feedback from the app, and "What's new"
        if ($p === 'onboarding' && $m === 'PATCH') Http::json(Onboarding::update($u, Http::input()));
        if ($p === 'feedback' && $m === 'POST') Http::json(Feedback::create($u, Http::input()));
        if ($p === 'changelog' && $m === 'GET') Http::json(Changelog::entries());
        if ($p === 'sync' && $m === 'GET') Http::json(Sync::pull($u, $space, (int) ($_GET['since'] ?? 0), (int) ($_GET['acl'] ?? -1), (string) ($_GET['y'] ?? '')));
        if ($p === 'sync' && $m === 'POST') Http::json(Sync::push($u, $space, Http::input()));
        if ($p === 'ytext' && $m === 'GET') Http::json(YText::load($u, $space, (string) ($_GET['id'] ?? ''), (int) ($_GET['after'] ?? 0)));
        if ($p === 'ytext/compact' && $m === 'POST') Http::json(YText::compact($u, $space, Http::input()));
        // comments and notifications
        if ($p === 'comments' && $m === 'POST') Http::json(Comments::add($u, Http::input()));
        if ($p === 'comments/resolve' && $m === 'POST') Http::json(Comments::resolve($u, Http::input()));
        if ($p === 'comments/people' && $m === 'GET') Http::json(Comments::people($u, $space, (string) ($_GET['board'] ?? '')));
        if (preg_match('~^comments/(c_[a-f0-9]{16})(/react)?$~', $p, $mm)) {
            if (!empty($mm[2]) && $m === 'POST') Http::json(Comments::react($u, $mm[1], Http::input()));
            if (empty($mm[2]) && $m === 'PATCH') Http::json(Comments::edit($u, $mm[1], Http::input()));
            if (empty($mm[2]) && $m === 'DELETE') Http::json(Comments::delete($u, $mm[1]));
        }
        if ($p === 'notifications' && $m === 'GET') Http::json(Notify::list($u));
        if ($p === 'notifications/read' && $m === 'POST') Http::json(Notify::read($u, Http::input()));
        // history: a board's activity, a card's versions, and a card as it was
        if ($p === 'history' && $m === 'GET') Http::json(History::feed($u, $space, (string) ($_GET['board'] ?? ''), (int) ($_GET['before'] ?? 0)));
        if ($p === 'history/item' && $m === 'GET') Http::json(History::versions($u, $space, (string) ($_GET['id'] ?? '')));
        if ($p === 'history/version' && $m === 'GET') Http::json(History::data($u, $space, (string) ($_GET['ref'] ?? '')));
        if ($p === 'assets' && $m === 'POST') { Auth::requireVerified($u); Http::json(Assets::upload($u)); }
        if ($p === 'unfurl' && $m === 'GET') {
            RateLimit::hit('unfurl:' . $u['id'], 120, 600);
            Http::json(Unfurl::fetch((string) ($_GET['url'] ?? '')));
        }
        if ($p === 'spaces' && $m === 'GET') Http::json(Spaces::contexts($u));
        if ($p === 'realtime/ticket' && $m === 'POST') Http::json(Realtime::ticket($u));
        if ($p === 'presence' && $m === 'POST') Http::json(Realtime::poll($u, Http::input()));
        if ($p === 'presence' && $m === 'DELETE') {
            $in = Http::input();
            Realtime::leave((string) ($in['space'] ?? ''), (string) ($in['client'] ?? ''), $u['id']);
            Http::json(['ok' => true]);
        }

        // workspaces
        if ($p === 'workspaces' && $m === 'POST') Http::json(Spaces::create($u, Http::input()));
        if (preg_match('~^workspaces/(w_[a-f0-9]{16})(?:/(.+))?$~', $p, $mm)) {
            [$id, $rest] = [$mm[1], $mm[2] ?? ''];
            if ($rest === '' && $m === 'GET') Http::json(Spaces::info($u, $id));
            if ($rest === '' && $m === 'PATCH') Http::json(Spaces::rename($u, $id, Http::input()));
            if ($rest === '' && $m === 'DELETE') Http::json(Spaces::delete($u, $id, Http::input()));
            if ($rest === 'restore' && $m === 'POST') Http::json(Spaces::restore($u, $id));
            if ($rest === 'purge' && $m === 'POST') Http::json(Spaces::purge($u, $id));
            if ($rest === 'leave' && $m === 'POST') Http::json(Spaces::leave($u, $id));
            if ($rest === 'invites' && $m === 'POST') {
                $s = Access::space($id);
                if (!in_array(Access::spaceRole($u['id'], $s), ['owner', 'admin'], true)) Http::fail(403, 'Only the workspace owner and admins can invite people');
                Auth::requireVerified($u);
                Http::json(Invites::create($u, $s, null, Http::input()));
            }
            if (preg_match('~^members/(u_[a-f0-9]{20})$~', $rest, $mu)) {
                if ($m === 'PATCH') Http::json(Spaces::setRole($u, $id, $mu[1], Http::input()));
                if ($m === 'DELETE') Http::json(Spaces::removeMember($u, $id, $mu[1], (string) ($_GET['cards'] ?? 'keep')));
            }
            if (preg_match('~^former/(u_[a-f0-9]{20})(/delete-cards)?$~', $rest, $mu)) {
                if (!empty($mu[2]) && $m === 'POST') Http::json(Spaces::deleteFormerCards($u, $id, $mu[1]));
                if (empty($mu[2]) && $m === 'DELETE') Http::json(Spaces::dismissFormer($u, $id, $mu[1]));
            }
        }

        // people on a board
        if (preg_match('~^boards/([uw]_[a-f0-9]{16,24})/([\w.-]{1,64})/(.+)$~', $p, $mm)) {
            [$sid, $bid, $rest] = [$mm[1], $mm[2], $mm[3]];
            if ($rest === 'access' && $m === 'GET') Http::json(Sharing::info($u, $sid, $bid));
            if ($rest === 'invites' && $m === 'POST') {
                $s = Access::space($sid);
                Access::need($u['id'], $s, $bid, 'owner');
                Auth::requireVerified($u);
                Http::json(Invites::create($u, $s, $bid, Http::input()));
            }
            if ($rest === 'leave' && $m === 'POST') Http::json(Sharing::leave($u, $sid, $bid));
            if ($rest === 'restrict' && $m === 'POST') Http::json(Sharing::restrict($u, $sid, $bid, Http::input()));
            if ($rest === 'transfer' && $m === 'POST') Http::json(Sharing::transfer($u, $sid, $bid, Http::input()));
            if ($rest === 'move' && $m === 'POST') Http::json(Sharing::move($u, $sid, $bid, Http::input()));
            if (preg_match('~^members/(u_[a-f0-9]{20})$~', $rest, $mu)) {
                if ($m === 'PATCH') Http::json(Sharing::setRole($u, $sid, $bid, $mu[1], Http::input()));
                if ($m === 'DELETE') Http::json(Sharing::remove($u, $sid, $bid, $mu[1], (string) ($_GET['cards'] ?? 'keep')));
            }
            if (preg_match('~^former/(u_[a-f0-9]{20})(/delete-cards)?$~', $rest, $mu)) {
                if (!empty($mu[2]) && $m === 'POST') Http::json(Sharing::deleteFormerCards($u, $sid, $bid, $mu[1]));
                if (empty($mu[2]) && $m === 'DELETE') Http::json(Sharing::dismissFormer($u, $sid, $bid, $mu[1]));
            }
        }

        // invitations
        if (preg_match('~^invites/([a-f0-9]{48}|i_[a-f0-9]{16})/accept$~', $p, $mm) && $m === 'POST') Http::json(Invites::accept($u, $mm[1]));
        if (preg_match('~^invites/(i_[a-f0-9]{16})(?:/(decline|resend))?$~', $p, $mm)) {
            $act = $mm[2] ?? '';
            if ($act === 'decline' && $m === 'POST') Http::json(Invites::decline($u, $mm[1]));
            if ($act === 'resend' && $m === 'POST') Http::json(Invites::resend($u, $mm[1]));
            if ($act === '' && $m === 'DELETE') Http::json(Invites::revoke($u, $mm[1]));
        }

        // links to a board (only its owner manages them)
        if (preg_match('~^shares/([uw]_[a-f0-9]{16,24})/([\w.-]{1,64})$~', $p, $mm)) {
            if ($m === 'GET') { Access::need($u['id'], Access::space($mm[1]), $mm[2], 'owner'); Http::json(['links' => Shares::list($mm[1], $mm[2])]); }
            if ($m === 'POST') { Auth::requireVerified($u); Http::json(['link' => Shares::create($u, $mm[1], $mm[2], Http::input())]); }
        }
        if (preg_match('~^links/([a-f0-9]{24})(/join)?$~', $p, $mm)) {
            if (!empty($mm[2]) && $m === 'POST') Http::json(Shares::join($u, $mm[1], Http::input()));
            if (empty($mm[2]) && $m === 'PATCH') Http::json(['link' => Shares::update($u, $mm[1], Http::input())]);
            if (empty($mm[2]) && $m === 'DELETE') { Shares::remove($u, $mm[1]); Http::json(['ok' => true]); }
        }
        // "Connect your AI": the apps and access key that reach your boards over MCP (Kolam runs no AI itself)
        if ($p === 'ai/state' && $m === 'GET') Http::json(['links' => Auth::tokens($u)]);
        if ($p === 'ai/token' && $m === 'POST') Http::json(['token' => Auth::newToken($u)]);
        if (preg_match('~^ai/tokens/([a-f0-9]{16})$~', $p, $mm) && $m === 'DELETE') { Auth::revokeToken($u, $mm[1]); Http::json(['ok' => true]); }
        Http::fail(404, 'Not found');
    }
}
