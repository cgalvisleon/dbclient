# Changelog

## 0.16.0 — 2026-10-20

- **Clear** on the **Output** tab empties the log and numbers queries from 1 again (open result tabs are renumbered in their current order).
- Right-click a result cell: **Copy Value**, **Copy Row** (TSV with header), **Copy Row as JSON**, and on results of one table **Generate INSERT/UPDATE/DELETE from Row**, which opens the statement with the row's values in a new editor bound to the connection (`WHERE` by primary key, or by every column with a warning comment).

## 0.15.0 — 2026-10-19

- SQL and Redis editors show their connection and database on the first line, with **Change Connection…**; the status bar tooltip adds the engine and whether it is connected. Setting `dbclient.connectionLens` turns the line off.
- Changing the connection of an editor that already had one asks for confirmation first.
- Results panel: **Output** is always the first tab; result tabs are kept across runs by default (up to 50, oldest closed first; uncheck **Keep tabs** for the old behavior), can be reordered by dragging and closed with a middle click.

## 0.14.0 — 2026-10-19

- **Open SQL** on tables and views: opens the same `SELECT * FROM` as **Open Data** in a new editor bound to the connection, without running it.

## 0.13.2 — 2026-10-18

- Store page: installation from the VS Code Marketplace (VS Code) and Open VSX (Cursor, VSCodium, Windsurf), with the Marketplace badge. No functional changes.

## 0.13.1 — 2026-10-18

- Store name changed to **DB Client: SQL, Redis & NATS** ("DB Client" is taken on the VS Code Marketplace); first release on the Marketplace. No functional changes.

## 0.13.0 — 2026-10-18

- **Refresh** on a connection, database, schema, folder, table or view re-reads it from the database, so schemas and tables created or dropped elsewhere show up. DDL run from the SQL editor refreshes the connection by itself.
- **Drop…** in the tree removes tables and views on every SQL engine (CASCADE on PostgreSQL, CASCADE CONSTRAINTS on Oracle, materialized views on PostgreSQL) and schemas where the engine has them: PostgreSQL and SQL Server schemas, MySQL databases, Oracle users. The dialog shows the `DROP` statement; schemas also ask for their name.

## 0.12.4 — 2026-10-16

- Sharper extension icon: redrawn as a vector and exported at 256 px for high-density screens.

## 0.12.1 — 2026-10-16

- Repackaged, no functional changes.

## 0.12.0 — 2026-10-16

- Connection folders can change their icon color: palette button on the folder, **Change Folder Color…** in its context menu or the Command Palette.
- MIT license, changelog and a release workflow for Open VSX, the VS Code Marketplace and GitHub Releases.

## 0.11.1 — 2026-10-16

- Repackaged, no functional changes.

## 0.11.0 — 2026-10-16

- **Appearance** section in the connection form: 6 icon shapes and 7 colors (blue, green, red, orange, purple, yellow, gray) with a live preview, for light and dark themes.
- **Export Connections…** on a connection exports the selected connections (without folders); **Import Connections…** on a folder merges a file into that folder.

## 0.10.0 — 2026-10-16

- **Settings and About** panel (⚙ in the view title): where the extension keeps its data, the `dbclient.*` settings against their defaults, the environment and the author's links.

## 0.9.2 — 2026-10-13

- Oracle connections by JDBC URL: service, SID, `tcps://`, descriptor or tnsnames.ora alias; credentials in the URL move to their fields.

## 0.9.1 — 2026-10-13

- **Show/Hide** button on every password field of the connection form.

## 0.9.0 — 2026-10-12

- SSL/TLS for PostgreSQL, MySQL, SQL Server, Oracle (TCPS), Redis and NATS: disable, require or verify-full, with CA, client certificate and key.
- SSH tunnel for every network engine (password or private key, host key fingerprint).
- Spanish interface, following the editor language.

## 0.8.0 — 2026-10-12

- Export and import connections and folders without secrets (merge or replace).

## 0.7.0 — 2026-10-12

- Table actions from the tree: Open Data, Show Structure, Show DDL, generate SELECT/INSERT/UPDATE/DELETE.
- Completion of real schemas, tables, views and columns, resolving aliases.
- Editing data in the results grid (cells, new and deleted rows, commit in one transaction).

## 0.6.0 — 2026-10-12

- Query history per SQL and Redis connection.
- NATS authentication with user/password, token, NKey and `.creds` files.

## 0.5.0 — 2026-10-12

- MySQL, SQL Server, Oracle and SQLite drivers; Redis (tree, `.redis` editor, value viewer) and NATS (console, JetStream).
- Folders for connections, saved and linked SQL folders per connection, export of results to Excel.

## 0.1.0 — 2026-10-12

- First version: PostgreSQL connections, SQL editor with results in tabs, SQL output and keyword completion.
