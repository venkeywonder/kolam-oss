# Architecture

How Kolam is put together: where the code lives, how boards sync between browsers, and how to add a new card type.

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
    api.js              fetch wrapper, asset URLs
    upload.js           chunked uploads that resume after a dropped connection (straight to the bucket with S3_DIRECT_UPLOADS)
    zip.js              reads a backup ZIP in the browser to restore it
    pwa.js              the service worker (sw.js): installing the app, desktop notifications (Web Push), the unread badge
    realtime.js         WebSocket to the realtime server (or polling), presence reports
    styles.js           styles for new elements: the last line style, card colour per type, table header, sketch pen and
                        board background/corners you picked become the defaults for new ones (saved to your account,
                        server/src/Styles.php; the AI tools use them too); "Reset styles for new elements" in the ⋯ menu
  vendor/yjs.js         Yjs 13.6 + lib0 bundled into one ES module (MIT); no build step needed
  vendor/lucide.json    Lucide 1.78 icons (ISC, vendor/lucide.LICENSE) as {name: [svg body, tags]}; loaded only for board icons and icons
  vendor/logos/         logos for the Icon element, built by scripts/build-logos.mjs: index.json (packs > groups > icons, loaded when
                        the picker opens) and one SVG per logo (loaded as an <img> only when on screen): dev/ Devicon (MIT),
                        brand/ Simple Icons (CC0), aws/ AWS Architecture Icons (AWS's terms, for diagrams; see vendor/logos/README.md)
  canvas/               viewport (pan/zoom), rendering, selection, drag & drop, lines, snapping,
                        cull.js (big boards: only cards on or near the screen have elements), images.js (an image loads
                        the smallest stored size that's sharp at the current zoom),
                        resize.js (every edge and corner, within each card type's min/max width; size badge, snapping,
                        Shift keeps the shape, Alt from the centre,
                        double-click a handle for the usual size),
                        motion.js (drag & drop animation: sway, landing, gliding into columns, flying into boards;
                        all off with the system's "reduce motion" setting)
  cards/                card types: types.js (text, note, to-do, link, image, file, board, column, comment,
                        sketch, swatch, icon, group) + text (text straight on the board: font, size, bold/italic/underline, colour, fill;
                        as wide as its words until resized), table, doc, drawing, embeds, extras, board-icon (a board card's icon: any emoji, any
                        Lucide icon, logo, AWS icon, or an uploaded picture cropped to a square and stored at 216 × 216; chosen in the
                        icon picker below, with an Emoji tab),
                        icon (a logo straight on the board with a label under it, and the icon picker: logos by area, AWS by
                        service category, Lucide icons or an upload), group (a labelled box under the cards; moving it moves what's
                        wholly inside; minimise it to its name), poll (a question to vote on: answers with words, pictures or
                        people, one or several picks, an optional end date; votes go through /api/polls/vote), corners (a board setting in the View menu:
                        sharp / curved / rounded for every card on that board; boards inside keep their own),
                        align (text alignment of text, notes, to-dos, columns, comments, image captions, tables and documents:
                        Align in the toolbar, or the alignment button in the formatting bar / document editor; per card, never a
                        default for new cards)
  actions/              create, delete/duplicate/clipboard, move between boards, uploads.js (the upload queue: a card for
                        each dropped file at once, smaller copies made in workers/image.js, then the file in chunks)
  ui/                   header & menus, toolbar (+ contextual mode), toasts, modals, search, drawer,
                        theme, sign-in screen, icons, presence (avatars, "X is editing"), notify (the bell),
                        install (the Install app button), datepicker (to-do due dates: a small calendar with Today / Tomorrow),
                        account (the Account settings page at #/account/<section>: profile, password & devices,
                        your data), avatars (profile pictures: initials, an illustration from src/assets/avatars/ or an
                        uploaded photo, looked up in batches), avatar-editor (crop, rotate, flip and adjust an uploaded
                        photo; saved as a 256 × 256 WebP)
  workers/image.js      makes the smaller copies of an image off the main thread before it uploads
  features/             templates, export (PNG/Markdown/text), backup import/export as a ZIP (io.js), sharing (share.js),
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
                        Comments, Notify (in-app notifications), Push (desktop notifications, no libraries),
                        History (activity and card versions),
                        Realtime (tickets, presence) + RealtimeServer (WebSocket server),
                        Assets, Uploads (chunked and direct uploads), Variants (smaller copies of images), AssetRefs (which
                        cards use which file), Export + ZipStream (backups as a streamed ZIP), Shares (links), Unfurl,
                        RateLimit, Db, Config, Http, Legacy, Polls (votes), Avatars (profile pictures),
                        Mcp (MCP server), BoardTools (the MCP tools),
                        OAuth (sign-in for MCP clients), Workspace (boards loaded for the MCP tools), Text
  src/Storage/          LocalStorage, S3Storage (any S3-compatible bucket; presigned URLs for direct uploads)
  bin/kolam          admin CLI (create users, reset passwords, backups, cleanup, s3-cors)
  bin/realtime          live-update server (WebSocket); bin/install-realtime.sh installs it as a service
  router.php            router for PHP's built-in server (local testing)
index.html, manifest.json, sw.js   app shell, the manifest that makes it installable, and the service worker (caches nothing;
                        shows an offline page and delivers desktop notifications)
storage/                SQLite database + uploads (created at runtime; never web-accessible)
deploy/                 example nginx / Apache / php.ini / cron files
scripts/build-logos.mjs  rebuilds src/vendor/logos from the simple-icons and devicon npm packages and AWS's Architecture Icons
                        Asset Package (https://aws.amazon.com/architecture/icons/); usage at the top of the file
```

## How sync works

Every board, card, line and trash entry is stored as its own database row in a **space** (your own boards, or a team
workspace) with a per-space revision number. The browser keeps the space on screen in memory; `save()` diffs it
against what the server last confirmed and sends **only the changed records, naming the fields that changed**, then asks
for records changed since its last revision whenever the space changes (see *Live updates* below), so other people's and
devices' edits appear quickly. A copy is kept in IndexedDB per space so boards open instantly and edits survive going
offline. The server checks every pushed change against your role on that board; if it refuses one, the browser drops
its local change and reloads the server's copy. Undo only reverts your own changes: fields someone else changed since
are left alone.

## Editing at the same time

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

## Live updates and presence

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

## Adding a card type

Add an entry to `TYPES` (see `src/cards/table.js` for a self-contained example): `label`, default width `w`,
`init()` for initial data, `html(item)`, and optional `mount`, `edit`, `read`, `text` (used by search and export).
Then add a toolbar entry in `src/ui/toolbar.js` and a tile drawing in `src/ui/tool-icons.js`.

## Security notes

- Passwords are hashed with `password_hash`. Sessions are random tokens stored hashed, in HttpOnly SameSite cookies, marked Secure on HTTPS.
- "Continue with Google" (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`) runs entirely on the server: the OpenID Connect
  authorization code flow with PKCE, a nonce, and a single-use state tied to the browser by an HttpOnly cookie (no
  login CSRF). The code is exchanged with Google directly over TLS, and the ID token's issuer, audience, expiry, nonce
  and verified email are checked. A Google account is matched by its stable subject id, else linked to the account
  with the same address. If that address was never verified, linking first removes its password, sessions and AI
  tokens, so someone who registered another person's address can't keep access. Every link sends a notice email.
  Accounts made with Google have no password until their owner sets one through the emailed reset link.
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
