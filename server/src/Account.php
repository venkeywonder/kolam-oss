<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Self-serve account deletion, scheduled with a grace period so a change of mind (signing in again) cancels it.
 * When the grace period passes, server/bin/kolam cleanup calls purgeDue(), which removes the account and everything
 * that belongs only to it, handing ownership of shared workspaces to someone else first.
 */
final class Account
{
    /** Ask to delete the account; requires the current password. Signs out everywhere right away. */
    public static function requestDeletion(array $u, array $in): array
    {
        $row = Db::one('SELECT pass_hash FROM users WHERE id = ?', [$u['id']]) ?? Http::fail(404, 'Account not found');
        if (!password_verify((string) ($in['password'] ?? ''), $row['pass_hash'])) Http::fail(403, 'Your password is wrong');
        RateLimit::hit('delete-req:' . $u['id'], 5, 3600);
        $deleteAt = time() + Config::get('delete_grace_days') * 86400;
        Db::tx(function () use ($u, $deleteAt) {
            Db::q('UPDATE users SET delete_at = ? WHERE id = ?', [$deleteAt, $u['id']]);
            // sign out everywhere and disconnect every AI/MCP client
            Db::q('DELETE FROM sessions WHERE user_id = ?', [$u['id']]);
            Db::q('DELETE FROM api_tokens WHERE user_id = ?', [$u['id']]);
        });
        self::sendDeletionEmail($u, $deleteAt);
        Auth::clearCookie();
        return ['ok' => true, 'deleteAt' => $deleteAt];
    }

    /** Called from Auth::login and Auth::reset: signing in again means the person changed their mind. */
    public static function cancelDeletion(string $userId): bool
    {
        $row = Db::one('SELECT delete_at FROM users WHERE id = ?', [$userId]);
        if (!$row || $row['delete_at'] === null) return false;
        Db::q('UPDATE users SET delete_at = NULL WHERE id = ?', [$userId]);
        return true;
    }

    /** Accounts whose scheduled deletion date has passed; purges each. Returns how many. */
    public static function purgeDue(): int
    {
        $n = 0;
        $ids = array_column(Db::q('SELECT id FROM users WHERE delete_at IS NOT NULL AND delete_at < ?', [time()])->fetchAll(), 'id');
        foreach ($ids as $id) {
            try { self::purge($id); $n++; }
            catch (\Throwable $e) { error_log("[kolam] purging account $id failed: $e"); }
        }
        return $n;
    }

    /** Permanently remove an account and everything that belongs only to it. */
    public static function purge(string $userId): void
    {
        $u = Db::one('SELECT * FROM users WHERE id = ?', [$userId]);
        if (!$u) return;
        Db::tx(function () use ($u, $userId) {
            // workspaces this person owns: hand them to someone else, or remove them when nobody else is left
            foreach (Db::q("SELECT id FROM spaces WHERE kind = 'workspace' AND owner_id = ? AND deleted_at IS NULL", [$userId]) as $w) {
                self::transferOrNuke($w['id'], $userId);
            }
            // the person's own boards
            self::nukeSpace($userId);
        });
        // files this person uploaded that nothing left references
        self::orphanAssets($userId);
        // the AI sign-ins folder on disk
        self::rmdir(Config::get('storage') . '/ai/users/' . $userId);
        Db::tx(function () use ($userId) {
            Db::q('DELETE FROM space_members WHERE user_id = ?', [$userId]);
            Db::q('DELETE FROM board_members WHERE user_id = ?', [$userId]);
            Db::q('DELETE FROM notifications WHERE user_id = ?', [$userId]);
            Db::q('DELETE FROM email_tokens WHERE user_id = ?', [$userId]);
            Db::q("DELETE FROM invites WHERE invited_by = ? AND status = 'pending'", [$userId]);
            Db::q('DELETE FROM oauth_codes WHERE user_id = ?', [$userId]);
            Db::q('DELETE FROM sessions WHERE user_id = ?', [$userId]);
            Db::q('DELETE FROM api_tokens WHERE user_id = ?', [$userId]);
            Db::q('UPDATE feedback SET user_id = NULL WHERE user_id = ?', [$userId]);
            // comments left on cards in other people's spaces stay, with the author's name but no link to the account
            Db::q('UPDATE comments SET author_id = NULL WHERE author_id = ?', [$userId]);
            Db::q('DELETE FROM users WHERE id = ?', [$userId]);
        });
    }

