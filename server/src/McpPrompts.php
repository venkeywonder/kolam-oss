<?php
declare(strict_types=1);

namespace Kolam;

/** MCP prompts: ready-made requests people pick from their AI app's menu (prompts/list, prompts/get). */
final class McpPrompts
{
    private const BOARD_ARG = [
        'name' => 'board',
        'description' => 'Board name or id. If omitted, use current_board to find the open board, or ask.',
        'required' => false,
    ];

    public static function definitions(): array
    {
        return [
            [
                'name' => 'summarise_board',
                'title' => 'Summarise board',
                'description' => 'Summarise what is on a board.',
                'arguments' => [self::BOARD_ARG],
            ],
            [
                'name' => 'notes_to_todos',
                'title' => 'Turn notes into to-dos',
                'description' => 'Read the notes on a board and turn them into to-do cards, with due dates when a note mentions one.',
                'arguments' => [self::BOARD_ARG],
            ],
            [
                'name' => 'plan_project',
                'title' => 'Plan a project',
                'description' => 'Turn a goal into a board of columns (e.g. To do / Doing / Done) with tasks and milestones.',
                'arguments' => [
                    ['name' => 'goal', 'description' => 'The project goal or brief.', 'required' => true],
                    self::BOARD_ARG,
                ],
            ],
            [
                'name' => 'draw_diagram',
                'title' => 'Draw a diagram',
                'description' => 'Turn a description into a diagram of icon cards, groups and connections, then arrange it as a tree.',
                'arguments' => [
                    ['name' => 'description', 'description' => 'What the diagram should show.', 'required' => true],
                    self::BOARD_ARG,
                ],
            ],
            [
                'name' => 'tidy_board',
                'title' => 'Tidy up a board',
                'description' => 'Arrange the cards on a messy board into a clean grid or rows, and group related cards.',
                'arguments' => [self::BOARD_ARG],
            ],
            [
                'name' => 'weekly_review',
                'title' => 'Weekly review',
                'description' => 'Review what changed on a board this week, list open tasks, and flag anything overdue.',
                'arguments' => [self::BOARD_ARG],
            ],
            [
                'name' => 'brainstorm',
                'title' => 'Brainstorm',
                'description' => 'Brainstorm ideas on a topic as note cards, clustered into columns by theme.',
                'arguments' => [
                    ['name' => 'topic', 'description' => 'The topic to brainstorm.', 'required' => true],
                    self::BOARD_ARG,
                ],
            ],
        ];
    }

    public static function get(string $name, array $args): array
    {
        $board = self::boardHint($args);

        switch ($name) {
            case 'summarise_board':
                return self::result(
                    'Summarise a board',
                    "Summarise $board. Use get_board (and search if the board is large) to read its cards, " .
                    'then give a short summary: what the board is for, its main groups or columns, ' .
                    'and anything that stands out (overdue to-dos, empty columns, duplicate cards). ' .
                    'Do not change anything.'
                );

            case 'notes_to_todos':
                return self::result(
                    'Turn notes into to-dos',
                    "Read the note cards on $board with get_board. For each note that describes a task, " .
                    "create a matching todo card with create_cards (type 'todo'), carrying over any due date " .
                    "mentioned in the note's text into the todo's data. Leave the original notes in place " .
                    'unless asked to remove them. Show the person the list of to-dos you created before deleting anything.'
                );

            case 'plan_project':
                $goal = self::required($args, 'goal');
                return self::result(
                    'Plan a project',
                    "Plan this project on $board: \"$goal\". First call get_board to see what is already there. " .
                    "Then use create_cards to add a column per stage (e.g. 'To do', 'Doing', 'Done') as type " .
                    "'column', and todo or text cards under each column for the tasks and milestones implied by " .
                    'the goal. Use arrange_cards to lay the columns out as a row once created. Ask before ' .
                    'deleting or replacing any existing cards.'
                );

            case 'draw_diagram':
                $description = self::required($args, 'description');
                return self::result(
                    'Draw a diagram',
                    "Draw a diagram of this on $board: \"$description\". Use list_icons to find suitable icons, " .
                    "create_cards (types 'icon' and 'group') for the pieces, connect_cards for the relationships " .
                    "between them, and finish with arrange_cards mode 'tree' to lay it out clearly. Check get_board " .
                    'first so you do not overlap existing cards.'
                );

            case 'tidy_board':
                return self::result(
                    'Tidy up a board',
                    "Tidy up $board. Call get_board to see the current layout, then use arrange_cards (grid, row, " .
                    'column, align or distribute as fits best) to line the cards up neatly, and group cards that ' .
                    'clearly belong together. Do not delete or change the content of any card, only its position ' .
                    'and grouping.'
                );

            case 'weekly_review':
                return self::result(
                    'Weekly review',
                    "Do a weekly review of $board. Use board_activity to see what changed in the last 7 days, " .
                    "get_board to list current to-do and task cards, and point out any with a due date in the past " .
                    'as overdue. Summarise: what changed, what is still open, and what is overdue. Do not change anything.'
                );

            case 'brainstorm':
                $topic = self::required($args, 'topic');
                return self::result(
                    'Brainstorm',
                    "Brainstorm ideas about \"$topic\" on $board. First call get_board to see what is already there " .
                    "and avoid duplicating it. Then use create_cards to add a 'column' card for each theme you " .
                    "notice, and note cards with one idea each placed under the matching column. Keep each note short."
                );

            default:
                throw new ToolError("Unknown prompt $name");
        }
    }

    /** A plain-English reference to the board argument, for use inside a prompt's instruction text. */
    private static function boardHint(array $args): string
    {
        $board = $args['board'] ?? null;
        if (is_string($board) && $board !== '') {
            return 'the board "' . $board . '"';
        }
        return 'the current board (use current_board to find it; ask the person which board if none is open)';
    }

    private static function required(array $args, string $name): string
    {
        $v = $args[$name] ?? null;
        if (!is_string($v) || trim($v) === '') {
            throw new ToolError("The \"$name\" argument is required for this prompt");
        }
        return $v;
    }

    private static function result(string $description, string $text): array
    {
        return [
            'description' => $description,
            'messages' => [
                ['role' => 'user', 'content' => ['type' => 'text', 'text' => $text]],
            ],
        ];
    }
}
