# Self-hosting

Everything you need to run Kolam on your own machine or server.

## Local development

Requirements: PHP 8.1+ with `pdo_sqlite` (or `pdo_mysql`), `curl`, `mbstring`, `fileinfo`. There is no build step and no Node/npm.

**XAMPP / any Apache with PHP:** put the folder in `htdocs` and open `http://localhost/kolam/`.
Edit files in `src/` and reload the page. Make `storage/` writable by Apache (`chmod 775 storage`, or `777` on a dev machine).
If you see *"attempt to write a readonly database"*, the database or its `-wal`/`-shm` files were created by a
different user than the web server (e.g. by running `sqlite3` or `server/bin/kolam` as yourself). Run the CLI
as the web server user (`sudo -u daemon …` on XAMPP, `sudo -u www-data …` on Ubuntu), or fix ownership of `storage/`.

**Without Apache:** `PHP_CLI_SERVER_WORKERS=4 php -S localhost:8080 server/router.php` from the project folder.

Copy `.env.example` to `.env` and set `APP_ENV=development` to see PHP error details.

**Database:** SQLite in `storage/` by default. For MySQL/MariaDB, create an empty database (collation `utf8mb4_bin`)
and set `DB_DSN`, `DB_USER`, `DB_PASSWORD` in `.env`. The tables are created on the first request.

The **first account** created on a server automatically imports boards from the old single-file version
(`data/state.json`), if that file exists.

---

## What to upload

The project folder is deployed as-is: the web server's document root is the project folder itself, and the
web server config blocks `server/`, `storage/`, `data/`, `deploy/` and dotfiles (`.env`). On Apache the included
`.htaccess` files do this; on nginx use the rules in `deploy/nginx.conf` (or the aaPanel rewrite below).

