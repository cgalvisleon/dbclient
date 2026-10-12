# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`dbclient` — a VS Code extension (TypeScript) that is a database client in the style of the "Database Client" extension the user has installed (`cweijan.vscode-database-client2`), with the SQL editor modeled on NetBeans' SQL editor. Target engines: PostgreSQL, SQLite, MySQL, MSSQL, Oracle, Redis, NATS. Only PostgreSQL is implemented so far (the MVP). Not a git repo yet, and not part of the workspace `go.work`.

## Commands

```bash
npm run typecheck          # tsc --noEmit (src + test)
npm run build              # esbuild → dist/extension.js (watch: npm run watch)
npm test                   # vitest: unit tests; integration tests skip without DBCLIENT_PG_*
npx vitest run test/unit/statements.test.ts -t "dollar"   # single file / test
npm run test:smoke         # builds, downloads VS Code into .vscode-test/, runs test/smoke/suite inside it
npm run package            # typecheck + production build + vsce → dbclient-<version>.vsix
```

Integration and smoke tests need a Postgres: `DBCLIENT_PG_HOST`, `DBCLIENT_PG_PORT`, `DBCLIENT_PG_DATABASE`, `DBCLIENT_PG_USER`, `DBCLIENT_PG_PASSWORD`. A local `postgres:15` container (user/db `test`) is usually running; read its password from `docker inspect postgres` env into the variable rather than writing it anywhere. The smoke test passes the password as `PGPASSWORD` so the test VS Code never touches the macOS keychain. Debugging by hand: open this folder in VS Code and press F5 (Extension Development Host) — there is no `code` CLI on PATH.

## Architecture

- `src/drivers/` must never import `vscode`. `types.ts` defines `Driver`/`SqlDriver`/`DriverFactory`; a factory declares its form `fields` (with `secret` flags), `category` (`sql`/`kv`/`pubsub`) and `dialect`. Adding an engine = new factory + one line in `registry.ts`; the tree, connection form, runner and completion only consume these contracts.
- `src/store/connectionStore.ts` — user-level `connections.json` in `globalStorageUri` (shared across windows via `fs.watch`); secret fields go to SecretStorage as `dbclient.<id>.<field>`. Takes a `SecretStore` interface so it is testable without VS Code.
- `src/connections/manager.ts` holds the live driver per connection; the tree (`src/tree/`) connects lazily on expand and delegates children to `driver.children(node)`. Node `path`s are opaque strings owned by the driver.
- Postgres driver: a `Pool` per database for metadata, plus one dedicated `Client` session per database for editor runs (so `SET`/`BEGIN` persist); statements are read via `pg-cursor` capped at `dbclient.maxRows`; cancel uses `pg_cancel_backend`; errors become `StatementError` with the engine's 1-based `position`.
- Editor flow: `editor/bindings.ts` maps document → `{connectionId, database}` (workspaceState for files, session-only for untitled) and drives the status bar. `editor/statements.ts` splits SQL with offsets (quotes, comments, nested `/* */`, `$tag$`); `sqlRunner.ts` runs selection / statement under caret / file / statement at offset (CodeLens), stops at the first error, maps the error position to a diagnostic and posts results + log entries to the results view.
- Webviews are plain JS/CSS in `media/` (no bundler), loaded by `webviews/html.ts` under a nonce CSP. `resultsView.ts` is a WebviewView in the bottom panel (`dbclient.results`); messages are queued until the webview says `ready`. Values pass through `webviews/cells.ts` before reaching the grid.

## Documentation workflow

- `feature.md` is the user's feature definition (Spanish). When complementing it, append plain bullets in the same style — don't restructure or reformat it.
- `spec.md` holds the requirements (ID, weight in points, status 0 / 0.5 / 1), the gap formula `brecha = (total − avance) / total`, and a history table.
- After every change to the project, update `spec.md`: requirement statuses, the per-block table, the current gap %, and a new history row.
