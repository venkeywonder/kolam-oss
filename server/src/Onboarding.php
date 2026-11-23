<?php
declare(strict_types=1);

namespace Kolam;

/**
 * First-run state for the SaaS onboarding flow: the "What will you use Kolam for?" picker and the small
 * getting-started checklist, stored as JSON in users.onboarding (NULL until the person touches either one).
 *   picked:    the template id they chose in the picker, or null (not shown yet, or they skipped it)
 *   dismissed: the checklist's "Hide" link was used
 *   done:      which checklist items are complete: card (added a card), invite (invited a teammate),
 *              share (shared a board with a link), ai (connected their own AI over MCP)
 */
final class Onboarding
{
    private const DONE_KEYS = ['card', 'invite', 'share', 'ai'];
    // onboarding shipped with migration 14; accounts older than this never see the picker, so a pre-existing
    // account with onboarding still NULL (never touched the new feature) isn't mistaken for a brand-new one
    private const FRESH_WINDOW = 7 * 86400;

    public static function get(string $userId): array
    {
        $r = Db::one('SELECT onboarding, created_at FROM users WHERE id = ?', [$userId]);
        $s = json_decode((string) ($r['onboarding'] ?? ''), true);
        $fresh = !is_array($s) && $r && (time() - (int) $r['created_at']) < self::FRESH_WINDOW;
        // a pre-existing account (not fresh, never touched this feature) gets neither the picker nor the checklist
        $clean = self::clean(is_array($s) ? $s : []);
        if (!is_array($s) && !$fresh) $clean['dismissed'] = true;
        return $clean + ['fresh' => $fresh];
    }

    /** Merge-patch: {picked}, {dismissed}, {done: {key: true}}; unknown fields/values are dropped. */
    public static function update(array $u, array $in): array
    {
        $cur = self::get($u['id']);
        unset($cur['fresh']);
        if (array_key_exists('picked', $in)) {
            $cur['picked'] = is_string($in['picked']) ? substr($in['picked'], 0, 32) : null;
        }
        if (array_key_exists('dismissed', $in)) {
            $cur['dismissed'] = (bool) $in['dismissed'];
        }
        if (isset($in['done']) && is_array($in['done'])) {
            foreach ($in['done'] as $k => $v) {
                if (in_array($k, self::DONE_KEYS, true) && $v === true) $cur['done'][$k] = true;
            }
        }
        $cur = self::clean($cur);
        Db::q('UPDATE users SET onboarding = ? WHERE id = ?', [json_encode($cur, JSON_UNESCAPED_SLASHES), $u['id']]);
        // the row is no longer NULL, so this account is never "fresh" again after its first update
        return $cur + ['fresh' => false];
    }

    private static function clean(array $s): array
    {
        $done = [];
        foreach (self::DONE_KEYS as $k) $done[$k] = !empty($s['done'][$k]);
        return [
            'picked' => isset($s['picked']) && is_string($s['picked']) ? $s['picked'] : null,
            'dismissed' => !empty($s['dismissed']),
            'done' => $done,
        ];
    }
}
