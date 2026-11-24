<?php
declare(strict_types=1);

namespace Kolam;

/**
 * A user's boards, cards and lines loaded into memory so server-side code (the MCP tools) can read and change them.
 * Changes are written back through Sync::push as field patches against what was loaded, so open browsers pick them up like
 * any other device's, and whatever people changed meanwhile in other fields (or in the text, merged by Yjs) is kept.
 */
final class Workspace
{
    public array $boards = [];
    public array $items = [];
    public array $lines = [];
    public array $trash = [];   // trash entries the person can restore (deleted from boards they can edit)
    public array $roles = [];
    private array $ops = [];
    private array $loaded = [];   // "kind:id" => record as loaded, to send only the changed fields

    private function __construct(private array $user, public readonly string $spaceId) {}

    /** Loads the boards the person can see in a space (their home workspace when $spaceId is omitted). */
    public static function load(array $u, ?string $spaceId = null): self
    {
        $spaceId ??= Spaces::home($u['id'])['id'];
        Access::forget($spaceId);   // a long-running MCP process: boards made or shared since the last call count
        $space = Access::space($spaceId);
        $roles = Access::boards($u['id'], $space);
        if (!$roles) throw new ToolError('You don’t have access to any boards in this space');
        $w = new self($u, $spaceId);
        $w->roles = $roles;
        $rows = Db::q("SELECT kind, id, parent, data FROM entities WHERE space_id = ? AND deleted = 0 AND kind IN ('board','item','line','trash')", [$spaceId]);
        foreach ($rows as $r) {
            $d = json_decode((string) $r['data'], true);
            if (!is_array($d)) continue;
            if ($r['kind'] === 'trash') {
                // the same rule as pulls: the owner, or editors of the board it was deleted from; a deleted workspace is restored elsewhere
                $can = ($roles['home'] ?? null) === 'owner' || Access::atLeast($roles[(string) ($d['from'] ?? '')] ?? null, 'editor');
                if (($d['type'] ?? '') === 'workspace' || !$can) continue;
                $w->trash[$r['id']] = $d + ['id' => $r['id']];
                $w->loaded['trash:' . $r['id']] = $d;
                continue;
            }
            // only rows on a board the person can open: the board itself, or an item/line whose board (parent) is visible
            if (!isset($roles[$r['kind'] === 'board' ? $r['id'] : ($r['parent'] ?? '')])) continue;
            match ($r['kind']) { 'board' => $w->boards[$r['id']] = $d, 'item' => $w->items[$r['id']] = $d, 'line' => $w->lines[$r['id']] = $d };
            $w->loaded[$r['kind'] . ':' . $r['id']] = $d;
        }
        return $w;
    }

    /** Same id style as the browser (src/core/util.js uid). */
    public static function uid(): string
    {
        $r = '';
        for ($i = 0; $i < 7; $i++) $r .= base_convert((string) random_int(0, 35), 10, 36);
        return $r . substr(base_convert((string) (int) (microtime(true) * 1000), 10, 36), -4);
    }

    public function putBoard(array $b): void { $this->boards[$b['id']] = $b; $this->ops['board:' . $b['id']] = ['k' => 'board', 'id' => $b['id'], 'd' => $b]; }
    public function putItem(array $i): void { $this->items[$i['id']] = $i; $this->ops['item:' . $i['id']] = ['k' => 'item', 'id' => $i['id'], 'd' => $i]; }
    public function putLine(array $l): void { $this->lines[$l['id']] = $l; $this->ops['line:' . $l['id']] = ['k' => 'line', 'id' => $l['id'], 'd' => $l]; }
    public function delBoard(string $id): void { unset($this->boards[$id]); $this->ops['board:' . $id] = ['k' => 'board', 'id' => $id, 'del' => 1]; }
    public function delItem(string $id): void { unset($this->items[$id]); $this->ops['item:' . $id] = ['k' => 'item', 'id' => $id, 'del' => 1]; }
    public function delLine(string $id): void { unset($this->lines[$id]); $this->ops['line:' . $id] = ['k' => 'line', 'id' => $id, 'del' => 1]; }
    public function putTrash(array $t): void { $this->ops['trash:' . $t['id']] = ['k' => 'trash', 'id' => $t['id'], 'd' => $t]; }
    public function delTrash(string $id): void { unset($this->trash[$id]); $this->ops['trash:' . $id] = ['k' => 'trash', 'id' => $id, 'del' => 1]; }

    public function commit(): void
    {
        if (!$this->ops) return;
        $ops = [];
        foreach ($this->ops as $key => $op) {
            $was = $this->loaded[$key] ?? null;
            if ($was !== null && isset($op['d'])) {
                $p = Merge::patchOf($was, $op['d']);
                if (!$p['f']) continue;
                $op += $p;
            }
            $ops[] = $op;
        }
        if ($ops) Sync::push($this->user, $this->spaceId, ['ops' => $ops]);
        foreach ($this->ops as $key => $op) if (isset($op['d'])) $this->loaded[$key] = $op['d']; else unset($this->loaded[$key]);
        $this->ops = [];
    }

    /* ---------- queries ---------- */

    public function itemsOf(string $board): array
    {
        return array_values(array_filter($this->items, fn($i) => ($i['board'] ?? null) === $board));
    }

    public function childrenOf(string $colId): array
    {
        $k = array_values(array_filter($this->items, fn($i) => ($i['col'] ?? null) === $colId));
        usort($k, fn($a, $b) => ($a['order'] ?? 0) <=> ($b['order'] ?? 0));
        return $k;
    }

    public function maxZ(string $board): int
    {
        $z = 0;
        foreach ($this->itemsOf($board) as $i) $z = max($z, (int) ($i['z'] ?? 0));
        return $z;
    }

    /** Path of board titles from Home down to this board. */
    public function path(string $board): string
    {
        $parts = []; $b = $this->boards[$board] ?? null; $n = 0;
        while ($b && $n++ < 50) { array_unshift($parts, $b['title'] ?? 'Untitled board'); $b = isset($b['parent']) ? ($this->boards[$b['parent']] ?? null) : null; }
        return implode(' / ', $parts);
    }
}
