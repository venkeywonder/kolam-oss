<?php
declare(strict_types=1);

namespace Kolam;

/**
 * The operator's admin page: numbers at a glance, accounts (verification, sign-out, suspension), reports about
 * share links, and feedback sent from the app. Only the verified accounts listed in ADMIN_EMAILS can use it.
 */
final class Admin
{
    private const PAGE = 50;

    public static function is(array $u): bool
    {
        $admins = Config::get('admin_emails');
        return $admins && !empty($u['email_verified_at']) && in_array(strtolower((string) $u['email']), $admins, true);
    }

    public static function route(array $u, string $m, string $p): void
    {
        if (!self::is($u)) Http::fail(404, 'Not found');
        if ($p === 'admin/overview' && $m === 'GET') Http::json(self::overview());
        if ($p === 'admin/users' && $m === 'GET') Http::json(self::users((string) ($_GET['q'] ?? ''), (int) ($_GET['offset'] ?? 0)));
        if (preg_match('~^admin/users/(u_[a-f0-9]{20})$~', $p, $mm) && $m === 'POST') Http::json(self::userAction($u, $mm[1], Http::input()));
        if ($p === 'admin/reports' && $m === 'GET') Http::json(self::reports((string) ($_GET['status'] ?? 'open')));
        if (preg_match('~^admin/reports/(r_[a-f0-9]{20})$~', $p, $mm) && $m === 'POST') Http::json(self::reportAction($mm[1], Http::input()));
        if ($p === 'admin/feedback' && $m === 'GET') Http::json(self::feedback((int) ($_GET['offset'] ?? 0)));
        Http::fail(404, 'Not found');
    }

    private static function count(string $sql, array $args = []): int
    {
        return (int) (Db::one($sql, $args)['n'] ?? 0);
    }

    public static function overview(): array
    {
        $day = time() - 86400; $week = time() - 7 * 86400; $month = time() - 30 * 86400;
        return [
            'users' => [
                'total' => self::count('SELECT COUNT(*) n FROM users'),
                'new7' => self::count('SELECT COUNT(*) n FROM users WHERE created_at > ?', [$week]),
                'new30' => self::count('SELECT COUNT(*) n FROM users WHERE created_at > ?', [$month]),
                'active1' => self::count('SELECT COUNT(*) n FROM users WHERE seen_at > ?', [$day]),
                'active7' => self::count('SELECT COUNT(*) n FROM users WHERE seen_at > ?', [$week]),
                'unverified' => self::count('SELECT COUNT(*) n FROM users WHERE email_verified_at IS NULL'),
                'deleting' => self::count('SELECT COUNT(*) n FROM users WHERE delete_at IS NOT NULL'),
                'suspended' => self::count('SELECT COUNT(*) n FROM users WHERE suspended_at IS NOT NULL'),
            ],
            'workspaces' => self::count("SELECT COUNT(*) n FROM spaces WHERE kind = 'workspace' AND deleted_at IS NULL"),
            'boards' => self::count("SELECT COUNT(*) n FROM entities WHERE kind = 'board' AND deleted = 0"),
            'cards' => self::count("SELECT COUNT(*) n FROM entities WHERE kind = 'item' AND deleted = 0"),
            'links' => self::count('SELECT COUNT(*) n FROM shares'),
            'storageBytes' => (int) (Db::one('SELECT COALESCE(SUM(size), 0) n FROM assets')['n'] ?? 0),
            'openReports' => self::count("SELECT COUNT(*) n FROM reports WHERE status = 'open'"),
            'feedback7' => self::count('SELECT COUNT(*) n FROM feedback WHERE created_at > ?', [$week]),
        ];
    }

