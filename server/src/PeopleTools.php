<?php
declare(strict_types=1);

namespace Kolam;

/** MCP tools: Workspaces, members, share links and invitations. */
final class PeopleTools
{
    public static function definitions(): array
    {
        $space = ['type' => 'string', 'description' => 'Space id from list_boards; omit for your own boards'];
        $board = ['type' => 'string', 'description' => 'Board id; "home" for the top board'];
        $obj = fn(array $props, array $req = []) => ['type' => 'object', 'properties' => (object) (['space' => $space] + $props)] + ($req ? ['required' => $req] : []);

        return [
            ['name' => 'create_workspace', 'title' => 'Create a workspace',
             'description' => 'Make a new workspace (a shared space separate from your own boards), owned by you. '
                . 'Returns its id, usable as "space" in other tools. Free plans may only create one.',
             'inputSchema' => ['type' => 'object', 'properties' => (object) ['name' => ['type' => 'string', 'description' => 'Workspace name']], 'required' => ['name']]],

            ['name' => 'list_members', 'title' => 'List people',
             'description' => 'Who can see this: the whole workspace\'s members (owner, admins, members, guests) by default, '
                . 'or one board\'s people (owner, those shared directly, and anyone with access through the workspace) when you pass board_id. '
                . 'Also lists pending invitations.',
             'inputSchema' => $obj(['board_id' => $board + ['description' => 'Board id to list that board\'s people instead of the whole workspace']]),
             'annotations' => ['readOnlyHint' => true]],

            ['name' => 'invite', 'title' => 'Invite someone',
             'description' => 'Invite a person by email to the workspace, or to one board when you pass board_id. This sends them an invitation email '
                . 'with a link to accept, and changes who can see the person\'s boards once they do. '
                . 'Workspace roles: admin (manage people), member (edit every board). Board roles: editor, commenter, viewer.',
             'inputSchema' => $obj([
                 'email' => ['type' => 'string', 'description' => 'Email address to invite'],
                 'board_id' => $board + ['description' => 'Invite to this board only, instead of the whole workspace'],
                 'role' => ['type' => 'string', 'enum' => ['admin', 'member', 'editor', 'commenter', 'viewer'],
                            'description' => 'Workspace invite: admin or member. Board invite: editor, commenter or viewer'],
             ], ['email', 'role'])],

            ['name' => 'share_link', 'title' => 'Share links for a board',
             'description' => 'Create, list or remove a link that lets anyone with it open a board without signing in (view or comment), '
                . 'or sign in and join it (join, with a role). Creating or listing needs action=create/list with board_id; '
                . 'removing needs action=remove with token. Making a link changes who can see the board\'s cards: anyone holding the link can.',
             'inputSchema' => $obj([
                 'action' => ['type' => 'string', 'enum' => ['create', 'list', 'remove']],
                 'board_id' => $board,
                 'kind' => ['type' => 'string', 'enum' => Shares::KINDS, 'description' => 'create: view (look only), comment (look and comment), join (sign in and become a member of the board)'],
                 'role' => ['type' => 'string', 'enum' => ['editor', 'commenter', 'viewer'], 'description' => 'create, kind=join only: the role people get when they join'],
                 'label' => ['type' => 'string', 'description' => 'create: a short label to tell links apart'],
                 'expires' => ['type' => 'integer', 'description' => 'create: unix timestamp the link stops working at; omit for no expiry'],
                 'password' => ['type' => 'string', 'description' => 'create: require this password to open the link; omit for none'],
                 'token' => ['type' => 'string', 'description' => 'action=remove: the link\'s token, from action=list'],
             ], ['action'])],
        ];
    }

    public static function call(array $u, string $name, array $a): array
    {
        return match ($name) {
            'create_workspace' => self::createWorkspace($u, $a),
            'list_members' => self::listMembers($u, $a),
            'invite' => self::invite($u, $a),
            'share_link' => self::shareLink($u, $a),
            default => throw new ToolError("Unknown tool $name"),
        };
    }

