<?php
declare(strict_types=1);

namespace Kolam;

/** One-time import of the old single-file storage (data/state.json) into the first account. */
final class Legacy
{
    public static function importInto(string $userId): void
    {
        if (!Config::get('legacy_import')) return;
        $dir = NK_ROOT . '/data';
        $file = "$dir/state.json";
        if (!is_file($file)) return;
        $st = json_decode((string) file_get_contents($file), true);
        if (!is_array($st) || empty($st['boards'])) return;
        foreach (glob("$dir/assets/a_*.txt") ?: [] as $f) {
            $id = basename($f, '.txt');
            if (!preg_match('/^a_[a-z0-9]{6,40}$/', $id)) continue;
            $d = (string) file_get_contents($f);
            if (!preg_match('/^data:[^;,]*(;base64)?,/', $d, $m)) continue;
            $raw = substr($d, strlen($m[0]));
            $bin = !empty($m[1]) ? base64_decode($raw) : rawurldecode($raw);
            $tmp = tempnam(sys_get_temp_dir(), 'nk');
            file_put_contents($tmp, $bin);
            $name = $id;
            foreach ($st['items'] ?? [] as $it) if (($it['data']['asset'] ?? '') === $id && !empty($it['data']['name'])) $name = $it['data']['name'];
            Assets::store($userId, $tmp, $name, strlen($bin), $id);
        }
        Sync::writeState($userId, $st);
        @rename($file, "$file.imported");
    }
}
