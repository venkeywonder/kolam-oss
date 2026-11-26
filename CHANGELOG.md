# Changelog

## 2026-11-26

- **Groups keep their cards inside**: a card is always fully in or out of a group, and resizing never cuts one off.
- **Minimize groups**: fold a group down to its name; its cards travel with it until you maximize it.

## 2026-11-24

- **AI can do more**: draw diagrams with icons and groups, style text, add images, tidy layouts, use templates and restore versions.
- **AI knows your board**: say "this board" and your AI works on the board you have open.
- **Ready-made prompts**: pick "Summarise board", "Plan a project", "Weekly review" and more from your AI app's menu.
- **Team setup from your AI**: create workspaces, invite people and make share links.
- **Workspaces**: you start with one workspace instead of "My boards", and can add more. Switch between them next to the logo.
- **Favorites bar**: a Dock-style bar at the bottom with Text, Note, To-do, Link and Column. Drag tools on or off it.
- **Horizontal columns**: switch a column to horizontal and its cards line up side by side.
- **Web clipper**: an animated guide shows how to put **Save to Kolam** on your bookmarks bar.
- **Templates** show a picture of each layout.
- **Right mouse button**: drag to pan; right-click a card or line to open its options.
- **Continue with Google**: sign in or sign up with your Google account (set `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` to turn it on).
- **Clearer sign-in**: errors show next to the field, with a Caps Lock warning, and your input is kept when you switch screens.
- **Icon tool**: add tech logos, AWS icons or simple shapes to diagrams.
- **Group tool**: draw a labelled box around cards and move them together.
- **Text tool**: write straight on the board, with your choice of font, size, colour and fill.
- **Board icons**: give a board an emoji, an icon or your own picture.
- **⌘S / Ctrl+S** saves right away.
- **Images**: SVGs are supported, and transparent images show without a card behind them.
- **Smaller improvements**: arrow keys move between to-do tasks, colour cards have an inline picker, new and empty cards show a hand and drag right away, ⌘Z works on a card you haven't typed in, drop-downs look cleaner, emptying the Trash frees storage, and connecting your AI no longer hangs on a loading screen.
- **Branding**: a new logo tile, and emails now carry the Kolam logo.
- **Sign out** asks you to confirm first.

## 2026-11-23

- **Kolam is open source**: the whole app — infinite canvas, cards, nested boards, team workspaces, sharing, comments, version history, live updates and the MCP server for Claude Code and Codex — is now available under the AGPL-3.0 license at [github.com/venkeywonder/kolam-oss](https://github.com/venkeywonder/kolam-oss). Host it yourself with PHP and SQLite, MySQL or PostgreSQL, no build step.