    /** A workspace $userId owns: give it to the longest-standing admin, else member, else guest; otherwise remove it. */
    private static function transferOrNuke(string $spaceId, string $userId): void
    {
        $next = null;
        foreach (['admin', 'member', 'guest'] as $role) {
            $next = Db::one('SELECT user_id FROM space_members WHERE space_id = ? AND user_id <> ? AND left_at IS NULL AND role = ? ORDER BY created_at ASC LIMIT 1',
                [$spaceId, $userId, $role]);
            if ($next) break;
        }
        if (!$next) { self::nukeSpace($spaceId); return; }
        Db::q('UPDATE spaces SET owner_id = ? WHERE id = ?', [$next['user_id'], $spaceId]);
        Db::q("UPDATE space_members SET role = 'owner' WHERE space_id = ? AND user_id = ?", [$spaceId, $next['user_id']]);
        Db::q('DELETE FROM space_members WHERE space_id = ? AND user_id = ?', [$spaceId, $userId]);
        Access::changed($spaceId);
    }

    /** Delete a space and everything that belongs to it: boards, cards, comments, history, shares, members, presence. */
    private static function nukeSpace(string $spaceId): void
    {
        Db::q('DELETE FROM comment_reactions WHERE comment_id IN (SELECT id FROM comments WHERE space_id = ?)', [$spaceId]);
        foreach (['entities', 'ylog', 'comments', 'comment_threads', 'history', 'shares', 'board_access', 'board_members',
                  'presence', 'invites', 'space_members', 'notifications'] as $t) {
            Db::q("DELETE FROM $t WHERE space_id = ?", [$spaceId]);
        }
        Db::q('DELETE FROM spaces WHERE id = ?', [$spaceId]);
    }

    /** Assets $uploaderId stored that no remaining space references any more. */
    private static function orphanAssets(string $uploaderId): void
    {
        $ids = array_column(Db::q('SELECT id FROM assets WHERE user_id = ?', [$uploaderId])->fetchAll(), 'id');
        foreach ($ids as $id) {
            $used = Db::one("SELECT 1 AS x FROM entities WHERE deleted = 0 AND data LIKE ?", ['%' . $id . '%']);
            if ($used) continue;
            Assets::storage()->delete($id);
            Db::q('DELETE FROM assets WHERE id = ?', [$id]);
        }
    }

    private static function rmdir(string $dir): void
    {
        if (!is_dir($dir)) return;
        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
        foreach ($it as $f) $f->isDir() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
        @rmdir($dir);
    }

    private static function sendDeletionEmail(array $u, int $deleteAt): void
    {
        $when = date('F j, Y', $deleteAt);
        $subject = 'Your Kolam account is scheduled for deletion';
        $text = "Hi {$u['name']},\n\nYour Kolam account will be permanently deleted on $when.\n\n"
              . "If this wasn't you, or you change your mind, just sign in again before then and the deletion is cancelled.\n\n"
              . "If you own a workspace with other people in it, it will automatically pass to one of them.\n";
        $e = fn($s) => htmlspecialchars((string) $s, ENT_QUOTES, 'UTF-8');
        $html = '<div style="font-family:-apple-system,Segoe UI,Inter,Arial,sans-serif;font-size:15px;line-height:1.5;color:#1b2536;max-width:520px">'
              . '<p>Hi ' . $e($u['name']) . ',</p>'
              . '<p>Your Kolam account will be permanently deleted on <b>' . $e($when) . '</b>.</p>'
              . '<p>If this wasn\'t you, or you change your mind, just sign in again before then and the deletion is cancelled.</p>'
              . '<p>If you own a workspace with other people in it, it will automatically pass to one of them.</p></div>';
        Mailer::send($u['email'], $subject, $text, $html);
    }
}
