<?php
declare(strict_types=1);

namespace Kolam;

/**
 * MCP tools: Starting boards from templates (list_templates, create_board_from_template).
 *
 * The templates themselves (name, description, colour, and the cards/connections each one builds) live in
 * src/templates.json, the single source of truth the browser (src/features/templates.js) also reads, so the
 * two never drift apart. This class only interprets that data, mirroring the browser's tplKit/runBuild.
 */
final class TemplateTools
{
    // sensible default widths per card type when a build step doesn't give one (mirrors src/cards/types.js)
    private const DEFAULT_W = ['note' => 260, 'todo' => 260, 'column' => 280, 'swatch' => 140, 'doc' => 260, 'sketch' => 320];

    private static ?array $templates = null;

    /** Loads and caches templates.json, shared verbatim with the browser. */
    private static function templates(): array
    {
        if (self::$templates !== null) return self::$templates;
        $path = dirname(__DIR__, 2) . '/src/templates.json';
        $json = @file_get_contents($path);
        if ($json === false) throw new ToolError('Templates are unavailable');
        $data = json_decode($json, true);
        if (!is_array($data)) throw new ToolError('Templates are unavailable');
        return self::$templates = $data;
    }

    private static function template(string $id): array
    {
        foreach (self::templates() as $t) if ($t['id'] === $id) return $t;
        throw new ToolError("No template called $id. Call list_templates for the ids.");
    }

    public static function definitions(): array
    {
        $space = ['type' => 'string', 'description' => 'Space id from list_boards; omit for your own boards'];
        $ids = array_map(fn($t) => $t['id'], self::templates());
        return [
            ['name' => 'list_templates', 'title' => 'List board templates',
             'description' => 'Ready-made layouts (moodboard, project plan, mind map, ...) that create_board_from_template can start a new board from.',
             'inputSchema' => ['type' => 'object', 'properties' => (object) []],
             'annotations' => ['readOnlyHint' => true]],
            ['name' => 'create_board_from_template', 'title' => 'Create a board from a template',
             'description' => 'Add a board card with a ready-made layout of cards inside it, the same as picking a template in the app.',
             'inputSchema' => ['type' => 'object', 'properties' => (object) [
                 'space' => $space,
                 'template' => ['type' => 'string', 'enum' => $ids, 'description' => 'Template id from list_templates'],
                 'title' => ['type' => 'string', 'description' => 'Title for the new board (default: the template name)'],
                 'board_id' => ['type' => 'string', 'description' => 'Board to put the new board card on (default: your top board)'],
                 'x' => ['type' => 'number'], 'y' => ['type' => 'number'],
             ], 'required' => ['template']],
            ],
        ];
    }

    public static function call(array $u, string $name, array $a): array
    {
        $w = Workspace::load($u, BoardTools::spaceArg($a));
        $r = match ($name) {
            'list_templates' => self::listTemplates(),
            'create_board_from_template' => self::createFromTemplate($w, $a),
            default => throw new ToolError("Unknown tool $name"),
        };
        BoardTools::save($w);
        return $r;
    }

    private static function listTemplates(): array
    {
        return ['templates' => array_map(fn($t) => ['id' => $t['id'], 'name' => $t['name'], 'description' => $t['desc']], self::templates())];
    }

    private static function createFromTemplate(Workspace $w, array $a): array
    {
        $tpl = self::template((string) ($a['template'] ?? ''));
        $onBid = BoardTools::editableBoard($w, $a['board_id'] ?? BoardTools::defaultBoard($w));
        $title = BoardTools::str($a['title'] ?? '', 200) ?: $tpl['name'];

        // the board card that opens the new board, placed like create_cards does
        $place = new Placer($w, $onBid);
        if (isset($a['x'], $a['y']) && is_numeric($a['x']) && is_numeric($a['y'])) {
            $x = (int) round((float) $a['x']); $y = (int) round((float) $a['y']);
        } else {
            [$x, $y] = $place->next(150, 150);
        }
        $nb = ['id' => Workspace::uid(), 'title' => $title, 'parent' => $onBid === BoardTools::UNSORTED ? 'home' : $onBid];
        $w->putBoard($nb);
        $card = ['id' => Workspace::uid(), 'board' => $onBid, 'type' => 'board', 'x' => $x, 'y' => $y, 'w' => 150,
                 'z' => $w->maxZ($onBid) + 1, 'col' => null, 'order' => 0, 'data' => ['target' => $nb['id']], 'color' => null];
        if ($onBid === BoardTools::UNSORTED) $card['order'] = (int) (microtime(true) * 1000);
        $w->putItem($card);

        $count = self::build($w, $nb['id'], $tpl['build']);
        return ['board_id' => $nb['id'], 'board_card_id' => $card['id'], 'title' => $title, 'cards' => $count];
    }

