<img src="media/icon.png" width="72" align="right" alt="DB Client">

# DB Client

[Español](README.es.md)

## Installation

Download `dbclient-<version>.vsix` (or build it with `npm install && npm run package`), then in VS Code or Cursor open the Command Palette (`Ctrl/Cmd+Shift+P`), run **Extensions: Install from VSIX…** and pick the file. It needs VS Code 1.90 or newer; SQLite connections need an editor running Node 22.13 or newer (Cursor, VS Code 1.101+). No native modules or database clients are required.

## What it is

A database client inside the editor. PostgreSQL, MySQL, SQL Server, Oracle, SQLite, Redis and NATS connections live in one tree, and each kind opens its own editor: a SQL editor modeled on NetBeans, a Redis command editor with a value viewer, and a NATS console.

Connections are stored once per user, shared by every window and workspace. Passwords and tokens go to the editor's secret storage, never to the settings file.

## Features

| Area | What you get |
|---|---|
| Connections | One tree for every engine; create, edit, duplicate, delete, test, connect and disconnect from a form. |
| Folders | Group connections in nested folders; create, rename, delete (content moves up a level), move with **Move to Folder…** or by drag and drop. |
| Storage | User-level `connections.json`; secrets in the editor's secret storage. |
| Explorer (SQL) | Databases/schemas → tables, views, functions, procedures, triggers, indexes (Oracle: packages, sequences) → columns with type, PK and NOT NULL. |
| SQL editor | Connection picker in the status bar and editor title; run the statement under the cursor, the selection or the whole file; ▶ Run above each statement; cancel. |
| Statement splitting | `;` everywhere, plus `GO` (SQL Server), `DELIMITER` (MySQL), `/` and PL/SQL blocks (Oracle), `$$` bodies (PostgreSQL), triggers (SQLite). |
| Results | Bottom panel with one tab per result set, optional tab keeping, paging, sorting, row selection, copy as TSV, export to CSV/JSON. |
| SQL output | Each statement logged with time, rows fetched/affected and errors; errors jump to the line and column in the editor and are underlined. |
| SQL completion | Keywords, types and functions of the connection's dialect. |
| Redis explorer | Databases with key counts → keys grouped by separator (`:`) with their type, using `SCAN`. |
| Redis editor | `.redis` files, one command per line; completion of commands, options and existing keys; asks before `FLUSHDB`/`FLUSHALL`. |
| Redis values | Viewer/editor for string, hash, list, set, sorted set and stream; TTL, rename and delete. |
| NATS | Publish with headers, request/reply, subscribe with `*`/`>` wildcards and queue groups, live message list; JetStream streams and consumers in the tree. |

## Usage

**Add a connection.** Open the **DB Client** view in the activity bar, press **+**, choose the type, fill in the form, press **Test** and then **Save**. Expand the connection to browse it.

**Organize with folders.** Press the **New Folder** button in the view title (or **New Folder** on a folder for a subfolder). Drag connections or folders onto a folder, or use **Move to Folder…**; drop them on empty space to return them to the top level. **Add Connection** on a folder creates the connection inside it, and the form's **Folder** field changes it later.

**Query a SQL database.** Click **New Query** on a connection or database. Write SQL and press `Ctrl/Cmd+Enter` to run the statement under the cursor (or the selection), or `Ctrl/Cmd+Shift+Enter` to run the whole file:

```sql
select id, name from customers where created_at > now() - interval '7 days';
update customers set active = false where id = 42;
```

Each query opens a tab in **DB Client → Results**; the **Output** tab lists every statement with its time and row count.

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

**Publish and subscribe with NATS.** Click **Open NATS Console** on a NATS connection. Subscribe to `orders.>` and publish to `orders.created` with a JSON payload and headers such as `X-Trace: abc`; incoming messages appear in the list, and selecting one shows its payload and headers.

## Settings

| Setting | Default | Description |
|---|---|---|
| `dbclient.maxRows` | 5000 | Rows fetched per statement; larger results are truncated. |
| `dbclient.pageSize` | 100 | Rows per page in the results grid. |
| `dbclient.codeLens` | true | Show ▶ Run above each SQL statement. |

## Development

```bash
npm install
npm run build        # bundle to dist/
npm test             # unit tests; integration tests run when DBCLIENT_* variables are set
npm run test:smoke   # runs the extension inside a downloaded VS Code
npm run package      # builds the .vsix
```

Press **F5** in this folder to start an Extension Development Host. Requirements and progress are tracked in [spec.md](spec.md).