    private static function createWorkspace(array $u, array $a): array
    {
        $name = trim((string) ($a['name'] ?? ''));
        if ($name === '') throw new ToolError('Give the workspace a name');
        try {
            return Spaces::create($u, ['name' => $name]);
        } catch (HttpError $e) {
            throw new ToolError($e->getMessage());
        }
    }

    private static function listMembers(array $u, array $a): array
    {
        $w = Workspace::load($u, BoardTools::spaceArg($a));
        $bid = isset($a['board_id']) ? BoardTools::boardArg($w, $a['board_id']) : null;
        try {
            return $bid === null ? Spaces::info($u, $w->spaceId) : Sharing::info($u, $w->spaceId, $bid);
        } catch (HttpError $e) {
            throw new ToolError($e->getMessage());
        }
    }

    private static function invite(array $u, array $a): array
    {
        $w = Workspace::load($u, BoardTools::spaceArg($a));
        $bid = isset($a['board_id']) ? BoardTools::boardArg($w, $a['board_id']) : null;
        $in = ['email' => (string) ($a['email'] ?? ''), 'role' => (string) ($a['role'] ?? '')];
        try {
            if ($bid === null) {
                $space = Access::space($w->spaceId);
                if (!in_array(Access::spaceRole($u['id'], $space), ['owner', 'admin'], true)) {
                    throw new ToolError('Only the workspace owner and admins can invite people');
                }
                Auth::requireVerified($u);
                return Invites::create($u, $space, null, $in);
            }
            Access::need($u['id'], Access::space($w->spaceId), $bid, 'owner');
            Auth::requireVerified($u);
            return Invites::create($u, Access::space($w->spaceId), $bid, $in);
        } catch (HttpError $e) {
            throw new ToolError($e->getMessage());
        }
    }

    private static function shareLink(array $u, array $a): array
    {
        $w = Workspace::load($u, BoardTools::spaceArg($a));
        $action = (string) ($a['action'] ?? '');
        try {
            return match ($action) {
                'create' => self::createLink($u, $w, $a),
                'list' => self::listLinks($u, $w, $a),
                'remove' => self::removeLink($u, $a),
                default => throw new ToolError('action must be create, list or remove'),
            };
        } catch (HttpError $e) {
            throw new ToolError($e->getMessage());
        }
    }

    private static function createLink(array $u, Workspace $w, array $a): array
    {
        $bid = BoardTools::boardArg($w, $a['board_id'] ?? '');
        Auth::requireVerified($u);
        $in = array_filter([
            'kind' => $a['kind'] ?? null,
            'role' => $a['role'] ?? null,
            'label' => $a['label'] ?? null,
            'expires' => $a['expires'] ?? null,
            'password' => $a['password'] ?? null,
        ], fn($v) => $v !== null);
        $link = Shares::create($u, $w->spaceId, $bid, $in);
        return ['link' => $link, 'url' => self::linkUrl($link)];
    }

    private static function listLinks(array $u, Workspace $w, array $a): array
    {
        $bid = BoardTools::boardArg($w, $a['board_id'] ?? '');
        Access::need($u['id'], Access::space($w->spaceId), $bid, 'owner');
        $links = array_map(fn($l) => $l + ['url' => self::linkUrl($l)], Shares::list($w->spaceId, $bid));
        return ['links' => $links];
    }

    private static function removeLink(array $u, array $a): array
    {
        $token = (string) ($a['token'] ?? '');
        if ($token === '') throw new ToolError('Pass token (from share_link action=list)');
        Shares::remove($u, $token);
        return ['ok' => true];
    }

    /** The URL the browser shows for a link: the app's root with ?join= or ?view= and the token. */
    private static function linkUrl(array $link): string
    {
        return Invites::appUrl() . '/?' . ($link['kind'] === 'join' ? 'join=' : 'view=') . $link['token'];
    }
}
