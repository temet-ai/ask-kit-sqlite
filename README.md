# ask-kit-sqlite

An [ask-kit](https://github.com/temet-ai/ask-kit) kit that lets your coding agent's `ask` tool
answer questions about a SQLite database file: an app's dev database, an agent's or a tool's state
database, a browser database. A cheap model lists the tables, reads the schema, runs queries and
checks the file outside your agent's context, and answers with table and column names, counts and
rows. It uses Node's own `node:sqlite`, so it needs no `sqlite3` program.

Questions it is built for, which agents answer by hand with many `sqlite3` calls:

- Which tables are in `dev.db`, and how many rows does each have?
- Which table has a `guard_id` column, and where is the value `WATCH-12` stored?
- Is `state.db` corrupt, and would VACUUM make it smaller?

## Install

You need [ask-kit](https://github.com/temet-ai/ask-kit#set-it-up) and Node.js 22.13 or newer,
which ask-kit needs anyway. Nothing else is installed.

Paste this into your agent:

```
Read ~/.config/ask-kit/AGENTS.md, then add this kit: github.com/temet-ai/ask-kit-sqlite
```

Or run it yourself:

```sh
ask-kit kit install temet-ai/ask-kit-sqlite        # shows what it reads, changes and runs
ask-kit kit install temet-ai/ask-kit-sqlite --yes  # installs and enables it
```

Restart your agents so `ask` lists `sqlite`. `ask-kit kit list` says whether it can run on this
machine, and why not.

A question names its file, as a path that is absolute or relative to the folder the agent runs
in. The optional setting `SQLITE_DB` is the database used when a question names none; without it,
the kit uses the only SQLite file in the folder, or lists them when there are several.

## What it can change

When asked, `sqlite.exec` runs any SQL that changes the file: INSERT, UPDATE, DELETE, CREATE,
ALTER, DROP, VACUUM. It is the only acting call, and it throws unless the caller asked for a
change (`act: true`).

Everything else reads, and `sqlite.mjs` and `worker.mjs` hold it to that:

- A query is one statement that starts with SELECT, WITH, VALUES, EXPLAIN or PRAGMA, on a
  read-only connection. Anything that writes is refused.
- Reading never changes the file and never leaves a `-wal`, `-shm` or journal file beside it. A
  database that another program has open is read as any reader would read it. One that is held
  with an exclusive lock, as a running browser holds its own, is read from a temporary copy, and
  the answer says so.
- Credentials are replaced with `<redacted>`: values of columns named like password, token,
  secret, API key, cookie or session key, the values of cookie and login tables, and the value of
  a key/value row whose key looks like one. The value search skips those columns. What the
  investigator reads goes to a model. The rule goes by names, so a credential in a column called
  `notes` is not caught.
- Every call runs in a child process that is stopped at its timeout (30 seconds for a query), and
  results are capped: 200 rows, long text clipped, blobs shown by size.

## How well it works

The bench, `bench/questions.json`, holds 14 shots (a script and its params, no model) against the
fixture `bench/fixture/watch.db`. `ask-kit kit test sqlite`, run from the kit's folder on
2026-11-20, passes 14/14 offline. No model run has been made yet: the bench has no model
questions, because ask-kit takes those only from real sessions and none were at hand.

## What is in it

`sqlite.mjs` gives the investigator `files`, `tables`, `schema`, `info`, `check`, `search`,
`query` and `exec`; `worker.mjs` is the child process that opens the database. Its scripts are
`overview` (size, pages, journal mode and every table with rows, columns and indexes, biggest
first), `describe` (one table's columns, indexes, foreign keys and CREATE statement),
`find-column` (tables and columns by name), `sample` (rows of a table, newest first, with a
condition), `where-value` (which tables and columns hold a value) and `health` (quick_check or
integrity_check, foreign key violations, free pages, the WAL). Two questions are answered with no
model at all: "what tables are in `<file>`" and "is `<file>` healthy". [RECIPE.md](RECIPE.md)
says what it reads and runs, and how to rebuild it.

MIT licence.
