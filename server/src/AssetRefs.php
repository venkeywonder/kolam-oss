<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Which cards mention which asset ids, kept in step with every entity write so Assets::release can find out
 * whether a file is still used without scanning every card's JSON (the old "data LIKE '%id%'").
 */
final class AssetRefs
{
    /** Same match the old LIKE scan used: any mention of the id anywhere in the card's JSON. */
    private static function extract(array $data): array
    {
        $json = json_encode($data, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        preg_match_all('/a_[a-z0-9]{6,40}/', (string) $json, $m);
        return array_values(array_unique($m[0]));
    }

    /** Called from Sync::put for the one row it just wrote (or deleted, $data = null). */
    public static function sync(string $spaceId, string $kind, string $id, ?array $data): void
    {
        Db::q('DELETE FROM asset_refs WHERE space_id = ? AND kind = ? AND entity_id = ?', [$spaceId, $kind, $id]);
        if ($data === null) return;
        foreach (self::extract($data) as $aid) {
            Db::q('INSERT INTO asset_refs (asset_id, space_id, kind, entity_id) VALUES (?,?,?,?)', [$aid, $spaceId, $kind, $id]);
        }
    }

    /** Recomputes every ref of one space from its current (live) entities, for the rare bulk admin writes that
     *  touch the entities table directly instead of going through Sync::put. */
    public static function rebuildSpace(string $spaceId): void
    {
        Db::q('DELETE FROM asset_refs WHERE space_id = ?', [$spaceId]);
        $ins = [];
        foreach (Db::q('SELECT kind, id, data FROM entities WHERE space_id = ? AND deleted = 0', [$spaceId]) as $r) {
            $d = json_decode((string) $r['data'], true);
            if (!is_array($d)) continue;
            foreach (self::extract($d) as $aid) $ins[] = [$aid, $spaceId, $r['kind'], $r['id']];
        }
        foreach (array_chunk($ins, 500) as $chunk) {
            $ph = implode(',', array_fill(0, count($chunk), '(?,?,?,?)'));
            $args = [];
            foreach ($chunk as $row) array_push($args, ...$row);
            Db::q("INSERT INTO asset_refs (asset_id, space_id, kind, entity_id) VALUES $ph", $args);
        }
    }

    /** Migration 25: build the table from whatever is already in entities. */
    public static function backfill(): void
    {
        foreach (Db::q("SELECT DISTINCT space_id FROM entities WHERE deleted = 0")->fetchAll() as $r) {
            self::rebuildSpace((string) $r['space_id']);
        }
    }

    /** True if any live card anywhere still mentions this asset id. */
    public static function exists(string $assetId): bool
    {
        return (bool) Db::one('SELECT 1 AS x FROM asset_refs WHERE asset_id = ?', [$assetId]);
    }
}
