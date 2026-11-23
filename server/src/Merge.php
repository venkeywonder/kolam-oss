<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Field-level merging of concurrent edits to one record. src/core/merge.js does exactly the same in the browser.
 *
 * A push names the fields it changed ("color", "data.thread", …), plus the value it started from for fields holding
 * objects or lists. Fields it didn't change keep what the server has, so two people changing different fields of one
 * card both keep their change. Inside a changed field:
 * - objects merge key by key;
 * - lists of objects with ids (to-do tasks) merge by id: additions and removals from both sides are kept;
 * - lists both sides only appended to keep both sides' additions;
 * - lists of the same length (table rows and cells) merge position by position;
 * - anything else: the later push wins. Rich text is merged character by character with Yjs instead (YText).
 */
final class Merge
{
    /** Marker for a key that isn't there. */
    public static function none(): \stdClass
    {
        static $none = null;
        return $none ??= new \stdClass();
    }

    /** What changed from $base to $mine, in the form a push sends: ['f' => changed fields, 'b' => starting values of containers]. */
    public static function patchOf(array $base, array $mine): array
    {
        $f = []; $b = [];
        $add = function (string $p, mixed $was) use (&$f, &$b) { $f[] = $p; if (is_array($was)) $b[$p] = $was; };
        foreach (array_keys($base + $mine) as $k) {
            $k = (string) $k;
            [$x, $y] = [self::get($base, $k), self::get($mine, $k)];
            if ($k === 'data' && self::isMap($x) && self::isMap($y)) {
                foreach (array_keys($x + $y) as $d) {
                    $d = (string) $d;
                    if (!self::eq(self::get($x, $d), self::get($y, $d))) $add("data.$d", $x[$d] ?? null);
                }
            } elseif (!self::eq($x, $y)) $add($k, $x === self::none() ? null : $x);
        }
        return ['f' => $f, 'b' => $b];
    }

    /** Apply the changed fields $f of $mine onto $theirs (the server's copy). $base: starting values of container fields. */
    public static function patch(array $theirs, array $mine, array $f, array $base): array
    {
        $out = $theirs;
        foreach ($f as $p) {
            if (!is_string($p) || $p === '') continue;
            [$top, $key] = str_contains($p, '.') ? explode('.', $p, 2) : [$p, null];
            if ($key !== null && $top === 'data' && is_array($mine['data'] ?? null)) {
                if (!is_array($out['data'] ?? null)) $out['data'] = [];
                $v = self::field($base, $p, self::get($mine['data'], $key), self::get(is_array($theirs['data'] ?? null) ? $theirs['data'] : [], $key));
                if ($v === self::none()) unset($out['data'][$key]); else $out['data'][$key] = $v;
            } else {
                $v = self::field($base, $top, self::get($mine, $top), self::get($theirs, $top));
                if ($v === self::none()) unset($out[$top]); else $out[$top] = $v;
            }
        }
        return $out;
    }

    private static function field(array $base, string $p, mixed $m, mixed $t): mixed
    {
        return array_key_exists($p, $base) ? self::merge3($base[$p], $m, $t) : $m;
    }

    private static function get(array $a, string $k): mixed
    {
        return array_key_exists($k, $a) ? $a[$k] : self::none();
    }

    public static function merge3(mixed $b, mixed $m, mixed $t): mixed
    {
        if (self::eq($m, $b)) return $t;
        if (self::eq($t, $b) || self::eq($m, $t)) return $m;
        if (self::isMap($b) && self::isMap($m) && self::isMap($t)) {
            $out = [];
            foreach (array_keys($t + $m) as $k) {
                $v = self::merge3(self::get($b, (string) $k), self::get($m, (string) $k), self::get($t, (string) $k));
                if ($v !== self::none()) $out[$k] = $v;
            }
            return $out;
        }
        if (self::isList($b) && self::isList($m) && self::isList($t)) {
            if (self::hasIds($b) && self::hasIds($m) && self::hasIds($t)) return self::byId($b, $m, $t);
            $nb = count($b);
            if (self::eq(array_slice($m, 0, $nb), $b) && self::eq(array_slice($t, 0, $nb), $b)) return array_merge($t, array_slice($m, $nb));
            if (count($m) === $nb && count($t) === $nb) {
                $out = [];
                foreach ($b as $i => $bv) $out[] = self::merge3($bv, $m[$i], $t[$i]);
                return $out;
            }
        }
        return $m;
    }

    private static function byId(array $b, array $m, array $t): array
    {
        $ix = fn(array $l) => array_combine(array_map(fn($e) => $e['id'], $l), $l);
        [$B, $M, $T] = [$ix($b), $ix($m), $ix($t)];
        // theirs' order wins, unless only this side moved the elements both sides still have
        $seq = fn(array $l) => implode(',', array_map(fn($e) => $e['id'], array_filter($l, fn($e) => isset($B[$e['id']], $M[$e['id']], $T[$e['id']]))));
        $mineOrder = $seq($m) !== $seq($b) && $seq($t) === $seq($b);
        [$lead, $Other, $other, $Lead] = $mineOrder ? [$m, $T, $t, $M] : [$t, $M, $m, $T];
        $out = [];
        foreach ($lead as $e) {
            $id = $e['id'];
            if (isset($B[$id]) && !isset($Other[$id])) continue;   // removed on the other side
            $out[] = isset($M[$id], $T[$id]) ? self::merge3($B[$id] ?? self::none(), $M[$id], $T[$id]) : $e;
        }
        // added on the other side: after the element it follows there, or first
        $prev = null;
        foreach ($other as $e) {
            $id = $e['id'];
            if (!isset($B[$id]) && !isset($Lead[$id])) {
                $at = 0;
                if ($prev !== null) foreach ($out as $i => $o) if ($o['id'] === $prev) { $at = $i + 1; break; }
                array_splice($out, $at, 0, [$e]);
            }
            foreach ($out as $o) if ($o['id'] === $id) { $prev = $id; break; }
        }
        return $out;
    }

    private static function isMap(mixed $x): bool { return is_array($x) && ($x === [] || !array_is_list($x)); }
    private static function isList(mixed $x): bool { return is_array($x) && array_is_list($x); }

    private static function hasIds(array $l): bool
    {
        $seen = [];
        foreach ($l as $e) {
            if (!is_array($e) || !is_string($e['id'] ?? null) || isset($seen[$e['id']])) return false;
            $seen[$e['id']] = true;
        }
        return true;
    }

    /** Deep equality of decoded JSON (key order doesn't matter; 1 equals 1.0). */
    public static function eq(mixed $a, mixed $b): bool
    {
        if (is_array($a) && is_array($b)) {
            if (count($a) !== count($b) || array_is_list($a) !== array_is_list($b)) return false;
            foreach ($a as $k => $v) if (!array_key_exists($k, $b) || !self::eq($v, $b[$k])) return false;
            return true;
        }
        if ((is_int($a) || is_float($a)) && (is_int($b) || is_float($b))) return $a == $b;
        return $a === $b;
    }
}
