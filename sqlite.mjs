// SQLite files for ask-kit, through node:sqlite: which tables and columns a file has, how many
// rows, what a row says, which table holds a value, how big and how healthy it is. It reads; with
// act it also runs SQL that changes the file (`exec`).
//
// Every call runs in a child process (worker.mjs) that is killed at its timeout, because
// node:sqlite is synchronous and a slow query cannot be stopped from inside. The child is where
// the ExperimentalWarning is silenced, so this process's warnings are untouched.
//
// Three rules, in the worker and here:
//  - reading never changes the file or leaves a -wal, -shm or journal file beside it;
//  - values of columns that hold credentials are replaced with <redacted>, because what the
//    investigator reads goes to a cloud model;
//  - `query` runs one reading statement on a read-only connection; anything else is `exec`.
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORKER = path.join(path.dirname(fileURLToPath(import.meta.url)), "worker.mjs");
const MAGIC = "SQLite format 3\u0000";
const SKIP_DIRS = new Set(["node_modules", ".git", ".hg", ".svn", "target", ".venv", "venv", "__pycache__", ".tox", ".mypy_cache", ".pytest_cache", ".gradle", ".next", ".nuxt", ".turbo", ".cargo", ".rustup", "vendor", "Pods", "bower_components"]);
const DB_EXT = /\.(db|db3|sqlite|sqlite3|s3db|sl3|sqlitedb)$/i;
const NOT_DB_EXT = /\.(js|mjs|cjs|ts|tsx|jsx|json|md|txt|html|css|py|rs|go|java|c|h|cpp|rb|sh|toml|ya?ml|lock|png|jpe?g|gif|svg|pdf|zip|gz|tar|wasm|map|log)$/i;
// The same names the worker redacts; here they decide whether a query's expressions are hidden.
const SECRET_WORD =
  /passw|passphrase|(^|_)pwd|secret|token(?!iz)|api[_-]?key|access[_-]?key|private[_-]?key|priv[_-]?key|signing[_-]?key|encryption[_-]?key|credential|cookie|(^|_)auth($|_)|authorization|bearer|(^|_)salt($|_)|(^|_)t?otp($|_)|recovery[_-]?code|backup[_-]?code|session[_-]?(key|token|secret|data|cookie)|^sid$|^sess$|encrypted|card[_-]?number|(^|_)cvv|(^|_)ssn($|_)/i;

/** SQL without its string literals and comments, for looking at keywords and identifiers. */
export const bare = (sql) => String(sql).replace(/'(?:[^']|'')*'|--[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m[0] === "'" ? "''" : " "));

const isSqlite = (file) => {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const b = Buffer.alloc(16);
    return fs.readSync(fd, b, 0, 16, 0) === 16 && b.toString("latin1") === MAGIC;
  } catch {
    return false;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
};

