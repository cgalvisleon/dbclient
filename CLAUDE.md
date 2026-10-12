# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Current state

`dbclient` is at the definition stage: the only source of truth so far is `feature.md` (written in Spanish). There is no code, no `package.json`, no build/lint/test tooling, and the folder is not a git repository yet. It is also not part of the workspace `go.work`. When the project gets scaffolded, replace this section with the real commands (build, lint, run a single test, launch the Extension Development Host, package the `.vsix`).

## What is being built

A VS Code extension named `dbclient`: a database client in the style of the "Database Client" extension the user already has installed (`cweijan.vscode-database-client2`, plus its `cweijan.dbclient-jdbc` companion) — use it as the functional reference. Targets:

- SQL engines: PostgreSQL, SQLite, MySQL, MSSQL, Oracle — each with a SQL editor whose autocompletion depends on the connection's driver/dialect.
- Redis — with its own command autocompletion.
- NATS — subscribe to subjects and publish messages.
- Connection configuration persisted in one centralized place (not scattered per workspace).

## Documentation workflow

- `feature.md` is the user's own feature definition. When asked to complement it, add content in the same plain bullet style — don't restructure or reformat what is already there.
- `spec.md` (to be created) holds the detailed specification plus a gap analysis (brecha) between the current implementation and the goal in `feature.md`.
- Every change to the project must be followed by updating `spec.md` and recalculating the gap, so the spec always reflects the real implementation status.
