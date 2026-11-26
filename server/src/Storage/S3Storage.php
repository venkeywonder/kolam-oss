<?php
declare(strict_types=1);

namespace Kolam\Storage;

/** Any S3-compatible bucket, e.g. DigitalOcean Spaces. Signs requests with AWS Signature V4. */
final class S3Storage implements Storage
{
    public function __construct(private array $c) {}

    /** $objectKey is the full key inside the bucket (no implicit prefix). $query is appended unsigned-safe (e.g. for ListObjectsV2).
     *  With $sink, the response body goes to it chunk by chunk instead of being returned. */
    private function request(string $method, string $objectKey, ?string $file = null, string $mime = '', ?\Closure $sink = null, string $query = '', ?string $range = null): array
    {
        $host = parse_url($this->c['endpoint'], PHP_URL_HOST);
        $path = '/' . $this->c['bucket'] . ($objectKey === '' ? '' : '/' . implode('/', array_map('rawurlencode', explode('/', $objectKey))));
        $now = gmdate('Ymd\THis\Z'); $day = substr($now, 0, 8);
        $hash = $file ? hash_file('sha256', $file) : hash('sha256', '');
        $headers = ['host' => $host, 'x-amz-content-sha256' => $hash, 'x-amz-date' => $now];
        if ($mime) $headers['content-type'] = $mime;
        ksort($headers);
        $canonH = ''; foreach ($headers as $k => $v) $canonH .= "$k:$v\n";
        $signed = implode(';', array_keys($headers));
        $creq = "$method\n$path\n$query\n$canonH\n$signed\n$hash";
        $scope = "$day/{$this->c['region']}/s3/aws4_request";
        $sts = "AWS4-HMAC-SHA256\n$now\n$scope\n" . hash('sha256', $creq);
        $k = hash_hmac('sha256', $day, 'AWS4' . $this->c['secret'], true);
        foreach ([$this->c['region'], 's3', 'aws4_request'] as $part) $k = hash_hmac('sha256', $part, $k, true);
        $sig = hash_hmac('sha256', $sts, $k);
        $h = ["Authorization: AWS4-HMAC-SHA256 Credential={$this->c['key']}/$scope, SignedHeaders=$signed, Signature=$sig"];
        foreach ($headers as $k2 => $v) if ($k2 !== 'host') $h[] = "$k2: $v";
        // Range doesn't need to be signed: S3 only requires the headers named in SignedHeaders to match
        if ($range !== null) $h[] = "Range: $range";

        $url = rtrim($this->c['endpoint'], '/') . $path . ($query !== '' ? '?' . $query : '');
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $h, CURLOPT_TIMEOUT => 120]);
        // a HEAD response has no body; without NOBODY curl waits for one until the timeout
        if ($method === 'HEAD') curl_setopt($ch, CURLOPT_NOBODY, true);
        if ($file) {
            $fh = fopen($file, 'rb');
            curl_setopt_array($ch, [CURLOPT_UPLOAD => true, CURLOPT_INFILE => $fh, CURLOPT_INFILESIZE => filesize($file)]);
        }
        if ($sink) {
            // an error response's body (S3's XML) never reaches the sink
            curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) use ($sink) {
                if (curl_getinfo($ch, CURLINFO_RESPONSE_CODE) < 300) $sink($chunk);
                return strlen($chunk);
            });
        } else {
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        }
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        $len = (int) curl_getinfo($ch, CURLINFO_CONTENT_LENGTH_DOWNLOAD);
        curl_close($ch);
        return [$code, $body, $len];
    }

    /** The object's size, or null when it doesn't exist (completing a direct-to-S3 upload verifies this against what was declared). */
    public function headSize(string $key): ?int
    {
        [$code, , $len] = $this->request('HEAD', 'assets/' . $key);
        return $code === 200 ? $len : null;
    }

    /** First $max bytes of an object, to sniff its mime after a direct-to-S3 upload (never the whole, possibly huge, original). */
    public function readRange(string $key, int $max): ?string
    {
        [$code, $body] = $this->request('GET', 'assets/' . $key, null, '', null, '', 'bytes=0-' . ($max - 1));
        return $code < 300 ? $body : null;
    }

    /** Sets the bucket's CORS rules (server/bin/kolam s3-cors), so direct browser uploads can PUT and GET across origins. */
    public function putCors(string $xml): void
    {
        $tmp = tempnam(sys_get_temp_dir(), 's3cors');
        file_put_contents($tmp, $xml);
        [$code, $body] = $this->request('PUT', '', $tmp, 'application/xml', null, 'cors=');
        @unlink($tmp);
        if ($code >= 300) throw new \RuntimeException("Could not set bucket CORS ($code): " . substr((string) $body, 0, 300));
    }

    public function put(string $key, string $tmpFile, string $mime): void
    {
        [$code] = $this->request('PUT', 'assets/' . $key, $tmpFile, $mime);
        @unlink($tmpFile);
        if ($code >= 300) throw new \RuntimeException("Upload to bucket failed ($code)");
    }

    public function output(string $key): bool
    {
        return $this->read($key, function (string $chunk): void { echo $chunk; });
    }

    public function read(string $key, \Closure $sink): bool
    {
        [$code] = $this->request('GET', 'assets/' . $key, null, '', $sink);
        return $code < 300;
    }

    public function delete(string $key): void { $this->request('DELETE', 'assets/' . $key); }

    /** Query-string (presigned) SigV4, for URLs the browser uses directly: no Authorization header, so no server round-trip. */
    private function presign(string $method, string $objectKey, int $expires, array $extraQuery = [], ?int $at = null): string
    {
        $host = parse_url($this->c['endpoint'], PHP_URL_HOST);
        $path = '/' . $this->c['bucket'] . '/' . implode('/', array_map('rawurlencode', explode('/', $objectKey)));
        $now = gmdate('Ymd\THis\Z', $at ?? time()); $day = substr($now, 0, 8);
        $scope = "$day/{$this->c['region']}/s3/aws4_request";
        $query = $extraQuery + [
            'X-Amz-Algorithm' => 'AWS4-HMAC-SHA256',
            'X-Amz-Credential' => "{$this->c['key']}/$scope",
            'X-Amz-Date' => $now,
            'X-Amz-Expires' => (string) $expires,
            'X-Amz-SignedHeaders' => 'host',
        ];
        ksort($query);
        $canonQuery = implode('&', array_map(fn($k, $v) => rawurlencode($k) . '=' . rawurlencode($v), array_keys($query), $query));
        $creq = "$method\n$path\n$canonQuery\nhost:$host\n\nhost\nUNSIGNED-PAYLOAD";
        $sts = "AWS4-HMAC-SHA256\n$now\n$scope\n" . hash('sha256', $creq);
        $k = hash_hmac('sha256', $day, 'AWS4' . $this->c['secret'], true);
        foreach ([$this->c['region'], 's3', 'aws4_request'] as $part) $k = hash_hmac('sha256', $part, $k, true);
        $sig = hash_hmac('sha256', $sts, $k);
        return rtrim($this->c['endpoint'], '/') . $path . '?' . $canonQuery . '&X-Amz-Signature=' . $sig;
    }

    /** A direct PUT URL for the browser (whole object, or one multipart part when $uploadId/$partNumber are given). */
    public function presignPut(string $key, int $expires = 3600, ?string $uploadId = null, ?int $partNumber = null): string
    {
        $q = $uploadId !== null ? ['partNumber' => (string) $partNumber, 'uploadId' => $uploadId] : [];
        return $this->presign('PUT', 'assets/' . $key, $expires, $q);
    }

    /** A direct GET URL for the browser, overriding how it's served (inline vs attachment, tier's mime, caching). Pinned to
     *  the start of the current UTC day (not wall-clock time), so repeated requests the same day sign the same URL and
     *  the browser's own HTTP cache can reuse it instead of re-fetching through a fresh redirect every time. */
    public function presignGet(string $key, int $expires, array $overrides = []): string
    {
        $q = [];
        foreach ($overrides as $ok => $ov) if ($ov !== null) $q["response-$ok"] = $ov;
        return $this->presign('GET', 'assets/' . $key, $expires, $q, strtotime(gmdate('Y-m-d') . ' 00:00:00 UTC'));
    }

    public function createMultipartUpload(string $key, string $mime): string
    {
        [$code, $body] = $this->request('POST', 'assets/' . $key, null, $mime, null, 'uploads=');
        if ($code >= 300) throw new \RuntimeException("Could not start multipart upload ($code)");
        if (!preg_match('~<UploadId>([^<]+)</UploadId>~', (string) $body, $m)) throw new \RuntimeException('No UploadId in response');
        return $m[1];
    }

    /** $parts: [['n' => partNumber, 'etag' => the ETag the browser's PUT response returned], ...], any order. */
    public function completeMultipartUpload(string $key, string $uploadId, array $parts): void
    {
        usort($parts, fn($a, $b) => $a['n'] <=> $b['n']);
        $xml = '<CompleteMultipartUpload>';
        foreach ($parts as $p) $xml .= '<Part><PartNumber>' . (int) $p['n'] . '</PartNumber><ETag>' . htmlspecialchars((string) $p['etag'], ENT_XML1) . '</ETag></Part>';
        $xml .= '</CompleteMultipartUpload>';
        $tmp = tempnam(sys_get_temp_dir(), 's3c');
        file_put_contents($tmp, $xml);
        [$code, $body] = $this->request('POST', 'assets/' . $key, $tmp, 'application/xml', null, 'uploadId=' . rawurlencode($uploadId));
        @unlink($tmp);
        if ($code >= 300) throw new \RuntimeException("Could not complete multipart upload ($code): " . substr((string) $body, 0, 300));
    }

    public function abortMultipartUpload(string $key, string $uploadId): void
    {
        $this->request('DELETE', 'assets/' . $key, null, '', null, 'uploadId=' . rawurlencode($uploadId));
    }

    /** Parts S3 has received for an in-progress multipart upload, so a dropped connection can resume. */
    public function listParts(string $key, string $uploadId): array
    {
        [$code, $body] = $this->request('GET', 'assets/' . $key, null, '', null, 'uploadId=' . rawurlencode($uploadId));
        if ($code >= 300) return [];
        $xml = @simplexml_load_string((string) $body);
        if (!$xml) return [];
        $out = [];
        foreach ($xml->Part ?? [] as $p) $out[] = ['n' => (int) $p->PartNumber, 'etag' => trim((string) $p->ETag, '"'), 'size' => (int) $p->Size];
        return $out;
    }
}
