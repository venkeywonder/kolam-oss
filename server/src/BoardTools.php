<?php
declare(strict_types=1);

namespace Kolam;

/** The board and card operations exposed to AI assistants as MCP tools. */
final class BoardTools
{
    private const UNSORTED = '__unsorted';
    private const COLORS = ['red', 'orange', 'yellow', 'green', 'teal', 'blue', 'purple', 'pink', 'dark'];
    private const CREATABLE = ['note', 'todo', 'link', 'column', 'board', 'shortcut', 'table', 'doc', 'comment', 'swatch'];
    private const WIDTH = ['note' => 260, 'todo' => 260, 'link' => 280, 'column' => 280, 'board' => 150, 'table' => 380,
                           'doc' => 260, 'comment' => 260, 'swatch' => 140, 'image' => 300, 'file' => 260, 'sketch' => 320, 'drawing' => 200, 'shortcut' => 150];
    private const LABEL = ['note' => 'Note', 'todo' => 'To-do', 'link' => 'Link', 'column' => 'Column', 'board' => 'Board', 'table' => 'Table',
                           'doc' => 'Document', 'comment' => 'Comment', 'swatch' => 'Colour', 'image' => 'Image', 'file' => 'File',
                           'sketch' => 'Sketch', 'drawing' => 'Drawing', 'shortcut' => 'Shortcut'];
    private const BACKGROUNDS = ['dots', 'grid', 'plain'];
    private const CORNERS = ['sharp', 'curved', 'rounded'];

    /** Work that has to wait until the card changes are saved (comments need their card to exist). */
    private static array $after = [];

    public const INSTRUCTIONS = <<<TXT
        Kolam is a visual workspace: boards hold cards placed on an infinite canvas (x/y in pixels, x grows right, y grows down).
        Card types: note (rich text), todo (checklist), link, column (a vertical list that holds other cards), board (a card that opens a
        sub-board), shortcut (a card that jumps to any board in the space, however deep; deleting or moving it never touches that board),
        table, doc (long document), comment, swatch (colour), plus image, file, sketch and drawing which you can read but not create.
        Boards live in a space: your own space has "home" as its top board, with "__unsorted" as the inbox drawer for cards not on a board
        yet. Other spaces (a team workspace, or a board someone shared with you) have their own top board instead of "home"; call
        list_boards to see them, then pass their id as "space" to every tool call that should act there. Without "space" you see your own boards.
        Read before you change: call get_board (or search) to learn ids. Write text as Markdown; it is converted for display.
        Leave x/y out to let Kolam place new cards in free space beside the existing ones. Use refs to fill a column you create in the same call.
        Todo tasks have ids and an optional due date (YYYY-MM-DD). To tick, edit, date, remove or reorder some tasks, use update_card's
        task_changes / task_order rather than resending the whole list. Comments (on any card) go through comment; they are posted as the person you work for.
        Locked cards can't be changed until they are unlocked (update_card locked=false). Deleted cards wait in the Trash (list_trash, restore_from_trash).
        TXT;

