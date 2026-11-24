# Collaboration and AI

Workspaces, sharing, links, comments, notifications, version history, and connecting Claude Code or Codex over MCP.

## Workspaces, sharing and comments

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
  as a placeholder outbox you can open in any mail app. Pending invitations also show in the spaces dropdown (the
  button next to the logo), and
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
  within 2 minutes count as one entry ("3 changes"). Click an entry (or Ctrl/Alt + right-click a card → *Version history*) to see
  that card's versions and preview any of them; people who can edit can restore one. Restoring brings back the card's
  content, colour and size and leaves it where it is now; a deleted card comes back on its board (and leaves the
  Trash). A restore is a normal change, so undo takes it back. Undo (⌘Z) only ever reverts your own changes.
  History is stored per change in the `history` table (with the card as it was before) and kept 90 days
  (`server/bin/kolam cleanup`).

## Connect your AI (Claude Code / Codex over MCP)

Kolam runs no AI itself, never calls an AI API and takes no API keys. People use their own Claude Code, Codex or any
other MCP client, on their own computer and with their own subscription, to read and change their boards. The
**Connect AI** button at the right end of the board bar (after View) shows how, lists what's connected, and
disconnects it.

- **Connecting:** `POST /api/mcp` (Streamable HTTP). `claude mcp add --transport http kolam <api>/mcp` (then `/mcp` →
  Authenticate) or `codex mcp add kolam --url <api>/mcp` open a Kolam "Allow" page and get a token automatically:
  Kolam is its own OAuth 2.1 server (authorization code + PKCE, dynamic client registration, discovered through the
  `WWW-Authenticate` header and `/api/.well-known/`). An access key from the panel is the fallback for tools that
  can't sign in through a browser. Every connection is listed in the panel and can be disconnected.
- **Board tools:** `list_boards`, `get_board`, `search`, `create_cards` (every card type incl. icons, group boxes drawn
  around cards, styled text, horizontal columns, and images fetched from an https URL into the person's storage),
  `update_card` (incl. single tasks with due dates, column order, lock, collapse), `duplicate_cards`, `delete_cards`
  (to Trash), `list_trash`, `restore_from_trash`, `connect_cards` / `update_connection` (label, colour, route, dash,
  width, arrowheads), `delete_connections`, `comment` (comment on any card, resolve threads), `update_board` (title,
  background, corners, emoji or icon, parent), `list_icons`, `arrange_cards` (grid, row, column, tree; align,
  distribute), `list_templates`, `create_board_from_template`, `board_activity`, `card_versions`, `restore_version`,
  `current_board` (the board the person has open, from presence), limited to the boards the signed-in person can reach,
  with their role. Writes go through the same change log as the browser, so open tabs pick them up within 3 seconds.
- **People tools:** `create_workspace`, `list_members`, `invite` (sends the same email as the app), `share_link`
  (create, list, remove), with the app's role checks.
- **Prompts:** ready-made requests in the AI app's menu: summarise a board, notes to to-dos, plan a project, draw a
  diagram, tidy a board, weekly review, brainstorm.
- **Code:** `server/src/Mcp.php` (JSON-RPC, tool modules, prompts); tools in `BoardTools`, `LayoutTools`,
  `TemplateTools`, `HistoryTools`, `PeopleTools`; prompts in `McpPrompts`. Board templates live in `src/templates.json`,
  shared by the browser and `TemplateTools`.
