<img src="media/icon.png" width="72" align="right" alt="DB Client">

# DB Client

[Español](README.es.md) · [Português](README.pt.md)

[![VS Code Marketplace](https://img.shields.io/visual-studio-marketplace/v/cgalvisleon.dbclient?label=VS%20Code%20Marketplace)](https://marketplace.visualstudio.com/items?itemName=cgalvisleon.dbclient) [![Open VSX version](https://img.shields.io/open-vsx/v/cgalvisleon/dbclient)](https://open-vsx.org/extension/cgalvisleon/dbclient) [![Open VSX downloads](https://img.shields.io/open-vsx/dt/cgalvisleon/dbclient)](https://open-vsx.org/extension/cgalvisleon/dbclient) [![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

A free, open source (MIT) database client for VS Code and Cursor: PostgreSQL, MySQL, SQL Server, Oracle, SQLite, Redis and NATS in one connections tree, with nothing else to install.

<!-- GIF (overview, ~8 s): the tree with several engines, run a query, results tab. Save as img/screenshots/overview.gif and reference it as
![DB Client](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/overview.gif) — absolute URL so it shows on Open VSX and the Marketplace. -->

## Installation

Search for **DB Client** (`cgalvisleon.dbclient`) in the Extensions view. VS Code installs it from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=cgalvisleon.dbclient); Cursor, VSCodium and Windsurf from [Open VSX](https://open-vsx.org/extension/cgalvisleon/dbclient). To install offline, download `dbclient-<version>.vsix` from the [GitHub Releases](https://github.com/cgalvisleon/dbclient/releases) (or build it with `npm install && npm run package`), open the Command Palette (`Ctrl/Cmd+Shift+P`), run **Extensions: Install from VSIX…** and pick the file. It needs VS Code 1.90 or newer; SQLite connections need an editor running Node 22.13 or newer (Cursor, VS Code 1.101+). No native modules or database clients are required.

## What it is

A database client inside the editor. PostgreSQL, MySQL, SQL Server, Oracle, SQLite, Redis and NATS connections live in one tree, and each kind opens its own editor: a SQL editor modeled on NetBeans, a Redis command editor with a value viewer, and a NATS console.

It is free with no paid tier and MIT licensed. Drivers are pure JavaScript, so no native modules, Oracle Instant Client or database CLI tools are needed. Redis and NATS (with JetStream) sit next to the SQL engines, and the interface is in English, Spanish and Brazilian Portuguese.

Connections are stored once per user, shared by every window and workspace. Passwords and tokens go to the editor's secret storage, never to the settings file. A **Show** button next to each password field reveals what you type.

## Features

| Area | What you get |
|---|---|
| Connections | One tree for every engine; create, edit, duplicate, delete, test, connect and disconnect from a form. |
| Folders | Group connections in nested folders; create, rename, delete (content moves up a level), move with **Move to Folder…** or by drag and drop. |
| Storage | User-level `connections.json`; secrets in the editor's secret storage. |
| Settings and About | The ⚙ button in the view title opens a panel with where the extension keeps its data (storage folder, `connections.json`, query history, saved SQL files) with **Copy** and **Open folder**, the current `dbclient.*` settings against their defaults, the environment (editor, Node.js, SQLite support) and the author's GitHub links. |
| SSL/TLS | PostgreSQL, MySQL, Oracle (TCPS), Redis and NATS: **disable**, **require** (encrypted) or **verify-full** (certificate and host name), with CA file, client certificate and key (with passphrase). SQL Server: **Encrypt** with or without trusting the certificate, and a CA file. |
| SSH tunnel | Every engine but SQLite can connect through an SSH server, with password or private key (with passphrase) and an optional host key fingerprint. |
| Languages | English, Spanish and Brazilian Portuguese. By default the interface follows the editor's display language; `dbclient.language` (or the selector in **Settings and About**) picks one. |
| Export / import | **Export Connections…** writes all connections, one folder (on the folder) or the selected connections (on a connection) to a JSON file without passwords; **Import Connections…** merges it (existing ones kept, identical ones skipped) or replaces the list, and on a folder imports into that folder. |
| Icons and colors | Each connection can pick its tree icon (database, server, cloud, with gear or magnifier) and one of 7 colors (blue, green, red, orange, purple, yellow, gray) in the form's **Appearance** section — e.g. red for production. Folders take a color too with **Change Color…**. |
| Explorer (SQL) | Databases/schemas → tables, views, functions, procedures, triggers, indexes (Oracle: packages, sequences) → columns with type, PK and NOT NULL. |
| SQL editor | The first line of SQL and Redis editors shows `Connection:` with the connection and database as a drop-down (click to pick a connection, then a database; asks before switching), followed by the DB Client SQL editor's toolbar as icon buttons (run file, statement or selection, ■ Cancel while running, connect/disconnect, history, save, copy, paste, export, import) and, last, one that opens the file in the DB Client SQL editor; ▶ Run above each statement (while it runs, ■ Cancel). Title bar buttons run the file or the statement at the cursor (or the selection), connect or disconnect, save, copy and paste, plus ■ Cancel while a query runs; its `…` menu runs the selection, changes the connection, opens the history, exports and imports. The connection picker shows each connection with its folder (`Work / Prod / prod-pg`). |
| DB Client SQL editor | Optional NetBeans-style editor for `.sql` files (**Open With…** or the editor title's button): a toolbar with real drop-downs for the connection (grouped by folder) and the database, larger icon buttons for every action, the SQL with syntax highlighting and the same autocompletion as the text editor, and the results below in the same tab with a draggable divider. The file stays a normal document (save, undo, Git). |
| Saved SQL files | Each SQL connection, and each of its databases, has a **SQL** node with its own `.sql` files; opening one binds it to that connection and database. New, rename, delete, **Save** (on files with unsaved changes), and save the current query there. |
| SQL locations | Link existing folders of `.sql` files (e.g. a repository's `sql/`) to a connection and browse them with their subfolders; choose where new files are saved. Paths accept `~` and `${workspaceFolder}`; unlinking never deletes files. |
| Statement splitting | `;` everywhere, plus `GO` (SQL Server), `DELIMITER` (MySQL), `/` and PL/SQL blocks (Oracle), `$$` bodies (PostgreSQL), triggers (SQLite). |
| Results | Bottom panel with **Output** first and one tab per result set, kept across runs (up to 50; **Keep tabs** off clears them on each run) and reordered by dragging, paging, sorting, row selection, copy as TSV, export to CSV, JSON or Excel (`.xlsx`, numbers and dates as Excel values). |
| SQL output | Each statement logged with time, rows fetched/affected and errors; errors jump to the line and column in the editor and are underlined. **Clear** empties the log and numbers queries from 1 again. |
| Query history | **Query History…** lists what ran on each SQL or Redis connection, newest first, with database, time, duration and rows or error; search it, insert a statement into the editor or open it in a new one. |
| Table actions | On a table or view: **Open Data**, **Open SQL**, **Show Structure** (columns and indexes), **Show DDL**, and **Generate SQL** → SELECT, INSERT, UPDATE, DELETE in a new editor. |
| Refresh and drop | **Refresh** on a connection, database, schema, folder or table re-reads it, so schemas and tables created or dropped elsewhere show up; DDL run from the editor refreshes the connection by itself. **Drop…** removes a table or view (CASCADE on PostgreSQL, CASCADE CONSTRAINTS on Oracle) and, where the engine has them, a schema: PostgreSQL and SQL Server schemas, MySQL databases, Oracle users. |
| Row context menu | Right-click a result cell: **Copy Value**, **Copy Row** (TSV with header), **Copy Row as JSON**; on results of one table, **Generate INSERT/UPDATE/DELETE from Row** opens the statement with the row's values in a new editor bound to the connection. |
| Grid editing | Results of a single table with a primary key are editable: edit cells, add and delete rows, set NULL, then **Commit** (one transaction, by primary key) or **Cancel**. |
| SQL completion | Keywords, types and functions of the connection's dialect; with the connection open, its schemas, tables, views and columns, resolving the query's aliases. The same in the text editor and the DB Client SQL editor. |
| Redis explorer | Databases with key counts → keys grouped by separator (`:`) with their type, using `SCAN`. |
| Redis editor | `.redis` files, one command per line; completion of commands, options and existing keys; asks before `FLUSHDB`/`FLUSHALL`. |
| Redis values | Viewer/editor for string, hash, list, set, sorted set and stream; TTL, rename and delete. |
| Oracle JDBC URL | Oracle connections can use **Connect by → JDBC URL** instead of host and service: `jdbc:oracle:thin:@//host:1521/service`, `@host:1521:SID`, `tcps://…`, `(DESCRIPTION=…)` or a tnsnames.ora alias with `?TNS_ADMIN=<folder>`. A user and password inside the URL move to their fields, so the password is never saved in plain text. Works with SSL and the SSH tunnel. |
| NATS | Connect without auth or with user/password, token, NKey seed or a `.creds` file. Publish with headers, request/reply, subscribe with `*`/`>` wildcards and queue groups, live message list; JetStream streams and consumers in the tree. |

## Usage

**Add a connection.** Open the **DB Client** view in the activity bar, press **+**, choose the type, fill in the form, press **Test** and then **Save**. Expand the connection to browse it.

**Connect securely.** In the connection form, the **SSL / TLS** section sets the mode and the PEM files; **verify-full** checks the certificate against the CA file (or the system CAs) and the host name. The **SSH tunnel** section reaches a database that is only visible from a bastion host: fill in the SSH host, user and a password or private key, and keep **Host** and **Port** as the database sees them from that server. Paste the server's `SHA256:` fingerprint (`ssh-keygen -lf` on its public host key) to refuse any other server.

```text
Host: db.internal   Port: 5432   SSL: verify-full   CA certificate: ~/certs/ca.pem
SSH tunnel: private key   SSH host: bastion.example.com   SSH user: deploy   Private key: ~/.ssh/id_ed25519
```

**Move connections to another machine.** In the view's **…** menu choose **Export Connections…** (or **Export Connections…** on a folder for just that folder) and save the `.json` file; it holds folders, connections and SQL locations, never passwords. On the other machine choose **Import Connections…**, pick the file and **Merge** or **Replace**, then enter passwords with **Edit Connection**. Restoring a backup on the same machine keeps each connection's id, so its saved password and SQL files work again.

**See where your data lives.** Press **⚙ Settings and About** in the view title. **Persistence** lists the storage folder, the connections file, the query history and the saved SQL files folder, each with **Copy** and **Open folder**; passwords are not there but in the editor's secret storage. **Settings** shows each `dbclient.*` value, where it is set and its default (**Open in Settings** to change them), and **About** has the version and the author's GitHub profile, repository and issues.

**Change the language.** DB Client uses the editor's display language by default. To use another one, open **⚙ Settings and About** and pick it in **Interface language** (or set `dbclient.language` to `en`, `es` or `pt-br`), then press **Reload Window**. Command titles in menus and the Settings editor always follow the editor's language; that is a VS Code limitation.

**Share one connection or fill a folder.** Right-click a connection (or several selected) → **Export Connections…** to save just those, without folders or passwords. Right-click a folder → **Import Connections…** to merge a file into that folder: its connections and folders land inside it.

**Tell connections apart.** In the connection form, **Appearance** shows the icon shapes and colors as a live preview; pick, for example, the gear database in red for production and the green one for development. **Automatic** keeps the engine's icon. To color a folder, right-click it → **Change Color…**.

**Organize with folders.** Press the **New Folder** button in the view title (or **New Folder** on a folder for a subfolder). Drag connections or folders onto a folder, or use **Move to Folder…**; drop them on empty space to return them to the top level. **Add Connection** on a folder creates the connection inside it, and the form's **Folder** field changes it later.

**Query a SQL database.** Click **New Query** on a connection or database. Write SQL and press `Ctrl/Cmd+Enter` to run the statement under the cursor (or the selection), or `Ctrl/Cmd+Shift+Enter` to run the whole file:

```sql
select id, name from customers where created_at > now() - interval '7 days';
update customers set active = false where id = 42;
```

<!-- GIF (sql-editor.gif): Ctrl/Cmd+Enter on a statement, results tab, export to Excel. ![SQL editor](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/sql-editor.gif) -->

Each query opens a tab in **DB Client → Results**, after the earlier ones; the **Output** tab, always first, lists every statement with its time and row count. Drag a tab to reorder it (drop it on **Output** to make it the first result), middle-click or **×** to close it. **CSV**, **JSON** and **Excel** in the tab's toolbar export all its rows in the current sort order.

**Keep queries per connection.** Expand a SQL connection and use **New SQL File** on its **SQL** node, or press **Save to Connection's SQL Folder** in the editor title to keep the current query. The files open already bound to their connection. They live in the extension's storage, one folder per connection; set `dbclient.sqlFolder` to keep them somewhere else, such as a synced or versioned folder.

**Link folders of SQL files.** Use **Link SQL Folder…** on a connection or its **SQL** node and pick one or more folders. If a folder is inside the open project you can store it as `${workspaceFolder}/…`, so the same connection shows the `sql/` folder of whichever project is open. Each linked folder appears under **SQL** with its subfolders (hidden, `.git` and `node_modules` folders are skipped). Files opened from a linked folder run against that connection; when two connections link the same folder, the most specific folder wins and a tie is asked once. **Set Save Location for SQL Files…** chooses where **New SQL File** and **Save to Connection's SQL Folder** write. The connection form's **SQL files** section edits the same settings:

```text
Save new files in:  ${workspaceFolder}/sql
Linked folders:     ${workspaceFolder}/sql
                    ~/projects/reports
```

**See and change the editor's connection.** The first line of every SQL and Redis editor shows the connection and database it runs against, NetBeans style; click it (or the status bar) to pick another connection and then, for a SQL connection with several databases, the database. When the editor already had a connection, a dialog asks before switching. ▶ Run sits above every statement.

```
Connection: 🛢 prod-pg / sales ▾ | ⏩ | ▶ | ☰ | 🔌 | 🕘 | 💾 | ⧉ | 📋 | ⇪ | ⇩ | ▣
▶ Run
select id, name from customers;
```

The editor title bar has buttons to **run the whole file**, **run the statement** at the cursor (or the selection), **connect** or **disconnect**, **save** to the connection's SQL folder, **copy** (the selection, or the whole file) and **paste**; while a query runs, a **■ Cancel** button stops it (the running statement's lens shows **Running…** and **■ Cancel** too). Its `…` menu has the rest: run the selection, change the connection, query history, export to a file, import a file at the cursor, and open the file in the DB Client SQL editor. The connection list shows each connection with the folder it is in (`Work / Prod / prod-pg`). The first line repeats those actions as icon buttons (the same as the DB Client SQL editor's toolbar; hover for the description), and its last button opens the file in the DB Client SQL editor. Turn the connection line off with `dbclient.connectionLens`.

**Use the DB Client SQL editor.** In a `.sql` editor press the **Open in DB Client SQL Editor** button in the title bar (or right-click the tab → **Reopen Editor With…** → **DB Client SQL Editor**). The tab shows a toolbar, the SQL and its own results:

```
Connection: [prod-pg (PostgreSQL) ▾]  Database: [sales ▾] │ ⏩ ▶ ☰ ■ │ 🔌 🕘 💾 │ ⧉ 📋 ⇪ ⇩ │      📄
select id, name from customers;
═════════════════════ (drag to resize) ═════════════════════
Output │ select id, name from…
```

Pick the connection and database in the drop-downs (they list databases once the connection is open), run with the buttons or `Ctrl/Cmd+Enter` (statement at the caret or the selection) and `Ctrl/Cmd+Shift+Enter` (everything). Results, editing in the grid and exports work as in the bottom panel, but each SQL editor keeps its own (the bottom panel's **DB Client** tab stays hidden until Redis, Show Structure or the text editor shows something there). Hover a button to see what it does (and its shortcut). The layout button moves the results below, above, left or right of the SQL. 📄 goes back to the text editor. It is optional: turn `dbclient.sqlEditor.openByDefault` on to open new queries, saved SQL files of the tree and table actions there (a query saved or renamed from it stays in it either way); to use it for every `.sql` file, choose **Configure default editor for '*.sql'** in the **Reopen Editor With…** list. Autocompletion suggests the same as in the text editor (as you type, after `.` or a space, or with `Ctrl+Space`); errors underlined in the text are still only in the text editor (a later version adds them).

**Keep SQL files per database.** Expand a database in the tree: its first child is **SQL**, with the files of that database. **New SQL File** on the database or its **SQL** node creates one there, and opening it runs against that connection and database. A file with unsaved changes shows `● unsaved` and a **Save** button in the tree.

**Work with a table.** Right-click a table in the tree. **Open Data** runs `SELECT * FROM` the table; **Open SQL** opens that same query in a new editor without running it; **Show Structure** lists its columns and indexes in the Results panel; **Show DDL** and **Generate SQL** open the statement in a new editor bound to the connection. These editors, the SQL generated from a result row and the statements Query History opens are text editors (DB Client SQL editors when `dbclient.sqlEditor.openByDefault` is on).

**Refresh or drop objects.** If someone changed the database outside the extension, press the refresh button on the connection, database, schema or folder (or **Refresh** in its context menu) to read it again. To remove a table, view or schema, right-click it → **Drop…**: the dialog shows the `DROP` statement and, on PostgreSQL and Oracle, offers **Drop with CASCADE**; schemas also ask you to type their name. The tree refreshes after the drop.

**Turn a row into SQL.** Right-click a cell of a result and choose **Generate UPDATE from Row**. A new editor bound to the same connection opens with the row's values as literals and a `WHERE` on the primary key:

```sql
UPDATE public.items
SET name = 'O''Brien',
    active = TRUE
WHERE id = 7;
```

When the result does not include the primary key, the `WHERE` uses every column and a comment asks you to check that it matches one row. **Copy Value**, **Copy Row** and **Copy Row as JSON** in the same menu copy to the clipboard. **Clear** on the **Output** tab empties the log and numbers the next queries from 1 again.

**Edit data in the grid.** In a result that reads one table and includes its primary key, double-click a cell (or press `F2`), type, and press `Enter`; `Tab` moves to the next column and `Escape` discards. **+ Row** adds a row (untouched cells keep their DEFAULT), **Delete** marks the selected rows, and **NULL** clears the focused cell. **Commit** saves everything in one transaction and reloads the rows; if a row changed meanwhile, nothing is saved. Results from views, joins or without the key show a **read-only** badge with the reason.

<!-- GIF (grid-editing.gif): edit a cell, + Row, Commit. ![Grid editing](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/grid-editing.gif) -->

**Complete table and column names.** With the connection open, type `select * from ` to get its tables, or an alias and a dot to get that table's columns:

```sql
select o.id, o.total, c.name
from orders o join customers c on c.id = o.customer_id
where o.   -- suggests the columns of orders
```

**Reuse a past query.** Right-click a SQL or Redis connection, or use the editor title's **…** menu, and pick **Query History…**. Type to filter, for example `orders`. Enter inserts the statement into the active editor when it runs on the same connection, and otherwise opens it in a new editor bound to its connection and database; the item buttons open it in a new editor or copy it. Set `dbclient.historySize` to `0` to turn the history off.

**Run a SQL Server batch or an Oracle block.** Separate batches with `GO` and PL/SQL blocks with `/`:

```sql
create or alter procedure dbo.touch as
begin
  update dbo.items set updated_at = sysdatetime();
end
GO
exec dbo.touch;
```

**Work with Redis.** Click **New Query** on a Redis connection or on one of its databases (`db0`, `db1`…) and type one command per line; `Ctrl/Cmd+Enter` runs the current line or the selected lines:

```redis
HSET user:1 name "Ana Maria" age 30
HGETALL user:1
EXPIRE user:1 3600
```

Click a key in the tree to open its value viewer and edit it.

<!-- GIF (redis.gif): run commands, open a hash in the value viewer. ![Redis](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/redis.gif) -->

**Publish and subscribe with NATS.** Click **Open NATS Console** on a NATS connection. Subscribe to `orders.>` and publish to `orders.created` with a JSON payload and headers such as `X-Trace: abc`; incoming messages appear in the list, and selecting one shows its payload and headers.

<!-- GIF (nats.gif): subscribe to orders.>, publish, message list. ![NATS](https://raw.githubusercontent.com/cgalvisleon/dbclient/main/img/screenshots/nats.gif) -->

## Settings

| Setting | Default | Description |
|---|---|---|
| `dbclient.maxRows` | 5000 | Rows fetched per statement; larger results are truncated. |
| `dbclient.pageSize` | 100 | Rows per page in the results grid. |
| `dbclient.codeLens` | true | Show ▶ Run above each SQL statement. |
| `dbclient.connectionLens` | true | Show the editor's connection and database on the first line of SQL and Redis editors. |
| `dbclient.sqlFolder` | (empty) | Folder for saved `.sql` files, one subfolder per connection; empty uses the extension's storage. |
| `dbclient.historySize` | 500 | Entries kept in each connection's query history; `0` turns it off. Commands that can carry credentials (`AUTH`, `HELLO`, `ACL`, `MIGRATE`, `CONFIG`) are never recorded. |
| `dbclient.sqlEditor.openByDefault` | false | Open new queries and saved SQL files of the tree in the DB Client SQL editor instead of the text editor. |
| `dbclient.sqlEditor.resultsPosition` | bottom | Where the DB Client SQL editor shows its results around the SQL: `bottom`, `top`, `left` or `right` (also the layout button of its toolbar). |
| `dbclient.language` | auto | Interface language: `auto` (same as the editor), `en`, `es` or `pt-br`. |

## Development

```bash
npm install
npm run build        # bundle to dist/
npm test             # unit tests; integration tests run when DBCLIENT_* variables are set
npm run test:smoke   # runs the extension inside a downloaded VS Code
npm run package      # builds the .vsix
```

To test SSL and SSH, `eval "$(scripts/tls-fixture.sh start)"` and `eval "$(scripts/ssh-fixture.sh start)"` start throwaway servers with Docker (fresh certificates and keys) and export their `DBCLIENT_TLS_*` / `DBCLIENT_SSH_*` variables; `stop` removes them. With every server up, run `npm run test:integration` (test files one at a time). Translations live in `l10n/bundle.l10n.<es|pt-br>.json` and `package.nls.<es|pt-br>.json`; `npx tsx test/unit/l10nKeys.ts l10n/bundle.l10n.pt-br.json` lists the texts still missing.

To test the NATS authentication modes, `eval "$(scripts/nats-auth-fixture.sh start)"` starts throwaway servers (user/password, NKey, token and `.creds`, with Docker) and exports their `DBCLIENT_NATS_AUTH_*` variables; `scripts/nats-auth-fixture.sh stop` removes them.

### Publishing

Bump `version` in `package.json`, add its section to `CHANGELOG.md`, commit, then push a tag with the same version:

```bash
git tag v0.19.0 && git push origin main v0.19.0
```

The **Release** workflow (`.github/workflows/release.yml`) runs the tests, builds the `.vsix`, attaches it to a GitHub Release with the changelog notes and publishes it to Open VSX and the VS Code Marketplace when the repository secrets `OVSX_PAT` and `VSCE_PAT` exist. From this machine: `OVSX_PAT=… npm run publish:ovsx` and `VSCE_PAT=… npm run publish:vsce`.

Press **F5** in this folder to start an Extension Development Host. Requirements and progress are tracked in [spec.md](spec.md).
