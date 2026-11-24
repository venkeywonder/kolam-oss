<?php
declare(strict_types=1);

namespace Kolam;

use PDO;

/** Thin PDO wrapper that works with SQLite, MySQL/MariaDB and PostgreSQL. */
final class Db
{
    private static ?PDO $pdo = null;
    public static string $driver = 'sqlite';

    public static function pdo(): PDO
    {
        if (self::$pdo) return self::$pdo;
        $dsn = (string) Config::get('db_dsn');
        if (str_starts_with($dsn, 'sqlite:')) {
            $dir = dirname(substr($dsn, 7));
            if (!is_dir($dir)) @mkdir($dir, 0775, true);
        }
        $pdo = new PDO($dsn, Config::get('db_user'), Config::get('db_pass'), [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
            PDO::ATTR_EMULATE_PREPARES => false,
        ]);
        self::$driver = $pdo->getAttribute(PDO::ATTR_DRIVER_NAME);
        if (self::$driver === 'sqlite') {
            $pdo->exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
        } elseif (self::$driver === 'mysql') {
            $pdo->exec("SET NAMES utf8mb4");
        }
        self::$pdo = $pdo;
        self::migrate();
        return $pdo;
    }

    public static function q(string $sql, array $args = []): \PDOStatement
    {
        $st = self::pdo()->prepare($sql);
        $st->execute($args);
        return $st;
    }

    public static function one(string $sql, array $args = []): ?array
    {
        $r = self::q($sql, $args)->fetch();
        return $r === false ? null : $r;
    }

    /** Runs $fn in a transaction; nested calls join the outer one. */
    public static function tx(callable $fn): mixed
    {
        $pdo = self::pdo();
        if ($pdo->inTransaction()) return $fn();
        $pdo->beginTransaction();
        try { $r = $fn(); $pdo->commit(); return $r; }
        catch (\Throwable $e) { $pdo->rollBack(); throw $e; }
    }

    /** INSERT ... or UPDATE on primary-key conflict, portable across drivers. */
    public static function upsert(string $table, array $row, array $keys): void
    {
        $cols = array_keys($row);
        $ph = implode(',', array_fill(0, count($cols), '?'));
        $upd = array_values(array_diff($cols, $keys));
        if (self::$driver === 'mysql') {
            $set = implode(',', array_map(fn($c) => "$c=VALUES($c)", $upd));
            $sql = "INSERT INTO $table (" . implode(',', $cols) . ") VALUES ($ph) ON DUPLICATE KEY UPDATE $set";
        } else {
            $set = implode(',', array_map(fn($c) => "$c=excluded.$c", $upd));
            $sql = "INSERT INTO $table (" . implode(',', $cols) . ") VALUES ($ph) ON CONFLICT (" . implode(',', $keys) . ") DO UPDATE SET $set";
        }
        self::q($sql, array_values($row));
    }

