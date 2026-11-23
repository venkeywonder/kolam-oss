<?php
declare(strict_types=1);

namespace Kolam;

/**
 * A small WebSocket server (RFC 6455, no libraries) that tells open browsers the moment a space changes and who else
 * is there. It doesn't carry the changes themselves: browsers still pull them through the API, which checks access.
 * It notices changes by watching each open space's revision in the database (every 300 ms), so edits from the API
 * and from MCP clients both show up. Run it with server/bin/realtime behind the web server's proxy.
 */
final class RealtimeServer
{
    private const MAX_FRAME = 65536;
    private const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';   // fixed by RFC 6455
    private const MAX_OUT = 4 * 1024 * 1024;

    /** @var resource */
    private $server;
    private array $conns = [];     // id => connection state
    private array $spaces = [];    // space id => ['rev' => int, 'acl' => int]
    private array $notes = [];     // user id => time of the newest notification they were told about
    private bool $stop = false;
    private int $nextId = 1;

    public function run(string $listen): int
    {
        $this->server = @stream_socket_server('tcp://' . $listen, $errno, $err);
        if (!$this->server) { self::log("can't listen on $listen: $err"); return 1; }
        stream_set_blocking($this->server, false);
        // the API sends a datagram here after each push (Realtime::nudge), so changes go out without waiting for the next check
        $nudge = @stream_socket_server('udp://' . $listen, $errno, $err, STREAM_SERVER_BIND);
        if ($nudge) stream_set_blocking($nudge, false);
        if (function_exists('pcntl_async_signals')) {
            pcntl_async_signals(true);
            foreach ([SIGTERM, SIGINT] as $s) pcntl_signal($s, function () { $this->stop = true; });
        }
        self::log("listening on $listen");
        $tick = $people = $beat = 0.0;
        while (!$this->stop) {
            $read = $nudge ? [$this->server, $nudge] : [$this->server];
            $write = [];
            foreach ($this->conns as $c) { $read[] = $c['sock']; if ($c['out'] !== '') $write[] = $c['sock']; }
            $except = null;
            if (@stream_select($read, $write, $except, 0, 200000) === false) { usleep(100000); continue; }
            foreach ($read as $s) {
                if ($s === $this->server) $this->accept();
                elseif ($s === $nudge) { while (($d = @stream_socket_recvfrom($nudge, 64)) !== false && $d !== '') {} $tick = 0.0; }
                elseif (($id = $this->idOf($s)) !== null) $this->receive($id);
            }
            foreach ($write as $s) if (($id = $this->idOf($s)) !== null) $this->flush($id);
            $now = microtime(true);
            if ($now >= $tick) { $this->checkRevisions(); $this->checkNotes(); $tick = $now + 0.3; }
            if ($now >= $people) { $this->sendPresence(); $people = $now + 1; }
            if ($now >= $beat) { $this->heartbeat(); $beat = $now + 10; }
        }
        foreach (array_keys($this->conns) as $id) $this->close($id);
        return 0;
    }

    private static function log(string $msg): void { fwrite(STDOUT, '[' . date('Y-m-d H:i:s') . "] $msg\n"); }

    private function idOf($sock): ?int
    {
        foreach ($this->conns as $id => $c) if ($c['sock'] === $sock) return $id;
        return null;
    }

    private function accept(): void
    {
        $s = @stream_socket_accept($this->server, 0);
        if (!$s) return;
        stream_set_blocking($s, false);
        $this->conns[$this->nextId++] = ['sock' => $s, 'buf' => '', 'out' => '', 'open' => false, 'closing' => false, 'uid' => null,
            'space' => null, 'client' => null, 'board' => null, 'editing' => null, 'seen' => time(), 'frag' => '', 'people' => ''];
    }

    private function receive(int $id): void
    {
        $data = @fread($this->conns[$id]['sock'], 65536);
        if ($data === '' || $data === false) { if (feof($this->conns[$id]['sock']) || $data === false) $this->close($id); return; }
        $c = &$this->conns[$id];
        $c['buf'] .= $data;
        $c['seen'] = time();
        if (!$c['open']) {
            if (strlen($c['buf']) > 8192) { $this->close($id); return; }
            if (!str_contains($c['buf'], "\r\n\r\n")) return;
            $this->handshake($id);
            return;
        }
        while (isset($this->conns[$id]) && ($frame = $this->frame($id)) !== null) $this->onFrame($id, ...$frame);
    }

    private function handshake(int $id): void
    {
        $c = &$this->conns[$id];
        [$head] = explode("\r\n\r\n", $c['buf'], 2);
        $c['buf'] = '';
        $lines = explode("\r\n", $head);
        $h = [];
        foreach (array_slice($lines, 1) as $l) if (str_contains($l, ':')) { [$k, $v] = explode(':', $l, 2); $h[strtolower(trim($k))] = trim($v); }
        $ticket = '';
        if (preg_match('~^GET (\S+) HTTP/1\.1$~', $lines[0], $m)) { parse_str((string) parse_url($m[1], PHP_URL_QUERY), $q); $ticket = (string) ($q['t'] ?? ''); }
        $uid = $ticket !== '' ? Realtime::verify($ticket) : null;
        if (strtolower($h['upgrade'] ?? '') !== 'websocket' || empty($h['sec-websocket-key']) || $uid === null) {
            $c['out'] .= "HTTP/1.1 " . ($uid === null ? '401 Unauthorized' : '400 Bad Request') . "\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";
            $c['closing'] = true;
            return;
        }
        $accept = base64_encode(sha1($h['sec-websocket-key'] . self::GUID, true));
        $c['out'] .= "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: $accept\r\n\r\n";
        $c['open'] = true;
        $c['uid'] = $uid;
    }

