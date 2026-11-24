<?php
declare(strict_types=1);

namespace Kolam;

/**
 * "Download all my data": a ZIP with one folder per space the person owns, admins or is a member of (personal boards
 * and workspaces), each with a JSON file the app can import back (the same shape as the in-app backup), a Markdown
 * file per board, and the files uploaded there. Boards shared with them individually (not a whole workspace) go
 * under shared/ as Markdown and files only.
 */
final class Export
{
    public static function zip(array $u): never
    {
        RateLimit::hit('export:' . $u['id'], 5, 3600);
        if (!class_exists(\ZipArchive::class)) {
            Http::fail(500, 'Exporting needs the PHP zip extension. Ask the server administrator to enable it (php-zip).');
        }
        $ctx = Spaces::contexts($u);
        $tmp = tempnam(sys_get_temp_dir(), 'kolam-export');
        $zip = new \ZipArchive();
        if ($zip->open((string) $tmp, \ZipArchive::OVERWRITE) !== true) Http::fail(500, 'Could not create the export archive');

        $zip->addFromString('README.txt', self::readme());

        $used = [];
        self::addSpace($zip, self::uniqueName('My boards', $used), $ctx['personal']['id']);
        foreach ($ctx['workspaces'] as $w) self::addSpace($zip, self::uniqueName($w['name'], $used), $w['id']);
        foreach ($ctx['shared'] as $sh) {
            self::addSharedBoard($zip, 'shared/' . self::uniqueName($sh['title'], $used), $sh['space'], $sh['board']);
        }
        $zip->close();

        $name = 'kolam-export-' . date('Y-m-d') . '.zip';
        header('Content-Type: application/zip');
        header('Content-Disposition: attachment; filename="' . $name . '"');
        header('Content-Length: ' . (string) filesize($tmp));
        readfile($tmp);
        @unlink($tmp);
        exit;
    }

    private static function readme(): string
    {
        return "Kolam data export\n==================\n\n"
             . "Each top-level folder is one of your spaces (your own boards, or a workspace).\n\n"
             . "  data.json    the whole space, in the format Kolam's own \"Back up everything\" uses. Import it from\n"
             . "               the account menu while viewing that space to restore it (or load it into a fresh Kolam).\n"
             . "  boards/      one Markdown file per board, for reading without Kolam.\n"
             . "  files/       every file you uploaded there, named \"<id>-<original name>\".\n\n"
             . "The \"shared\" folder has one subfolder per board someone shared with you individually (not a whole\n"
             . "workspace): a Markdown file and its files, since you don't have the rest of that space to export.\n";
    }

    private static function uniqueName(string $name, array &$used): string
    {
        $base = self::safe($name) ?: 'space';
        $n = $base; $i = 2;
        while (isset($used[$n])) $n = $base . '-' . $i++;
        $used[$n] = true;
        return $n;
    }

    private static function safe(string $s): string
    {
        $s = preg_replace('/[\x00-\x1f\/\\\\:*?"<>|]/u', '', $s) ?? '';
        return trim(preg_replace('/\s+/u', ' ', $s) ?? '');
    }

