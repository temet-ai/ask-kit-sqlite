// The child process that touches the database. sqlite.mjs starts one per call with
// `--disable-warning=ExperimentalWarning` (so node:sqlite's warning is silenced here and nowhere
// else) and kills it at the call's timeout: DatabaseSync is synchronous and cannot be interrupted
// from inside. The job arrives as JSON on stdin and the result leaves as JSON on stdout.
//
// Reading never changes the file or its folder:
//  - a WAL-mode database with nothing in its `-wal` is opened with the `immutable=1` URI. A plain
//    read-only open would create `-wal` and `-shm` files and leave them behind;
//  - a database another program is writing is opened read-only, which uses the side files that
//    are already there, as any reader does;
//  - when that is refused (an exclusive lock, as browsers take; an unfinished journal), the file and
//    its `-wal` or `-journal` are copied to a temporary folder and the copy is read.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

const MAGIC = "SQLite format 3\u0000";
const SNAPSHOT_MAX = 1 << 30;
const started = Date.now();
const elapsed = () => Date.now() - started;

// ---------- secrets ----------

const SECRET =
  /passw|passphrase|(^|_)pwd|secret|token(?!iz)|api[_-]?key|access[_-]?key|private[_-]?key|priv[_-]?key|signing[_-]?key|encryption[_-]?key|credential|cookie|(^|_)auth($|_)|authorization|bearer|(^|_)salt($|_)|(^|_)t?otp($|_)|recovery[_-]?code|backup[_-]?code|session[_-]?(key|token|secret|data|cookie)|^sid$|^sess$|encrypted|card[_-]?number|(^|_)cvv|(^|_)ssn($|_)/i;
const SECRET_TABLE = /cookie|secret|credential|passw|token(?!iz)|login|api[_-]?key|(^|_)auth/i;
const VALUE_COLUMN = /^(value|val|v|data|content|payload)$/i;
const KEY_COLUMN = /^(key|name|k|setting|option|property|variable|var|param)$/i;
// The same idea in SQL, for the value search: wider than SECRET, which only costs a missed hit.
const KEY_LIKE = ["passw", "pwd", "secret", "token", "key", "credential", "cookie", "auth", "salt", "session", "encrypted", "otp"];
const REDACTED = "<redacted>";

/** Is this column one whose values are credentials? By its own name, or a value column of a table of credentials. */
const secretColumn = (name, table) => SECRET.test(String(name ?? "")) || (!!table && SECRET_TABLE.test(table) && VALUE_COLUMN.test(String(name ?? "")));
/** The same for a declared column: a column declared as a number is a count, not a credential (input_tokens INTEGER). */
const secretDeclared = (c, table) => secretColumn(c.name, table) && !/int|real|floa|doub|num|dec|bool/i.test(c.type ?? "");
const holdsSecret = (v) => (typeof v === "string" && v !== "") || v instanceof Uint8Array;

// ---------- values ----------

const cell = (v, clip) => {
  if (v == null) return null;
  if (typeof v === "bigint") return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString();
  if (v instanceof Uint8Array) return `<blob ${v.length} bytes>`;
  if (typeof v === "string" && v.length > clip) return `${v.slice(0, clip)}...[+${v.length - clip} chars]`;
  return v;
};
const num = (v) => (typeof v === "bigint" ? Number(v) : v);
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;
const sizeOf = (f) => {
  try {
    return fs.statSync(f).size;
  } catch {
    return null;
  }
};

// ---------- opening ----------

function header(file) {
  const fd = fs.openSync(file, "r");
  try {
    const b = Buffer.alloc(100);
    const n = fs.readSync(fd, b, 0, 100, 0);
    return { n, b };
  } finally {
    fs.closeSync(fd);
  }
}

const uri = (file, query) => `${pathToFileURL(file).href.replace(/\?/g, "%3f").replace(/#/g, "%23")}?${query}`;

function probe(db) {
  db.prepare("select count(*) from sqlite_schema").get();
  return db;
}

