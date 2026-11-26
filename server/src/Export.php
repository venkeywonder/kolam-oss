<?php
declare(strict_types=1);

namespace Kolam;

/**
 * "Download all my data" (zip) and "back up this space" (backup): both stream a ZIP straight to the response via
 * ZipStream — nothing is ever held whole in memory or written to a temp file, so this scales to thousands of images
 * and large files. zip() makes one folder per workspace the person belongs to, each with a JSON file the app can
 * import back, a Markdown file per board, and the files uploaded there; in a workspace where they're a guest, only
 * the boards shared with them. backup() is the same shape for a single space, at the archive's top level.
 */
final class Export
{
    public static function zip(array $u): never
    {
        RateLimit::hit('export:' . $u['id'], 5, 3600);
        $ctx = Spaces::contexts($u);
        $z = ZipStream::begin('kolam-export-' . date('Y-m-d') . '.zip', self::forceZip64());
        $z->addString('README.txt', self::readme());

        $used = [];
        foreach ($ctx['workspaces'] as $w) {
            if ($w['role'] !== 'guest') { self::addSpace($z, self::uniqueName($w['name'], $used), $w['id'], $u); continue; }
            // a guest has only the boards shared with them
            foreach (Access::roots(Access::boards($u['id'], Access::space($w['id'])), $w['id']) as $b) {
                $title = Spaces::titles($w['id'], [$b])[$b] ?? 'Untitled board';
                self::addSharedBoard($z, 'shared/' . self::uniqueName($title, $used), $w['id'], $b, $u);
            }
        }
        $z->finish();
        exit;
    }

    /** GET spaces/{id}/backup: exactly what this person can see there, re-importable from data.json. */
    public static function backup(array $u, string $spaceId): never
    {
        RateLimit::hit('export:' . $u['id'], 5, 3600);
        $space = Access::space($spaceId);
        if (!Access::boards($u['id'], $space)) Http::fail(404, 'Not found');
        $name = 'kolam-' . (self::safe((string) $space['name']) ?: 'space') . '-' . date('Y-m-d') . '.zip';
        $z = ZipStream::begin($name, self::forceZip64());
        $z->addString('README.txt', self::readme());
        self::addSpace($z, '', $spaceId, $u);
        $z->finish();
        exit;
    }

    /** ?_forceZip64=1 in development only: makes every entry use the ZIP64 format, to prove that path on a tiny archive. */
    private static function forceZip64(): bool
    {
        return Config::dev() && !empty($_GET['_forceZip64']);
    }

    private static function readme(): string
    {
        return "Kolam data export\n==================\n\n"
             . "Each top-level folder is one of your workspaces (or the whole thing, for a single space's backup).\n\n"
             . "  data.json    the whole space, in the format Kolam's own \"Back up everything\" uses. Import it from\n"
             . "               the account menu while viewing that space to restore it (or load it into a fresh Kolam).\n"
             . "  boards/      one Markdown file per board, for reading without Kolam.\n"
             . "  files/       every file you uploaded there, named \"<id>-<original name>\".\n\n"
             . "The \"shared\" folder has one subfolder per board shared with you in a workspace you're a guest in:\n"
             . "a Markdown file and its files, since you don't have the rest of that workspace to export.\n";
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

    private static function path(string $folder, string $rest): string
    {
        return $folder === '' ? $rest : "$folder/$rest";
    }

    /** Everything this person can see in a space (Sync::pull's own visibility, since=0): data.json, boards/*.md, files/*. */
    private static function addSpace(ZipStream $z, string $folder, string $spaceId, array $u): void
    {
        $pull = Sync::pull($u, $spaceId, 0);
        [$boards, $items, $lines, $trash] = self::splitChanges($pull['changes']);
        $state = ['boards' => (object) $boards, 'items' => (object) $items, 'lines' => (object) $lines, 'trash' => $trash];
        if (!empty($pull['comments'])) $state['comments'] = $pull['comments'];
        if (!empty($pull['threads'])) $state['threads'] = $pull['threads'];
        $files = self::filesOf($items);

        $filesMeta = [];
        foreach ($files as $id => $a) {
            $filesMeta[$id] = ['path' => 'files/' . self::fileEntryName($id, $a), 'name' => $a['name'], 'mime' => $a['mime'], 'size' => (int) $a['size']];
        }
        $z->addString(self::path($folder, 'data.json'), json_encode([
            'app' => 'kolam', 'version' => 3, 'exportedAt' => date('c'), 'state' => (object) $state, 'files' => (object) $filesMeta,
        ], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));

        $usedTitles = [];
        foreach ($boards as $id => $b) {
            $title = self::safe((string) ($b['title'] ?? 'Untitled board')) ?: 'Untitled board';
            $z->addString(self::path($folder, 'boards/' . self::uniqueName($title, $usedTitles) . '.md'), self::boardMd($boards, $items, (string) $id));
        }
        self::streamFiles($z, self::path($folder, 'files'), $files);
    }

    /** One board shared individually: Markdown + its files, no data.json (re-importing a single foreign board isn't meaningful). */
    private static function addSharedBoard(ZipStream $z, string $folder, string $spaceId, string $boardId, array $u): void
    {
        $pull = Sync::pull($u, $spaceId, 0);
        [$boards, $items] = self::splitChanges($pull['changes']);
        $sub = Access::subtree($spaceId, $boardId);
        $title = self::safe((string) ($boards[$boardId]['title'] ?? 'Untitled board')) ?: 'Untitled board';
        $z->addString(self::path($folder, "$title.md"), self::boardMd($boards, $items, $boardId));
        $theseItems = array_filter($items, fn($it) => in_array((string) ($it['board'] ?? ''), $sub, true));
        self::streamFiles($z, self::path($folder, 'files'), self::filesOf($theseItems));
    }

    /** Sync::pull's flat change list, split back into boards/items/lines (id => data) and trash (a plain list). */
    private static function splitChanges(array $changes): array
    {
        $boards = []; $items = []; $lines = []; $trash = [];
        foreach ($changes as $c) {
            if (!empty($c['del'])) continue;   // not visible (or since this is a full pull, simply absent already)
            $d = (array) $c['d'];
            match ($c['k']) {
                'board' => $boards[$c['id']] = $d,
                'item' => $items[$c['id']] = $d,
                'line' => $lines[$c['id']] = $d,
                'trash' => $trash[] = $d,
                default => null,
            };
        }
        return [$boards, $items, $lines, $trash];
    }

    /** Asset ids referenced by these items, with their stored mime/name/size (no bytes read here). */
    private static function filesOf(array $items): array
    {
        $ids = [];
        foreach ($items as $it) {
            $d = (array) ($it['data'] ?? []);
            $id = $d['asset'] ?? null;
            if (is_string($id) && $id !== '') $ids[$id] = true;
        }
        $out = [];
        foreach (array_keys($ids) as $id) {
            $a = Db::one('SELECT mime, name, size FROM assets WHERE id = ?', [$id]);
            if ($a) $out[$id] = $a;
        }
        return $out;
    }

    private static function fileEntryName(string $id, array $a): string
    {
        return $id . '-' . (self::safe((string) ($a['name'] ?? $id)) ?: $id);
    }

    /** Streams every file straight from storage into the archive: never whole in memory. */
    private static function streamFiles(ZipStream $z, string $folder, array $files): void
    {
        $storage = Assets::storage();
        foreach ($files as $id => $a) {
            $z->addFromSink(self::path($folder, self::fileEntryName($id, $a)), fn(\Closure $write) => $storage->read($id, $write));
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
        $d = (array) ($it['data'] ?? []);
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
            'poll' => Polls::markdown($d),
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
