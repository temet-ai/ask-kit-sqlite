// Every function takes the database as `file`: a path, absolute or relative to the working folder, with ~ for
// the home folder. Leave it out (undefined) for the default: the SQLITE_DB setting, else the only SQLite file
// in the working folder.
//
// An ordinary failure is returned, not thrown: {file, error} for a missing file, a file that is not SQLite, a
// SQL error (with `have`, the table names, when a table does not exist), a lock or a timeout. Check r.error.
// A call throws only for a refusal, a missing argument or a table name that matches nothing.
//
// Credentials are never shown. A value is replaced with "<redacted>" when its column name looks like one
// (password, passwd, pwd, secret, token, api_key, access_key, private_key, credential, cookie, auth, salt, otp,
// session_key, session_data, sid, encrypted ...), when it is the `value` of a table of cookies, tokens or
// logins, or when it is the value of a key/value row whose key looks like one. The rule follows a column
// through an alias, a subquery and a view, and a query that names such a column has its text expressions
// redacted too (substr(api_token, 1, 4)). You can still count, group and test them: count(*), length(x),
// x is null. Do not try to get round it; say that the value is a credential and is not shown.
//
// Reading never changes the file and never leaves a -wal, -shm or journal file beside it. A database that
// another program holds with an exclusive lock (a running browser) is read from a temporary copy; the result
// then has `openNote`, which you repeat in the answer.

interface Failure { file: string; error: string; have?: string[]; timedOut?: boolean; sqliteFilesThere?: string[] }
interface Opened { openNote?: string } // set when the file was read from a copy, or from the main file only

interface Rows extends Opened {
  file: string;
  columns: string[];             // a name that repeats (a join with select *) becomes "table.column"
  rows: Record<string, any>[];   // null, number, string; a blob is "<blob N bytes>"; a long text is cut with "...[+N chars]"
  total: number;                 // rows the statement produced
  complete: boolean;             // false when `rows` holds only the first `max`
  totalIsMinimum?: true;         // counting stopped (a million rows, or 8 seconds): there are at least `total`
  redacted?: string[];           // result columns whose values were replaced with "<redacted>"
}

declare const sqlite: {
  workdir: string;          // the folder relative paths resolve against
  default: string | null;   // the SQLITE_DB setting, or null

  // SQLite files under a folder (default: the working folder), newest first, recognised by their header, so a
  // file with any extension counts. At most 6 folders deep and 50 files; node_modules, .git, target, .venv and
  // the like are skipped. Synchronous.
  files(dir?: string, o?: { depth?: number; max?: number }): { root: string; files: { file: string; bytes: number; modified: string; wal?: true }[]; total: number; complete: boolean; note?: string };

  // Tables and views, biggest first. kind is table | view | virtual (FTS, rtree) | shadow (a virtual table's own
  // storage). rows is null when counting was cut short (it stops after 5 s) or failed (`error`). bytes and
  // indexBytes are on disk, for files up to 256 MB.
  tables(file?: string, o?: { max?: number }): Promise<Failure | (Opened & { file: string; tables: { name: string; kind: string; rows: number | null; columns: number; indexes: number; bytes?: number; indexBytes?: number; error?: string }[]; total: number; complete: boolean; note?: string })>;

  // With a table: its columns, indexes, foreign keys, the tables that point at it, triggers, row count and
  // CREATE statement. The name is matched exactly, then in any case, then as a substring; `matched` says which.
  // A name that matches nothing, or several tables, throws with the names that exist.
  // Without a table: every table and view with its columns on one line ("id INTEGER pk, name TEXT not null").
  schema(file: string | undefined, table: string): Promise<Failure | (Opened & {
    file: string; table: string; matched: string; kind: string; withoutRowid?: true; strict?: true; rows: number | null;
    columns: { name: string; type: string | null; pk?: number; notNull?: true; default?: string; hidden?: true; generated?: "virtual" | "stored"; secret?: true }[];
    indexes: { name: string; columns: string[]; unique?: true; primaryKey?: true; partial?: true }[];
    foreignKeys: { columns: string[]; references: string; referencedColumns: string[]; onDelete?: string; onUpdate?: string }[];
    referencedBy: string[]; triggers: string[]; sql: string | null;
  })>;
  schema(file?: string): Promise<Failure | { file: string; tables: { name: string; kind: string; columns: string }[]; total: number; complete: boolean }>;

  // File and page facts: size, page size, pages, free pages, journal mode ("wal" or "delete" and the like), the
  // size of the -wal and -journal files beside it (null when there is none), user_version, counts of objects.
  info(file?: string): Promise<Failure | (Opened & { file: string; bytes: number; pageSize: number; pages: number; freePages: number; freeBytes: number; journalMode: string; walBytes: number | null; shm: boolean; journalBytes: number | null; autoVacuum: string; encoding: string; userVersion: number; applicationId: number; writtenBySqlite: string | null; modified: string; tables: number; views: number; indexes: number; triggers: number })>;

  // PRAGMA quick_check (full: integrity_check, slower) and PRAGMA foreign_key_check. ok is true when the check
  // printed "ok"; problems holds its lines otherwise. Stops at 2 minutes (5 with full).
  check(file?: string, o?: { full?: boolean; timeoutMs?: number }): Promise<Failure | (Opened & { file: string; check: string; ok: boolean; problems: string[]; foreignKeys: { violations: number; byTable: { table: string; references: string; count: number; rowids: number[] }[] } })>;

  // Which tables and columns hold a value: a substring in any case, or the whole cell with exact (a number
  // also matches numeric cells). Tables and virtual tables are searched, in their first `scan` rows (default
  // 200000; `partial` names the tables that have more). Views, blobs and credential columns are not searched.
  search(file: string | undefined, value: string | number, o?: { exact?: boolean; tables?: string[]; scan?: number; examples?: number }): Promise<Failure | (Opened & { file: string; value: string; match: string; hits: { table: string; column: string; rows: number; examples: { row?: string; value: any }[] }[]; tablesSearched: number; partial?: string[]; notSearched?: string[]; skippedSecret?: string[]; errors?: string[] })>;

  // One statement that reads: SELECT, WITH, VALUES, EXPLAIN [QUERY PLAN] or PRAGMA, on a read-only connection.
  // params: an array for ?, or an object for :name / $name. Put values there, not in the SQL text.
  // max: rows returned (default 200, at most 5000); clip: characters kept of a long text (default 300).
  // Stops at 30 s (timeoutMs, at most 300000). Quote odd names with double quotes: select * from "my table".
  // Anything that writes is refused here; it is sqlite.exec.
  query(file: string | undefined, sql: string, params?: any[] | Record<string, any> | null, o?: { max?: number; clip?: number; timeoutMs?: number }): Promise<Failure | Rows>;

  // ACTS. Runs SQL that changes the database: INSERT, UPDATE, DELETE, CREATE, ALTER, DROP, VACUUM, PRAGMA
  // journal_mode ... It throws "not in this ask" unless the caller asked for a change (act: true).
  // Without params the string may hold several statements separated by ; (wrap them in BEGIN; ... COMMIT; to
  // make them one transaction). With params it is one statement; a RETURNING clause gives `rows`.
  // changes counts rows inserted, updated and deleted. Foreign keys are enforced on this connection.
  // A file that does not exist is an error unless o.create is true.
  exec(file: string | undefined, sql: string, params?: any[] | Record<string, any> | null, o?: { create?: boolean; timeoutMs?: number }): Promise<Failure | ({ file: string; ok: true; changes: number; lastInsertRowid: number } & Partial<Rows>)>;
};