    /** One complete frame from the buffer as [opcode, fin, payload], or null when more bytes are needed. */
    private function frame(int $id): ?array
    {
        $c = &$this->conns[$id];
        $b = $c['buf'];
        if (strlen($b) < 2) return null;
        $b1 = ord($b[0]); $b2 = ord($b[1]);
        $len = $b2 & 0x7f; $off = 2;
        if ($len === 126) { if (strlen($b) < 4) return null; $len = unpack('n', substr($b, 2, 2))[1]; $off = 4; }
        elseif ($len === 127) { if (strlen($b) < 10) return null; $len = unpack('J', substr($b, 2, 8))[1]; $off = 10; }
        if (!($b2 & 0x80) || $len > self::MAX_FRAME) { $this->close($id); return null; }   // browsers always mask
        if (strlen($b) < $off + 4 + $len) return null;
        $mask = substr($b, $off, 4);
        $payload = substr($b, $off + 4, $len);
        $c['buf'] = (string) substr($b, $off + 4 + $len);
        if ($len) $payload ^= substr(str_repeat($mask, intdiv($len, 4) + 1), 0, $len);
        return [$b1 & 0x0f, (bool) ($b1 & 0x80), $payload];
    }

    private function onFrame(int $id, int $op, bool $fin, string $payload): void
    {
        $c = &$this->conns[$id];
        if ($op === 0x8) { $this->send($id, '', 0x8); $c['closing'] = true; return; }
        if ($op === 0x9) { $this->send($id, $payload, 0xA); return; }
        if ($op === 0xA) return;
        if ($op === 0x1 || $op === 0x0) {
            $c['frag'] .= $payload;
            if (strlen($c['frag']) > self::MAX_FRAME) { $this->close($id); return; }
            if (!$fin) return;
            $msg = json_decode($c['frag'], true);
            $c['frag'] = '';
            if (is_array($msg)) $this->onMessage($id, $msg);
        }
    }

    private function onMessage(int $id, array $m): void
    {
        $c = &$this->conns[$id];
        try {
            if (($m['t'] ?? '') === 'sub') {
                $client = (string) ($m['client'] ?? '');
                if (!preg_match('/^[\w-]{4,24}$/', $client)) return;
                $space = Access::space((string) ($m['space'] ?? ''));
                if (!Access::boards($c['uid'], $space)) { $this->sendJson($id, ['t' => 'gone', 'space' => $space['id']]); return; }
                if ($c['space'] && $c['space'] !== $space['id']) Realtime::leave($c['space'], $c['client'], $c['uid']);
                $c['space'] = $space['id']; $c['client'] = $client; $c['board'] = $c['editing'] = null; $c['people'] = '';
                $this->spaces[$space['id']] ??= ['rev' => (int) $space['rev'], 'acl' => (int) $space['acl_rev']];
                $this->sendJson($id, ['t' => 'rev', 'space' => $space['id'], 'rev' => (int) $space['rev'], 'acl' => (int) $space['acl_rev']]);
                $this->sendJson($id, ['t' => 'note', 'at' => $this->notes[$c['uid']] ??= Notify::latest($c['uid'])]);
            } elseif (($m['t'] ?? '') === 'here' && $c['space']) {
                $c['board'] = $m['board'] ?? null; $c['editing'] = $m['editing'] ?? null;
                Realtime::here($c['uid'], Access::space($c['space']), $c['client'], $c['board'], $c['editing']);
                $this->presenceFor($c['space']);
            }
        } catch (HttpError) {
            $this->sendJson($id, ['t' => 'gone', 'space' => $m['space'] ?? $c['space']]);
        }
    }

    /** Tell people the moment they get a notification (the browser then fetches the list). */
    private function checkNotes(): void
    {
        $uids = array_values(array_unique(array_filter(array_column($this->conns, 'uid'))));
        foreach (array_keys($this->notes) as $uid) if (!in_array($uid, $uids, true)) unset($this->notes[$uid]);
        if (!$uids) return;
        $in = implode(',', array_fill(0, count($uids), '?'));
        foreach (Db::q("SELECT user_id, MAX(created_at) m FROM notifications WHERE user_id IN ($in) GROUP BY user_id", $uids) as $r) {
            $at = (int) $r['m'];
            if (($this->notes[$r['user_id']] ?? 0) >= $at) continue;
            $this->notes[$r['user_id']] = $at;
            foreach ($this->conns as $id => $c) if ($c['uid'] === $r['user_id'] && $c['open']) $this->sendJson($id, ['t' => 'note', 'at' => $at]);
        }
    }

