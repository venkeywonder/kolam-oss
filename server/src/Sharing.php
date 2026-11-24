<?php
declare(strict_types=1);

namespace Kolam;

/** People on a single board: who has access and how, invitations, roles, restricting, transferring and moving. */
final class Sharing
{
    private static function board(string $spaceId, string $board): array
    {
        if (!preg_match('/^[\w.-]{1,64}$/', $board) || $board === Access::UNSORTED) Http::fail(404, 'Board not found');
        return Access::space($spaceId);
    }

    public static function info(array $u, string $spaceId, string $board): array
    {
        $space = self::board($spaceId, $board);
        $me = Access::need($u['id'], $space, $board, 'viewer');
        $manage = $me === 'owner';
        $tree = Access::tree($spaceId);
        $restricted = Access::restricted($spaceId);
        $grants = Access::grants($spaceId);
        $titles = Spaces::titles($spaceId, array_keys($tree));
        $people = [];
        // people with access to the whole workspace
        foreach (Db::q("SELECT user_id, role FROM space_members WHERE space_id = ? AND left_at IS NULL AND role <> 'guest'", [$spaceId]) as $r) {
            $people[$r['user_id']] = ['role' => Access::blanket($r['role']), 'via' => 'workspace', 'wsRole' => $r['role']];
        }
        foreach ($grants as $uid => $g) {
            if (isset($people[$uid])) continue;
            $role = Access::resolve($tree, $g, $restricted)[$board] ?? null;
            if ($role === null) continue;
            // where the access comes from: this board, or the nearest board above it with a grant
            $b = $board; $n = 0;
            while (!isset($g[$b]) && $n++ < 100) $b = $tree[$b];
            $people[$uid] = ['role' => $role, 'via' => $b === $board ? 'direct' : 'inherited', 'from' => $b === $board ? null : ['id' => $b, 'title' => $titles[$b] ?? 'a board above']];
        }
        $names = Access::names(array_keys($people));
        $list = [];
        foreach ($people as $uid => $p) {
            if (!isset($names[$uid])) continue;
            $list[] = ['id' => $uid, 'name' => $names[$uid]['name'], 'email' => $manage || $uid === $u['id'] ? $names[$uid]['email'] : null] + $p;
        }
        $rank = fn($p) => [-Access::RANK[$p['role']], strtolower($p['name'])];
        usort($list, fn($a, $b) => $rank($a) <=> $rank($b));
        $former = [];
        if ($manage) {
            foreach (Db::q('SELECT m.user_id, m.left_at, u.name, u.email FROM board_members m JOIN users u ON u.id = m.user_id
                            WHERE m.space_id = ? AND m.board_id = ? AND m.left_at IS NOT NULL', [$spaceId, $board]) as $r) {
                if (isset($people[$r['user_id']])) continue;   // came back another way
                $former[] = ['id' => $r['user_id'], 'name' => $r['name'], 'email' => $r['email'], 'left' => (int) $r['left_at'],
                             'cards' => Spaces::cardCount($spaceId, $r['user_id'], Access::subtree($spaceId, $board))];
            }
        }
        $owner = ['kind' => 'workspace', 'id' => $spaceId, 'name' => $space['name'], 'mine' => $space['owner_id'] === $u['id']];
        return [
            'space' => $spaceId, 'board' => $board, 'title' => $titles[$board] ?? 'Untitled board',
            'role' => $me, 'canManage' => $manage, 'owner' => $owner,
            'nested' => ($tree[$board] ?? null) !== null, 'restricted' => isset($restricted[$board]),
            'people' => $list, 'former' => $former,
            'invites' => $manage ? Invites::listFor($spaceId, $board) : [],
            'canLeave' => !$manage && self::grantAbove($grants[$u['id']] ?? [], $tree, $board) !== null,
            'mail' => Mailer::configured(),
            'links' => $manage ? Shares::list($spaceId, $board) : [],
        ];
    }

    /** The board (this one or above) whose grant gives the person access here. */
    private static function grantAbove(array $g, array $tree, string $board): ?string
    {
        $b = $board; $n = 0;
        while ($b !== null && $n++ < 100) { if (isset($g[$b])) return $b; $b = $tree[$b] ?? null; }
        return null;
    }

    public static function setRole(array $u, string $spaceId, string $board, string $target, array $in): array
    {
        $space = self::board($spaceId, $board);
        Access::need($u['id'], $space, $board, 'owner');
        $role = (string) ($in['role'] ?? '');
        if (!in_array($role, Access::BOARD_ROLES, true)) Http::fail(422, 'Pick a role');
        if (Access::blanket(Access::spaceRole($target, $space)) !== null) Http::fail(409, 'This person has access through the workspace. Change their role in the workspace settings.');
        if (!Db::one('SELECT id FROM users WHERE id = ?', [$target])) Http::fail(404, 'Not found');
        $was = Access::role($target, $space, $board);
        if ($was === null) Http::fail(404, 'This person has no access here. Invite them instead.');
        Db::upsert('board_members', ['space_id' => $spaceId, 'board_id' => $board, 'user_id' => $target, 'role' => $role, 'created_at' => time(), 'left_at' => null],
            ['space_id', 'board_id', 'user_id']);
        Access::changed($spaceId);
        if ($was !== $role) Notify::add($target, 'role', ['space' => $spaceId, 'board' => $board, 'actor' => $u['id'],
            'text' => 'made you ' . Invites::roleName($role) . ' on the board “' . (Spaces::titles($spaceId, [$board])[$board] ?? 'Untitled board') . '”']);
        return self::info($u, $spaceId, $board);
    }

    /** Take someone's access away; $cards = 'delete' also moves the cards they made on these boards to the trash. */
    public static function remove(array $u, string $spaceId, string $board, string $target, string $cards): array
    {
        $space = self::board($spaceId, $board);
        Access::need($u['id'], $space, $board, 'owner');
        if (!Db::one('SELECT user_id FROM board_members WHERE space_id = ? AND board_id = ? AND user_id = ? AND left_at IS NULL', [$spaceId, $board, $target])) {
            $from = self::grantAbove(Access::grants($spaceId)[$target] ?? [], Access::tree($spaceId), $board);
            Http::fail(409, $from ? 'This person has access through “' . (Spaces::titles($spaceId, [$from])[$from] ?? 'a board above') . '”. Remove them there, or restrict this board.'
                                  : 'This person doesn’t have their own access to this board.');
        }
        Db::tx(function () use ($u, $spaceId, $board, $target, $cards) {
            Db::q('UPDATE board_members SET left_at = ? WHERE space_id = ? AND board_id = ? AND user_id = ?', [time(), $spaceId, $board, $target]);
            if ($cards === 'delete') Spaces::deleteCardsBy($spaceId, $target, Access::subtree($spaceId, $board), $u);
            Access::changed($spaceId);
        });
        return self::info($u, $spaceId, $board);
    }

    public static function leave(array $u, string $spaceId, string $board): array
    {
        $space = self::board($spaceId, $board);
        Access::need($u['id'], $space, $board, 'viewer');
        $from = self::grantAbove(Access::grants($spaceId)[$u['id']] ?? [], Access::tree($spaceId), $board);
        if ($from === null) Http::fail(409, 'You can’t leave this board: you have access through the workspace');
        Db::q('UPDATE board_members SET left_at = ? WHERE space_id = ? AND board_id = ? AND user_id = ?', [time(), $spaceId, $from, $u['id']]);
        Access::changed($spaceId);
        return ['ok' => true];
    }

    public static function restrict(array $u, string $spaceId, string $board, array $in): array
    {
        $space = self::board($spaceId, $board);
        Access::need($u['id'], $space, $board, 'owner');
        if ((Access::tree($spaceId)[$board] ?? null) === null) Http::fail(422, 'Only boards inside another board can be restricted');
        Db::upsert('board_access', ['space_id' => $spaceId, 'board_id' => $board, 'restricted' => empty($in['on']) ? 0 : 1], ['space_id', 'board_id']);
        Access::changed($spaceId);
        return self::info($u, $spaceId, $board);
    }

    /** Give a board in a workspace you own to someone who already has access: it moves to their home workspace and you stay on as an editor. */
    public static function transfer(array $u, string $spaceId, string $board, array $in): array
    {
        $space = self::board($spaceId, $board);
        Access::need($u['id'], $space, $board, 'owner');
        if ($space['owner_id'] !== $u['id']) Http::fail(403, 'Only the workspace owner can give its boards away');
        $target = (string) ($in['user'] ?? '');
        if ($target === $u['id'] || Access::role($target, $space, $board) === null) Http::fail(422, 'Pick someone who already has access to this board');
        $to = Spaces::home($target);
        Db::tx(function () use ($u, $spaceId, $board, $target, $to) {
            Spaces::moveBoard($u, $spaceId, $board, $to['id'], 'home');
            Db::q('DELETE FROM board_members WHERE space_id = ? AND board_id = ? AND user_id = ?', [$to['id'], $board, $target]);
            Db::upsert('board_members', ['space_id' => $to['id'], 'board_id' => $board, 'user_id' => $u['id'], 'role' => 'editor', 'created_at' => time(), 'left_at' => null],
                ['space_id', 'board_id', 'user_id']);
            Access::changed($to['id']);
        });
        return ['space' => $to['id'], 'board' => $board];
    }

    /** Move a board you own into a workspace (or another place you can edit). People it's shared with keep their access. */
    public static function move(array $u, string $spaceId, string $board, array $in): array
    {
        $space = self::board($spaceId, $board);
        Access::need($u['id'], $space, $board, 'owner');
        $toId = (string) ($in['space'] ?? '');
        $toParent = (string) ($in['parent'] ?? 'home');
        $to = Access::space($toId);
        Access::need($u['id'], $to, $toParent, 'editor');
        Db::tx(fn() => Spaces::moveBoard($u, $spaceId, $board, $toId, $toParent));
        return ['space' => $toId, 'board' => $board];
    }

    public static function deleteFormerCards(array $u, string $spaceId, string $board, string $target): array
    {
        $space = self::board($spaceId, $board);
        Access::need($u['id'], $space, $board, 'owner');
        Db::tx(fn() => Spaces::deleteCardsBy($spaceId, $target, Access::subtree($spaceId, $board), $u));
        return self::info($u, $spaceId, $board);
    }

    public static function dismissFormer(array $u, string $spaceId, string $board, string $target): array
    {
        $space = self::board($spaceId, $board);
        Access::need($u['id'], $space, $board, 'owner');
        Db::q('DELETE FROM board_members WHERE space_id = ? AND board_id = ? AND user_id = ? AND left_at IS NOT NULL', [$spaceId, $board, $target]);
        return self::info($u, $spaceId, $board);
    }
}
