<?php
declare(strict_types=1);

namespace Kolam\Storage;

/** Any S3-compatible bucket, e.g. DigitalOcean Spaces. Signs requests with AWS Signature V4. */
final class S3Storage implements Storage
{
    public function __construct(private array $c) {}

    /** $objectKey is the full key inside the bucket (no implicit prefix). $query is appended unsigned-safe (e.g. for ListObjectsV2). */
    private function request(string $method, string $objectKey, ?string $file = null, string $mime = '', bool $stream = false, string $query = ''): array
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

        $url = rtrim($this->c['endpoint'], '/') . $path . ($query !== '' ? '?' . $query : '');
        $ch = curl_init($url);
        curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_HTTPHEADER => $h, CURLOPT_TIMEOUT => 120]);
        // a HEAD response has no body; without NOBODY curl waits for one until the timeout
        if ($method === 'HEAD') curl_setopt($ch, CURLOPT_NOBODY, true);
        if ($file) {
            $fh = fopen($file, 'rb');
            curl_setopt_array($ch, [CURLOPT_UPLOAD => true, CURLOPT_INFILE => $fh, CURLOPT_INFILESIZE => filesize($file)]);
        }
        if ($stream) {
            curl_setopt($ch, CURLOPT_WRITEFUNCTION, function ($ch, $chunk) { echo $chunk; return strlen($chunk); });
        } else {
            curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        }
        $body = curl_exec($ch);
        $code = (int) curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return [$code, $body];
    }

    public function put(string $key, string $tmpFile, string $mime): void
    {
        [$code] = $this->request('PUT', 'assets/' . $key, $tmpFile, $mime);
        @unlink($tmpFile);
        if ($code >= 300) throw new \RuntimeException("Upload to bucket failed ($code)");
    }

    public function output(string $key): bool
    {
        [$code] = $this->request('GET', 'assets/' . $key, null, '', true);
        return $code < 300;
    }

    public function delete(string $key): void { $this->request('DELETE', 'assets/' . $key); }
}
