# Changelog

## 0.20.2 — 2026-10-21

- DB Client SQL editor: the results (Output and result tabs) can go below, above, left or right of the SQL — layout button in its toolbar, or `dbclient.sqlEditor.resultsPosition`; every open SQL editor follows the change, and the divider turns vertical beside the SQL.
- Output tab: the entries keep the arrow pointer instead of the hand (a click still goes to the statement).
- Disconnecting a connection while a query runs on it ends that run at once (logged as `Cancelled: The connection was closed.`, the server is asked to stop the query). Before, the editor waited for the query to finish on the server and refused to run anything else until then, so after connecting again it looked like it had lost its connection.
- Clicking a SQL file in the tree (SQL folder, linked folders, a database's SQL folder) opens it in the DB Client SQL editor; 0.20.1 still opened it in the text editor.
- **Open Data**, **Open SQL**, **Show DDL**, **Generate SQL**, the SQL generated from a result row and the statements Query History opens now use the DB Client SQL editor (when `dbclient.sqlEditor.openByDefault` is on, the default); Open Data shows its results inside that editor.
- **Query History…** from the Command Palette inserts the statement at the caret of the active DB Client SQL editor instead of opening a new editor.
- One tab per query: **Open in DB Client SQL Editor** and 📄 (open as text) replace the tab instead of opening a second one next to it, and opening a SQL file that is already open as text moves it to the SQL editor.

## 0.20.1 — 2026-10-21

- The DB Client SQL editor is now the default for new queries and saved SQL files of the tree (`dbclient.sqlEditor.openByDefault` defaults to `true`; turn it off to keep the text editor).
- The **DB Client** tab of the bottom panel is hidden until something is shown in it (Redis commands, Show Structure, runs from the text editor).
- DB Client SQL editor: the toolbar buttons and drop-downs show a tooltip (with the keyboard shortcut of the run buttons), also on disabled buttons and on keyboard focus.
- Saving an untitled query of the DB Client SQL editor in the SQL folder no longer leaves the untitled tab open next to the saved file; renaming and deleting a saved SQL file also close its SQL editor tab.

## 0.20.0 — 2026-10-21

- Disconnecting a connection collapses its detail in the tree.
- **■ Cancel** stops the running query from a button in the editor title bar (only while a query runs) and from the lens of the statement being executed, which shows **Running…** and **■ Cancel** instead of ▶ Run.
- Cancelling is no longer reported as a SQL error (no red underline): the Output tab shows `Cancelled` and how many statements were not run. A cancel pressed while the connection is still opening stops the run before its first statement, and a new run waits until the cancel has reached the server, so it can never interrupt the next query.

## 0.19.0 — 2026-10-21

- **DB Client SQL editor** (optional, NetBeans style): open a `.sql` file with **Open in DB Client SQL Editor** or **Reopen Editor With…**. It has a toolbar with drop-downs for the connection (grouped by folder) and the database, icon buttons for every action, the SQL with syntax highlighting (CodeMirror), and its own results below in the same tab with a draggable divider. The file stays a normal document (save, undo, Git). `dbclient.sqlEditor.openByDefault` opens new queries and saved SQL files of the tree there. Autocompletion and inline errors come in a later version.
- Text editor: the first line now shows only the connection and database selector, and ▶ Run appears above every statement. Run file, run selection, copy, paste and save are buttons in the editor title bar; the other actions (run statement, cancel, change/connect/disconnect, history, export, import, open in the SQL editor) are in its `…` menu.
- Interface in Brazilian Portuguese, and a `dbclient.language` setting (default `auto`, the editor's language) with a selector in **Settings and About**.

## 0.18.0 — 2026-10-20

- NetBeans-style editor toolbar: the first line of SQL and Redis editors shows `Connection:` with the connection and database as a drop-down, followed by icon-only buttons with tooltips (the separate **Change Connection…** is gone; the drop-down does the same).
- New toolbar buttons: **stop** (only while a query runs), **connect/disconnect** the editor's connection, **Query History…** and **Save to Connection's SQL Folder** (SQL editors).
- The editor title's `…` menu also lists run statement, run selection, cancel, copy, paste, export and import.
- Documentation in Brazilian Portuguese (`README.pt.md`), linked from the English and Spanish READMEs.

## 0.17.0 — 2026-10-20

- Every database of a SQL connection has its own **SQL** node in the tree; its files run against that connection and database, and **New SQL File** on a database creates them there.
- Files with unsaved changes show `● unsaved` and a **Save** button in the tree.
- The first line of SQL and Redis editors is a bar: the connection and database (click to pick a connection, then a database), **Change Connection…**, **Run All**, **Statement**, **Selection**, **Copy**, **Paste**, **Export** and **Import**.

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