    /** Tool list for MCP tools/list. */
    public static function definitions(): array
    {
        $space = ['type' => 'string', 'description' => 'Space id from list_boards; omit for your own boards'];
        $color = ['type' => 'string', 'enum' => array_merge(self::COLORS, ['none']), 'description' => 'Card colour; "none" clears it'];
        $align = ['type' => 'string', 'enum' => Styles::ALIGNS, 'description' => 'Text alignment of a note, todo, column, comment, image caption, table or doc (columns are centred by default, the rest left)'];
        $tasks = ['type' => 'array', 'items' => ['anyOf' => [['type' => 'string'], ['type' => 'object', 'properties' => [
            'id' => ['type' => 'string', 'description' => 'Id of an existing task, to keep it'],
            'text' => ['type' => 'string'], 'done' => ['type' => 'boolean'],
            'due' => ['type' => 'string', 'description' => 'Due date YYYY-MM-DD; "" clears it']], 'required' => ['text']]]]];
        $position = ['type' => 'integer', 'minimum' => 0, 'description' => 'Place inside the column, 0 = top (default: the end)'];
        $card = [
            'type' => 'object',
            'properties' => [
                'type' => ['type' => 'string', 'enum' => self::CREATABLE],
                'ref' => ['type' => 'string', 'description' => 'Optional name so later cards in this call can use it as column_id'],
                'title' => ['type' => 'string', 'description' => 'Title of a todo, column, doc, link or board'],
                'target_board_id' => ['type' => 'string', 'description' => 'Board a shortcut card opens (an id from list_boards)'],
                'text' => ['type' => 'string', 'description' => 'Markdown body of a note or doc, or the text of a comment'],
                'tasks' => $tasks + ['description' => 'Todo items'],
                'url' => ['type' => 'string', 'description' => 'Link URL (a preview is fetched automatically)'],
                'rows' => ['type' => 'array', 'items' => ['type' => 'array', 'items' => ['type' => 'string']],
                           'description' => 'Table cells, first row is the header. Cells may hold formulas like =SUM(B2:B5)'],
                'hex' => ['type' => 'string', 'description' => 'Swatch colour like #e76f51'],
                'color' => $color, 'align' => $align,
                'column_id' => ['type' => 'string', 'description' => 'Put the card inside this column (an id or a ref from this call); x/y are then ignored'],
                'position' => $position,
                'x' => ['type' => 'number'], 'y' => ['type' => 'number'],
                'w' => ['type' => 'number', 'description' => 'Width in pixels'],
            ],
            'required' => ['type'],
        ];
        $obj = fn(array $props, array $req = []) => ['type' => 'object', 'properties' => (object) (['space' => $space] + $props)] + ($req ? ['required' => $req] : []);

        return [
            ['name' => 'list_boards', 'title' => 'List boards',
             'description' => 'All boards with their ids, parent board, path and card count.',
             'inputSchema' => $obj([]), 'annotations' => ['readOnlyHint' => true]],
            ['name' => 'get_board', 'title' => 'Read a board',
             'description' => 'Every card on a board with its id, type, position, colour and content, plus connections between cards. Column contents are nested under the column.',
             'inputSchema' => $obj(['board_id' => ['type' => 'string', 'description' => 'Board id; "home" for the top board, "__unsorted" for the inbox']], ['board_id']),
             'annotations' => ['readOnlyHint' => true]],
            ['name' => 'search', 'title' => 'Search cards',
             'description' => 'Find cards and boards whose text contains the query (case-insensitive).',
             'inputSchema' => $obj(['query' => ['type' => 'string'], 'limit' => ['type' => 'integer', 'minimum' => 1, 'maximum' => 100]], ['query']),
             'annotations' => ['readOnlyHint' => true]],
            ['name' => 'create_cards', 'title' => 'Create cards',
             'description' => 'Add one or more cards to a board. Creating a card of type "board" also creates the sub-board it opens (its id is returned as board_id). '
                . 'A "shortcut" card opens an existing board (target_board_id), so people can jump to a deep board without clicking through the boards above it.',
             'inputSchema' => $obj(['board_id' => ['type' => 'string'], 'cards' => ['type' => 'array', 'items' => $card, 'minItems' => 1, 'maxItems' => 100]], ['board_id', 'cards'])],
            ['name' => 'update_card', 'title' => 'Update a card',
             'description' => 'Change a card. Only the fields you pass change. "tasks" replaces the whole checklist (pass task ids to keep their due dates); '
                . '"add_tasks" appends; "task_changes" edits single tasks by id; "task_order" reorders them. On a board card, "title" renames the board. '
                . 'Set column_id to move the card into a column, or to "" to take it out; position reorders it inside its column. Set board_id to move it to another board.',
             'inputSchema' => $obj([
                 'card_id' => ['type' => 'string'],
                 'title' => ['type' => 'string'], 'text' => ['type' => 'string', 'description' => 'Markdown; replaces a note/doc body or image caption, adds a reply to a comment card'],
                 'tasks' => $tasks, 'add_tasks' => $tasks,
                 'task_changes' => ['type' => 'array', 'items' => ['type' => 'object', 'properties' => [
                     'id' => ['type' => 'string'], 'text' => ['type' => 'string'], 'done' => ['type' => 'boolean'],
                     'due' => ['type' => 'string', 'description' => 'YYYY-MM-DD; "" clears it'],
                     'delete' => ['type' => 'boolean', 'description' => 'Remove the task']], 'required' => ['id']]],
                 'task_order' => ['type' => 'array', 'items' => ['type' => 'string'], 'description' => 'Task ids in the new order; tasks left out keep their order after these'],
                 'url' => ['type' => 'string'],
                 'rows' => $card['properties']['rows'], 'hex' => ['type' => 'string'], 'color' => $color, 'align' => $align,
                 'x' => ['type' => 'number'], 'y' => ['type' => 'number'], 'w' => ['type' => 'number'], 'h' => ['type' => 'number'],
                 'column_id' => ['type' => 'string'], 'position' => $position, 'board_id' => ['type' => 'string'],
                 'locked' => ['type' => 'boolean', 'description' => 'Lock the card in place so it can’t be edited, moved or resized; false unlocks it'],
                 'collapsed' => ['type' => 'boolean', 'description' => 'Collapse or expand a column'],
             ], ['card_id'])],
            ['name' => 'duplicate_cards', 'title' => 'Duplicate cards',
             'description' => 'Copy cards (with a column’s cards, a board card’s whole board, and the connections between them). Copies go beside the originals, or onto board_id.',
             'inputSchema' => $obj(['card_ids' => ['type' => 'array', 'items' => ['type' => 'string'], 'minItems' => 1, 'maxItems' => 100],
                                    'board_id' => ['type' => 'string', 'description' => 'Board to put the copies on (default: the same board)']], ['card_ids'])],
            ['name' => 'delete_cards', 'title' => 'Delete cards',
             'description' => 'Move cards to the Trash (the user can restore them). Deleting a column deletes its cards; deleting a board card deletes the board inside it.',
             'inputSchema' => $obj(['card_ids' => ['type' => 'array', 'items' => ['type' => 'string'], 'minItems' => 1]], ['card_ids']),
             'annotations' => ['destructiveHint' => true]],
            ['name' => 'connect_cards', 'title' => 'Connect cards',
             'description' => 'Draw an arrow from one card to another on the same board.',
             'inputSchema' => $obj(['from_card_id' => ['type' => 'string'], 'to_card_id' => ['type' => 'string'], 'label' => ['type' => 'string'],
                                    'arrow' => ['type' => 'boolean', 'description' => 'Arrow head at the end (default: the person’s usual line style)']], ['from_card_id', 'to_card_id'])],
            ['name' => 'update_connection', 'title' => 'Update a connection',
             'description' => 'Change a connection line’s label, arrow head or colour.',
             'inputSchema' => $obj(['connection_id' => ['type' => 'string'], 'label' => ['type' => 'string', 'description' => '"" removes the label'],
                                    'arrow' => ['type' => 'boolean'], 'color' => $color], ['connection_id'])],
            ['name' => 'delete_connections', 'title' => 'Delete connections',
             'description' => 'Remove connection lines by id (ids come from get_board).',
             'inputSchema' => $obj(['connection_ids' => ['type' => 'array', 'items' => ['type' => 'string'], 'minItems' => 1]], ['connection_ids']),
             'annotations' => ['destructiveHint' => true]],
            ['name' => 'comment', 'title' => 'Comment on a card',
             'description' => 'Add a comment to any card’s thread (Markdown), and/or resolve or reopen that thread. A new comment reopens a resolved thread.',
             'inputSchema' => $obj(['card_id' => ['type' => 'string'], 'text' => ['type' => 'string'],
                                    'resolved' => ['type' => 'boolean', 'description' => 'true resolves the thread, false reopens it']], ['card_id'])],
            ['name' => 'update_board', 'title' => 'Update a board',
             'description' => 'Rename a board, change its background or card corners, set the icon on the card that opens it, or move it under another board.',
             'inputSchema' => $obj([
                 'board_id' => ['type' => 'string'], 'title' => ['type' => 'string'],
                 'background' => ['type' => 'string', 'enum' => self::BACKGROUNDS],
                 'corners' => ['type' => 'string', 'enum' => self::CORNERS, 'description' => 'Corners of every card on this board'],
                 'icon' => ['type' => 'string', 'description' => 'One emoji shown on the board’s card; "" restores the default icon'],
                 'parent_board_id' => ['type' => 'string', 'description' => 'Move the board (its card) onto this board'],
             ], ['board_id'])],
            ['name' => 'list_trash', 'title' => 'List the Trash',
             'description' => 'Deleted cards and boards that can still be restored, newest first.',
             'inputSchema' => $obj([]), 'annotations' => ['readOnlyHint' => true]],
            ['name' => 'restore_from_trash', 'title' => 'Restore from the Trash',
             'description' => 'Bring a Trash entry back to the board it was deleted from (or the top board if that is gone).',
             'inputSchema' => $obj(['trash_id' => ['type' => 'string']], ['trash_id'])],
        ];
    }

    /** Run a tool; returns data that is sent back to the model as JSON text. */
    public static function call(array $u, string $name, array $a): array
    {
        $space = isset($a['space']) && is_string($a['space']) && $a['space'] !== '' ? $a['space'] : null;
        $w = Workspace::load($u, $space);
        self::$after = [];
        $r = match ($name) {
            'list_boards' => self::listBoards($w, $u),
            'get_board' => self::getBoard($w, self::boardArg($w, $a['board_id'] ?? self::defaultBoard($w))),
            'search' => self::search($w, (string) ($a['query'] ?? ''), (int) ($a['limit'] ?? 30)),
            'create_cards' => self::createCards($w, $u, self::editableBoard($w, $a['board_id'] ?? ''), $a['cards'] ?? null),
            'update_card' => self::updateCard($w, $u, $a),
            'duplicate_cards' => self::duplicateCards($w, $a),
            'delete_cards' => self::deleteCards($w, $a['card_ids'] ?? null),
            'connect_cards' => self::connect($w, $u, $a),
            'update_connection' => self::updateConnection($w, $a),
            'delete_connections' => self::deleteConnections($w, $a['connection_ids'] ?? null),
            'comment' => self::comment($w, $u, $a),
            'update_board' => self::updateBoard($w, $a),
            'list_trash' => self::listTrash($w),
            'restore_from_trash' => self::restoreTrash($w, (string) ($a['trash_id'] ?? '')),
            default => throw new ToolError("Unknown tool $name"),
        };
        $w->commit();
        foreach (self::$after as $f) $f();
        self::$after = [];
        return $r;
    }

    /** First board the person can see when "home" isn't visible to them (a shared board with its own top). */
    private static function defaultBoard(Workspace $w): string
    {
        if (isset($w->boards['home'])) return 'home';
        foreach ($w->boards as $id => $b) {
            if (!isset($b['parent']) || !isset($w->boards[$b['parent']])) return $id;
        }
        return self::UNSORTED;
    }

    /** Fails with a model-friendly message when the person can only view this board. */
    private static function requireEditor(Workspace $w, string $bid): void
    {
        if (!Access::atLeast($w->roles[$bid] ?? null, 'editor')) throw new ToolError('You can only view this board');
    }

    private static function editableBoard(Workspace $w, mixed $id): string
    {
        $bid = self::boardArg($w, $id);
        self::requireEditor($w, $bid);
        return $bid;
    }

    /* ---------- reading ---------- */