    /** Tell everyone in a space when its revision moves, so they pull right away. */
    private function checkRevisions(): void
    {
        $open = array_values(array_unique(array_filter(array_column($this->conns, 'space'))));
        foreach (array_keys($this->spaces) as $sid) if (!in_array($sid, $open, true)) unset($this->spaces[$sid]);
        if (!$open) return;
        $in = implode(',', array_fill(0, count($open), '?'));
        $rows = [];
        foreach (Db::q("SELECT id, rev, acl_rev, deleted_at FROM spaces WHERE id IN ($in)", $open) as $r) $rows[$r['id']] = $r;
        foreach ($open as $sid) {
            $r = $rows[$sid] ?? null;
            if (!$r || $r['deleted_at'] !== null) { $this->drop($sid); continue; }
            $was = $this->spaces[$sid];
            if ($was['rev'] === (int) $r['rev'] && $was['acl'] === (int) $r['acl_rev']) continue;
            Access::forget($sid);
            $this->spaces[$sid] = ['rev' => (int) $r['rev'], 'acl' => (int) $r['acl_rev']];
            $space = Access::space($sid);
            foreach ($this->conns as $id => $c) {
                if ($c['space'] !== $sid) continue;
                if ($was['acl'] !== (int) $r['acl_rev'] && !Access::boards($c['uid'], $space)) { $this->unsubscribe($id); continue; }
                $this->sendJson($id, ['t' => 'rev', 'space' => $sid, 'rev' => (int) $r['rev'], 'acl' => (int) $r['acl_rev']]);
            }
            if ($was['acl'] !== (int) $r['acl_rev']) $this->presenceFor($sid);
        }
    }

    /** Everyone loses a space (deleted). */
    private function drop(string $sid): void
    {
        foreach ($this->conns as $id => $c) if ($c['space'] === $sid) $this->unsubscribe($id);
        unset($this->spaces[$sid]);
    }

    private function unsubscribe(int $id): void
    {
        $c = &$this->conns[$id];
        $this->sendJson($id, ['t' => 'gone', 'space' => $c['space']]);
        Realtime::leave($c['space'], $c['client'], $c['uid']);
        $c['space'] = null;
    }

    private function sendPresence(): void
    {
        foreach (array_keys($this->spaces) as $sid) $this->presenceFor($sid);
    }

    /** Send each person in the space the people list as they may see it, when it changed for them. */
    private function presenceFor(string $sid): void
    {
        try { $space = Access::space($sid); } catch (HttpError) { $this->drop($sid); return; }
        $rows = Realtime::rows($sid);
        $lists = [];
        foreach ($this->conns as $id => $c) {
            if ($c['space'] !== $sid) continue;
            $json = $lists[$c['uid']] ??= json_encode(Realtime::who($c['uid'], $space, $rows), JSON_UNESCAPED_UNICODE);
            if ($json === $c['people']) continue;
            $this->conns[$id]['people'] = $json;
            $this->send($id, '{"t":"presence","space":' . json_encode($sid) . ',"people":' . $json . '}');
        }
    }

    /** Keep presence rows fresh, ping browsers, and drop connections that went quiet. */
    private function heartbeat(): void
    {
        foreach ($this->conns as $id => $c) {
            if (!$c['open'] || $c['seen'] < time() - 75) { $this->close($id); continue; }
            $this->send($id, '', 0x9);
            if (!$c['space']) continue;
            try { Realtime::here($c['uid'], Access::space($c['space']), $c['client'], $c['board'], $c['editing']); }
            catch (HttpError) { $this->unsubscribe($id); }
        }
    }

    private function sendJson(int $id, array $m): void { $this->send($id, json_encode($m, JSON_UNESCAPED_UNICODE)); }

    private function send(int $id, string $payload, int $op = 0x1): void
    {
        if (!isset($this->conns[$id]) || !$this->conns[$id]['open']) return;
        $len = strlen($payload);
        $head = chr(0x80 | $op) . ($len < 126 ? chr($len) : ($len < 65536 ? chr(126) . pack('n', $len) : chr(127) . pack('J', $len)));
        $this->conns[$id]['out'] .= $head . $payload;
        if (strlen($this->conns[$id]['out']) > self::MAX_OUT) { $this->close($id); return; }   // a reader that stopped reading
        $this->flush($id);
    }

    private function flush(int $id): void
    {
        $c = &$this->conns[$id];
        if ($c['out'] !== '') {
            $n = @fwrite($c['sock'], $c['out']);
            if ($n === false) { $this->close($id); return; }
            $c['out'] = (string) substr($c['out'], $n);
        }
        if ($c['out'] === '' && $c['closing']) $this->close($id);
    }

    private function close(int $id): void
    {
        $c = $this->conns[$id] ?? null;
        if (!$c) return;
        unset($this->conns[$id]);
        @fclose($c['sock']);
        if ($c['space']) { try { Realtime::leave($c['space'], $c['client'], $c['uid']); } catch (\Throwable) {} }
    }
}