    /** A whole space: data.json (re-importable), boards/*.md, files/*. */
    private static function addSpace(\ZipArchive $zip, string $folder, string $spaceId): void
    {
        [$boards, $items, $lines, $trash] = self::entities($spaceId);
        $state = ['boards' => (object) $boards, 'items' => (object) $items, 'lines' => (object) $lines, 'trash' => $trash];
        $assets = self::assetsOf($items);
        $zip->addFromString("$folder/data.json", json_encode([
            'app' => 'kolam', 'version' => 2, 'exportedAt' => date('c'), 'state' => $state, 'assets' => $assets['dataUrls'],
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
        $usedTitles = [];
        foreach ($boards as $id => $b) {
            $title = self::safe((string) ($b['title'] ?? 'Untitled board')) ?: 'Untitled board';
            $zip->addFromString("$folder/boards/" . self::uniqueName($title, $usedTitles) . '.md', self::boardMd($boards, $items, (string) $id));
        }
        self::addFiles($zip, "$folder/files", $assets['files']);
    }

    /** One board shared individually: Markdown + its files, no data.json (re-importing a single foreign board isn't meaningful). */
    private static function addSharedBoard(\ZipArchive $zip, string $folder, string $spaceId, string $boardId): void
    {
        [$boards, $items] = self::entities($spaceId);
        $sub = Access::subtree($spaceId, $boardId);
        $title = self::safe($boards[$boardId]['title'] ?? 'Untitled board') ?: 'Untitled board';
        $zip->addFromString("$folder/$title.md", self::boardMd($boards, $items, $boardId));
        $theseItems = array_filter($items, fn($it) => in_array((string) ($it['board'] ?? ''), $sub, true));
        self::addFiles($zip, "$folder/files", self::assetsOf($theseItems)['files']);
    }

    /** Live boards/items/lines/trash of a space, decoded: [id => data, …] (trash as a plain list). */
    private static function entities(string $spaceId): array
    {
        $out = ['board' => [], 'item' => [], 'line' => []];
        foreach (['board', 'item', 'line'] as $kind) {
            foreach (Db::q("SELECT id, data FROM entities WHERE space_id = ? AND kind = ? AND deleted = 0", [$spaceId, $kind]) as $r) {
                $d = json_decode((string) $r['data'], true);
                if (is_array($d)) $out[$kind][$r['id']] = $d;
            }
        }
        $trash = [];
        foreach (Db::q("SELECT data FROM entities WHERE space_id = ? AND kind = 'trash' AND deleted = 0", [$spaceId]) as $r) {
            $d = json_decode((string) $r['data'], true);
            if (is_array($d)) $trash[] = $d;
        }
        return [$out['board'], $out['item'], $out['line'], $trash];
    }

    /** Asset ids referenced by these items: data URLs for data.json, and id => stored name for the files/ folder. */
    private static function assetsOf(array $items): array
    {
        $ids = [];
        foreach ($items as $it) {
            $id = $it['data']['asset'] ?? null;
            if (is_string($id) && $id !== '') $ids[$id] = true;
        }
        $dataUrls = []; $files = [];
        foreach (array_keys($ids) as $id) {
            $a = Db::one('SELECT mime, name FROM assets WHERE id = ?', [$id]);
            if (!$a) continue;
            $files[$id] = $a;
            $bin = self::read($id);
            if ($bin !== null) $dataUrls[$id] = 'data:' . $a['mime'] . ';base64,' . base64_encode($bin);
        }
        return ['dataUrls' => (object) $dataUrls, 'files' => $files];
    }

    /** Reads a stored asset fully into memory (local disk, or a GET from S3). */
    private static function read(string $id): ?string
    {
        ob_start();
        $ok = Assets::storage()->output($id);
        $bin = ob_get_clean();
        return $ok && $bin !== false ? $bin : null;
    }

    private static function addFiles(\ZipArchive $zip, string $folder, array $files): void
    {
        foreach ($files as $id => $a) {
            $bin = self::read($id);
            if ($bin === null) continue;
            $name = self::safe((string) ($a['name'] ?? $id)) ?: $id;
            $zip->addFromString("$folder/$id-$name", $bin);
        }
    }

    /** A board, top-level cards only (depth 1), as readable Markdown. */
    private static function boardMd(array $boards, array $items, string $boardId): string
    {
        $title = $boards[$boardId]['title'] ?? 'Untitled board';
        $tops = [];
        foreach ($items as $id => $it) {
            if ((string) ($it['board'] ?? '') === $boardId && empty($it['col'])) $tops[$id] = $it;
        }
        uasort($tops, fn($a, $b) => [(int) round(($a['y'] ?? 0) / 80), $a['x'] ?? 0] <=> [(int) round(($b['y'] ?? 0) / 80), $b['x'] ?? 0]);
        $parts = [];
        foreach ($tops as $id => $it) {
            $md = self::itemMd($it, $items, $boards, (string) $id);
            if ($md !== '') $parts[] = $md;
        }
        return "# $title\n\n" . implode("\n\n", $parts);
    }

    private static function itemMd(array $it, array $items, array $boards, string $id): string
    {
        $d = $it['data'] ?? [];
        return match ($it['type'] ?? '') {
            'note', 'text' => Text::plain($d['html'] ?? ''),
            'todo' => '**' . ($d['title'] ?? 'To-do') . "**\n\n" . implode("\n", array_map(
                fn($t) => '- [' . (!empty($t['done']) ? 'x' : ' ') . '] ' . ($t['t'] ?? '') . (!empty($t['due']) ? ' (due ' . $t['due'] . ')' : ''),
                is_array($d['tasks'] ?? null) ? $d['tasks'] : []
            )),
            'link' => !empty($d['url']) ? '[' . ($d['title'] ?: $d['url']) . '](' . $d['url'] . ')' . (!empty($d['desc']) ? "\n\n" . $d['desc'] : '') : '',
            'image' => '*[Image' . (!empty($d['caption']) ? ': ' . Text::plain($d['caption']) : '') . ']*',
            'file' => '*[File: ' . ($d['name'] ?? '') . ']*',
            'doc' => '## ' . ($d['title'] ?? 'Untitled document') . "\n\n" . Text::plain($d['html'] ?? ''),
            'column' => '### ' . ($d['title'] ?? 'Column') . "\n\n" . implode("\n\n", array_filter(array_map(
                fn($cid) => self::itemMd($items[$cid], $items, $boards, (string) $cid),
                array_keys(array_filter($items, fn($x) => ($x['col'] ?? null) === $id))
            ))),
            'board' => '*[See board: ' . ($boards[$d['target'] ?? '']['title'] ?? $d['title'] ?? 'Untitled board') . ']*',
            'shortcut' => '*[Shortcut to: ' . ($boards[$d['target'] ?? '']['title'] ?? 'a board') . ']*',
            'table' => self::tableMd($d['rows'] ?? []),
            'swatch' => 'Colour `' . ($d['hex'] ?? '') . '`',
            'icon' => !empty($d['label']) ? '*[Icon: ' . $d['label'] . ']*' : '',
            'group' => !empty($d['title']) ? '### ' . $d['title'] : '',
            default => '',
        };
    }

    private static function tableMd(mixed $rows): string
    {
        if (!is_array($rows) || !$rows) return '';
        $cells = fn($r) => array_map(fn($c) => str_replace('|', '\\|', (string) (is_array($c) ? ($c['v'] ?? '') : $c)), is_array($r) ? $r : []);
        $head = $cells($rows[0]);
        $body = array_slice($rows, 1);
        $lines = ['| ' . implode(' | ', $head) . ' |', '| ' . implode(' | ', array_fill(0, count($head), '---')) . ' |'];
        foreach ($body as $r) $lines[] = '| ' . implode(' | ', $cells($r)) . ' |';
        return implode("\n", $lines);
    }
}