Upload everything except `storage/` and `.env` (those hold each machine's own database, uploads and settings).
After deploying, check that `https://your-domain/.env` and `https://your-domain/storage/` return 403/404.

---

## Deploying on an Ubuntu server (no Docker)

1. **Create a server** (Ubuntu 24.04; 1 GB RAM is plenty to start) and point a DNS A record (e.g. `notes.example.com`) at it.

2. **Install the stack:**

   ```bash
   sudo apt update && sudo apt install -y nginx php8.3-fpm php8.3-sqlite3 php8.3-curl php8.3-mbstring php8.3-xml certbot python3-certbot-nginx
   ```

   For MySQL or PostgreSQL also install `php8.3-mysql` or `php8.3-pgsql`.

3. **Upload the project** from your machine:

   ```bash
   rsync -av --delete --exclude storage --exclude .env --exclude data --exclude .git ./ root@YOUR_IP:/var/www/kolam/
   ```

   On the server:

   ```bash
   sudo mkdir -p /var/www/kolam/storage
   sudo chown -R www-data:www-data /var/www/kolam/storage
   sudo cp /var/www/kolam/.env.example /var/www/kolam/.env
   sudo nano /var/www/kolam/.env
   ```

   For a single server the defaults are fine (SQLite in `storage/`).

4. **Web server:** copy `deploy/nginx.conf` to `/etc/nginx/sites-available/kolam`, set `server_name`
   and the php-fpm socket, enable it, then add HTTPS:

   ```bash
   sudo ln -s /etc/nginx/sites-available/kolam /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   sudo certbot --nginx -d notes.example.com
   ```

   Copy `deploy/php.ini` to `/etc/php/8.3/fpm/conf.d/90-kolam.ini` and run `sudo systemctl restart php8.3-fpm`.
   Apache users: see `deploy/apache.conf`.

5. **Create your account** in the browser, then close sign-ups by setting `ALLOW_SIGNUP=false` in `.env`.
   You can still add people with:

   ```bash
   sudo -u www-data php server/bin/kolam user:create
   ```

6. **Backups & maintenance:** copy `deploy/kolam-cron` to `/etc/cron.d/kolam` for nightly SQLite
   backups in `storage/backups/`. Also enable your provider's server backups or snapshots.

**Updating:** rsync again with the same command. `storage/` and `.env` are excluded, so data is kept, and
database tables upgrade themselves automatically on the first request (other requests arriving meanwhile wait for
it to finish; you can also run `server/bin/kolam migrate` right after deploying).

## Deploying with aaPanel (MySQL)

1. **Website → Add site** for your domain, PHP 8.1 or newer. In *App Store → PHP → Install extensions* make sure
   `fileinfo` is installed (`pdo_mysql`, `curl`, `mbstring` are on by default).
2. **Databases → Add database:** name `kolam`, a user and a strong password. aaPanel creates it as
   `utf8mb4`; that's fine — Kolam creates its own tables with case-sensitive collation.
3. Upload the project folder (everything except `storage/` and `.env`) to the site folder
   (e.g. `/www/wwwroot/notes.example.com/`), so `index.html`, `src/`, `api/` and `server/` sit directly in it.
   Create an empty `storage/` folder there. Leave **Running directory** as `/` (the site root).
4. "Anti-XSS attack" (open_basedir) can stay on: everything lives inside the site folder.
5. **URL rewrite** (nginx). aaPanel's nginx ignores `.htaccess`, so these rules are what keep `.env`, the
   database and the PHP code private (the `.well-known` line lets Claude Code and Codex find the sign-in page):

   ```nginx
   location ^~ /api/.well-known/ { rewrite ^ /api/index.php last; }
   location ~ /\. { deny all; }
   location ~ ^/(server|storage|data|deploy)(/|$) { return 404; }
   location = /README.md { return 404; }
   location /api/ { try_files $uri /api/index.php?$query_string; }
   location ^~ /src/ { add_header Cache-Control "no-cache"; }
   ```

6. Copy `.env.example` to `.env` and set:

   ```
   APP_ENV=production
   DB_DSN=mysql:host=127.0.0.1;port=3306;dbname=kolam;charset=utf8mb4
   DB_USER=kolam
   DB_PASSWORD=the-password-from-step-2
   ```

7. Make `storage/` writable by PHP: `chown -R www:www storage` (aaPanel's PHP runs as `www`).
8. **SSL → Let's Encrypt**, then open the site and create your account. Set `ALLOW_SIGNUP=false` afterwards.
9. Backups: **Cron → Backup database** for `kolam`, plus **Backup site** (or just `storage/`) for uploaded files.

## Scaling up

| Need | Change |
|---|---|
| More traffic on one server | A larger server; PHP OPcache is already enabled by `deploy/php.ini`. |
| Several app servers behind a load balancer | Use a **managed MySQL/PostgreSQL** database (`DB_DSN`, `DB_USER`, `DB_PASSWORD`) and an **S3-compatible bucket** for uploads (`ASSET_DRIVER=s3`, `S3_*`). Sessions and rate limits already live in the database, so any server can handle any request. Set `TRUST_PROXY=true`. |
| A platform with a temporary disk | Possible with the same two changes: managed database + bucket. |

## Running a public instance

Everything below is optional and off by default — a self-hosted install with no `.env` changes ignores all of it.

**Error alerts.** Set `ALERT_EMAIL` to get an email on uncaught server errors (at most one per distinct error per
hour, and about 20 a day overall, so a recurring bug doesn't flood the inbox). Uses whatever `SMTP_*`/`MAIL_FROM` is
already configured; with no SMTP set up, alert emails land in `storage/mail/` like everything else.

**Uptime monitoring.** `GET /api/health` returns `{"ok":true,"db":"mysql","storage":true}` with HTTP 200, or
`{"ok":false,...}` with HTTP 503 when the database or the storage folder isn't reachable/writable. Point a monitor
(UptimeRobot, Better Stack, etc.) at `https://app.<yourdomain>/api/health` every 5 minutes, with a keyword check for
`"ok":true`, alerting to the same address as `ALERT_EMAIL`.

**Abuse reports.** Anyone viewing a public share link can use its "Report" link to flag it (spam, phishing, malware,
etc.), without an account. Reports email `ALERT_EMAIL` and `SUPPORT_EMAIL` and are stored in the `reports` table;
list or close them with `php server/bin/kolam reports` / `reports close <id>`.

**Admin page.** List operator emails in `ADMIN_EMAILS` (comma-separated, verified accounts only) and those accounts
get **Admin…** in the account menu: sign-ups and activity at a glance; accounts (search, mark verified, sign out
everywhere, suspend / unsuspend); reports (turn the reported link off, suspend its owner, mark handled); and feedback.
A suspended account can't sign in, its sessions and access keys are removed, and its share links stop working;
nothing is deleted. Every admin action is written to the PHP error log.

**Analytics.** Set `FIREBASE_API_KEY`, `FIREBASE_PROJECT_ID`, `FIREBASE_APP_ID` and `FIREBASE_MEASUREMENT_ID` (a
Firebase web app with Google Analytics) to log page views and a few product events: `sign_up`, `login`,
`board_created`, `card_created`, `invite_sent`, `share_link_created`, `ai_connected`, `onboarding_choice`,
`feedback_sent`, `data_export`. Events carry the account's id, never board names or content. The Firebase SDK is
loaded from Google's CDN only when these are set, and not at all for browsers sending Global Privacy Control or Do
Not Track. Visitors from the EU, EEA, UK and Switzerland (`Http::consentRequired()`, from Cloudflare's `CF-IPCountry`;
the browser's time zone when the country is unknown) get a cookie banner first, with equal Accept and Reject; analytics
only loads after Accept. The choice is kept in the browser's local storage (`kolam-consent`), and **Cookie settings** in
the app's ? menu reopens the banner; Reject turns collection off and removes the `_ga` cookies.
