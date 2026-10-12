# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`dbclient` — a VS Code extension (TypeScript) that is a database client in the style of the "Database Client" extension (`cweijan.vscode-database-client2`), with the SQL editor modeled on NetBeans' SQL editor. Engines: PostgreSQL, MySQL, SQL Server, Oracle, SQLite, Redis and NATS — all in one connections tree, each with its own editor (`.sql` editor, `.redis` editor + value viewer, NATS console). The user tests it in Cursor (VS Code 1.128 base, Node 24); there is no VS Code or `code` CLI on this machine. Not a git repo yet; `package.json` already points at `github.com/cgalvisleon/dbclient` (other repos of this user use `git@github.com:cgalvisleon/<repo>.git` as `origin`).

## Commands

```bash
npm run typecheck          # tsc --noEmit (src + test)
npm run build              # esbuild → dist/extension.js (watch: npm run watch)
npm test                   # vitest: unit tests; integration tests skip without DBCLIENT_* vars
npx vitest run test/unit/statements.test.ts -t "oracle"   # single file / test
npm run test:smoke         # builds, downloads VS Code into .vscode-test/, runs test/smoke/suite inside it
npm run package            # typecheck + production build + vsce → dbclient-<version>.vsix
npm run icons              # regenerate media/icons/ and media/icon.png from img/ (macOS: uses sips)
```

Integration and smoke tests read `DBCLIENT_PG_*`, `DBCLIENT_MYSQL_*`, `DBCLIENT_MSSQL_*`, `DBCLIENT_ORACLE_*` (`_SERVICE`, default `FREEPDB1`), `DBCLIENT_REDIS_*` and `DBCLIENT_NATS_SERVERS`. Local containers usually running: `postgres` (user/db `test`), `jsql-mysql` (root), `jsql-mssql` (sa), `jsql-oracle` (APP_USER `jsql`), `redis` (password in its command line) and `nats` (no auth, JetStream on). Read passwords from `docker inspect <name>` env into the variables — never write them to files. Tests must not touch existing data: Redis tests use db 15 with a unique key prefix, NATS tests a temporary stream, SQL tests their own temp database/table. The smoke suite injects passwords by overriding `store.getSecrets`, so it never touches the macOS keychain.

## Architecture

- `src/drivers/` must never import `vscode`. `types.ts` defines `Driver` plus `SqlDriver` (`execute` returns one result per result set), `KvDriver` (`command`, `scan`) and `PubSubDriver`; a `DriverFactory` declares its form `fields` (`secret`, `showWhen`, `file` kinds), `category` (`sql`/`kv`/`pubsub`) and `dialect`. Adding an engine = new factory + one line in `registry.ts`.
- Every SQL driver keeps metadata connections separate from one dedicated session per database/schema (so `SET`, `BEGIN`, temp tables persist), caps rows at `dbclient.maxRows` while streaming, and throws `StatementError` with `position` (1-based char) or `line` (1-based) inside the statement; `sqlRunner` maps either to a diagnostic. Engine quirks worth knowing: MySQL truncation sends `KILL QUERY` and waits for it before releasing the session; MSSQL must use `request.batch()` (not `query`) for session state; Oracle needs the trailing `;` re-added to PL/SQL blocks; SQLite uses `node:sqlite` (absent before Node 22.13).
- `editor/statements.ts` splits per dialect (`GO` for mssql, `DELIMITER` and BEGIN…END bodies for mysql, `/` lines and PL/SQL blocks for oracle, triggers for sqlite, `$$` for postgres) and returns offsets into the document.
- `src/store/connectionStore.ts` — user-level `connections.json` in `globalStorageUri` holding `connections` and nested `folders` (`parentId`; a connection's `folderId`); deleting a folder moves its content up a level, moves refuse cycles, items pointing at a missing folder show at the top level. Secrets in SecretStorage as `dbclient.<id>.<field>`.
- The tree's `FolderItem` (contextValue `connectionFolder`) is a user folder — different from driver nodes of kind `folder` (Tables, Views…). `ConnectionsDragAndDrop` moves connections/folders; the form's Folder select must be kept when saving, or edits would drop the folder.
- `src/connections/manager.ts` holds live drivers. `onDidChangeState` (connect/disconnect) refreshes the whole tree; `onDidChangeContent` (driver-side, e.g. NATS subscriptions, throttled) refreshes only that connection's subtree.
- `editor/bindings.ts` maps a `.sql` or `.redis` document to `{connectionId, database}` (`EDITOR_CATEGORIES`: sql→sql, redis→kv). `dbclient.run`/`runFile` dispatch on the editor language; `dbclient.newQuery` opens a SQL or Redis editor, or the NATS console for pub/sub connections.
- Webviews are plain JS/CSS in `media/` (no bundler) behind a nonce CSP (`webviews/html.ts`): connection form, results panel (bottom `WebviewView`, messages queued until `ready`), Redis value viewer (`redisValue.ts` turns edits into commands), NATS console (messages buffered per connection while connected).
- Icons: `src/icons.ts` returns `{light, dark}` PNGs from `media/icons/` (generated from `img/`); the activity-bar icon stays the monochrome `media/database.svg` because VS Code masks it.

## Documentation workflow

- `README.md` (English) is the user-facing doc and ships in the `.vsix`; `README.es.md` is its Spanish translation. Keep them in sync section by section: installation first, then short paragraphs, the features table and usage examples. When a feature lands or changes, update the features table and examples in both.
- `feature.md` is the user's feature definition (Spanish). When complementing it, append plain bullets in the same style — don't restructure or reformat it.
- `spec.md` holds the requirements (ID, weight in points, status 0 / 0.5 / 1), the gap formula `brecha = (total − avance) / total`, and a history table.
- After every change to the project, update `spec.md`: requirement statuses, the per-block table, the current gap %, and a new history row. Mark a requirement 1 only when it is verified; partial or unverified pieces are 0.5 with the reason.
