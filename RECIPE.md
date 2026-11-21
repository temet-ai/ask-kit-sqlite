# Recipe: the sqlite kit

## What it answers

Which tables, views and columns a SQLite file has; how many rows; what a row says; which table and column hold a value; how big the file and each table are; whether it is sound (quick_check, integrity_check, foreign keys), how many pages are free and what its journal mode and WAL are. It also acts: any SQL that changes the file, through `sqlite.exec`.

## What it needs

- Node.js 22.13 or newer, for `node:sqlite`. No `sqlite3` program and no package.
- ask-kit 0.3.0 or newer (`min_ask_kit = "0.3.0"`).
- No tokens. Two settings: `WORKDIR` (detected: the folder the agent runs in; relative paths resolve against it) and the optional `SQLITE_DB` (the database used when a question names none).

## What it reads and runs

It reads the SQLite files the questions name, and, for `sqlite.files`, the names and first 16 bytes of files under the working folder (6 folders deep, 20000 entries, 5 seconds; `node_modules`, `.git`, `target`, `.venv` and the like are skipped). It runs one program: Node itself, as a child process with `worker.mjs`, once per call, killed at the call's timeout. No shell.

How a file is opened for reading, so that nothing is created or changed beside it:

- A rollback-journal database: read-only.
- A WAL database whose `-wal` is empty or absent: the URI `file:...?immutable=1`. A plain read-only open would create `-wal` and `-shm` and leave them.
- A WAL database with content in its `-wal` and a `-shm` beside it (another program has it open): read-only, with a 1.5 second busy timeout. This uses the existing side files.
- When that is refused (an exclusive lock, an unfinished journal), or the `-wal` has content and there is no `-shm`: the file and its `-wal` or `-journal` are copied to a folder under the system's temporary folder (up to 1 GB), the copy is opened with `query_only`, and the folder is removed. The result carries `openNote`.
- Last, the main file alone with `immutable=1`, with an `openNote` that says the data may be stale.

Redacted because answers go to a cloud model: string and blob values of result columns whose name, or whose origin column behind an alias, subquery or view, looks like a credential (password, passwd, pwd, secret, token, api_key, access_key, private_key, credential, cookie, auth, salt, otp, session_key, session_token, session_data, sid, sess, encrypted, card_number); the `value` column of a table named like cookies, tokens, logins or secrets; the value of a key/value row whose key looks like one; and every text expression of a query that names such a column. `search` does not search those columns. `session_id` and numeric columns such as `input_tokens` are not treated as credentials. On Node before 22.16 a statement's column origins are not available: a query that names a credential column then has all its text values redacted, and a view that renames one is not caught.

Refused: in `query`, anything but one statement starting with SELECT, WITH, VALUES, EXPLAIN or PRAGMA, and any statement the read-only connection rejects; `exec` without act.

## Brief to rebuild it from an empty folder

Make a folder with `ask-kit.toml` (id `temet.sqlite`, name `sqlite`, `says`, `keywords`, `route_hint`, `cite`, `acts = ["sqlite.exec"]`, the settings `WORKDIR` with `detect` and `SQLITE_DB` with an empty default, one `[[sources]]` of kind `module`, name `sqlite`, module `sqlite.mjs`, api `api.d.ts`, `instructions = "instructions.md"`, and two reading `[[actions]]`: `overview` for "what tables are in <file>" and `health` for "is <file> healthy", each with `expect`).

`sqlite.mjs` exports `make({settings, push, act})` returning the `sqlite` global. Each function resolves `file` (absolute, relative to `WORKDIR`, `~` expanded; default `SQLITE_DB`, else the only SQLite file found), returns `{file, error}` for a missing file or a folder, and otherwise sends a job as JSON on stdin to `node --disable-warning=ExperimentalWarning worker.mjs` with `execFile`, a timeout and SIGKILL, journals the call with `push`, and removes the job's temporary folder. Functions: `files(dir?)` (in-process: walk, check the 16-byte header), `tables(file)`, `schema(file, table?)`, `info(file)`, `check(file, {full})`, `search(file, value, {exact, tables, scan})`, `query(file, sql, params?, {max, clip, timeoutMs})` (refuses by first keyword and by a second statement, after removing string literals and comments), `exec(file, sql, params?, {create})` (throws `not in this ask: ...` unless `act`).

`worker.mjs` opens the file as described above and runs one operation: `tables` (`pragma_table_list`, `count(*)` per table within 5 seconds, sizes from `dbstat` for files up to 256 MB), `schema` (`pragma_table_xinfo`, `index_list`, `index_xinfo`, `foreign_key_list`, triggers and the CREATE text; a name is matched exactly, then in any case, then as a substring, and an unknown name is thrown with the names that exist), `info` (header and pragmas), `check` (`quick_check` or `integrity_check`, `foreign_key_check` grouped by table), `search` (per table one statement that sums a LIKE or equality test per column over the first `scan` rows, then a few example rows per hit, within 20 seconds), `query` (iterate, keep `max` rows, keep counting to a million rows or 8 seconds, clip text, show blobs by size, read integers as BigInt and return unsafe ones as strings, redact), `exec` (read-write connection, `exec` for several statements or a prepared statement with params, `changes` from `total_changes()`).

Scripts in `scripts/` (each `export const meta = {purpose, params, returns, example}` and `export default async function ({sqlite}, params)`, each returning a one-line `verdict`): `overview`, `describe`, `find-column`, `sample`, `where-value`, `health`. `lib.mjs` holds their shared helpers.

`instructions.md` has the docker kit's structure: how to work (the file, scripts first, then `sqlite.query` with params after reading the schema, errors are data, credentials are off limits, verdicts from evidence, acting only through `exec` and reading back), and the answer format.

`bench/fixture/build.mjs` builds `bench/fixture/watch.db` with `node:sqlite`: the Ankh-Morpork City Watch, with posts, guards, patrols, incidents, accounts (a `password_hash` and an `api_token` column), a key/value `settings` table with a password, a view, one patrol that breaks a foreign key and free pages from a dropped table. `bench/questions.json` holds shots against it with `expect` patterns checked against the output; run `ask-kit kit test sqlite` from the kit's folder. Questions for the model (`q`) are still to be added, from real sessions in which an agent dug through a SQLite file by hand, with expectations checked against that file.

## Results

ask-kit `kit test` on 2026-11-20: 14/14 shots pass, all answered with no model. No model run has been made yet.