    /** Newest accounts first, or those whose email or name contains $q. */
    public static function users(string $q, int $offset): array
    {
        $q = trim(mb_substr($q, 0, 120));
        $where = ''; $args = [];
        if ($q !== '') {
            $where = 'WHERE LOWER(u.email) LIKE ? OR LOWER(u.name) LIKE ?';
            $like = '%' . mb_strtolower($q) . '%';
            $args = [$like, $like];
        }
        $offset = max(0, $offset);
        $rows = Db::q("SELECT u.id, u.email, u.name, u.email_verified_at, u.created_at, u.seen_at, u.delete_at, u.suspended_at,
                         (SELECT COALESCE(SUM(a.size), 0) FROM assets a WHERE a.user_id = u.id) storage,
                         (SELECT COUNT(*) FROM spaces s WHERE s.owner_id = u.id AND s.kind = 'workspace' AND s.deleted_at IS NULL) workspaces
                       FROM users u $where ORDER BY u.created_at DESC LIMIT " . self::PAGE . " OFFSET $offset", $args)->fetchAll();
        return [
            'total' => self::count("SELECT COUNT(*) n FROM users u $where", $args),
            'offset' => $offset, 'page' => self::PAGE,
            'users' => array_map(fn ($r) => [
                'id' => $r['id'], 'email' => $r['email'], 'name' => $r['name'],
                'verified' => $r['email_verified_at'] !== null, 'created' => (int) $r['created_at'],
                'seen' => $r['seen_at'] === null ? null : (int) $r['seen_at'],
                'deleteAt' => $r['delete_at'] === null ? null : (int) $r['delete_at'],
                'suspended' => $r['suspended_at'] !== null, 'storageBytes' => (int) $r['storage'], 'workspaces' => (int) $r['workspaces'],
                'admin' => in_array(strtolower($r['email']), Config::get('admin_emails'), true),
            ], $rows),
        ];
    }

    /** {action: verify | signout | suspend | unsuspend | keep (cancel a scheduled deletion)} */
    public static function userAction(array $me, string $id, array $in): array
    {
        $u = Db::one('SELECT * FROM users WHERE id = ?', [$id]) ?? Http::fail(404, 'No such account');
        $action = (string) ($in['action'] ?? '');
        $signOut = function () use ($id) {
            Db::q('DELETE FROM sessions WHERE user_id = ?', [$id]);
            Db::q('DELETE FROM api_tokens WHERE user_id = ?', [$id]);
        };
        switch ($action) {
            case 'verify':
                Db::q('UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?', [time(), $id]);
                break;
            case 'signout':
                $signOut();
                break;
            case 'suspend':
                if ($id === $me['id'] || in_array(strtolower($u['email']), Config::get('admin_emails'), true)) Http::fail(422, "Admins can't be suspended");
                Db::tx(function () use ($id, $signOut) {
                    Db::q('UPDATE users SET suspended_at = ? WHERE id = ?', [time(), $id]);
                    $signOut();
                });
                break;
            case 'unsuspend':
                Db::q('UPDATE users SET suspended_at = NULL WHERE id = ?', [$id]);
                break;
            case 'keep':
                Account::cancelDeletion($id);
                break;
            default:
                Http::fail(422, 'Unknown action');
        }
        error_log("[kolam] admin {$me['email']}: $action on {$u['email']}");
        return ['ok' => true];
    }

    /** $status: open | closed | all. Each with who made the link and whether it still exists. */
    public static function reports(string $status): array
    {
        $where = in_array($status, ['open', 'closed'], true) ? 'WHERE r.status = ?' : '';
        $rows = Db::q("SELECT r.*, s.token live, u.id owner_id, u.email owner_email, u.name owner_name, u.suspended_at
                       FROM reports r LEFT JOIN shares s ON s.token = r.share_token LEFT JOIN users u ON u.id = s.user_id
                       $where ORDER BY r.created_at DESC LIMIT 200", $where ? [$status] : [])->fetchAll();
        return ['reports' => array_map(fn ($r) => [
            'id' => $r['id'], 'token' => $r['share_token'], 'reason' => $r['reason'], 'details' => (string) $r['details'],
            'email' => (string) $r['email'], 'ip' => (string) $r['ip'], 'status' => $r['status'], 'created' => (int) $r['created_at'],
            'linkLive' => $r['live'] !== null,
            'owner' => $r['owner_id'] ? ['id' => $r['owner_id'], 'email' => $r['owner_email'], 'name' => $r['owner_name'],
                                          'suspended' => $r['suspended_at'] !== null] : null,
        ], $rows)];
    }

    /** {action: close | reopen | disable}; disable removes the share link and closes every report about it. */
    public static function reportAction(string $id, array $in): array
    {
        $r = Db::one('SELECT * FROM reports WHERE id = ?', [$id]) ?? Http::fail(404, 'No such report');
        $action = (string) ($in['action'] ?? '');
        if ($action === 'close') Db::q("UPDATE reports SET status = 'closed' WHERE id = ?", [$id]);
        elseif ($action === 'reopen') Db::q("UPDATE reports SET status = 'open' WHERE id = ?", [$id]);
        elseif ($action === 'disable') {
            Db::tx(function () use ($r) {
                Db::q('DELETE FROM shares WHERE token = ?', [$r['share_token']]);
                Db::q("UPDATE reports SET status = 'closed' WHERE share_token = ?", [$r['share_token']]);
            });
        } else Http::fail(422, 'Unknown action');
        return ['ok' => true];
    }

    public static function feedback(int $offset): array
    {
        $offset = max(0, $offset);
        $rows = Db::q('SELECT f.*, u.name FROM feedback f LEFT JOIN users u ON u.id = f.user_id
                       ORDER BY f.created_at DESC LIMIT ' . self::PAGE . " OFFSET $offset")->fetchAll();
        return [
            'total' => self::count('SELECT COUNT(*) n FROM feedback'), 'offset' => $offset, 'page' => self::PAGE,
            'feedback' => array_map(fn ($r) => [
                'id' => $r['id'], 'kind' => $r['kind'], 'body' => $r['body'], 'email' => (string) $r['email'], 'name' => (string) $r['name'],
                'page' => (string) $r['page'], 'ua' => (string) $r['ua'], 'created' => (int) $r['created_at'],
            ], $rows),
        ];
    }
}
