<?php
declare(strict_types=1);

namespace Kolam;

/** Reads settings from the environment, with an optional .env file for convenience. */
final class Config
{
    private static array $v = [];

    public static function load(string $envFile): void
    {
        if (is_file($envFile)) {
            foreach (file($envFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES) as $line) {
                $line = trim($line);
                if ($line === '' || $line[0] === '#' || !str_contains($line, '=')) continue;
                [$k, $val] = array_map('trim', explode('=', $line, 2));
                $val = trim($val, "\"'");
                if (getenv($k) === false) putenv("$k=$val");
            }
        }
        $storage = self::env('STORAGE_PATH', NK_ROOT . '/storage');
        self::$v = [
            'env'           => self::env('APP_ENV', 'production'),
            'storage'       => rtrim($storage, '/'),
            'db_dsn'        => self::env('DB_DSN', 'sqlite:' . rtrim($storage, '/') . '/kolam.sqlite'),
            'db_user'       => self::env('DB_USER', null),
            'db_pass'       => self::env('DB_PASSWORD', null),
            'allow_signup'  => filter_var(self::env('ALLOW_SIGNUP', 'true'), FILTER_VALIDATE_BOOL),
            'session_days'  => (int) self::env('SESSION_DAYS', '30'),
            'max_upload_mb' => (int) self::env('MAX_UPLOAD_MB', '50'),
            'trust_proxy'   => filter_var(self::env('TRUST_PROXY', 'false'), FILTER_VALIDATE_BOOL),
            'legacy_import' => filter_var(self::env('LEGACY_IMPORT', 'true'), FILTER_VALIDATE_BOOL),
            'asset_driver'  => self::env('ASSET_DRIVER', 'local'),
            // browsers PUT straight to the bucket with presigned URLs instead of through PHP (needs asset_driver = s3)
            's3_direct_uploads' => filter_var(self::env('S3_DIRECT_UPLOADS', 'false'), FILTER_VALIDATE_BOOL),
            // local files: '' streams through PHP (works anywhere); 'x-accel' (Nginx) or 'x-sendfile' (Apache mod_xsendfile)
            // hands the bytes to the web server instead, see deploy/nginx.conf and deploy/apache.conf
            'asset_sendfile' => self::env('ASSET_SENDFILE', ''),
            's3'            => [
                'endpoint' => self::env('S3_ENDPOINT', ''),   // e.g. https://fra1.digitaloceanspaces.com
                'region'   => self::env('S3_REGION', 'us-east-1'),
                'bucket'   => self::env('S3_BUCKET', ''),
                'key'      => self::env('S3_KEY', ''),
                'secret'   => self::env('S3_SECRET', ''),
            ],
            'smtp'          => [
                'host'      => self::env('SMTP_HOST', ''),
                'port'      => (int) self::env('SMTP_PORT', '587'),
                'user'      => self::env('SMTP_USER', ''),
                'pass'      => self::env('SMTP_PASSWORD', ''),
                'secure'    => self::env('SMTP_SECURE', 'tls'), // tls = STARTTLS, ssl = implicit TLS (e.g. port 465), none
                'from'      => self::env('MAIL_FROM', ''),
                'from_name' => self::env('MAIL_FROM_NAME', 'Kolam'),
            ],
            // Public URL of the app, e.g. https://notes.example.com, used in email links; empty = derived from the request
            'app_url'       => self::env('APP_URL', ''),
            // Live updates: where browsers reach server/bin/realtime (e.g. wss://notes.example.com/ws); empty = ~1 s polling
            'realtime_url'    => self::env('REALTIME_URL', ''),
            // the address server/bin/realtime listens on (behind the web server's proxy)
            'realtime_listen' => self::env('REALTIME_LISTEN', '127.0.0.1:8090'),
            // hosted-service switches (all off by default)
            'email_verification' => filter_var(self::env('EMAIL_VERIFICATION', 'false'), FILTER_VALIDATE_BOOL),
            'block_disposable'   => filter_var(self::env('BLOCK_DISPOSABLE_EMAILS', 'false'), FILTER_VALIDATE_BOOL),
            'turnstile'          => ['site' => self::env('TURNSTILE_SITE_KEY', ''), 'secret' => self::env('TURNSTILE_SECRET', '')],
            'delete_grace_days'  => (int) self::env('DELETE_GRACE_DAYS', '14'),
            // public website (landing, terms, privacy, help); empty = the app links to none of them
            'site_url'           => rtrim((string) self::env('SITE_URL', ''), '/'),
            'support_email'      => self::env('SUPPORT_EMAIL', ''),
            // server alerts (errors) go here
            'alert_email'        => self::env('ALERT_EMAIL', ''),
            // the operator admin page (users, reports, feedback): comma-separated emails; empty = no admin page
            'admin_emails'       => array_values(array_filter(array_map(fn($e) => strtolower(trim($e)), explode(',', (string) self::env('ADMIN_EMAILS', ''))))),
            // Google Analytics for Firebase in the app: the web app's config from the Firebase console; empty = no analytics
            'firebase'           => [
                'apiKey'        => self::env('FIREBASE_API_KEY', ''),
                'projectId'     => self::env('FIREBASE_PROJECT_ID', ''),
                'appId'         => self::env('FIREBASE_APP_ID', ''),
                'measurementId' => self::env('FIREBASE_MEASUREMENT_ID', ''),
            ],
            // "Continue with Google" (OAuth client from Google Cloud console → APIs & Services → Credentials); empty = off
            'google'             => ['id' => self::env('GOOGLE_CLIENT_ID', ''), 'secret' => self::env('GOOGLE_CLIENT_SECRET', '')],
        ];
    }

    private static function env(string $k, ?string $default): ?string
    {
        $v = getenv($k);
        return $v === false || $v === '' ? $default : $v;
    }

    public static function get(string $k): mixed { return self::$v[$k] ?? null; }
    public static function dev(): bool { return self::$v['env'] === 'development'; }
}
