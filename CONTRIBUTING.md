# Contributing to Kolam

Thanks for helping. Bug reports, fixes, new card types and documentation are all welcome.

## Before you start

- **Bugs:** open an issue with steps to reproduce, what you expected, and your browser / PHP version / database.
- **Features:** open an issue (or a Discussion) first, so we can agree on the approach before you spend time on it.
- **Security problems:** don't open an issue; see [SECURITY.md](SECURITY.md).

## Setting up

Requirements: PHP 8.1+ with `pdo_sqlite`, `curl`, `mbstring` and `fileinfo`. No Node, no build step.

```bash
cp .env.example .env        # set APP_ENV=development to see PHP error details
PHP_CLI_SERVER_WORKERS=4 php -S localhost:8080 server/router.php
```

Open <http://localhost:8080>, create an account, edit files in `src/` or `server/`, and reload the page.
[Project structure](docs/architecture.md#project-structure) explains where things live.

## Code style

- **Frontend:** plain ES modules and CSS, loaded by the browser as-is. No frameworks, no bundler, no new dependencies
  without discussing it first.
- **Backend:** PHP 8.1, `declare(strict_types=1)`, one class per file in `server/src/`. Database changes go in a new
  numbered step in `Db::migrate()`; never edit an existing step.
- Match the style of the file you're in. Comments explain *why*, not *what*.
- Keep the server and browser merge rules in sync (`server/src/Merge.php` and `src/core/merge.js`).

## Pull requests

1. Fork the repo and create a branch from `main`.
2. Keep each pull request to one change, and describe what it does and how you tested it.
3. Make sure the **Check** workflow passes (PHP syntax and that every app import resolves). You can run the same
   checks locally:
   ```bash
   find api server -name '*.php' -print0 | xargs -0 -n1 php -l > /dev/null
   npx esbuild src/main.js --bundle --format=esm --outfile=/dev/null --log-level=error --external:'https://*'
   ```
4. Add a line to `CHANGELOG.md` for anything people will notice (it's shown in the app's "What's new").

By contributing, you agree that your contributions are licensed under the project's [AGPL-3.0 license](LICENSE).

Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
