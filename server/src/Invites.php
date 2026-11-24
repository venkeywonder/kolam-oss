<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Invitations to a board or a workspace. Each one is for one email address, lasts 7 days, and is accepted by signing in
 * (or creating an account, even when sign-ups are closed) with that address. The link carries a secret token; only its hash is stored.
 */
final class Invites
{
    private const TTL = 7 * 86400;

    /** Invite someone; the caller has already checked that $u may manage people here. */
    public static function create(array $u, array $space, ?string $board, array $in): array
    {
        $email = strtolower(Http::str($in, 'email', 255));
        $role = (string) ($in['role'] ?? '');
        if (!filter_var($email, FILTER_VALIDATE_EMAIL)) Http::fail(422, 'Enter a valid email address');
        $roles = $board === null ? ['admin', 'member'] : Access::BOARD_ROLES;
        if (!in_array($role, $roles, true)) Http::fail(422, 'Pick a role');
        if ($board === null && $role === 'admin' && Access::spaceRole($u['id'], $space) !== 'owner') Http::fail(403, 'Only the workspace owner can invite admins');
        if ($email === strtolower($u['email'])) Http::fail(422, 'That’s you');
        RateLimit::hit('invite:' . $u['id'], 60, 3600);
        $existing = Db::one('SELECT id FROM users WHERE email = ?', [$email]);
        if ($existing) {
            $already = $board === null
                ? in_array(Access::spaceRole($existing['id'], $space), ['owner', 'admin', 'member'], true)
                : (Access::blanket(Access::spaceRole($existing['id'], $space)) !== null
                   || Db::one('SELECT user_id FROM board_members WHERE space_id = ? AND board_id = ? AND user_id = ? AND left_at IS NULL', [$space['id'], $board, $existing['id']]));
            if ($already) Http::fail(409, 'This person already has access');
        }
        $tok = bin2hex(random_bytes(24));
        $now = time();
        $row = Db::one("SELECT id FROM invites WHERE space_id = ? AND email = ? AND status = 'pending' AND " . ($board === null ? 'board_id IS NULL' : 'board_id = ?'),
            $board === null ? [$space['id'], $email] : [$space['id'], $email, $board]);
        $id = $row['id'] ?? 'i_' . bin2hex(random_bytes(8));
        if ($row) {
            Db::q('UPDATE invites SET token_hash = ?, role = ?, invited_by = ?, created_at = ?, expires_at = ? WHERE id = ?',
                [hash('sha256', $tok), $role, $u['id'], $now, $now + self::TTL, $id]);
        } else {
            Db::q('INSERT INTO invites (id, token_hash, space_id, board_id, email, role, invited_by, status, created_at, expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
                [$id, hash('sha256', $tok), $space['id'], $board, $email, $role, $u['id'], 'pending', $now, $now + self::TTL]);
        }
        $inv = Db::one('SELECT * FROM invites WHERE id = ?', [$id]);
        if ($existing) {
            $t = self::target($inv);
            Notify::add($existing['id'], 'invite', ['space' => $space['id'], 'board' => $board, 'ref' => $id, 'actor' => $u['id'],
                'text' => 'invited you to ' . ($board === null ? "the workspace “{$t['title']}”" : "the board “{$t['title']}”") . ' as ' . self::roleName($role)]);
        }
        return self::deliver($u, $inv, $tok);
    }

    /** A fresh link and expiry, emailed again. */
    public static function resend(array $u, string $id): array
    {
        $inv = self::managed($u, $id);
        $tok = bin2hex(random_bytes(24));
        Db::q('UPDATE invites SET token_hash = ?, created_at = ?, expires_at = ? WHERE id = ?', [hash('sha256', $tok), time(), time() + self::TTL, $id]);
        return self::deliver($u, Db::one('SELECT * FROM invites WHERE id = ?', [$id]), $tok);
    }

    public static function revoke(array $u, string $id): array
    {
        self::managed($u, $id);
        Db::q("UPDATE invites SET status = 'revoked' WHERE id = ?", [$id]);
        Db::q('DELETE FROM notifications WHERE ref = ?', [$id]);
        return ['ok' => true];
    }

    /** A pending invitation the person may manage (resend / revoke). */
    private static function managed(array $u, string $id): array
    {
        $inv = Db::one("SELECT * FROM invites WHERE id = ? AND status = 'pending'", [$id]) ?? Http::fail(404, 'Invitation not found');
        $space = Access::space($inv['space_id']);
        if ($inv['board_id'] === null) {
            if (!in_array(Access::spaceRole($u['id'], $space), ['owner', 'admin'], true)) Http::fail(403, 'Only the workspace owner and admins can do that');
        } else {
            Access::need($u['id'], $space, $inv['board_id'], 'owner');
        }
        return $inv;
    }