    private static function listBoards(Workspace $w, array $u): array
    {
        $count = [];
        foreach ($w->items as $i) $count[$i['board'] ?? ''] = ($count[$i['board'] ?? ''] ?? 0) + 1;
        $out = [];
        foreach ($w->boards as $id => $b) {
            $out[] = ['id' => $id, 'title' => $b['title'] ?? '', 'parent_id' => $b['parent'] ?? null, 'path' => $w->path($id), 'cards' => $count[$id] ?? 0];
        }
        usort($out, fn($a, $b) => strcmp($a['path'], $b['path']));
        return ['boards' => $out, 'unsorted_cards' => $count[self::UNSORTED] ?? 0, 'spaces' => self::otherSpaces($w, $u)];
    }

    /** Other places (workspaces, or boards shared with them) the person can open, besides the space just listed. */
    private static function otherSpaces(Workspace $w, array $u): array
    {
        $out = [];
        foreach (Db::q('SELECT s.id, s.name, m.role FROM space_members m JOIN spaces s ON s.id = m.space_id
                         WHERE m.user_id = ? AND m.left_at IS NULL AND s.deleted_at IS NULL AND s.id <> ?', [$u['id'], $w->spaceId]) as $r) {
            $out[$r['id']] = ['space' => $r['id'], 'name' => $r['name'], 'kind' => 'workspace', 'role' => $r['role']];
        }
        foreach (Db::q('SELECT DISTINCT space_id FROM board_members WHERE user_id = ? AND left_at IS NULL AND space_id <> ?',
                        [$u['id'], $w->spaceId]) as $r) {
            $sid = $r['space_id'];
            if (isset($out[$sid])) continue;
            $space = Access::space($sid);
            $roles = Access::boards($u['id'], $space);
            $best = null;
            foreach ($roles as $role) if ($best === null || Access::RANK[$role] > Access::RANK[$best]) $best = $role;
            if ($best === null) continue;
            $name = $space['kind'] === 'personal'
                ? (Access::names([$space['owner_id']])[$space['owner_id']]['name'] ?? 'Someone') . '’s boards'
                : $space['name'];
            $out[$sid] = ['space' => $sid, 'name' => $name, 'kind' => $space['kind'], 'role' => $best];
        }
        return array_values($out);
    }

    private static function getBoard(Workspace $w, string $bid): array
    {
        $top = array_values(array_filter($w->itemsOf($bid), fn($i) => empty($i['col'])));
        usort($top, fn($a, $b) => [$a['y'] ?? 0, $a['x'] ?? 0] <=> [$b['y'] ?? 0, $b['x'] ?? 0]);
        $cards = array_map(fn($i) => self::describe($w, $i), $top);
        $conns = [];
        foreach ($w->lines as $l) {
            if (($l['board'] ?? null) !== $bid) continue;
            $conns[] = array_filter(['id' => $l['id'], 'from' => $l['a']['item'] ?? null, 'to' => $l['b']['item'] ?? null,
                                     'label' => ($l['label'] ?? '') ?: null, 'arrow' => !empty($l['arrow']), 'color' => $l['color'] ?? null], fn($v) => $v !== null);
        }
        $b = $w->boards[$bid] ?? null;
        return [
            'board' => $bid === self::UNSORTED ? ['id' => $bid, 'title' => 'Unsorted'] :
                ['id' => $bid, 'title' => $b['title'] ?? '', 'path' => $w->path($bid), 'parent_id' => $b['parent'] ?? null,
                 'background' => $b['bg'] ?? 'dots', 'corners' => $b['corners'] ?? 'sharp'],
            'cards' => $cards,
            'connections' => $conns,
        ];
    }

    private static function describe(Workspace $w, array $i, bool $inColumn = false): array
    {
        $d = $i['data'] ?? [];
        $o = ['id' => $i['id'], 'type' => $i['type']];
        if (!$inColumn) $o += ['x' => $i['x'] ?? 0, 'y' => $i['y'] ?? 0, 'w' => $i['w'] ?? null];
        if (!empty($i['h'])) $o['h'] = $i['h'];
        if (!empty($i['color'])) $o['color'] = $i['color'];
        if (!empty($i['locked'])) $o['locked'] = true;
        if (!empty($i['align'])) $o['align'] = $i['align'];
        switch ($i['type']) {
            case 'note': $o['text'] = Text::plain($d['html'] ?? ''); break;
            case 'todo':
                $o['title'] = $d['title'] ?? '';
                $o['tasks'] = array_map(fn($t) => array_filter(['id' => $t['id'] ?? '', 'text' => $t['t'] ?? '', 'done' => !empty($t['done']),
                                                                'due' => $t['due'] ?? null], fn($v) => $v !== null), $d['tasks'] ?? []);
                break;
            case 'link': $o += array_filter(['url' => $d['url'] ?? '', 'title' => $d['title'] ?? '', 'description' => $d['desc'] ?? '']); break;
            case 'image': $o['caption'] = Text::plain($d['caption'] ?? ''); if (!empty($d['src'])) $o['src'] = $d['src']; break;
            case 'file': $o += ['name' => $d['name'] ?? '', 'size' => $d['size'] ?? 0]; break;
            case 'board':
                $t = $d['target'] ?? '';
                $o += ['board_id' => $t, 'title' => $w->boards[$t]['title'] ?? 'Missing board', 'cards' => count($w->itemsOf($t))];
                if (!empty($d['emoji'])) $o['icon'] = $d['emoji'];
                break;
            case 'shortcut':
                $t = $d['target'] ?? '';
                $o += isset($w->boards[$t]) ? ['board_id' => $t, 'title' => $w->boards[$t]['title'] ?? '', 'path' => $w->path($t)]
                    : ['board_id' => $t, 'title' => 'Missing board'];
                break;
            case 'column':
                $o['title'] = $d['title'] ?? '';
                if (!empty($d['collapsed'])) $o['collapsed'] = true;
                $o['cards'] = array_map(fn($k) => self::describe($w, $k, true), $w->childrenOf($i['id']));
                break;
            case 'table': $o['rows'] = $d['rows'] ?? []; break;
            case 'doc': $o += ['title' => $d['title'] ?? '', 'text' => Text::plain($d['html'] ?? '')]; break;
            case 'swatch': $o['hex'] = $d['hex'] ?? ''; break;
        }
        // comments on any card, as "Name: text"
        $c = self::comments($w);
        if ($t = $c['texts'][$i['id']] ?? null) $o['comments'] = $t;
        if (isset($c['resolved'][$i['id']])) $o['comments_resolved'] = true;
        return $o;
    }

    /** Comments of the workspace's cards and their resolved threads, read once per revision of the space. */
    private static function comments(Workspace $w): array
    {
        static $cache = [];
        $rev = (int) (Db::one('SELECT rev FROM spaces WHERE id = ?', [$w->spaceId])['rev'] ?? 0);
        if (($cache[$w->spaceId][0] ?? null) !== $rev) {
            $resolved = [];
            foreach (Db::q('SELECT item_id FROM comment_threads WHERE space_id = ? AND resolved_at IS NOT NULL', [$w->spaceId]) as $r) $resolved[$r['item_id']] = true;
            $cache[$w->spaceId] = [$rev, ['texts' => Comments::texts($w->spaceId), 'resolved' => $resolved]];
        }
        return $cache[$w->spaceId][1];
    }

    private static function search(Workspace $w, string $q, int $limit): array
    {
        $q = trim($q);
        if ($q === '') throw new ToolError('Pass a query');
        $limit = max(1, min(100, $limit));
        $hits = [];
        foreach ($w->boards as $id => $b) {
            if (mb_stripos($b['title'] ?? '', $q) !== false) $hits[] = ['kind' => 'board', 'board_id' => $id, 'path' => $w->path($id)];
        }
        foreach ($w->items as $i) {
            $text = self::text($w, $i);
            $p = mb_stripos($text, $q);
            if ($p === false) continue;
            $bid = $i['board'] ?? '';
            $hits[] = ['kind' => 'card', 'card_id' => $i['id'], 'type' => $i['type'], 'board_id' => $bid,
                       'board' => $bid === self::UNSORTED ? 'Unsorted' : $w->path($bid),
                       'snippet' => mb_substr($text, max(0, $p - 60), 160)];
            if (count($hits) >= $limit) break;
        }
        return ['results' => array_slice($hits, 0, $limit)];
    }

    /** Searchable plain text of a card (mirrors each type's text() in the browser). */
    private static function text(Workspace $w, array $i): string
    {
        $d = $i['data'] ?? [];
        return trim(match ($i['type']) {
            'note' => Text::plain($d['html'] ?? ''),
            'todo' => ($d['title'] ?? '') . "\n" . implode("\n", array_map(fn($t) => $t['t'] ?? '', $d['tasks'] ?? [])),
            'link' => ($d['title'] ?? '') . ' ' . ($d['url'] ?? ''),
            'image' => Text::plain($d['caption'] ?? ''),
            'file' => $d['name'] ?? '',
            'board', 'shortcut' => $w->boards[$d['target'] ?? '']['title'] ?? '',
            'column' => $d['title'] ?? '',
            'comment' => implode("\n", self::comments($w)['texts'][$i['id']] ?? []),
            'table' => implode("\n", array_map(fn($r) => implode(' | ', array_map('strval', (array) $r)), $d['rows'] ?? [])),
            'doc' => ($d['title'] ?? '') . "\n" . Text::plain($d['html'] ?? ''),
            'swatch' => $d['hex'] ?? '',
            default => '',
        });
    }

    /* ---------- writing ---------- */

    private static function createCards(Workspace $w, array $u, string $bid, mixed $cards): array
    {
        if (!is_array($cards) || !$cards || !array_is_list($cards)) throw new ToolError('Pass cards as a non-empty list');
        if (count($cards) > 100) throw new ToolError('At most 100 cards per call');
        $refs = [];
        $styles = Styles::get($u['id']);   // the person's last-used colours, table header and board look
        $place = new Placer($w, $bid);
        $out = [];
        foreach ($cards as $n => $c) {
            if (!is_array($c)) throw new ToolError("Card $n is not an object");
            $type = $c['type'] ?? '';
            if (!in_array($type, self::CREATABLE, true)) throw new ToolError("Card $n: type must be one of " . implode(', ', self::CREATABLE));
            $it = ['id' => Workspace::uid(), 'board' => $bid, 'type' => $type, 'x' => 0, 'y' => 0,
                   'w' => self::num($c['w'] ?? null, 80, 2000) ?? self::WIDTH[$type], 'z' => $w->maxZ($bid) + 1,
                   'col' => null, 'order' => 0, 'data' => [],
                   'color' => array_key_exists('color', $c) ? self::color($c['color']) : ($styles[$type]['color'] ?? null)];
            if ($bid === self::UNSORTED) $it['order'] = (int) (microtime(true) * 1000) + $n;
            $it['data'] = self::dataFor($type, $c);
            if ($type === 'table' && isset($styles['table']['header'])) $it['data']['header'] = $styles['table']['header'];
            if (in_array($type, Styles::ALIGNABLE, true)) {
                $al = array_key_exists('align', $c) ? self::align($type, $c['align']) : ($styles[$type]['align'] ?? null);
                if ($al) $it['align'] = $al;
            } elseif (array_key_exists('align', $c)) throw new ToolError("Card $n: a $type card has no text alignment");
            $res = ['id' => $it['id'], 'type' => $type];
            if ($type === 'board') {
                $nb = ['id' => Workspace::uid(), 'title' => self::str($c['title'] ?? '', 200) ?: 'Untitled board', 'parent' => $bid === self::UNSORTED ? 'home' : $bid]
                    + array_filter(['bg' => $styles['board']['bg'] ?? null, 'corners' => ($styles['board']['corners'] ?? 'sharp') === 'sharp' ? null : $styles['board']['corners']]);
                $w->putBoard($nb);
                $it['data'] = ['target' => $nb['id']];
                $res['board_id'] = $nb['id'];
            }
            if ($type === 'shortcut') {
                $t = (string) ($c['target_board_id'] ?? '');
                if (!isset($w->boards[$t])) throw new ToolError("Card $n: target_board_id must be the id of a board from list_boards");
                $it['data'] = ['target' => $t];
                $res['board_id'] = $t;
            }
            if ($type === 'sketch') $it['h'] = 220;
            $colId = isset($c['column_id']) ? (string) $c['column_id'] : '';
            if ($colId !== '') {
                $colId = $refs[$colId] ?? $colId;
                self::intoColumn($w, $it, $colId);
                $res['column_id'] = $colId;
            } elseif (isset($c['x'], $c['y']) && is_numeric($c['x']) && is_numeric($c['y'])) {
                $it['x'] = (int) round((float) $c['x']); $it['y'] = (int) round((float) $c['y']);
            } else {
                [$it['x'], $it['y']] = $place->next($it['w'], $type === 'column' ? 420 : 240);
            }
            $w->putItem($it);
            if ($colId !== '' && isset($c['position'])) self::reorder($w, $colId, $it['id'], (int) $c['position']);
            if ($type === 'comment' && ($text = self::str($c['text'] ?? '', 5000)) !== '') self::commentLater($w, $u, $it['id'], $text);
            if (isset($c['ref']) && is_string($c['ref']) && $c['ref'] !== '') $refs[$c['ref']] = $it['id'];
            $out[] = $res;
        }
        return ['created' => $out];
    }

    private static function updateCard(Workspace $w, array $u, array $a): array
    {
        $it = self::card($w, $a['card_id'] ?? null);
        self::requireEditor($w, $it['board'] ?? '');
        $changes = array_diff(array_keys($a), ['card_id', 'space', 'locked']);
        if (!empty($it['locked']) && ($a['locked'] ?? true) !== false && $changes) {
            throw new ToolError('This card is locked. Pass locked: false (in the same call) to unlock it first.');
        }
        $d = $it['data'] ?? [];
        $type = $it['type'];
        if (array_key_exists('title', $a)) {
            $t = self::str($a['title'], 200);
            if ($type === 'board') {
                $b = $w->boards[$d['target'] ?? ''] ?? throw new ToolError('The board behind this card is missing');
                $b['title'] = $t ?: 'Untitled board';
                $w->putBoard($b);
            } elseif (in_array($type, ['todo', 'column', 'doc', 'link'], true)) $d['title'] = $t;
            else throw new ToolError("A $type card has no title");
        }
        if (array_key_exists('text', $a)) {
            $md = self::str($a['text'], 200000);
            match ($type) {
                'note', 'doc' => $d['html'] = Text::html($md),
                'image' => $d['caption'] = Text::html($md),
                'comment' => $md === '' ? null : self::commentLater($w, $u, $it['id'], $md),
                default => throw new ToolError("A $type card has no text; use title, tasks, rows or url instead"),
            };
        }
        if (array_intersect(['tasks', 'add_tasks', 'task_changes', 'task_order'], array_keys($a))) {
            if ($type !== 'todo') throw new ToolError('Only todo cards have tasks');
            if (array_key_exists('tasks', $a)) $d['tasks'] = self::tasks($a['tasks'], $d['tasks'] ?? []);
            if (array_key_exists('add_tasks', $a)) $d['tasks'] = array_merge($d['tasks'] ?? [], self::tasks($a['add_tasks']));
            if (array_key_exists('task_changes', $a)) $d['tasks'] = self::changeTasks($d['tasks'] ?? [], $a['task_changes']);
            if (array_key_exists('task_order', $a)) $d['tasks'] = self::orderTasks($d['tasks'] ?? [], $a['task_order']);
        }
        if (array_key_exists('url', $a)) {
            if ($type !== 'link') throw new ToolError('Only link cards have a url');
            $d = self::linkData((string) $a['url'], array_key_exists('title', $a) ? ($d['title'] ?? '') : '');
        }
        if (array_key_exists('rows', $a)) {
            if ($type !== 'table') throw new ToolError('Only table cards have rows');
            $d['rows'] = self::rows($a['rows']);
        }
        if (array_key_exists('hex', $a)) {
            if ($type !== 'swatch') throw new ToolError('Only swatch cards have a hex colour');
            $d['hex'] = self::hex($a['hex']);
        }
        if (array_key_exists('collapsed', $a)) {
            if ($type !== 'column') throw new ToolError('Only columns can be collapsed');
            if ($a['collapsed']) $d['collapsed'] = true; else unset($d['collapsed']);
        }
        $it['data'] = $d;
        if (array_key_exists('color', $a)) $it['color'] = self::color($a['color']);
        if (array_key_exists('align', $a)) $it['align'] = self::align($type, $a['align']);
        if (array_key_exists('locked', $a)) {
            if ($a['locked']) $it['locked'] = true; else unset($it['locked'], $it['lockedBy']);
        }
        foreach (['x' => [-1e6, 1e6], 'y' => [-1e6, 1e6], 'w' => [80, 2000], 'h' => [60, 3000]] as $k => [$min, $max]) {
            if (array_key_exists($k, $a) && ($v = self::num($a[$k], $min, $max)) !== null) $it[$k] = $v;
        }

        if (array_key_exists('board_id', $a) && (string) $a['board_id'] !== ($it['board'] ?? '')) {
            self::moveToBoard($w, $it, self::editableBoard($w, (string) $a['board_id']));
        } elseif (array_key_exists('column_id', $a)) {
            $col = (string) $a['column_id'];
            if ($col === '') {
                if (!empty($it['col'])) {
                    $old = $it['col'];
                    $it['col'] = null;
                    if (!array_key_exists('x', $a) || !array_key_exists('y', $a)) [$it['x'], $it['y']] = (new Placer($w, $it['board']))->next($it['w'] ?? 260, 240);
                    $it['z'] = $w->maxZ($it['board']) + 1;
                    $w->putItem($it);
                    self::renumber($w, $old);
                }
            } elseif ($col !== ($it['col'] ?? '')) {
                $old = $it['col'] ?? null;
                self::intoColumn($w, $it, $col);
                $w->putItem($it);
                if ($old) self::renumber($w, $old);
            }
        }
        $w->putItem($it);
        if (array_key_exists('position', $a)) {
            if (empty($it['col'])) throw new ToolError('position only applies to a card inside a column');
            self::reorder($w, $it['col'], $it['id'], (int) $a['position']);
        }
        return ['updated' => self::describe($w, $w->items[$it['id']])];
    }

    /** Duplicate cards the way the browser does: a column brings its cards, a board card a copy of its board, plus the lines between them. */
    private static function duplicateCards(Workspace $w, array $a): array
    {
        $ids = $a['card_ids'] ?? null;
        if (!is_array($ids) || !$ids) throw new ToolError('Pass card_ids');
        if (count($ids) > 100) throw new ToolError('At most 100 cards per call');
        $tops = array_map(fn($id) => self::card($w, $id), array_values(array_unique($ids)));
        $from = $tops[0]['board'];
        foreach ($tops as $t) if ($t['board'] !== $from) throw new ToolError('Duplicate cards from one board at a time');
        self::requireEditor($w, $from);
        $to = isset($a['board_id']) && $a['board_id'] !== '' ? self::editableBoard($w, $a['board_id']) : $from;
        $set = [];
        foreach ($tops as $t) {
            $set[$t['id']] = true;
            if ($t['type'] === 'column') foreach ($w->childrenOf($t['id']) as $k) $set[$k['id']] = true;
        }
        $place = new Placer($w, $to);
        $items = [];
        foreach (array_keys($set) as $id) {
            $n = $w->items[$id];
            if (!empty($n['col']) && !isset($set[$n['col']])) {   // a card taken out of its column
                $n['col'] = null;
                [$n['x'], $n['y']] = $place->next($n['w'] ?? 260, 240);
                $n['moved'] = true;
            }
            $items[] = $n;
        }
        $lines = array_values(array_filter($w->lines, fn($l) => ($l['board'] ?? '') === $from && (isset($l['a']['item']) || isset($l['b']['item']))
            && (!isset($l['a']['item']) || isset($set[$l['a']['item']])) && (!isset($l['b']['item']) || isset($set[$l['b']['item']]))));
        // same board: just beside the originals; another board: the group goes into free space there
        $dx = $dy = 24;
        if ($to !== $from) {
            $free = array_filter($items, fn($i) => empty($i['col']) && empty($i['moved']));
            if ($free) {
                $minX = min(array_map(fn($i) => $i['x'] ?? 0, $free)); $minY = min(array_map(fn($i) => $i['y'] ?? 0, $free));
                [$px, $py] = $place->next(260, 240);
                $dx = $px - $minX; $dy = $py - $minY;
            }
        }
        $map = self::cloneItems($w, $items, $lines, $to, $dx, $dy);
        return ['created' => array_map(fn($t) => ['from' => $t['id'], 'id' => $map[$t['id']]], $tops)];
    }

    /** Copies of $items (and $lines between them) on board $bid, shifted by dx/dy; returns old id => new id. */
    private static function cloneItems(Workspace $w, array $items, array $lines, string $bid, int $dx, int $dy): array
    {
        $map = [];
        foreach ($items as $i) $map[$i['id']] = Workspace::uid();
        $z = $w->maxZ($bid);
        foreach ($items as $src) {
            $n = $src;
            $moved = !empty($n['moved']);
            unset($n['moved']);
            $n['id'] = $map[$src['id']]; $n['board'] = $bid;
            $n['col'] = !empty($src['col']) ? ($map[$src['col']] ?? null) : null;
            if (!$n['col']) {
                if (!$moved) { $n['x'] = (int) round(($n['x'] ?? 0) + $dx); $n['y'] = (int) round(($n['y'] ?? 0) + $dy); }
                $n['z'] = ++$z;
                if ($bid === self::UNSORTED) $n['order'] = (int) (microtime(true) * 1000) + $z;
            }
            if ($n['type'] === 'board') $n['data'] = ['target' => self::cloneBoard($w, $src['data']['target'] ?? '', $bid)] + array_intersect_key($src['data'] ?? [], ['emoji' => 1]);
            $w->putItem($n);
        }
        $end = fn(array $e) => isset($e['item']) ? (isset($map[$e['item']]) ? ['item' => $map[$e['item']]] + $e : null)
                                                 : ['x' => ($e['x'] ?? 0) + $dx, 'y' => ($e['y'] ?? 0) + $dy] + $e;
        foreach ($lines as $l) {
            $ea = $end($l['a'] ?? []); $eb = $end($l['b'] ?? []);
            if ($ea && $eb) $w->putLine(['id' => Workspace::uid(), 'board' => $bid, 'a' => $ea, 'b' => $eb] + $l);
        }
        return $map;
    }

    private static function cloneBoard(Workspace $w, string $bid, string $parent): string
    {
        $src = $w->boards[$bid] ?? null;
        $nb = ['id' => Workspace::uid(), 'title' => $src['title'] ?? 'Untitled board', 'parent' => $parent === self::UNSORTED ? 'home' : $parent]
            + array_intersect_key($src ?? [], ['bg' => 1, 'corners' => 1]);
        $w->putBoard($nb);
        if ($src) {
            self::cloneItems($w, $w->itemsOf($bid), array_values(array_filter($w->lines, fn($l) => ($l['board'] ?? '') === $bid)), $nb['id'], 0, 0);
        }
        return $nb['id'];
    }

    private static function deleteCards(Workspace $w, mixed $ids): array
    {
        if (!is_array($ids) || !$ids) throw new ToolError('Pass card_ids');
        $tops = array_map(fn($id) => self::card($w, $id), $ids);
        foreach ($tops as $t) self::requireEditor($w, $t['board'] ?? '');
        // gather everything that goes, the same way the browser does (columns take their cards, board cards take their board)
        $items = []; $boards = [];
        $addItem = function (string $id) use (&$addItem, &$addBoard, &$items, $w) {
            if (isset($items[$id]) || !isset($w->items[$id])) return;
            $it = $w->items[$id]; $items[$id] = $it;
            if ($it['type'] === 'column') foreach ($w->childrenOf($id) as $k) $addItem($k['id']);
            if ($it['type'] === 'board') $addBoard($it['data']['target'] ?? '');
        };
        $addBoard = function (string $bid) use (&$addItem, &$boards, $w) {
            if ($bid === 'home' || isset($boards[$bid]) || !isset($w->boards[$bid])) return;
            $boards[$bid] = $w->boards[$bid];
            foreach ($w->itemsOf($bid) as $i) $addItem($i['id']);
        };
        foreach ($tops as $t) $addItem($t['id']);
        $lines = array_filter($w->lines, fn($l) => isset($boards[$l['board'] ?? '']) || isset($items[$l['a']['item'] ?? '']) || isset($items[$l['b']['item'] ?? '']));
        $first = $tops[0];
        $label = count($tops) === 1 ? self::LABEL[$first['type']] . (($t = mb_substr(self::text($w, $first), 0, 70)) !== '' ? ': ' . $t : '') : count($tops) . ' cards';
        $w->putTrash(['id' => Workspace::uid(), 'at' => (int) (microtime(true) * 1000), 'from' => $first['board'], 'label' => $label,
                      'items' => array_values($items), 'boards' => array_values($boards), 'lines' => array_values($lines)]);
        foreach ($lines as $id => $_) $w->delLine($id);
        foreach ($items as $id => $_) $w->delItem($id);
        foreach ($boards as $id => $_) $w->delBoard($id);
        $cols = array_unique(array_filter(array_map(fn($t) => $t['col'] ?? null, $tops)));
        foreach ($cols as $c) if (isset($w->items[$c])) self::renumber($w, $c);
        return ['moved_to_trash' => count($items), 'boards_removed' => count($boards)];
    }

    private static function connect(Workspace $w, array $u, array $a): array
    {
        $from = self::card($w, $a['from_card_id'] ?? null);
        $to = self::card($w, $a['to_card_id'] ?? null);
        self::requireEditor($w, $from['board'] ?? '');
        if ($from['id'] === $to['id']) throw new ToolError('Pick two different cards');
        if ($from['board'] !== $to['board']) throw new ToolError('Both cards must be on the same board');
        // the person's line style (route, arrowheads, head, width, dash, colour); "arrow" from the call wins
        $s = Styles::get($u['id'])['line'] ?? [];
        $ln = ['id' => Workspace::uid(), 'board' => $from['board'], 'a' => ['item' => $from['id']], 'b' => ['item' => $to['id']],
               'arrow' => array_key_exists('arrow', $a) ? $a['arrow'] !== false : ($s['arrow'] ?? true), 'color' => $s['color'] ?? null, 'bend' => 0]
            + array_intersect_key($s, ['route' => 1, 'arrowStart' => 1, 'head' => 1, 'width' => 1, 'dash' => 1]);
        if (($ln['route'] ?? '') === 'curved') {   // a curve needs a bend to show; about a fifth of the distance, like the browser
            $ln['bend'] = (int) max(40, round(hypot(($to['x'] ?? 0) - ($from['x'] ?? 0), ($to['y'] ?? 0) - ($from['y'] ?? 0)) * 0.2));
        }
        if (($l = self::str($a['label'] ?? '', 120)) !== '') $ln['label'] = $l;
        $w->putLine($ln);
        return ['connection_id' => $ln['id']];
    }

    private static function deleteConnections(Workspace $w, mixed $ids): array
    {
        if (!is_array($ids) || !$ids) throw new ToolError('Pass connection_ids');
        foreach ($ids as $id) {
            if (!is_string($id) || !isset($w->lines[$id])) throw new ToolError("No connection with id $id");
            self::requireEditor($w, $w->lines[$id]['board'] ?? '');
            $w->delLine($id);
        }
        return ['deleted' => count($ids)];
    }

    private static function updateConnection(Workspace $w, array $a): array
    {
        $id = $a['connection_id'] ?? null;
        if (!is_string($id) || !isset($w->lines[$id])) throw new ToolError('No connection with id ' . (is_string($id) ? $id : '?'));
        $ln = $w->lines[$id];
        self::requireEditor($w, $ln['board'] ?? '');
        if (array_key_exists('label', $a)) {
            if (($l = self::str($a['label'], 120)) !== '') $ln['label'] = $l; else unset($ln['label']);
        }
        if (array_key_exists('arrow', $a)) $ln['arrow'] = (bool) $a['arrow'];
        if (array_key_exists('color', $a)) $ln['color'] = self::color($a['color']);
        $w->putLine($ln);
        return ['updated' => array_filter(['id' => $id, 'label' => ($ln['label'] ?? '') ?: null, 'arrow' => !empty($ln['arrow']), 'color' => $ln['color'] ?? null], fn($v) => $v !== null)];
    }

    /** Comment on a card and/or resolve its thread, through the comments API (mentions notify, rules hold). */
    private static function comment(Workspace $w, array $u, array $a): array
    {
        $it = self::card($w, $a['card_id'] ?? null);
        $text = self::str($a['text'] ?? '', 5000);
        if ($text === '' && !array_key_exists('resolved', $a)) throw new ToolError('Pass text, resolved, or both');
        $out = ['card_id' => $it['id']];
        if ($text !== '') $out['comment_id'] = Comments::add($u, ['space' => $w->spaceId, 'item' => $it['id'], 'body' => $text])['comment']['id'] ?? null;
        if (array_key_exists('resolved', $a)) {
            Comments::resolve($u, ['space' => $w->spaceId, 'item' => $it['id'], 'resolved' => (bool) $a['resolved']]);
            $out['resolved'] = (bool) $a['resolved'];
        }
        return $out;
    }

    /** Post a comment once the card changes are saved (a new comment card has to exist first). */
    private static function commentLater(Workspace $w, array $u, string $item, string $text): null
    {
        self::$after[] = fn() => Comments::add($u, ['space' => $w->spaceId, 'item' => $item, 'body' => mb_substr($text, 0, 5000)]);
        return null;
    }

    private static function updateBoard(Workspace $w, array $a): array
    {
        $bid = self::editableBoard($w, $a['board_id'] ?? null);
        if ($bid === self::UNSORTED) throw new ToolError('The Unsorted inbox has no board settings');
        $b = $w->boards[$bid];
        if (array_key_exists('title', $a)) $b['title'] = self::str($a['title'], 200) ?: 'Untitled board';
        if (array_key_exists('background', $a)) {
            if (!in_array($a['background'], self::BACKGROUNDS, true)) throw new ToolError('background must be one of ' . implode(', ', self::BACKGROUNDS));
            $b['bg'] = $a['background'];
        }
        if (array_key_exists('corners', $a)) {
            if (!in_array($a['corners'], self::CORNERS, true)) throw new ToolError('corners must be one of ' . implode(', ', self::CORNERS));
            if ($a['corners'] === 'sharp') unset($b['corners']); else $b['corners'] = $a['corners'];
        }
        $w->putBoard($b);
        if (array_key_exists('icon', $a) || array_key_exists('parent_board_id', $a)) {
            $card = null;
            foreach ($w->items as $i) if ($i['type'] === 'board' && ($i['data']['target'] ?? null) === $bid) { $card = $i; break; }
            if (!$card) throw new ToolError('This board has no card that opens it (a top board has no icon and can’t be moved)');
            self::requireEditor($w, $card['board']);
            if (array_key_exists('icon', $a)) {
                $icon = self::str($a['icon'], 16);
                if (mb_strlen($icon) > 4) throw new ToolError('icon must be a single emoji');
                if ($icon === '') unset($card['data']['emoji']); else $card['data']['emoji'] = $icon;
                $w->putItem($card);
            }
            if (array_key_exists('parent_board_id', $a) && (string) $a['parent_board_id'] !== $card['board']) {
                self::moveToBoard($w, $card, self::editableBoard($w, $a['parent_board_id']));
            }
        }
        $b = $w->boards[$bid];
        return ['board' => ['id' => $bid, 'title' => $b['title'] ?? '', 'path' => $w->path($bid), 'parent_id' => $b['parent'] ?? null,
                            'background' => $b['bg'] ?? 'dots', 'corners' => $b['corners'] ?? 'sharp']];
    }

    private static function listTrash(Workspace $w): array
    {
        $out = [];
        foreach ($w->trash as $t) {
            $from = (string) ($t['from'] ?? '');
            $out[] = ['id' => $t['id'], 'label' => $t['label'] ?? '', 'deleted_at' => date('c', (int) (($t['at'] ?? 0) / 1000)),
                      'deleted_by' => $t['by']['name'] ?? null, 'from_board' => $from === self::UNSORTED ? 'Unsorted' : (isset($w->boards[$from]) ? $w->path($from) : 'a deleted board'),
                      'cards' => count($t['items'] ?? []), 'boards' => count($t['boards'] ?? [])];
        }
        usort($out, fn($a, $b) => strcmp($b['deleted_at'], $a['deleted_at']));
        return ['trash' => array_slice($out, 0, 100)];
    }

    /** Put a trash entry back, the way the browser's Restore does. */
    private static function restoreTrash(Workspace $w, string $tid): array
    {
        $t = $w->trash[$tid] ?? throw new ToolError("No Trash entry with id $tid (use list_trash)");
        $from = (string) ($t['from'] ?? '');
        $target = isset($w->boards[$from]) || $from === self::UNSORTED ? $from : self::defaultBoard($w);
        self::requireEditor($w, $target);
        $ids = array_fill_keys(array_column($t['items'] ?? [], 'id'), true);
        $bids = array_fill_keys(array_column($t['boards'] ?? [], 'id'), true);
        foreach ($t['boards'] ?? [] as $b) {
            if (!isset($w->boards[$b['parent'] ?? '']) && !isset($bids[$b['parent'] ?? ''])) $b['parent'] = $target === self::UNSORTED ? 'home' : $target;
            $w->putBoard($b);
        }
        foreach ($t['items'] ?? [] as $it) {
            if (!isset($w->boards[$it['board'] ?? '']) && ($it['board'] ?? '') !== self::UNSORTED) $it['board'] = $target;
            if (!empty($it['col']) && !isset($w->items[$it['col']]) && !isset($ids[$it['col']])) $it['col'] = null;
            $w->putItem($it);
        }
        foreach ($t['lines'] ?? [] as $l) {
            $ok = fn($e) => !isset($e['item']) || isset($w->items[$e['item']]);
            if ($ok($l['a'] ?? []) && $ok($l['b'] ?? []) && isset($w->boards[$l['board'] ?? ''])) $w->putLine($l);
        }
        $w->delTrash($tid);
        return ['restored_cards' => count($ids), 'restored_boards' => count($bids), 'board_id' => $target,
                'board' => $target === self::UNSORTED ? 'Unsorted' : $w->path($target)];
    }

    /* ---------- helpers ---------- */

    private static function dataFor(string $type, array $c): array
    {
        $title = self::str($c['title'] ?? '', 200);
        $text = self::str($c['text'] ?? '', 200000);
        return match ($type) {
            'note' => ['html' => Text::html($text)],
            'todo' => ['title' => $title, 'tasks' => self::tasks($c['tasks'] ?? [])],
            'link' => self::linkData((string) ($c['url'] ?? ''), $title),
            'column' => ['title' => $title],
            'table' => ['rows' => isset($c['rows']) ? self::rows($c['rows']) : [['', '', ''], ['', '', ''], ['', '', '']], 'header' => true],
            'doc' => ['title' => $title, 'html' => Text::html($text)],
            'comment' => [],
            'swatch' => ['hex' => self::hex($c['hex'] ?? '#e9c46a')],
            default => [],
        };
    }

    private static function linkData(string $url, string $title): array
    {
        $url = trim($url);
        if ($url !== '' && !preg_match('~^https?://~i', $url)) $url = 'https://' . $url;
        if (!filter_var($url, FILTER_VALIDATE_URL)) throw new ToolError('Pass a valid http(s) url');
        $d = ['url' => $url];
        try {
            $m = Unfurl::fetch($url);
            $d += array_filter(['title' => $m['title'] ?? '', 'desc' => $m['desc'] ?? '', 'img' => $m['img'] ?? '', 'siteName' => $m['siteName'] ?? '']);
        } catch (\Throwable) {}
        if ($title !== '') $d['title'] = $title;
        return $d;
    }

    private static function intoColumn(Workspace $w, array &$it, string $colId): void
    {
        $col = $w->items[$colId] ?? null;
        if (!$col || $col['type'] !== 'column') throw new ToolError("No column with id $colId");
        if ($col['board'] !== $it['board']) throw new ToolError('The column is on a different board');
        if ($it['type'] === 'column') throw new ToolError('Columns can’t go inside columns');
        $it['col'] = $colId;
        $it['order'] = count(array_filter($w->childrenOf($colId), fn($k) => $k['id'] !== $it['id']));
        $it['x'] = 0; $it['y'] = 0;
    }

    private static function renumber(Workspace $w, string $colId): void
    {
        foreach ($w->childrenOf($colId) as $n => $k) if (($k['order'] ?? null) !== $n) { $k['order'] = $n; $w->putItem($k); }
    }

    /** Move card $id to index $pos among its column's cards (clamped), renumbering the rest. */
    private static function reorder(Workspace $w, string $colId, string $id, int $pos): void
    {
        $kids = array_values(array_filter($w->childrenOf($colId), fn($k) => $k['id'] !== $id));
        array_splice($kids, max(0, min($pos, count($kids))), 0, [$w->items[$id]]);
        foreach ($kids as $n => $k) if (($k['order'] ?? null) !== $n) { $k['order'] = $n; $w->putItem($k); }
    }

    private static function moveToBoard(Workspace $w, array &$it, string $bid): void
    {
        if ($it['type'] === 'board') {
            $target = $it['data']['target'] ?? '';
            for ($b = $w->boards[$bid] ?? null, $n = 0; $b && $n < 100; $b = $w->boards[$b['parent'] ?? ''] ?? null, $n++) {
                if ($b['id'] === $target) throw new ToolError('A board can’t be moved inside itself');
            }
            if (isset($w->boards[$target])) { $b = $w->boards[$target]; $b['parent'] = $bid === self::UNSORTED ? 'home' : $bid; $w->putBoard($b); }
        }
        $old = $it['col'] ?? null;
        $from = $it['board'];
        $it['board'] = $bid; $it['col'] = null;
        [$it['x'], $it['y']] = (new Placer($w, $bid))->next($it['w'] ?? 260, 240);
        $it['z'] = $w->maxZ($bid) + 1;
        $it['order'] = $bid === self::UNSORTED ? (int) (microtime(true) * 1000) : 0;
        if ($it['type'] === 'column') foreach ($w->childrenOf($it['id']) as $k) { $k['board'] = $bid; $w->putItem($k); }
        foreach ($w->lines as $l) {   // connections can't cross boards
            if (($l['board'] ?? '') === $from && (($l['a']['item'] ?? '') === $it['id'] || ($l['b']['item'] ?? '') === $it['id'])) $w->delLine($l['id']);
        }
        $w->putItem($it);
        if ($old) self::renumber($w, $old);
    }

    private static function boardArg(Workspace $w, mixed $id): string
    {
        $id = is_string($id) ? trim($id) : '';
        if ($id === self::UNSORTED || isset($w->boards[$id])) return $id;
        throw new ToolError($id === '' ? 'Pass board_id' : "No board with id $id (use list_boards)");
    }

    private static function card(Workspace $w, mixed $id): array
    {
        if (!is_string($id) || !isset($w->items[$id])) throw new ToolError('No card with id ' . (is_string($id) ? $id : '?'));
        return $w->items[$id];
    }

    /**
     * A checklist from the model. Entries matching an existing task (by id, else by the same text) keep its id, due date
     * and done state unless they set them, so replacing the list doesn't lose what people added in the browser.
     */
    private static function tasks(mixed $list, array $old = []): array
    {
        if (!is_array($list)) throw new ToolError('tasks must be a list');
        $byId = []; $byText = [];
        foreach ($old as $o) { $byId[$o['id'] ?? ''] = $o; $byText[$o['t'] ?? ''][] = $o['id'] ?? ''; }
        $used = [];
        $out = [];
        foreach ($list as $t) {
            $text = is_array($t) ? ($t['text'] ?? '') : $t;
            if (!is_string($text) || ($text = trim($text)) === '') continue;
            $text = mb_substr(str_replace("\n", ' ', $text), 0, 500);
            $id = is_array($t) && is_string($t['id'] ?? null) && isset($byId[$t['id']]) ? $t['id'] : null;
            if ($id === null) foreach ($byText[$text] ?? [] as $cand) if (!isset($used[$cand])) { $id = $cand; break; }
            if ($id !== null && isset($used[$id])) $id = null;   // the same task listed twice: the second is new
            $was = $id !== null ? $byId[$id] : [];
            if ($id !== null) $used[$id] = true;
            $task = ['id' => $id ?? Workspace::uid(), 't' => $text, 'done' => is_array($t) && array_key_exists('done', $t) ? (bool) $t['done'] : !empty($was['done'])];
            $due = is_array($t) && array_key_exists('due', $t) ? self::due($t['due']) : ($was['due'] ?? null);
            if ($due !== null) $task['due'] = $due;
            $out[] = $task;
        }
        return $out;
    }

    /** Edit single tasks by id: text, done, due, or delete. */
    private static function changeTasks(array $tasks, mixed $changes): array
    {
        if (!is_array($changes)) throw new ToolError('task_changes must be a list');
        $at = [];
        foreach ($tasks as $n => $t) $at[$t['id'] ?? ''] = $n;
        foreach ($changes as $c) {
            $id = is_array($c) ? ($c['id'] ?? null) : null;
            if (!is_string($id) || !isset($at[$id])) throw new ToolError('No task with id ' . (is_string($id) ? $id : '?') . ' on this card');
            $n = $at[$id];
            if (!empty($c['delete'])) { $tasks[$n] = null; continue; }
            if ($tasks[$n] === null) continue;
            if (array_key_exists('text', $c)) {
                $text = trim(str_replace("\n", ' ', self::str($c['text'], 500)));
                if ($text === '') throw new ToolError('Task text can’t be empty; pass delete: true to remove it');
                $tasks[$n]['t'] = $text;
            }
            if (array_key_exists('done', $c)) $tasks[$n]['done'] = (bool) $c['done'];
            if (array_key_exists('due', $c)) {
                $due = self::due($c['due']);
                if ($due === null) unset($tasks[$n]['due']); else $tasks[$n]['due'] = $due;
            }
        }
        return array_values(array_filter($tasks));
    }

    /** Tasks in the order of $ids; the ones left out follow in their current order. */
    private static function orderTasks(array $tasks, mixed $ids): array
    {
        if (!is_array($ids)) throw new ToolError('task_order must be a list of task ids');
        $by = [];
        foreach ($tasks as $t) $by[$t['id'] ?? ''] = $t;
        $out = [];
        foreach ($ids as $id) {
            if (!is_string($id) || !isset($by[$id])) throw new ToolError('No task with id ' . (is_string($id) ? $id : '?') . ' on this card');
            $out[$id] = $by[$id];
        }
        return array_values($out + $by);
    }

    /** A due date as YYYY-MM-DD, or null to clear it. */
    private static function due(mixed $v): ?string
    {
        if ($v === null || $v === '') return null;
        if (!is_string($v) || !preg_match('/^(\d{4})-(\d{2})-(\d{2})$/', trim($v), $m) || !checkdate((int) $m[2], (int) $m[3], (int) $m[1])) {
            throw new ToolError('due must be a date like 2026-12-31');
        }
        return trim($v);
    }

    private static function rows(mixed $rows): array
    {
        if (!is_array($rows) || !$rows) throw new ToolError('rows must be a list of rows');
        $width = max(array_map(fn($r) => is_array($r) ? count($r) : 1, $rows));
        if (count($rows) > 200 || $width > 30) throw new ToolError('Tables are limited to 200 rows and 30 columns');
        return array_map(fn($r) => array_pad(array_map(fn($c) => is_scalar($c) ? (string) $c : '', array_values((array) $r)), $width, ''), array_values($rows));
    }

    private static function color(mixed $c): ?string
    {
        if ($c === null || $c === '' || $c === 'none') return null;
        if (!in_array($c, self::COLORS, true)) throw new ToolError('color must be one of ' . implode(', ', self::COLORS) . ' or none');
        return $c;
    }

    /** A text alignment for a card of $type; null for the type's usual one (columns centred, the rest left). */
    private static function align(string $type, mixed $v): ?string
    {
        if (!in_array($type, Styles::ALIGNABLE, true)) throw new ToolError("A $type card has no text alignment");
        if (!in_array($v, Styles::ALIGNS, true)) throw new ToolError('align must be one of ' . implode(', ', Styles::ALIGNS));
        return $v === ($type === 'column' ? 'center' : 'left') ? null : $v;
    }

    private static function hex(mixed $h): string
    {
        if (!is_string($h) || !preg_match('/^#?([0-9a-f]{6})$/i', trim($h), $m)) throw new ToolError('hex must look like #e76f51');
        return '#' . strtolower($m[1]);
    }

    private static function str(mixed $v, int $max): string
    {
        if ($v === null) return '';
        if (!is_scalar($v)) throw new ToolError('Expected text');
        return mb_substr(trim((string) $v), 0, $max);
    }

    private static function num(mixed $v, float $min, float $max): ?int
    {
        return is_numeric($v) ? (int) round(max($min, min($max, (float) $v))) : null;
    }
}

/** A tool was called with bad arguments; the message goes back to the model. */
final class ToolError extends \RuntimeException {}

/** Finds free space for new cards: a row to the right of what is already on the board. */
final class Placer
{
    private int $x0; private int $x; private int $y; private int $rowH = 0; private int $n = 0;

    public function __construct(Workspace $w, string $board)
    {
        $top = array_filter($w->itemsOf($board), fn($i) => empty($i['col']));
        if (!$top) { $this->x0 = $this->x = 40; $this->y = 40; return; }
        $right = max(array_map(fn($i) => ($i['x'] ?? 0) + ($i['w'] ?? 260), $top));
        $this->y = (int) min(array_map(fn($i) => $i['y'] ?? 0, $top));
        $this->x0 = $this->x = (int) $right + 60;
    }

    public function next(int $w, int $h): array
    {
        if ($this->n > 0 && $this->n % 4 === 0) { $this->x = $this->x0; $this->y += $this->rowH + 40; $this->rowH = 0; }
        $p = [$this->x, $this->y];
        $this->x += $w + 30; $this->rowH = max($this->rowH, $h); $this->n++;
        return $p;
    }
}