export function make({ settings = {}, push = () => {}, act = false } = {}) {
  const workdir = path.resolve(settings.WORKDIR || process.env.WORKDIR || process.cwd());
  const preset = settings.SQLITE_DB || process.env.SQLITE_DB || null;
  const home = os.homedir();
  let seq = 0;

  const abs = (p) => {
    const s = String(p);
    if (s === "~") return home;
    if (s.startsWith("~/") || s.startsWith("~\\")) return path.join(home, s.slice(2));
    return path.resolve(workdir, s);
  };
  const shown = (file) => {
    const rel = path.relative(workdir, file);
    return rel && !rel.startsWith("..") && !path.isAbsolute(rel) && path.dirname(workdir) !== workdir ? rel : file;
  };

  /** SQLite files under a folder, found by their header. Bounded in depth, entries read and results. */
  function files(dir, o = {}) {
    const root = dir ? abs(dir) : workdir;
    const depth = o.depth ?? 6;
    const max = o.max ?? 50;
    const started = Date.now();
    const found = [];
    let seen = 0;
    let cut = null;
    const walk = (d, level) => {
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (cut) return;
        if (++seen > 20000) return void (cut = "20000 directory entries were read");
        if (Date.now() - started > 5000) return void (cut = "the scan took 5 s");
        const p = path.join(d, e.name);
        if (e.isDirectory()) {
          if (level < depth && !SKIP_DIRS.has(e.name)) walk(p, level + 1);
        } else if (e.isFile()) {
          if (/-(wal|shm|journal)$/.test(e.name)) continue;
          const named = DB_EXT.test(e.name);
          if (!named && NOT_DB_EXT.test(e.name)) continue;
          let st;
          try {
            st = fs.statSync(p);
          } catch {
            continue;
          }
          // A database is a whole number of pages; the smallest page is 512 bytes.
          if (st.size < 512 || (!named && st.size % 512)) continue;
          if (!isSqlite(p)) continue;
          found.push({ file: shown(p), bytes: st.size, modified: st.mtime.toISOString(), ...(fs.existsSync(`${p}-wal`) ? { wal: true } : {}) });
        }
      }
    };
    if (!fs.existsSync(root)) return { root, files: [], total: 0, complete: true, error: `no such folder: ${root}` };
    walk(root, 0);
    push({ kind: "sqlite.files", detail: root, ms: Date.now() - started, code: 0, size: found.length });
    found.sort((a, b) => b.modified.localeCompare(a.modified));
    return { root, files: found.slice(0, max), total: found.length, complete: found.length <= max && !cut, ...(cut ? { note: `the scan stopped early: ${cut}; name a subfolder` } : {}) };
  }

  /** The file a call is about: the one named, else SQLITE_DB, else the only SQLite file under WORKDIR. */
  function resolve(file) {
    if (file != null && file !== "") return abs(file);
    if (preset) return abs(preset);
    const f = files();
    if (f.files.length === 1) return abs(f.files[0].file);
    throw new Error(
      f.files.length
        ? `which database? Pass \`file\`; SQLite files under ${workdir}: ${f.files.slice(0, 20).map((x) => x.file).join(", ")}`
        : `which database? Pass \`file\` (a path, absolute or relative to ${workdir}); no SQLite file was found under it`,
    );
  }

  /** Run one job in the worker. Ordinary failures come back as {file, error}. */
  function call(op, file, args, timeoutMs) {
    const target = resolve(file);
    const base = { file: shown(target) };
    const started = Date.now();
    const done = (r, code) => {
      push({ kind: `sqlite.${op}`, detail: `${base.file}${args?.sql ? ` ${String(args.sql).replace(/\s+/g, " ")}` : args?.table ? ` ${args.table}` : ""}`.slice(0, 200), ms: Date.now() - started, code, size: JSON.stringify(r).length });
      return r;
    };
    let st;
    try {
      st = fs.statSync(target);
    } catch {
      const near = op === "exec" && args?.create ? null : files(path.dirname(target), { depth: 1, max: 15 }).files.map((x) => x.file);
      if (near) return Promise.resolve(done({ ...base, error: `no such file: ${target}`, ...(near.length ? { sqliteFilesThere: near } : {}) }, 1));
    }
    if (st?.isDirectory()) {
      const inside = files(target, { depth: 3, max: 15 }).files.map((x) => x.file);
      return Promise.resolve(done({ ...base, error: `${target} is a folder, not a file`, ...(inside.length ? { sqliteFilesThere: inside } : {}) }, 1));
    }
    const tmp = path.join(os.tmpdir(), `ask-kit-sqlite-${process.pid}-${Date.now()}-${seq++}`);
    return new Promise((resolveP, reject) => {
      const child = execFile(process.execPath, ["--disable-warning=ExperimentalWarning", WORKER], { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer: 64 << 20, encoding: "utf8", windowsHide: true }, (err, stdout, stderr) => {
        fs.rmSync(tmp, { recursive: true, force: true });
        let r;
        try {
          r = JSON.parse(stdout);
        } catch {
          r = { error: err?.killed ? `timed out after ${timeoutMs / 1000} s and was stopped${op === "exec" ? "; SQLite rolls an unfinished transaction back" : "; ask for less (a LIMIT, one table, quick_check)"}` : `the SQLite worker failed: ${String(stderr || err?.message || "no output").trim().slice(0, 500)}`, ...(err?.killed ? { timedOut: true } : {}) };
        }
        if (r.throw) {
          done({ error: r.throw }, 2);
          return reject(new Error(`${base.file}: ${r.throw}`));
        }
        resolveP(done({ ...base, ...r }, r.error ? 1 : 0));
      });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify({ op, file: target, tmp, args }));
    });
  }

  const cap = (n, lo, hi, dflt) => Math.min(hi, Math.max(lo, Number.isFinite(Number(n)) ? Number(n) : dflt));
  const refuseWrite = (what) => {
    throw new Error(`not in this ask: ${what} changes things, and the caller did not ask for a change (act: true)`);
  };

  const api = {
    /** The folder relative paths resolve against. */
    workdir,

    /** The database used when a call names none, or null. */
    default: preset ? shown(abs(preset)) : null,

    files,

    /** Tables and views with rows, columns, indexes and bytes, biggest first. */
    tables: (file, o = {}) => call("tables", file, { max: cap(o.max, 1, 1000, 200) }, 60_000),

    /** One table in full (columns, indexes, foreign keys, CREATE statement), or every table with its columns on one line. */
    schema: (file, table, o = {}) => call("schema", file, { table, max: cap(o.max, 1, 1000, 80) }, 60_000),

    /** File size, pages, free pages, journal mode, WAL size and counts of tables, views, indexes and triggers. */
    info: (file) => call("info", file, {}, 30_000),

    /** quick_check (or integrity_check with o.full) and foreign_key_check. */
    check: (file, o = {}) => call("check", file, { full: !!o.full }, cap(o.timeoutMs, 1000, 600_000, o.full ? 300_000 : 120_000)),

    /** Which tables and columns hold a value. Columns that hold credentials are not searched. */
    search(file, value, o = {}) {
      if (value == null || value === "") throw new Error("sqlite.search needs a value to look for");
      return call("search", file, { value: String(value), exact: !!o.exact, tables: o.tables, scan: cap(o.scan, 1, 5_000_000, 200_000), examples: cap(o.examples, 0, 10, 3) }, 60_000);
    },

    /** One statement that reads: SELECT, WITH, VALUES, EXPLAIN or PRAGMA, on a read-only connection. */
    query(file, sql, params, o = {}) {
      if (typeof sql !== "string" || !sql.trim()) throw new Error("sqlite.query needs SQL: query(file, sql, params?, {max})");
      const b = bare(sql).trim().replace(/;\s*$/, "");
      if (b.includes(";")) throw new Error("sqlite.query runs one statement; send them one at a time");
      const first = (b.match(/^[a-z]+/i)?.[0] ?? "").toUpperCase();
      if (!["SELECT", "WITH", "VALUES", "EXPLAIN", "PRAGMA"].includes(first)) {
        if (!act) refuseWrite(`${first || "that statement"} through sqlite.exec`);
        throw new Error(`sqlite.query only reads (SELECT, WITH, VALUES, EXPLAIN, PRAGMA); run ${first || "that statement"} with sqlite.exec`);
      }
      const mentionsSecret = (b.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []).some((w) => SECRET_WORD.test(w));
      return call("query", file, { sql, params: params ?? null, max: cap(o.max, 1, 5000, 200), clip: cap(o.clip, 20, 20000, 300), mentionsSecret }, cap(o.timeoutMs, 1000, 300_000, 30_000)).then((r) => {
        if (r.error && /readonly database|query_only/i.test(r.error)) {
          if (!act) refuseWrite("a statement that writes");
          throw new Error("sqlite.query only reads; run a statement that writes with sqlite.exec");
        }
        return r;
      });
    },

    /** SQL that changes the database. Present in every ask; it runs only when the caller asked for a change. */
    exec(file, sql, params, o = {}) {
      if (!act) refuseWrite("sqlite.exec");
      if (typeof sql !== "string" || !sql.trim()) throw new Error("sqlite.exec needs SQL: exec(file, sql, params?)");
      return call("exec", file, { sql, params: params ?? null, create: !!o.create }, cap(o.timeoutMs, 1000, 600_000, 120_000));
    },
  };
  return api;
}