    private static function deliver(array $u, array $inv, string $tok): array
    {
        $link = self::appUrl() . '/?invite=' . $tok;
        $t = self::target($inv);
        $what = $inv['board_id'] === null ? "the “{$t['title']}” workspace" : "the board “{$t['title']}”";
        $roleName = self::roleName($inv['role']);
        $days = (int) round(self::TTL / 86400);
        $subject = "{$u['name']} invited you to {$what} on Kolam";
        $text = "{$u['name']} ({$u['email']}) invited you to {$what} on Kolam as {$roleName}.\n\n"
              . "Open this link to accept:\n$link\n\nThe invitation expires in $days days. If you weren’t expecting it, you can ignore this email.\n";
        $e = fn($s) => htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
        $html = '<p><b>' . $e($u['name']) . '</b> (' . $e($u['email']) . ') invited you to ' . $e($what) . ' on Kolam as ' . $e($roleName) . '.</p>'
              . '<p style="margin:24px 0"><a href="' . $e($link) . '" style="background:#1b2536;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;display:inline-block">Open invitation</a></p>'
              . '<p style="color:#5b6575;font-size:13px">The invitation expires in ' . $days . ' days. If you weren’t expecting it, you can ignore this email.</p>';
        $emailed = Mailer::send($inv['email'], $subject, $text, Emails::layout($subject, $html));
        return ['invite' => self::public($inv), 'link' => $link, 'emailed' => $emailed, 'mail' => Mailer::configured()];
    }

    public static function roleName(string $role): string
    {
        return match ($role) { 'admin' => 'an admin', 'member' => 'a member', 'guest' => 'a guest', 'editor' => 'an editor', 'commenter' => 'a commenter', default => 'a viewer' };
    }

    /** Where the app lives, for links in emails: APP_URL, or worked out from this request. */
    public static function appUrl(): string
    {
        $u = rtrim((string) Config::get('app_url'), '/');
        return $u !== '' ? $u : substr(Http::apiUrl(), 0, -4);
    }

    /** Title of what the invitation is for, and who sent it. */
    private static function target(array $inv): array
    {
        $space = Db::one('SELECT * FROM spaces WHERE id = ?', [$inv['space_id']]);
        $title = $inv['board_id'] === null ? ($space['name'] ?? 'Workspace') : (Spaces::titles($inv['space_id'], [$inv['board_id']])[$inv['board_id']] ?? 'Untitled board');
        $by = Db::one('SELECT name FROM users WHERE id = ?', [$inv['invited_by']])['name'] ?? 'Someone';
        return ['title' => $title, 'by' => $by, 'workspace' => ($space['kind'] ?? '') === 'workspace' ? $space['name'] : null];
    }

    private static function public(array $inv): array
    {
        $t = self::target($inv);
        return ['id' => $inv['id'], 'email' => $inv['email'], 'role' => $inv['role'], 'kind' => $inv['board_id'] === null ? 'workspace' : 'board',
                'space' => $inv['space_id'], 'board' => $inv['board_id'], 'title' => $t['title'], 'by' => $t['by'], 'workspace' => $t['workspace'],
                'status' => $inv['status'], 'expires' => (int) $inv['expires_at'], 'expired' => (int) $inv['expires_at'] < time(), 'sent' => (int) $inv['created_at']];
    }

    public static function listFor(string $spaceId, ?string $board): array
    {
        $rows = $board === null
            ? Db::q("SELECT * FROM invites WHERE space_id = ? AND board_id IS NULL AND status = 'pending' ORDER BY created_at DESC", [$spaceId])
            : Db::q("SELECT * FROM invites WHERE space_id = ? AND board_id = ? AND status = 'pending' ORDER BY created_at DESC", [$spaceId, $board]);
        return array_map([self::class, 'public'], $rows->fetchAll());
    }

    /** Invitations waiting for this person (by email), newest first. */
    public static function pendingFor(array $u): array
    {
        $out = [];
        foreach (Db::q("SELECT * FROM invites WHERE email = ? AND status = 'pending' AND expires_at > ? ORDER BY created_at DESC", [strtolower($u['email']), time()]) as $r) {
            $s = Db::one('SELECT deleted_at FROM spaces WHERE id = ?', [$r['space_id']]);
            if (!$s || $s['deleted_at'] !== null) continue;
            $out[] = self::public($r);
        }
        return $out;
    }