    private static function migrate(): void
    {
        $pdo = self::$pdo;
        $mysql = self::$driver === 'mysql';
        $big = $mysql ? 'LONGTEXT' : 'TEXT';
        // MySQL compares text case-insensitively by default; ids and tokens are case-sensitive, so use binary collation
        $opts = $mysql ? ' ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin' : '';
        $pdo->exec('CREATE TABLE IF NOT EXISTS nk_meta (k VARCHAR(64) PRIMARY KEY, v VARCHAR(255))' . $opts);
        $steps = [
            1 => [
                "CREATE TABLE users (id VARCHAR(32) PRIMARY KEY, email VARCHAR(255) NOT NULL UNIQUE, name VARCHAR(120) NOT NULL,
                  pass_hash VARCHAR(255) NOT NULL, rev BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL)",
                "CREATE TABLE sessions (token_hash CHAR(64) PRIMARY KEY, user_id VARCHAR(32) NOT NULL, expires_at BIGINT NOT NULL,
                  created_at BIGINT NOT NULL, ua VARCHAR(255))",
                "CREATE INDEX sessions_user ON sessions (user_id)",
                "CREATE TABLE entities (user_id VARCHAR(32) NOT NULL, kind VARCHAR(16) NOT NULL, id VARCHAR(64) NOT NULL,
                  parent VARCHAR(64), data $big, rev BIGINT NOT NULL, deleted SMALLINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL,
                  PRIMARY KEY (user_id, kind, id))",
                "CREATE INDEX entities_rev ON entities (user_id, rev)",
                "CREATE INDEX entities_parent ON entities (user_id, kind, parent)",
                "CREATE TABLE assets (id VARCHAR(48) PRIMARY KEY, user_id VARCHAR(32) NOT NULL, mime VARCHAR(120) NOT NULL,
                  size BIGINT NOT NULL, name VARCHAR(255), created_at BIGINT NOT NULL)",
                "CREATE INDEX assets_user ON assets (user_id)",
                "CREATE TABLE shares (token CHAR(24) PRIMARY KEY, user_id VARCHAR(32) NOT NULL, board_id VARCHAR(64) NOT NULL, created_at BIGINT NOT NULL)",
                "CREATE INDEX shares_board ON shares (user_id, board_id)",
                "CREATE TABLE rate_limits (k VARCHAR(160) PRIMARY KEY, hits INT NOT NULL, reset_at BIGINT NOT NULL)",
            ],
            2 => [
                "CREATE TABLE api_tokens (token_hash CHAR(64) PRIMARY KEY, user_id VARCHAR(32) NOT NULL, name VARCHAR(120) NOT NULL,
                  created_at BIGINT NOT NULL, last_used_at BIGINT)",
                "CREATE INDEX api_tokens_user ON api_tokens (user_id)",
                "CREATE TABLE ai_bridges (user_id VARCHAR(32) PRIMARY KEY, agents VARCHAR(64) NOT NULL, seen_at BIGINT NOT NULL)",
                "CREATE TABLE ai_chats (id VARCHAR(32) PRIMARY KEY, user_id VARCHAR(32) NOT NULL, agent VARCHAR(16) NOT NULL,
                  session_id VARCHAR(128), ver BIGINT NOT NULL DEFAULT 0, created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)",
                "CREATE INDEX ai_chats_user ON ai_chats (user_id, updated_at)",
                "CREATE TABLE ai_messages (id VARCHAR(32) PRIMARY KEY, chat_id VARCHAR(32) NOT NULL, user_id VARCHAR(32) NOT NULL,
                  role VARCHAR(16) NOT NULL, status VARCHAR(16) NOT NULL, prompt $big, content $big, board VARCHAR(64),
                  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL)",
                "CREATE INDEX ai_messages_chat ON ai_messages (chat_id, created_at)",
                "CREATE INDEX ai_messages_status ON ai_messages (user_id, status, created_at)",
            ],
            // "Sign in with Kolam" for MCP clients (OAuth) and browser linking for the AI bridge (device flow)
            3 => [
                "ALTER TABLE api_tokens ADD COLUMN kind VARCHAR(16) NOT NULL DEFAULT 'key'",
                "CREATE TABLE oauth_clients (id VARCHAR(48) PRIMARY KEY, name VARCHAR(120) NOT NULL, redirect_uris TEXT NOT NULL,
                  created_at BIGINT NOT NULL)",
                "CREATE TABLE oauth_codes (code_hash CHAR(64) PRIMARY KEY, kind VARCHAR(8) NOT NULL, client_id VARCHAR(48) NOT NULL,
                  user_id VARCHAR(32), user_code VARCHAR(16), redirect_uri TEXT, challenge VARCHAR(128), name VARCHAR(120) NOT NULL,
                  status VARCHAR(16) NOT NULL, expires_at BIGINT NOT NULL)",
                "CREATE INDEX oauth_codes_user_code ON oauth_codes (user_code)",
            ],
            // which provider account each CLI on the bridge is signed in to ("Max plan · ann@example.com")
            4 => [
                "ALTER TABLE ai_bridges ADD COLUMN accounts TEXT",
            ],
            // the AI worker (server/bin/ai-worker) replaces the per-user terminal bridge: one row, written by the worker,
            // plus the sign-in / restart requests the AI panel leaves for it
            5 => [
                "DROP TABLE ai_bridges",
                "DELETE FROM api_tokens WHERE kind = 'bridge'",
                "CREATE TABLE ai_worker (id VARCHAR(16) PRIMARY KEY, seen_at BIGINT NOT NULL, status TEXT, login_req TEXT, login TEXT)",
            ],
            // providers the owner disconnected from Kolam (a JSON list), while the CLI may stay signed in on the machine
            6 => [
                "ALTER TABLE ai_worker ADD COLUMN disabled TEXT",
            ],
            // collaboration: records belong to a space (a person's own boards, or a team workspace) instead of a user,
            // and people get access to a whole workspace or to single boards (and the boards inside them)
            7 => [
                "CREATE TABLE spaces (id VARCHAR(32) PRIMARY KEY, kind VARCHAR(12) NOT NULL, name VARCHAR(120) NOT NULL,
                  owner_id VARCHAR(32) NOT NULL, rev BIGINT NOT NULL DEFAULT 0, acl_rev BIGINT NOT NULL DEFAULT 0,
                  created_at BIGINT NOT NULL, deleted_at BIGINT)",
                "CREATE INDEX spaces_owner ON spaces (owner_id)",
                "INSERT INTO spaces (id, kind, name, owner_id, rev, acl_rev, created_at)
                  SELECT id, 'personal', name, id, rev, 0, created_at FROM users",
                "CREATE TABLE space_members (space_id VARCHAR(32) NOT NULL, user_id VARCHAR(32) NOT NULL, role VARCHAR(12) NOT NULL,
                  created_at BIGINT NOT NULL, left_at BIGINT, PRIMARY KEY (space_id, user_id))",
                "CREATE INDEX space_members_user ON space_members (user_id)",
                "CREATE TABLE board_members (space_id VARCHAR(32) NOT NULL, board_id VARCHAR(64) NOT NULL, user_id VARCHAR(32) NOT NULL,
                  role VARCHAR(12) NOT NULL, created_at BIGINT NOT NULL, left_at BIGINT, PRIMARY KEY (space_id, board_id, user_id))",
                "CREATE INDEX board_members_user ON board_members (user_id)",
                "CREATE TABLE board_access (space_id VARCHAR(32) NOT NULL, board_id VARCHAR(64) NOT NULL, restricted SMALLINT NOT NULL DEFAULT 0,
                  PRIMARY KEY (space_id, board_id))",
                "CREATE TABLE invites (id VARCHAR(24) PRIMARY KEY, token_hash CHAR(64) NOT NULL, space_id VARCHAR(32) NOT NULL,
                  board_id VARCHAR(64), email VARCHAR(255) NOT NULL, role VARCHAR(12) NOT NULL, invited_by VARCHAR(32) NOT NULL,
                  status VARCHAR(12) NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL, user_id VARCHAR(32))",
                "CREATE INDEX invites_token ON invites (token_hash)",
                "CREATE INDEX invites_email ON invites (email, status)",
                "CREATE INDEX invites_space ON invites (space_id, status)",
                "CREATE TABLE entities_v7 (space_id VARCHAR(32) NOT NULL, kind VARCHAR(16) NOT NULL, id VARCHAR(64) NOT NULL,
                  parent VARCHAR(64), data $big, rev BIGINT NOT NULL, deleted SMALLINT NOT NULL DEFAULT 0, updated_at BIGINT NOT NULL,
                  created_by VARCHAR(32), updated_by VARCHAR(32), PRIMARY KEY (space_id, kind, id))",
                "INSERT INTO entities_v7 (space_id, kind, id, parent, data, rev, deleted, updated_at, created_by, updated_by)
                  SELECT user_id, kind, id, parent, data, rev, deleted, updated_at, user_id, user_id FROM entities",
                "DROP TABLE entities",
                "ALTER TABLE entities_v7 RENAME TO entities",
                "CREATE INDEX entities_rev ON entities (space_id, rev)",
                "CREATE INDEX entities_parent ON entities (space_id, kind, parent)",
                "CREATE INDEX entities_creator ON entities (space_id, created_by)",
                "ALTER TABLE shares ADD COLUMN space_id VARCHAR(32)",
                "UPDATE shares SET space_id = user_id",
            ],
            // who has a space open right now (browser tabs, via the realtime server or polling), for avatars and "X is editing"
            8 => [
                "CREATE TABLE presence (space_id VARCHAR(32) NOT NULL, client VARCHAR(24) NOT NULL, user_id VARCHAR(32) NOT NULL,
                  board VARCHAR(64), editing VARCHAR(64), seen_at BIGINT NOT NULL, PRIMARY KEY (space_id, client))",
                "CREATE INDEX presence_seen ON presence (seen_at)",
            ],
            // text merging: the Yjs log of each card's rich text (updates, plain-text writes, snapshots), numbered per card
            9 => [
                "CREATE TABLE ylog (space_id VARCHAR(32) NOT NULL, item_id VARCHAR(64) NOT NULL, n INT NOT NULL, kind CHAR(1) NOT NULL,
                  data $big NOT NULL, user_id VARCHAR(32), at BIGINT NOT NULL, PRIMARY KEY (space_id, item_id, n))",
            ],
            // comments on cards (one thread per card, resolved or open), reactions, and in-app notifications
            10 => [
                "CREATE TABLE comments (id VARCHAR(24) PRIMARY KEY, space_id VARCHAR(32) NOT NULL, item_id VARCHAR(64) NOT NULL,
                  author_id VARCHAR(32), author_name VARCHAR(120) NOT NULL, body TEXT NOT NULL, created_at BIGINT NOT NULL,
                  edited_at BIGINT, deleted SMALLINT NOT NULL DEFAULT 0, rev BIGINT NOT NULL)",
                "CREATE INDEX comments_rev ON comments (space_id, rev)",
                "CREATE INDEX comments_item ON comments (space_id, item_id)",
                "CREATE TABLE comment_reactions (comment_id VARCHAR(24) NOT NULL, who VARCHAR(32) NOT NULL, emoji VARCHAR(16) NOT NULL,
                  at BIGINT NOT NULL, PRIMARY KEY (comment_id, who, emoji))",
                "CREATE TABLE comment_threads (space_id VARCHAR(32) NOT NULL, item_id VARCHAR(64) NOT NULL, resolved_at BIGINT,
                  resolved_by VARCHAR(32), rev BIGINT NOT NULL, PRIMARY KEY (space_id, item_id))",
                "CREATE INDEX comment_threads_rev ON comment_threads (space_id, rev)",
                "CREATE TABLE notifications (id VARCHAR(24) PRIMARY KEY, user_id VARCHAR(32) NOT NULL, kind VARCHAR(12) NOT NULL,
                  space_id VARCHAR(32), board_id VARCHAR(64), item_id VARCHAR(64), ref VARCHAR(24), actor_id VARCHAR(32),
                  text VARCHAR(400) NOT NULL, created_at BIGINT NOT NULL, read_at BIGINT)",
                "CREATE INDEX notifications_user ON notifications (user_id, created_at)",
                "ALTER TABLE users ADD COLUMN notify_off VARCHAR(64)",
                // replies stored inside comment cards become comments
                fn() => Comments::migrateThreads(),
            ],
            // history (who changed which card or board, and what it was before) and link options: several labelled links
            // per board (view, comment without an account, join with one) with expiry and password; comments by link guests
            11 => [
                "CREATE TABLE history (id VARCHAR(24) PRIMARY KEY, space_id VARCHAR(32) NOT NULL, kind VARCHAR(16) NOT NULL,
                  entity_id VARCHAR(64) NOT NULL, board_id VARCHAR(64), user_id VARCHAR(32), act VARCHAR(12) NOT NULL,
                  fields VARCHAR(400) NOT NULL DEFAULT '', type VARCHAR(16), label VARCHAR(200) NOT NULL DEFAULT '',
                  n INT NOT NULL DEFAULT 1, prev $big, started_at BIGINT NOT NULL, at BIGINT NOT NULL)",
                "CREATE INDEX history_entity ON history (space_id, entity_id, at)",
                "CREATE INDEX history_board ON history (space_id, board_id, at)",
                "CREATE INDEX history_at ON history (at)",
                "ALTER TABLE shares ADD COLUMN kind VARCHAR(12) NOT NULL DEFAULT 'view'",
                "ALTER TABLE shares ADD COLUMN role VARCHAR(12)",
                "ALTER TABLE shares ADD COLUMN label VARCHAR(120)",
                "ALTER TABLE shares ADD COLUMN expires_at BIGINT",
                "ALTER TABLE shares ADD COLUMN pass_hash VARCHAR(255)",
                "ALTER TABLE shares ADD COLUMN uses INT NOT NULL DEFAULT 0",
                "ALTER TABLE comments ADD COLUMN anon VARCHAR(96)",
                "ALTER TABLE notifications ADD COLUMN actor_name VARCHAR(120)",
            ],
            // everyone connects their own Claude / ChatGPT account (the worker keeps each sign-in in its own folder) instead of
            // the whole server sharing the owner's: the server-wide sign-in is no longer used, so replies waiting for it are
            // cancelled and its conversations start afresh
            12 => [
                "CREATE TABLE ai_accounts (user_id VARCHAR(32) NOT NULL, agent VARCHAR(16) NOT NULL, signed_in SMALLINT NOT NULL DEFAULT 0,
                  account VARCHAR(255), req TEXT, login TEXT, updated_at BIGINT NOT NULL, PRIMARY KEY (user_id, agent))",
                "ALTER TABLE ai_worker DROP COLUMN login_req",
                "ALTER TABLE ai_worker DROP COLUMN login",
                "ALTER TABLE ai_worker DROP COLUMN disabled",
                "UPDATE ai_messages SET status = 'cancelled', prompt = NULL WHERE status IN ('pending', 'running', 'cancelling')",
                "UPDATE ai_chats SET session_id = NULL",
            ],
            // each person's styles for new elements (Styles.php)
            13 => [
                "ALTER TABLE users ADD COLUMN styles TEXT",
            ],
            // verified email, scheduled account deletion, first-run state; one-time email links
            // (verify / reset), abuse reports on share links, and feedback from the app
            14 => [
                "ALTER TABLE users ADD COLUMN email_verified_at BIGINT",
                "ALTER TABLE users ADD COLUMN delete_at BIGINT",
                "ALTER TABLE users ADD COLUMN onboarding TEXT",
                // accounts made before verification existed count as verified
                "UPDATE users SET email_verified_at = created_at",
                "CREATE TABLE email_tokens (token_hash CHAR(64) PRIMARY KEY, user_id VARCHAR(32) NOT NULL, kind VARCHAR(12) NOT NULL,
                  email VARCHAR(255) NOT NULL, created_at BIGINT NOT NULL, expires_at BIGINT NOT NULL)",
                "CREATE INDEX email_tokens_user ON email_tokens (user_id, kind)",
                "CREATE TABLE reports (id VARCHAR(24) PRIMARY KEY, share_token CHAR(24) NOT NULL, space_id VARCHAR(32), board_id VARCHAR(64),
                  reason VARCHAR(32) NOT NULL, details TEXT, email VARCHAR(255), ip VARCHAR(64), status VARCHAR(12) NOT NULL DEFAULT 'open',
                  created_at BIGINT NOT NULL)",
                "CREATE INDEX reports_status ON reports (status, created_at)",
                "CREATE TABLE feedback (id VARCHAR(24) PRIMARY KEY, user_id VARCHAR(32), email VARCHAR(255), kind VARCHAR(16) NOT NULL,
                  body TEXT NOT NULL, page VARCHAR(500), ua VARCHAR(255), created_at BIGINT NOT NULL)",
                "CREATE INDEX feedback_at ON feedback (created_at)",
            ],
            // signed-in devices (last seen, address) for "sign out other devices"; when each account was last active and
            // whether the operator suspended it (admin page)
            15 => [
                "ALTER TABLE sessions ADD COLUMN seen_at BIGINT",
                "ALTER TABLE sessions ADD COLUMN ip VARCHAR(64)",
                "UPDATE sessions SET seen_at = created_at",
                "ALTER TABLE users ADD COLUMN seen_at BIGINT",
                "ALTER TABLE users ADD COLUMN suspended_at BIGINT",
            ],
            // the AI chat is gone (people use Kolam from their own Claude Code / Codex over MCP): its tables, and the
            // Claude / ChatGPT sign-ins the old AI worker kept on this server
            16 => [
                "DROP TABLE IF EXISTS ai_messages",
                "DROP TABLE IF EXISTS ai_chats",
                "DROP TABLE IF EXISTS ai_accounts",
                "DROP TABLE IF EXISTS ai_worker",
                function () {
                    foreach (['ai', 'ai-workspace'] as $sub) {
                        $dir = Config::get('storage') . '/' . $sub;
                        if (!is_dir($dir)) continue;
                        $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($dir, \FilesystemIterator::SKIP_DOTS), \RecursiveIteratorIterator::CHILD_FIRST);
                        foreach ($it as $f) $f->isDir() && !$f->isLink() ? @rmdir($f->getPathname()) : @unlink($f->getPathname());
                        @rmdir($dir);
                    }
                },
            ],
            // each upload records the space it went into (older files count towards the uploader's own boards)
            17 => [
                "ALTER TABLE assets ADD COLUMN space_id VARCHAR(32)",
                "UPDATE assets SET space_id = user_id",
                "CREATE INDEX assets_user_space ON assets (user_id, space_id)",
            ],
            // "Continue with Google": the Google account (its stable subject id and address) linked to each account, and
            // sign-ins in progress (hashed state, PKCE verifier, nonce). Accounts made with Google have pass_hash '' (no password).
            18 => [
                "ALTER TABLE users ADD COLUMN google_sub VARCHAR(255)",
                "ALTER TABLE users ADD COLUMN google_email VARCHAR(255)",
                "CREATE UNIQUE INDEX users_google ON users (google_sub)",
                "CREATE TABLE google_flows (state_hash CHAR(64) PRIMARY KEY, verifier VARCHAR(128) NOT NULL, nonce VARCHAR(64) NOT NULL,
                  intent TEXT NOT NULL, expires_at BIGINT NOT NULL)",
            ],
            // favorite tools on the floating bar at the bottom of the board (Favorites.php), JSON; NULL until changed
            19 => [
                "ALTER TABLE users ADD COLUMN favorites TEXT",
            ],
            // one workspace for everyone: each person's own boards become their home workspace (see Spaces::migratePersonal)
            20 => [
                fn() => Spaces::migratePersonal(),
            ],
        ];
        // Most requests find the schema current. Otherwise one request migrates while the others wait for it, then
        // read the version again (two requests running the same step would fail on "table already exists").
        $current = fn() => (int) (self::one("SELECT v FROM nk_meta WHERE k='schema'")['v'] ?? 0);
        if ($current() >= max(array_keys($steps))) return;
        $unlock = self::lock();
        try {
            $ver = $current();
            foreach ($steps as $n => $sqls) {
                if ($n <= $ver) continue;
                foreach ($sqls as $sql) {
                    if ($sql instanceof \Closure) $sql();
                    else $pdo->exec(str_starts_with($sql, 'CREATE TABLE') ? $sql . $opts : $sql);
                }
                self::upsert('nk_meta', ['k' => 'schema', 'v' => (string) $n], ['k']);
            }
        } finally {
            $unlock();
        }
    }

    /** Takes the migration lock (shared by every PHP process using this database); returns the function that releases it. */
    private static function lock(): \Closure
    {
        $pdo = self::$pdo;
        if (self::$driver === 'mysql') {
            if ((int) $pdo->query("SELECT GET_LOCK('kolam-migrate', 300)")->fetchColumn() !== 1) {
                throw new \RuntimeException('Timed out waiting for another request to update the database');
            }
            return fn() => $pdo->query("SELECT RELEASE_LOCK('kolam-migrate')");
        }
        if (self::$driver === 'pgsql') {
            $pdo->exec('SELECT pg_advisory_lock(735100711)');
            return fn() => $pdo->exec('SELECT pg_advisory_unlock(735100711)');
        }
        // SQLite: a lock file next to the database file
        $path = substr((string) Config::get('db_dsn'), 7) . '.migrate-lock';
        $fh = fopen($path, 'c');
        if ($fh === false || !flock($fh, LOCK_EX)) throw new \RuntimeException("Can't lock $path to update the database");
        return function () use ($fh) { flock($fh, LOCK_UN); fclose($fh); };
    }
}
