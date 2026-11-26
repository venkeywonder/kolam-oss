<?php
declare(strict_types=1);

namespace Kolam;

/**
 * Streams a ZIP straight to the HTTP response: store method only (no compression, so no CPU is spent and every size
 * is exactly what we write), general-purpose bit 3 (data descriptors) so no file's size ever has to be known before
 * its bytes are, and ZIP64 records wherever a size, offset or entry count outgrows the plain 32-bit format. Nothing
 * is ever held whole in memory or written to a temp file first: addFromSink hands bytes straight from a Closure
 * (e.g. Storage::read) to the response as they arrive.
 */
final class ZipStream
{
    private const SIG_LOCAL = "PK\x03\x04";
    private const SIG_DATA_DESC = "PK\x07\x08";
    private const SIG_CENTRAL = "PK\x01\x02";
    private const SIG_EOCD64 = "PK\x06\x06";
    private const SIG_EOCD64_LOC = "PK\x06\x07";
    private const SIG_EOCD = "PK\x05\x06";

    private int $pos = 0;
    private int $entryOffset = 0;
    /** @var array<int, array{name:string, offset:int, crc:int, csize:int, usize:int}> */
    private array $entries = [];

    private function __construct(private bool $forceZip64) {}

    /**
     * Starts the response: headers, no output buffering/compression, no time limit. $forceZip64 is a test knob only:
     * it makes every entry use the ZIP64 local/central format regardless of size, to exercise that path on a tiny archive.
     */
    public static function begin(string $filename, bool $forceZip64 = false): self
    {
        set_time_limit(0);
        while (ob_get_level() > 0) @ob_end_clean();
        ini_set('zlib.output_compression', '0');
        header('Content-Type: application/zip');
        header('Content-Disposition: attachment; filename="' . str_replace('"', '', $filename) . '"');
        header('X-Accel-Buffering: no');   // nginx: don't buffer the whole thing before sending
        return new self($forceZip64);
    }

    /** A whole file already in memory: a README, data.json, a board's Markdown. */
    public function addString(string $path, string $bytes): void
    {
        $zip64 = $this->forceZip64 || strlen($bytes) >= 0xFFFFFFFF;
        $this->localHeader($path, $zip64);
        $this->write($bytes);
        $crc = crc32($bytes);
        $this->dataDescriptor($crc, strlen($bytes), strlen($bytes), $zip64);
        $this->entries[] = ['name' => $path, 'offset' => $this->entryOffset, 'crc' => $crc, 'csize' => strlen($bytes), 'usize' => strlen($bytes)];
        $this->flushOut();
    }

    /**
     * A file of unknown size, fed piece by piece: $producer($write) must call $write(chunk) for every chunk (in
     * order) and return true, or return false when the source turns out missing — then nothing is added to the
     * central directory, so the bytes already sent sit unreferenced in the stream and no unzip tool ever sees them.
     * Always reserves ZIP64 fields locally since the final size isn't known until the last byte arrives.
     */
    public function addFromSink(string $path, \Closure $producer): bool
    {
        $this->localHeader($path, true);
        $start = $this->pos;
        $ctx = hash_init('crc32b');
        $usize = 0;
        $write = function (string $chunk) use (&$usize, $ctx): void {
            if ($chunk === '') return;
            $usize += strlen($chunk);
            hash_update($ctx, $chunk);
            $this->write($chunk);
            $this->flushOut();
        };
        $ok = $producer($write);
        if (!$ok) {
            $this->dataDescriptor(0, 0, 0, true);
            return false;
        }
        $crc = (int) hexdec(hash_final($ctx, false));
        $csize = $this->pos - $start;
        $this->dataDescriptor($crc, $csize, $usize, true);
        $this->entries[] = ['name' => $path, 'offset' => $this->entryOffset, 'crc' => $crc, 'csize' => $csize, 'usize' => $usize];
        return true;
    }