/** Open for reading. Returns {db, via, note?}; throws an Error whose message is the reason. */
function openRead(file, tmp) {
  const st = fs.statSync(file);
  if (st.size === 0) throw new Error("the file is empty (0 bytes): a database nothing has been written to yet");
  const { n, b } = header(file);
  if (n < 16 || b.toString("latin1", 0, 16) !== MAGIC) throw new Error("not a SQLite database: the file does not start with 'SQLite format 3' (it may be encrypted, for example SQLCipher, or another format)");
  const wal = b[18] === 2 || b[19] === 2;
  const side = { wal: sizeOf(`${file}-wal`), shm: sizeOf(`${file}-shm`), journal: sizeOf(`${file}-journal`) };
  const reasons = [];

  // Nothing is pending beside it: the main file is the whole database, and immutable reads it as it
  // is, creating and touching nothing. (A -wal that has ever been written keeps its size, so an
  // empty or absent one means no program is writing through it.)
  const idle = wal ? !side.wal : !side.journal;
  if (idle && wal) {
    try {
      return { db: probe(new DatabaseSync(uri(file, "immutable=1"), { readOnly: true })), via: "immutable" };
    } catch (e) {
      reasons.push(`immutable open: ${e.message}`);
    }
  }
  // A WAL file with content but no -shm: a read-only open would have to create the -shm (or the holder locks exclusively). Read a copy.
  const wouldCreate = wal && side.shm == null;
  if (!wouldCreate) {
    try {
      const db = new DatabaseSync(file, { readOnly: true, timeout: 1500 });
      try {
        return { db: probe(db), via: "read-only" };
      } catch (e) {
        db.close();
        throw e;
      }
    } catch (e) {
      reasons.push(`read-only open: ${e.message}`);
    }
  }
  // A copy of the file and what lies beside it. Opening the copy replays its WAL or rolls back its journal.
  const total = st.size + (side.wal ?? 0) + (side.journal ?? 0);
  if (total <= SNAPSHOT_MAX) {
    try {
      fs.mkdirSync(tmp, { recursive: true });
      const copy = path.join(tmp, "copy.db");
      fs.copyFileSync(file, copy);
      for (const ext of ["-wal", "-journal"]) if (fs.existsSync(file + ext)) fs.copyFileSync(file + ext, copy + ext);
      const db = new DatabaseSync(copy, { timeout: 1500 });
      probe(db);
      db.exec("pragma query_only = 1");
      // An idle file whose immutable open failed (Node before 22.15 has no URI filenames): the copy is the whole database, nothing to say.
      if (idle) return { db, via: "snapshot" };
      const why = reasons.length ? `another program holds the database (${reasons.at(-1)})` : "its -wal file has changes and no -shm file";
      return { db, via: "snapshot", note: `read from a temporary copy of the file${side.wal ? " and its -wal" : ""}, because ${why}. Changes made after the copy are not in it.` };
    } catch (e) {
      reasons.push(`copy: ${e.message}`);
    }
  } else reasons.push(`too big to copy (${total} bytes)`);
  // Last resort: the main file alone, as it lies on disk.
  try {
    const db = probe(new DatabaseSync(uri(file, "immutable=1"), { readOnly: true }));
    return { db, via: "immutable", note: `read from the main file only, because it is locked or busy (${reasons.join("; ")}). Changes still in the -wal or journal are missing and the data may be inconsistent.` };
  } catch (e) {
    reasons.push(`immutable open: ${e.message}`);
  }
  throw new Error(`cannot read the database: ${reasons.join("; ")}. Close the program that holds it, or copy the file and ask about the copy.`);
}

// ---------- the schema ----------