    public static function byToken(string $tok): ?array
    {
        if (!preg_match('/^[a-f0-9]{48}$/', $tok)) return null;
        return Db::one('SELECT * FROM invites WHERE token_hash = ?', [hash('sha256', $tok)]);
    }

    /** Whether this token lets $email create an account while sign-ups are closed. */
    public static function allowsSignup(string $tok, string $email): bool
    {
        $inv = self::byToken($tok);
        return $inv && $inv['status'] === 'pending' && (int) $inv['expires_at'] >= time() && $inv['email'] === strtolower($email);
    }

    /** What the invitation page shows before signing in. */
    public static function info(string $tok): array
    {
        RateLimit::hit('invite-view:' . Http::ip(), 120, 600);
        $inv = self::byToken($tok) ?? Http::fail(404, 'This invitation link isn’t valid');
        $space = Db::one('SELECT deleted_at FROM spaces WHERE id = ?', [$inv['space_id']]);
        if (!$space || $space['deleted_at'] !== null) Http::fail(404, 'What you were invited to no longer exists');
        return self::public($inv) + ['hasAccount' => (bool) Db::one('SELECT id FROM users WHERE email = ?', [$inv['email']])];
    }

    /** Accept by link token or, for invitations shown in the app, by id. Returns where to go. */
    public static function accept(array $u, string $key): array
    {
        $inv = str_starts_with($key, 'i_') ? Db::one('SELECT * FROM invites WHERE id = ?', [$key]) : self::byToken($key);
        if (!$inv) Http::fail(404, 'This invitation isn’t valid');
        if ($inv['email'] !== strtolower($u['email'])) Http::fail(403, 'This invitation was sent to ' . $inv['email'] . '. Sign in with that address to accept it.');
        $go = ['space' => $inv['space_id'], 'board' => $inv['board_id']];
        if ($inv['status'] === 'accepted' && $inv['user_id'] === $u['id']) return $go;
        if ($inv['status'] !== 'pending') Http::fail(410, 'This invitation was ' . ($inv['status'] === 'revoked' ? 'cancelled' : $inv['status']));
        if ((int) $inv['expires_at'] < time()) Http::fail(410, 'This invitation has expired. Ask for a new one.');
        $space = Access::space($inv['space_id']);
        Db::tx(function () use ($u, $inv, $space) {
            $now = time();
            if ($inv['board_id'] === null) {
                $cur = Access::spaceRole($u['id'], $space);
                if (!in_array($cur, ['owner', 'admin', 'member'], true) || ($cur === 'member' && $inv['role'] === 'admin')) {
                    Db::upsert('space_members', ['space_id' => $space['id'], 'user_id' => $u['id'], 'role' => $inv['role'], 'created_at' => $now, 'left_at' => null], ['space_id', 'user_id']);
                }
            } else {
                if (Db::one('SELECT id FROM entities WHERE space_id = ? AND kind = ? AND id = ? AND deleted = 0', [$space['id'], 'board', $inv['board_id']]) === null) {
                    Http::fail(410, 'The board you were invited to was deleted');
                }
                // a board invitation makes a guest
                self::addToBoard($space, $inv['board_id'], $u['id'], $inv['role']);
            }
            Db::q("UPDATE invites SET status = 'accepted', user_id = ? WHERE id = ?", [$u['id'], $inv['id']]);
            Access::changed($space['id']);
        });
        return $go;
    }

    /** Give someone a role on a board; outsiders join a workspace as guests, so they see only what's shared with them. */
    public static function addToBoard(array $space, string $board, string $uid, string $role): void
    {
        $now = time();
        Db::upsert('board_members', ['space_id' => $space['id'], 'board_id' => $board, 'user_id' => $uid, 'role' => $role, 'created_at' => $now, 'left_at' => null],
            ['space_id', 'board_id', 'user_id']);
        if ($space['kind'] === 'workspace' && Access::spaceRole($uid, $space) === null) {
            Db::upsert('space_members', ['space_id' => $space['id'], 'user_id' => $uid, 'role' => 'guest', 'created_at' => $now, 'left_at' => null], ['space_id', 'user_id']);
        }
    }

    public static function decline(array $u, string $id): array
    {
        $inv = Db::one("SELECT * FROM invites WHERE id = ? AND status = 'pending'", [$id]) ?? Http::fail(404, 'Invitation not found');
        if ($inv['email'] !== strtolower($u['email'])) Http::fail(404, 'Invitation not found');
        Db::q("UPDATE invites SET status = 'declined', user_id = ? WHERE id = ?", [$u['id'], $id]);
        return ['ok' => true];
    }
}