    /** Central directory, then the (ZIP64, if needed) end-of-central-directory records. */
    public function finish(): void
    {
        $cdStart = $this->pos;
        foreach ($this->entries as $e) {
            $zip64 = $this->forceZip64 || $e['csize'] >= 0xFFFFFFFF || $e['usize'] >= 0xFFFFFFFF || $e['offset'] >= 0xFFFFFFFF;
            $extra = $zip64 ? pack('vv', 0x0001, 24) . pack('PPP', $e['usize'], $e['csize'], $e['offset']) : '';
            $this->write(self::SIG_CENTRAL);
            $this->write(pack('v', 0x031E));                                           // version made by: 3.0, unix
            $this->write(pack('v', $zip64 ? 45 : 20));                                 // version needed
            $this->write(pack('v', 0x0808));                                           // bit3 data descriptor, bit11 UTF-8 name
            $this->write(pack('v', 0));                                                // method: store
            [$t, $d] = self::dosTime($e['mtime'] ?? time());
            $this->write(pack('vv', $t, $d));
            $this->write(pack('V', $e['crc']));
            $this->write(pack('VV', $zip64 ? 0xFFFFFFFF : $e['csize'], $zip64 ? 0xFFFFFFFF : $e['usize']));
            $this->write(pack('v', strlen($e['name'])));
            $this->write(pack('v', strlen($extra)));
            $this->write(pack('v', 0));                                                // comment length
            $this->write(pack('v', 0));                                                // disk number start
            $this->write(pack('v', 0));                                                // internal attrs
            $this->write(pack('V', 0100644 << 16));                                    // external attrs: -rw-r--r--
            $this->write(pack('V', $zip64 ? 0xFFFFFFFF : $e['offset']));
            $this->write($e['name']);
            $this->write($extra);
        }
        $cdSize = $this->pos - $cdStart;
        $count = count($this->entries);
        if ($this->forceZip64 || $count >= 0xFFFF || $cdSize >= 0xFFFFFFFF || $cdStart >= 0xFFFFFFFF) {
            $eocd64At = $this->pos;
            $this->write(self::SIG_EOCD64);
            $this->write(pack('P', 44));                                              // record size, excluding the first 12 bytes
            $this->write(pack('v', 0x031E));
            $this->write(pack('v', 45));
            $this->write(pack('V', 0));
            $this->write(pack('V', 0));
            $this->write(pack('P', $count));
            $this->write(pack('P', $count));
            $this->write(pack('P', $cdSize));
            $this->write(pack('P', $cdStart));
            $this->write(self::SIG_EOCD64_LOC);
            $this->write(pack('V', 0));
            $this->write(pack('P', $eocd64At));
            $this->write(pack('V', 1));
        }
        $this->write(self::SIG_EOCD);
        $this->write(pack('v', 0));
        $this->write(pack('v', 0));
        $this->write(pack('v', min($count, 0xFFFF)));
        $this->write(pack('v', min($count, 0xFFFF)));
        $this->write(pack('V', min($cdSize, 0xFFFFFFFF)));
        $this->write(pack('V', min($cdStart, 0xFFFFFFFF)));
        $this->write(pack('v', 0));
        $this->flushOut();
    }

    private function localHeader(string $path, bool $zip64): void
    {
        $this->entryOffset = $this->pos;
        $extra = $zip64 ? pack('vv', 0x0001, 16) . pack('PP', 0, 0) : '';   // placeholder sizes: real ones are in the data descriptor
        $this->write(self::SIG_LOCAL);
        $this->write(pack('v', $zip64 ? 45 : 20));
        $this->write(pack('v', 0x0808));
        $this->write(pack('v', 0));
        [$t, $d] = self::dosTime(time());
        $this->write(pack('vv', $t, $d));
        $this->write(pack('V', 0));                                                    // crc: unknown yet
        $this->write(pack('VV', $zip64 ? 0xFFFFFFFF : 0, $zip64 ? 0xFFFFFFFF : 0));     // sizes: unknown yet
        $this->write(pack('v', strlen($path)));
        $this->write(pack('v', strlen($extra)));
        $this->write($path);
        $this->write($extra);
    }

    private function dataDescriptor(int $crc, int $csize, int $usize, bool $zip64): void
    {
        $this->write(self::SIG_DATA_DESC);
        $this->write(pack('V', $crc));
        if ($zip64) { $this->write(pack('P', $csize)); $this->write(pack('P', $usize)); }
        else { $this->write(pack('V', $csize)); $this->write(pack('V', $usize)); }
    }

    private function write(string $bytes): void
    {
        echo $bytes;
        $this->pos += strlen($bytes);
    }

    private function flushOut(): void
    {
        if (ob_get_level() > 0) @ob_flush();
        @flush();
    }

    /** DOS time/date words (zip's native timestamp format) from a unix timestamp. */
    private static function dosTime(int $ts): array
    {
        $g = getdate($ts);
        $time = ($g['hours'] << 11) | ($g['minutes'] << 5) | intdiv($g['seconds'], 2);
        $date = (max(0, $g['year'] - 1980) << 9) | ($g['mon'] << 5) | $g['mday'];
        return [$time, $date];
    }
}