    /** Interprets one template's build steps onto a fresh board, the same as the browser's tplKit/runBuild. */
    private static function build(Workspace $w, string $bid, array $steps): int
    {
        $origin = ['x' => 40, 'y' => 40];
        $z = 0;
        $refs = [];
        $prevCol = null;
        $colCount = [];
        $count = 0;
        $fill = fn($html) => str_replace('{{date}}', date('j F Y'), (string) $html);

        foreach ($steps as $s) {
            $op = $s['op'] ?? '';
            $col = ($s['col'] ?? null) === '$prev' ? $prevCol : (isset($s['col']) ? ($refs[$s['col']] ?? null) : null);
            $made = null;
            switch ($op) {
                case 'note':
                    $made = ['id' => Workspace::uid(), 'board' => $bid, 'type' => 'note', 'x' => (int) round($origin['x'] + ($s['x'] ?? 0)),
                             'y' => (int) round($origin['y'] + ($s['y'] ?? 0)), 'w' => (float) ($s['w'] ?? self::DEFAULT_W['note']),
                             'z' => ++$z, 'col' => null, 'order' => 0, 'data' => ['html' => $fill($s['html'] ?? '')], 'color' => $s['color'] ?? null];
                    break;
                case 'doc':
                    $made = ['id' => Workspace::uid(), 'board' => $bid, 'type' => 'doc', 'x' => (int) round($origin['x'] + ($s['x'] ?? 0)),
                             'y' => (int) round($origin['y'] + ($s['y'] ?? 0)), 'w' => (float) ($s['w'] ?? self::DEFAULT_W['doc']),
                             'z' => ++$z, 'col' => null, 'order' => 0, 'data' => ['title' => $s['title'] ?? '', 'html' => $fill($s['html'] ?? '')], 'color' => $s['color'] ?? null];
                    break;
                case 'swatch':
                    $made = ['id' => Workspace::uid(), 'board' => $bid, 'type' => 'swatch', 'x' => (int) round($origin['x'] + ($s['x'] ?? 0)),
                             'y' => (int) round($origin['y'] + ($s['y'] ?? 0)), 'w' => self::DEFAULT_W['swatch'],
                             'z' => ++$z, 'col' => null, 'order' => 0, 'data' => ['hex' => $s['hex'] ?? '#000000'], 'color' => null];
                    break;
                case 'todo':
                    $made = ['id' => Workspace::uid(), 'board' => $bid, 'type' => 'todo', 'x' => (int) round($origin['x'] + ($s['x'] ?? 0)),
                             'y' => (int) round($origin['y'] + ($s['y'] ?? 0)), 'w' => (float) ($s['w'] ?? self::DEFAULT_W['todo']),
                             'z' => ++$z, 'col' => null, 'order' => 0,
                             'data' => ['title' => $s['title'] ?? '', 'tasks' => self::tasks($s['tasks'] ?? [])], 'color' => $s['color'] ?? null];
                    break;
                case 'column':
                    $made = ['id' => Workspace::uid(), 'board' => $bid, 'type' => 'column', 'x' => (int) round($origin['x'] + ($s['x'] ?? 0)),
                             'y' => (int) round($origin['y'] + ($s['y'] ?? 0)), 'w' => (float) ($s['w'] ?? self::DEFAULT_W['column']),
                             'z' => ++$z, 'col' => null, 'order' => 0, 'data' => ['title' => $s['title'] ?? ''], 'color' => $s['color'] ?? null];
                    $prevCol = $made;
                    $colCount[$made['id']] = 0;
                    break;
                case 'inCol':
                    if (!$col) break;
                    $ctype = $s['type'] ?? 'note';
                    $data = $ctype === 'todo' ? ['title' => $s['title'] ?? '', 'tasks' => self::tasks($s['tasks'] ?? [])] : ['html' => $fill($s['html'] ?? '')];
                    $made = ['id' => Workspace::uid(), 'board' => $bid, 'type' => $ctype, 'x' => 0, 'y' => 0,
                             'w' => self::DEFAULT_W[$ctype] ?? 260, 'z' => ++$z, 'col' => $col['id'], 'order' => $colCount[$col['id']] ?? 0,
                             'data' => $data, 'color' => null];
                    if (isset($s['h'])) $made['h'] = (int) $s['h'];
                    $colCount[$col['id']] = ($colCount[$col['id']] ?? 0) + 1;
                    break;
                case 'line':
                    if (isset($refs[$s['from'] ?? ''], $refs[$s['to'] ?? ''])) {
                        $w->putLine(['id' => Workspace::uid(), 'board' => $bid, 'a' => ['item' => $refs[$s['from']]['id']],
                                     'b' => ['item' => $refs[$s['to']]['id']], 'arrow' => ($s['arrow'] ?? true) !== false,
                                     'color' => $s['color'] ?? null, 'bend' => 0]);
                    }
                    continue 2;
            }
            if ($made !== null) {
                $w->putItem($made);
                $count++;
                if (isset($s['ref'])) $refs[$s['ref']] = $made;
            }
        }
        return $count;
    }

    /** k.tasks(['text', ...]) equivalent: plain strings become fresh unticked tasks. */
    private static function tasks(array $texts): array
    {
        return array_map(fn($t) => ['id' => Workspace::uid(), 't' => (string) $t, 'done' => false], $texts);
    }
}
