# Kolam

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
[![Check](https://github.com/venkeywonder/kolam-oss/actions/workflows/check.yml/badge.svg)](https://github.com/venkeywonder/kolam-oss/actions/workflows/check.yml)

A self-hosted visual workspace for notes, to-dos, links, images, files, boards, columns, tables, documents, sketches and freehand drawing — on an infinite canvas, with accounts, sync across devices, team workspaces, boards shared with people, comments, activity and version history, and share links (view, comment or join). Claude Code and Codex can read and change your boards over MCP.

- **Frontend:** plain JavaScript ES modules + CSS, no framework and no build step. The browser loads `src/` directly.
- **Backend:** PHP 8.1+ with PDO. SQLite by default, or MySQL/MariaDB/PostgreSQL. Uploads on local disk or any S3-compatible bucket.

Don't want to host it yourself? [trykolam.com](https://trykolam.com) runs it for you.

## Quick start

```bash
git clone https://github.com/venkeywonder/kolam-oss.git kolam && cd kolam
cp .env.example .env              # SQLite in storage/ by default; set APP_ENV=development for error details
PHP_CLI_SERVER_WORKERS=4 php -S localhost:8080 server/router.php
```

Open <http://localhost:8080> and create your account (the first one on a server can always sign up). Then set
`ALLOW_SIGNUP=false` in `.env` if you don't want strangers to join. For production, see [Deploying](#deploying-on-an-ubuntu-server-no-docker).

---

## Project structure

```
index.html              app shell (loads src/main.js as an ES module)
favicon.svg
src/
  main.js               boot: sign-in → load → render, wires every module's init()
  core/                 state, sync engine, API client, model queries, sanitiser, palette, seed data
    store.js            in-memory state (S) of the space on screen, roles (can / RO), selection, undo/redo
    sync.js             persistence per space: diff → push changed fields, poll → pull and merge, IndexedDB offline cache
    merge.js            field-level merging of concurrent edits (same rules as server/src/Merge.php)
    ytext.js            character-level merging of rich text with Yjs (notes, documents, captions)
    caret.js            keeps your cursor in place while other people's changes redraw what you're typing in
    api.js              fetch wrapper, uploads, asset URLs
    realtime.js         WebSocket to the realtime server (or polling), presence reports
    styles.js           styles for new elements: the last line style, card colour per type, text alignment, table header, sketch pen and
                        board background/corners you picked become the defaults for new ones (saved to your account,
                        server/src/Styles.php; the AI tools use them too); "Reset styles for new elements" in the ⋯ menu
  vendor/yjs.js         Yjs 13.6 + lib0 bundled into one ES module (MIT); no build step needed
  canvas/               viewport (pan/zoom), rendering, selection, drag & drop, lines, snapping,
                        resize.js (every edge and corner, within each card type's min/max width; size badge, snapping,
                        Shift keeps the shape, Alt from the centre,
                        double-click a handle for the usual size),
                        motion.js (drag & drop animation: sway, landing, gliding into columns, flying into boards;
                        all off with the system's "reduce motion" setting)
  cards/                card types: types.js (note, to-do, link, image, file, board, column, comment,
                        sketch, swatch) + table, doc, drawing, embeds, extras, corners (a board setting in the View menu:
                        sharp / curved / rounded for every card on that board; boards inside keep their own),
                        align (text alignment of notes, to-dos, columns, comments, image captions, tables and documents:
                        Align in the toolbar, or the alignment button in the formatting bar / document editor)
  actions/              create, delete/duplicate/clipboard, move between boards
  ui/                   header & menus, toolbar (+ contextual mode), toasts, modals, search, drawer,
                        theme, sign-in screen, icons, presence (avatars, "X is editing"), notify (the bell),
                        datepicker (to-do due dates: a small calendar with Today / Tomorrow),
                        account (the Account settings page at #/account/<section>: profile, password & devices,
                        your data)
  features/             templates, export (PNG/Markdown/text), backup import/export, sharing (share.js),
                        spaces & workspaces (spaces.js), people/invite pieces (people.js),
                        comments on cards and the Comments panel (comments.js), activity & versions (history.js),
                        opening a link: its password, joining (links.js),
                        shortcut cards that jump to any board, however deep (shortcuts.js)
  app/                  navigation (boards/URL), keyboard shortcuts
  styles/               tokens.css (design tokens, light/dark) + one file per area, imported by app.css
api/
  index.php             front controller for every /api/* request
  .htaccess             Apache rewrite to index.php
server/
  bootstrap.php         autoloader + config
  src/                  App (router), Auth, Sync, Merge (field merging), YText (Yjs text logs), Access (roles),
                        Spaces (workspaces), Sharing (people on a board), Invites, Mailer (SMTP / outbox),
                        Comments, Notify (in-app notifications), History (activity and card versions),
                        Realtime (tickets, presence) + RealtimeServer (WebSocket server),
                        Assets, Shares (links), Unfurl, RateLimit, Db, Config, Http, Legacy,
                        Mcp (MCP server), BoardTools (the MCP tools),
                        OAuth (sign-in for MCP clients), Workspace (boards loaded for the MCP tools), Text
  src/Storage/          LocalStorage, S3Storage (any S3-compatible bucket)
  bin/kolam          admin CLI (create users, reset passwords, backups, cleanup)
  bin/realtime          live-update server (WebSocket); bin/install-realtime.sh installs it as a service
  router.php            router for PHP's built-in server (local testing)
storage/                SQLite database + uploads (created at runtime; never web-accessible)
deploy/                 example nginx / Apache / php.ini / cron files
```

### How sync works

Every board, card, line and trash entry is stored as its own database row in a **space** (your own boards, or a team
workspace) with a per-space revision number. The browser keeps the space on screen in memory; `save()` diffs it
against what the server last confirmed and sends **only the changed records, naming the fields that changed**, then asks
for records changed since its last revision whenever the space changes (see *Live updates* below), so other people's and
devices' edits appear quickly. A copy is kept in IndexedDB per space so boards open instantly and edits survive going
offline. The server checks every pushed change against your role on that board; if it refuses one, the browser drops
its local change and reloads the server's copy. Undo only reverts your own changes: fields someone else changed since
are left alone.

### Editing at the same time

- **Different fields of one card** (one person moves it, another recolours it) both stick: a push only overwrites the
  fields it changed, and the browser merges incoming copies into its unsent changes the same way
  (`server/src/Merge.php`, `src/core/merge.js`). Inside a field: to-do tasks merge by task (one ticks, another adds or
  renames), items appended to the same list at the same time are all kept, table cells merge cell by cell. Otherwise
  the later save wins for that field.
- **Rich text** (notes, documents, image captions) merges character by character with [Yjs](https://yjs.dev). When
  someone starts editing a card's text, the browser loads that card's Yjs log (`GET /api/ytext`); its typing goes out as
  Yjs updates with the normal push, and pulls bring other people's. The server stores the log (`ylog` table) without
  running Yjs: plain-text writes (the AI tools, imports, older browsers) are logged as "set the text to …" entries
  that every browser turns into the identical Yjs change. Browsers replace long logs with a snapshot. The card keeps the
  merged HTML in `data.html`, so search, export, sharing and the AI read plain HTML as before.
- Pulls no longer wait while you type: the card or document you're in is redrawn with other people's changes and your
  cursor stays where it was. While typing in a shared space with live updates, changes go out every 250 ms.
- A card deleted while someone else edits it stays deleted.

### Live updates and presence

- **With the realtime server** (`server/bin/realtime`, a dependency-free PHP WebSocket server; install it with
  `bash server/bin/install-realtime.sh`, proxy `/ws` to it as in `deploy/nginx.conf` / `deploy/apache.conf`, and set
  `REALTIME_URL=wss://your-domain/ws`): each browser connects with a 60-second signed ticket from `POST /api/realtime/ticket`
  and subscribes to the space on screen. The server watches each open space's revision (the API also nudges it over local
  UDP after every push), tells subscribers to pull, and sends who's there. It never carries board data itself: pulls still
  go through the API's access checks. Browsers reconnect by themselves if it restarts.
- **Without it** (shared hosting): browsers pull about once a second and report presence through `POST /api/presence`.
  Both kinds of browser share the `presence` table, so they see each other.
- Presence shows as avatars in the board bar (dimmed when someone is on another board) and an "X is editing" marker on
  the card or document someone is typing in.

### Collaboration

- **Spaces.** Your own boards are one space; a **workspace** is a shared set of boards for a team (anyone can create
  one from the space button next to the logo). Workspace roles: *Owner*, *Admin* (manages members), *Member* (sees and
  edits every board), *Guest* (only boards shared with them). Boards in a workspace belong to the workspace.
- **Sharing a board** (Share button): invite people by email as *Can edit*, *Can comment* or *Can view*. Access covers
  the board and the boards inside it. An inner board can give someone a different role, or be set to
  *Only people added here*. Only the owner invites, changes roles, removes people (keeping or trashing their cards),
  manages links, deletes or moves the shared board, transfers ownership, and unlocks other people's locks.
- **Links** (Share → *Links*, only the board's owner): a board can have several, each with an optional label, expiry
  date and password. A link covers the board and the boards inside it. Kinds:
  - *can view*: anyone with it can look, without an account.
  - *can view and comment*: the same, and they can comment under a name they give (shown as "Name (guest)"). Their
    browser keeps a key, so they can edit and delete their own comments from that browser. They can't @mention or
    resolve threads.
  - *can join and edit / comment / view*: people sign in (or create an account, even when `ALLOW_SIGNUP=false`) and
    are added to the board with that role; the owner gets a notification. This is the only kind of link that can give
    edit access, since editing always needs an account.

  A password is asked once per browser tab; changing it asks everyone again. Turning a link off, or its expiry, stops
  it right away (people who already joined keep their access).
- **Invitations** last 7 days, are for one email address, and let that address create an account even when
  `ALLOW_SIGNUP=false`. They're emailed when SMTP is set up in `.env`; the link can always be copied from the dialog.
  Until SMTP is set up, each email is written to `storage/mail/` instead (one `.eml` file per message, kept 30 days),
  as a placeholder outbox you can open in any mail app. Pending invitations also show in the Spaces panel, and
  people who already have an account get an in-app notification.
- Cards deleted on a shared board go to that board's Trash, which every editor sees, with who deleted them.
  A deleted workspace waits 30 days in its owner's Trash (`server/bin/kolam cleanup` removes it after that).
- Moving cards to a board that a different set of people can see asks first.
- Collaborators' own Claude Code / Codex (MCP) can reach shared boards with their role (`space` argument on every
  tool).
- **Comments.** Every card has one comment thread: hover a card and click the speech bubble in its corner (a blue
  badge shows the number of open comments), or open **Comments** in the board bar for every thread on the board
  (*Open* / *Resolved*). Comment cards show their thread right on the board. Type `@` to mention someone who can see
  the board. Anyone who can comment can reply, react (👍 ❤️ 😂 🎉 👀 ✅) and resolve or reopen a thread (a new comment
  reopens it); authors edit their own comments (marked *edited*); authors and the board's owner delete them.
  Comments are stored in their own tables (`comments`, `comment_reactions`, `comment_threads`), written through
  `/api/comments`, and come to open browsers with the board's other changes. They stay with a card in the Trash and
  come back with it; the AI tools see them as `comments` on each card.
- **Notifications** (the bell in the top bar) are in-app only: someone @mentioned you, replied in a thread you
  commented in, a guest commented through a comment link you made, someone joined through your link, invited you, or
  changed your role. The realtime server tells browsers at once (otherwise the presence
  poll does). Each kind can be switched off from the bell's ••• menu. Notifications older than 90 days are removed by
  `server/bin/kolam cleanup`.
- **Activity and versions.** The clock button in the board bar shows the board's activity: who added, edited, moved,
  recoloured or deleted which card, renamed the board, or commented, newest first. One person's changes to a card
  within 2 minutes count as one entry ("3 changes"). Click an entry (or right-click a card → *Version history*) to see
  that card's versions and preview any of them; people who can edit can restore one. Restoring brings back the card's
  content, colour and size and leaves it where it is now; a deleted card comes back on its board (and leaves the
  Trash). A restore is a normal change, so undo takes it back. Undo (⌘Z) only ever reverts your own changes.
  History is stored per change in the `history` table (with the card as it was before) and kept 90 days
  (`server/bin/kolam cleanup`).

### Connect your AI (Claude Code / Codex over MCP)

Kolam runs no AI itself, never calls an AI API and takes no API keys. People use their own Claude Code, Codex or any
other MCP client, on their own computer and with their own subscription, to read and change their boards. The
**Connect AI** button at the right end of the board bar (after View) shows how, lists what's connected, and
disconnects it.

- **Connecting:** `POST /api/mcp` (Streamable HTTP). `claude mcp add --transport http kolam <api>/mcp` (then `/mcp` →
  Authenticate) or `codex mcp add kolam --url <api>/mcp` open a Kolam "Allow" page and get a token automatically:
  Kolam is its own OAuth 2.1 server (authorization code + PKCE, dynamic client registration, discovered through the
  `WWW-Authenticate` header and `/api/.well-known/`). An access key from the panel is the fallback for tools that
  can't sign in through a browser. Every connection is listed in the panel and can be disconnected.
- **Board tools:** `list_boards`, `get_board`, `search`, `create_cards`, `update_card` (incl. single tasks with due dates, column order,
  lock, collapse), `duplicate_cards`, `delete_cards` (to Trash), `list_trash`, `restore_from_trash`, `connect_cards`,
  `update_connection`, `delete_connections`, `comment` (comment on any card, resolve threads), `update_board` (title,
  background, corners, icon, parent), limited to the boards the signed-in person can reach, with their role. Writes go
  through the same change log as the browser, so open tabs pick them up within 3 seconds.

### Adding a card type

Add an entry to `TYPES` (see `src/cards/table.js` for a self-contained example): `label`, default width `w`,
`init()` for initial data, `html(item)`, and optional `mount`, `edit`, `read`, `text` (used by search and export).
Then add a toolbar entry in `src/ui/toolbar.js` and a tile drawing in `src/ui/tool-icons.js`.

---

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

### Deploying with aaPanel (MySQL)

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

### Scaling up

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
Not Track.
Visitors from the EU, EEA, UK and Switzerland (`Http::consentRequired()`, from Cloudflare's `CF-IPCountry`; the
browser's time zone when the country is unknown) get a cookie banner first, with equal Accept and Reject; analytics only
loads after Accept. The app learns this from `auth/me` (`config.consent`), the website from the public `GET /api/consent`.
The choice is kept in the browser's local storage (`kolam-consent`), and **Cookie settings** (the app's ? menu, the
website's footer) reopens the banner; Reject turns collection off and removes the `_ga` cookies.

### Security notes

- Passwords are hashed with `password_hash`. Sessions are random tokens stored hashed, in HttpOnly SameSite cookies, marked Secure on HTTPS.
- Every state-changing request needs an `X-Requested-With: kolam` header, which blocks cross-site form posts.
- Sign-in, sign-up and link-preview requests are rate-limited.
- Uploaded files are served with a sandboxing Content-Security-Policy. Non-media types are forced to download, so uploads can never run as pages on your domain.
- Link previews refuse private and local network addresses, and pin the checked IP so DNS rebinding can't redirect them.
- View and comment links expose only the shared board and the boards inside it, and can't change cards. Link passwords
  are hashed; a correct one gives the tab a key derived from the hash, and wrong guesses are rate-limited. Guests'
  comment keys are stored as SHA-256 hashes. Uploaded files use long random IDs.
- Every change a browser or MCP client sends is checked on the server against the person's role on that board; pulls
  only return boards (and their cards and trash) the person can open. Invitation links carry a random token stored as a hash.
- AI access tokens (from browser sign-in or an access key) can read and change all of a user's boards. They're stored
  as SHA-256 hashes and can be disconnected one by one in the sidebar. The MCP endpoint accepts only these tokens,
  never the session cookie. The OAuth "Allow" pages can't be framed, refuse cross-site posts, require PKCE, and only
  send codes back to https addresses or to localhost.
- Kolam runs no AI processes: AI clients reach it only over MCP, signed in as one person and limited to what they can reach.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md), and report security problems privately as
described in [SECURITY.md](SECURITY.md).

## License

Kolam is free software under the [GNU Affero General Public License v3.0](LICENSE). If you run a modified version as a
network service, you must offer its source code to its users. Bundled Yjs and lib0 (`src/vendor/yjs.js`) are MIT-licensed.