function tableList(db) {
  let rows;
  try {
    rows = db.prepare("select name, type, ncol, wr, strict from pragma_table_list where schema = 'main'").all();
  } catch {
    // SQLite before 3.37 has no table_list.
    rows = db.prepare("select name, type, 0 ncol, 0 wr, 0 strict from sqlite_schema where type in ('table','view')").all();
  }
  return rows
    .filter((r) => !/^sqlite_/i.test(r.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((r) => ({ name: r.name, kind: r.type, ncol: num(r.ncol), withoutRowid: !!num(r.wr), strict: !!num(r.strict) }));
}

class Named extends Error {}

/** A table or view by the name the caller gave: exact, then any case, then the one name that contains it. */
function pick(db, name) {
  const all = tableList(db);
  const names = all.map((t) => t.name);
  const have = `have: ${names.slice(0, 60).join(", ") || "no tables"}${names.length > 60 ? `, and ${names.length - 60} more` : ""}`;
  if (name == null || name === "") throw new Named(`a table name is needed; ${have}`);
  const want = String(name);
  let t = all.find((x) => x.name === want);
  if (t) return { ...t, matched: "exact" };
  t = all.find((x) => x.name.toLowerCase() === want.toLowerCase());
  if (t) return { ...t, matched: "exact, another case" };
  const part = all.filter((x) => x.name.toLowerCase().includes(want.toLowerCase()));
  // Several names contain it: the one that starts with it wins, when there is only one such.
  const lead = part.filter((x) => x.name.toLowerCase().startsWith(want.toLowerCase()));
  const one = part.length === 1 ? part[0] : lead.length === 1 ? lead[0] : null;
  if (one) return { ...one, matched: `substring: "${want}" is in ${one.name}${part.length > 1 ? ` (also in ${part.filter((x) => x !== one).map((x) => x.name).slice(0, 10).join(", ")})` : ""}` };
  if (part.length > 1) throw new Named(`"${want}" matches several tables: ${part.map((x) => x.name).slice(0, 30).join(", ")}; name one`);
  throw new Named(`no table ${want}; ${have}`);
}

function columnsOf(db, table) {
  return db
    .prepare("select name, type, \"notnull\" nn, dflt_value dflt, pk, hidden from pragma_table_xinfo(?) order by cid")
    .all(table)
    .map((c) => ({ name: c.name, type: c.type || null, pk: num(c.pk), notNull: !!num(c.nn), default: c.dflt, hidden: num(c.hidden) }));
}

function describe(db, t, { clip = 4000 } = {}) {
  const cols = columnsOf(db, t.name).map((c) => {
    const o = { name: c.name, type: c.type };
    if (c.pk) o.pk = c.pk;
    if (c.notNull) o.notNull = true;
    if (c.default != null) o.default = cell(c.default, 120);
    if (c.hidden === 1) o.hidden = true;
    if (c.hidden === 2 || c.hidden === 3) o.generated = c.hidden === 2 ? "virtual" : "stored";
    if (secretDeclared(c, t.name)) o.secret = true;
    return o;
  });
  const indexes = db
    .prepare("select name, \"unique\" u, origin, partial from pragma_index_list(?)")
    .all(t.name)
    .map((i) => {
      const parts = db.prepare("select name, \"desc\" d from pragma_index_xinfo(?) where key = 1 order by seqno").all(i.name);
      const o = { name: i.name, columns: parts.map((p) => (p.name == null ? "<expression>" : p.name) + (num(p.d) ? " desc" : "")) };
      if (num(i.u)) o.unique = true;
      if (i.origin === "pk") o.primaryKey = true;
      if (num(i.partial)) o.partial = true;
      return o;
    });
  const fk = new Map();
  for (const r of db.prepare("select id, \"table\" t, \"from\" f, \"to\" c, on_update u, on_delete d from pragma_foreign_key_list(?) order by id, seq").all(t.name)) {
    const k = num(r.id);
    if (!fk.has(k)) fk.set(k, { columns: [], references: r.t, referencedColumns: [], ...(r.d && r.d !== "NO ACTION" ? { onDelete: r.d } : {}), ...(r.u && r.u !== "NO ACTION" ? { onUpdate: r.u } : {}) });
    fk.get(k).columns.push(r.f);
    if (r.c != null) fk.get(k).referencedColumns.push(r.c);
  }
  let referencedBy = [];
  try {
    referencedBy = db
      .prepare("select m.name tbl, f.\"from\" col, f.\"to\" ref from sqlite_schema m, pragma_foreign_key_list(m.name) f where m.type = 'table' and lower(f.\"table\") = lower(?)")
      .all(t.name)
      .map((r) => `${r.tbl}.${r.col}${r.ref ? ` -> ${r.ref}` : ""}`);
  } catch {}
  const triggers = db.prepare("select name from sqlite_schema where type = 'trigger' and lower(tbl_name) = lower(?)").all(t.name).map((r) => r.name);
  const sql = db.prepare("select sql from sqlite_schema where name = ? and type in ('table','view')").get(t.name)?.sql ?? null;
  return {
    table: t.name,
    kind: t.kind,
    ...(t.withoutRowid ? { withoutRowid: true } : {}),
    ...(t.strict ? { strict: true } : {}),
    columns: cols,
    indexes,
    foreignKeys: [...fk.values()],
    referencedBy,
    triggers,
    sql: sql == null ? null : cell(sql, clip),
  };
}

const count = (db, name) => num(db.prepare(`select count(*) c from ${q(name)}`).get().c);

// ---------- operations ----------

const ops = {
  /** Tables and views with rows, columns, indexes and bytes. Counting stops after a few seconds. */
  tables(db, file, { max = 200, countMs = 5000 }) {
    const all = tableList(db);
    const idx = new Map();
    for (const r of db.prepare("select name, tbl_name t from sqlite_schema where type = 'index'").all()) idx.set(r.name, r.t);
    const nIdx = new Map();
    for (const t of idx.values()) nIdx.set(t, (nIdx.get(t) ?? 0) + 1);
    // dbstat walks every page: only for files small enough to walk quickly.
    const bytes = new Map();
    const idxBytes = new Map();
    let sized = false;
    if (fs.statSync(file).size <= 256 << 20) {
      try {
        for (const r of db.prepare("select name, sum(pgsize) b from dbstat group by name").all()) {
          if (idx.has(r.name)) idxBytes.set(idx.get(r.name), (idxBytes.get(idx.get(r.name)) ?? 0) + num(r.b));
          else bytes.set(r.name, num(r.b));
        }
        sized = true;
      } catch {}
    }
    const t0 = Date.now();
    let uncounted = 0;
    const rows = all.map((t) => {
      const o = { name: t.name, kind: t.kind, rows: null, columns: t.ncol || columnsOf(db, t.name).length, indexes: nIdx.get(t.name) ?? 0 };
      if (Date.now() - t0 < countMs) {
        try {
          o.rows = count(db, t.name);
        } catch (e) {
          o.error = e.message.slice(0, 200);
        }
      } else uncounted++;
      if (sized && t.kind !== "view") {
        o.bytes = bytes.get(t.name) ?? 0;
        if (idxBytes.has(t.name)) o.indexBytes = idxBytes.get(t.name);
      }
      return o;
    });
    rows.sort((a, b) => (b.bytes ?? 0) + (b.indexBytes ?? 0) - ((a.bytes ?? 0) + (a.indexBytes ?? 0)) || (b.rows ?? 0) - (a.rows ?? 0) || a.name.localeCompare(b.name));
    return {
      tables: rows.slice(0, max),
      total: rows.length,
      complete: rows.length <= max,
      ...(uncounted ? { note: `${uncounted} tables were not counted (rows: null): counting stopped after ${countMs / 1000} s. Count one with sqlite.query.` } : {}),
    };
  },

  /** One table in full, or every table as one line of columns. */
  schema(db, file, { table, max = 80 }) {
    if (table != null && table !== "") {
      const t = pick(db, table);
      const d = describe(db, t);
      let rows = null;
      try {
        if (fs.statSync(file).size <= 512 << 20) rows = count(db, t.name);
      } catch {}
      return { ...d, rows, matched: t.matched };
    }
    const all = tableList(db).filter((t) => t.kind !== "shadow");
    return {
      tables: all.slice(0, max).map((t) => ({
        name: t.name,
        kind: t.kind,
        columns: columnsOf(db, t.name)
          .slice(0, 60)
          .map((c) => `${c.name}${c.type ? ` ${c.type}` : ""}${c.pk ? " pk" : ""}${c.notNull && !c.pk ? " not null" : ""}`)
          .join(", "),
      })),
      total: all.length,
      complete: all.length <= max,
    };
  },

  /** File and page facts. */
  info(db, file) {
    const { b } = header(file);
    const p = (name) => {
      try {
        return Object.values(db.prepare(`pragma ${name}`).get() ?? {})[0];
      } catch {
        return null;
      }
    };
    const kinds = {};
    for (const r of db.prepare("select type, count(*) c from sqlite_schema where name not like 'sqlite_%' group by type").all()) kinds[r.type] = num(r.c);
    const pageSize = num(p("page_size"));
    const pages = num(p("page_count"));
    const free = num(p("freelist_count"));
    const v = b.readUInt32BE(96);
    return {
      bytes: fs.statSync(file).size,
      pageSize,
      pages,
      freePages: free,
      freeBytes: free * pageSize,
      journalMode: b[18] === 2 || b[19] === 2 ? "wal" : String(p("journal_mode") ?? "delete"),
      walBytes: sizeOf(`${file}-wal`),
      shm: sizeOf(`${file}-shm`) != null,
      journalBytes: sizeOf(`${file}-journal`),
      autoVacuum: ["none", "full", "incremental"][num(p("auto_vacuum")) ?? 0] ?? "none",
      encoding: p("encoding"),
      userVersion: num(p("user_version")),
      applicationId: num(p("application_id")),
      writtenBySqlite: v ? `${Math.floor(v / 1e6)}.${Math.floor(v / 1000) % 1000}.${v % 1000}` : null,
      modified: fs.statSync(file).mtime.toISOString(),
      tables: kinds.table ?? 0,
      views: kinds.view ?? 0,
      indexes: kinds.index ?? 0,
      triggers: kinds.trigger ?? 0,
    };
  },

  /** quick_check or integrity_check, and foreign_key_check. */
  check(db, file, { full = false, max = 20 }) {
    const kind = full ? "integrity_check" : "quick_check";
    const lines = db.prepare(`pragma ${kind}(${Number(max) || 20})`).all().map((r) => String(Object.values(r)[0]));
    const ok = lines.length === 1 && lines[0] === "ok";
    const by = new Map();
    let violations = 0;
    let fkError = null;
    try {
      for (const r of db.prepare("pragma foreign_key_check").iterate()) {
        violations++;
        const k = `${r.table}\u0000${r.parent}`;
        if (!by.has(k)) by.set(k, { table: r.table, references: r.parent, count: 0, rowids: [] });
        const g = by.get(k);
        g.count++;
        if (g.rowids.length < 5 && r.rowid != null) g.rowids.push(num(r.rowid));
        if (violations >= 100000) break;
      }
    } catch (e) {
      fkError = e.message.slice(0, 300);
    }
    return {
      check: kind,
      ok,
      problems: ok ? [] : lines.map((l) => l.slice(0, 300)),
      foreignKeys: { violations, ...(violations >= 100000 ? { stoppedAt: 100000 } : {}), byTable: [...by.values()].sort((a, b) => b.count - a.count).slice(0, 20), ...(fkError ? { error: fkError } : {}) },
    };
  },

  /** A statement that reads. */
  query(db, file, { sql, params, max = 200, clip = 300, mentionsSecret = false }) {
    const stmt = db.prepare(sql);
    return readRows(stmt, params, { max, clip, mentionsSecret });
  },

  /** Which tables and columns hold a value. */
  search(db, file, { value, exact = false, tables, scan = 200000, examples = 3, budgetMs = 20000, clip = 160 }) {
    const want = String(value);
    const all = tableList(db);
    const only = tables ? new Set([].concat(tables).map((n) => pick(db, n).name)) : null;
    const like = `%${want.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const asNumber = /^-?\d+(\.\d+)?$/.test(want) ? Number(want) : null;
    const hits = [];
    const skippedSecret = [];
    const notSearched = [];
    const partial = [];
    const errors = [];
    let searched = 0;
    const t0 = Date.now();
    for (const t of all) {
      if (only ? !only.has(t.name) : t.kind !== "table" && t.kind !== "virtual") continue;
      if (Date.now() - t0 > budgetMs) {
        notSearched.push(t.name);
        continue;
      }
      try {
        const cols = columnsOf(db, t.name).filter((c) => c.hidden !== 1);
        const open = [];
        for (const c of cols) {
          if (secretDeclared(c, t.name)) skippedSecret.push(`${t.name}.${c.name}`);
          else if (!/blob/i.test(c.type ?? "")) open.push(c);
        }
        if (!open.length) continue;
        // A key/value table: the value of a row whose key names a credential is not searched either.
        const keys = cols.filter((c) => KEY_COLUMN.test(c.name));
        const guard = (c) => (VALUE_COLUMN.test(c.name) && keys.length ? ` and not (${keys.map((k) => KEY_LIKE.map((w) => `ifnull(${q(k.name)}, '') like '%${w}%'`).join(" or ")).join(" or ")})` : "");
        const test = (c) => (exact ? `((${q(c.name)} = $v${asNumber != null ? " or " + q(c.name) + " = $n" : ""})${guard(c)})` : `(typeof(${q(c.name)}) in ('text','integer','real') and ${q(c.name)} like $v escape '\\'${guard(c)})`);
        // Named parameters: each is used once per column.
        const args = exact ? (asNumber != null ? { v: want, n: asNumber } : { v: want }) : { v: like };
        const src = `(select ${t.withoutRowid || t.kind !== "table" ? "" : "rowid as __rowid, "}* from ${q(t.name)} limit ${Number(scan) + 1})`;
        const sums = db.prepare(`select count(*) n, ${open.map((c, i) => `sum(${test(c)}) c${i}`).join(", ")} from ${src}`).get(args);
        searched++;
        if (num(sums.n) > scan) partial.push(t.name);
        const pk = cols.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
        const idCols = pk.length ? pk : t.withoutRowid || t.kind !== "table" ? [] : ["__rowid"];
        open.forEach((c, i) => {
          const n = num(sums[`c${i}`]) ?? 0;
          if (!n) return;
          const ex = db
            .prepare(`select ${[...idCols.map(q), q(c.name) + " as __v"].join(", ")} from ${src} where ${test(c)} limit ${Number(examples)}`)
            .all(args)
            .map((r) => {
              const id = idCols.map((k) => `${k === "__rowid" ? "rowid" : k}=${secretColumn(k, t.name) ? REDACTED : cell(r[k], 60)}`).join(", ");
              return { ...(id ? { row: id } : {}), value: cell(r.__v, clip) };
            });
          hits.push({ table: t.name, column: c.name, rows: n, examples: ex });
        });
      } catch (e) {
        errors.push(`${t.name}: ${e.message.slice(0, 160)}`);
      }
    }
    hits.sort((a, b) => b.rows - a.rows);
    return {
      value: want,
      match: exact ? "exact" : "substring, any case",
      hits: hits.slice(0, 60),
      ...(hits.length > 60 ? { moreHits: hits.length - 60 } : {}),
      tablesSearched: searched,
      ...(partial.length ? { partial: partial.slice(0, 40), partialNote: `only the first ${scan} rows of these tables were searched` } : {}),
      ...(notSearched.length ? { notSearched: notSearched.slice(0, 60), notSearchedNote: `the search stopped after ${budgetMs / 1000} s; pass tables to search these` } : {}),
      ...(skippedSecret.length ? { skippedSecret: skippedSecret.slice(0, 40), skippedNote: "columns that hold credentials are never searched" } : {}),
      ...(errors.length ? { errors: errors.slice(0, 10) } : {}),
    };
  },
};

/** Run a prepared statement and return capped, clipped, redacted rows. */
function readRows(stmt, params, { max, clip, mentionsSecret }) {
  let meta = null;
  try {
    meta = stmt.columns();
  } catch {}
  let arrays = false;
  try {
    if (meta && typeof stmt.setReturnArrays === "function") {
      stmt.setReturnArrays(true);
      arrays = true;
    }
  } catch {}
  try {
    stmt.setReadBigInts(true);
  } catch {}
  const args = params == null ? [] : Array.isArray(params) ? params : [params];
  let names = null; // result keys, unique
  let secret = null; // per column: true when its values are credentials
  let expr = null; // per column: true when it is an expression, not a table column
  // Without column metadata (Node before 22.16) an alias cannot be traced to its column: a query
  // that names a credential column then has every text value redacted.
  let keyAt = [];
  let valueAt = [];
  const setup = (first) => {
    const raw = meta ? meta.map((m) => m.name) : Object.keys(first);
    const seen = new Map();
    names = raw.map((n, i) => {
      const k = seen.get(n) ?? 0;
      seen.set(n, k + 1);
      if (!k) return n;
      const full = meta?.[i]?.table ? `${meta[i].table}.${n}` : `${n}:${k + 1}`;
      return raw.includes(full) || seen.has(full) ? `${n}:${k + 1}` : full;
    });
    secret = raw.map((n, i) => secretColumn(n, meta?.[i]?.table) || (meta?.[i]?.column != null && secretColumn(meta[i].column, meta[i].table)));
    expr = raw.map((n, i) => (meta ? meta[i].column == null : false));
    keyAt = raw.map((n, i) => (KEY_COLUMN.test(meta?.[i]?.column ?? n) ? i : -1)).filter((i) => i >= 0);
    valueAt = raw.map((n, i) => (VALUE_COLUMN.test(meta?.[i]?.column ?? n) ? i : -1)).filter((i) => i >= 0);
  };
  const rows = [];
  const redacted = new Set();
  let total = 0;
  let stopped = false;
  for (const r of stmt.iterate(...args)) {
    total++;
    if (total > max) {
      // Keep counting so the caller knows how many there are, within reason.
      if (total >= 1_000_000 || elapsed() > 8000) {
        stopped = true;
        break;
      }
      continue;
    }
    const vals = arrays ? r : Object.values(r);
    if (!names) setup(r);
    // A key/value table: the value of a row whose key names a credential.
    const kv = keyAt.some((i) => typeof vals[i] === "string" && SECRET.test(vals[i]));
    const o = {};
    for (let i = 0; i < names.length; i++) {
      const v = vals[i];
      const hide = holdsSecret(v) && (secret[i] || (kv && valueAt.includes(i)) || (mentionsSecret && (expr[i] || !meta)));
      if (hide) redacted.add(names[i]);
      o[names[i]] = hide ? REDACTED : cell(v, clip);
    }
    rows.push(o);
  }
  if (!names) names = meta ? meta.map((m) => m.name) : [];
  return {
    columns: names,
    rows,
    total,
    complete: total <= max,
    ...(stopped ? { totalIsMinimum: true } : {}),
    ...(redacted.size ? { redacted: [...redacted], redactedNote: "values of columns that hold credentials are replaced with <redacted>" } : {}),
  };
}

/** Statements that change the database. Only reached when the caller asked for a change. */
function exec(file, { sql, params, create = false, max = 50, clip = 300 }) {
  if (!create) {
    const { n, b } = header(file);
    if (n > 0 && b.toString("latin1", 0, 16) !== MAGIC) throw new Error("not a SQLite database: the file does not start with 'SQLite format 3'");
  }
  const db = new DatabaseSync(file, { timeout: 5000 });
  try {
    const totals = () => db.prepare("select total_changes() t, last_insert_rowid() r").get();
    const before = num(totals().t);
    let out = {};
    if (params != null) {
      const stmt = db.prepare(sql);
      const got = readRows(stmt, params, { max, clip, mentionsSecret: false });
      if (got.columns.length) out = got;
    } else db.exec(sql);
    const after = totals();
    return { ok: true, changes: num(after.t) - before, lastInsertRowid: num(after.r), ...out };
  } finally {
    db.close();
  }
}

// ---------- main ----------

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const job = JSON.parse(Buffer.concat(chunks).toString("utf8"));
let result;
try {
  if (job.op === "exec") result = exec(job.file, job.args ?? {});
  else {
    const { db, via, note } = openRead(job.file, job.tmp);
    try {
      result = { ...ops[job.op](db, job.file, job.args ?? {}), ...(note ? { opened: via, openNote: note } : {}) };
    } finally {
      try {
        db.close();
      } catch {}
    }
  }
} catch (e) {
  if (e instanceof Named) result = { throw: e.message };
  else {
    let msg = String(e?.message ?? e);
    let have;
    if (/no such table/i.test(msg) && job.op !== "exec") {
      try {
        const { db } = openRead(job.file, job.tmp);
        have = tableList(db).map((t) => t.name).slice(0, 60);
        db.close();
      } catch {}
    }
    result = { error: msg.slice(0, 1500), ...(e?.errcode != null ? { sqliteCode: e.errcode } : {}), ...(have ? { have } : {}) };
  }
}
process.stdout.write(JSON.stringify(result));
