import { failed } from "../lib.mjs";

export const meta = {
  purpose:
    "What the rows of one table look like: a few rows, newest first (by a time column such as created_at when the table has one, else by rowid or primary key), with an optional SQL condition. For 'show me the last rows of X', 'what does a row in X say', 'the latest patrols of guard 3'. Long cells are clipped, blobs are shown by size and credentials are redacted.",
  params: {
    file: "the database; default SQLITE_DB, or the only SQLite file in the folder",
    table: "table or view name, or a part of it",
    n: "rows, default 5, at most 50",
    where: "a SQL condition without the word WHERE, e.g. \"guard_id = 3 and ended_at is null\"",
    oldest: "true for the oldest rows first",
    clip: "characters kept of a long cell, default 200",
  },
  returns: "{file, table, matched, order, rows:[{column: value}], shown, total, redacted, verdict}",
  example: 'await scripts.run("sample", { file: "dev.db", table: "patrols", n: 3, where: "guard_id = 3" })',
};

const TIME = [/^(created|inserted|added)(_?(at|on|time|date|ts))?$/i, /^(updated|modified|changed)(_?(at|on|time|date|ts))?$/i, /^(timestamp|ts|time|date|datetime|started_at|start_time|opened_at)$/i, /(_at|_time|_date|_on|_ts|timestamp)$/i];
const q = (s) => `"${String(s).replace(/"/g, '""')}"`;

export default async function ({ sqlite }, { file, table, n = 5, where, oldest = false, clip = 200 } = {}) {
  if (!table) throw new Error("sample needs `table` (the `overview` script lists the tables)");
  const d = await sqlite.schema(file, String(table));
  if (d.error) return failed(d, "cannot read the table");
  const names = d.columns.filter((c) => !c.hidden).map((c) => c.name);
  let time = null;
  for (const re of TIME) if ((time = names.find((c) => re.test(c)))) break;
  const pk = d.columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  const rowid = d.kind === "table" && !d.withoutRowid;
  // Sorting by a time column reads the whole table unless an index leads with it: only do that for a small table.
  const cheap = time && ((d.rows != null && d.rows <= 200000) || d.indexes.some((i) => i.columns[0]?.replace(/ desc$/, "") === time));
  const dir = oldest ? "asc" : "desc";
  const by = cheap ? [time, ...(rowid ? ["rowid"] : pk)] : rowid ? ["rowid"] : pk;
  const order = by.length ? ` order by ${by.map((c) => `${c === "rowid" ? "rowid" : q(c)} ${dir}`).join(", ")}` : "";
  const count = Math.min(50, Math.max(1, Number(n) || 5));
  const cond = where ? ` where (${String(where).replace(/^\s*where\s+/i, "")})` : "";
  const r = await sqlite.query(file, `select * from ${q(d.table)}${cond}${order}${where ? "" : ` limit ${count}`}`, null, { max: count, clip });
  if (r.error) return { file: r.file, table: d.table, error: r.error, columns: names, verdict: `the query failed: ${r.error}; the columns of ${d.table} are ${names.join(", ")}` };
  const total = where ? r.total : d.rows;
  // A wide table: leave the empty cells out of each row.
  const wide = names.length > 24;
  const rows = wide ? r.rows.map((row) => Object.fromEntries(Object.entries(row).filter(([, v]) => v != null))) : r.rows;
  const orderText = by.length ? `${by.join(", ")} ${oldest ? "ascending (oldest first)" : "descending (newest first)"}` : "none (no time column, rowid or primary key)";
  return {
    file: r.file,
    table: d.table,
    matched: d.matched,
    order: orderText,
    ...(where ? { where: String(where) } : {}),
    rows,
    ...(wide ? { nullsOmitted: `${d.table} has ${names.length} columns; cells that are NULL are left out of each row` } : {}),
    shown: r.rows.length,
    total,
    ...(r.totalIsMinimum ? { totalIsMinimum: true } : {}),
    ...(r.redacted ? { redacted: r.redacted, redactedNote: r.redactedNote } : {}),
    ...(r.openNote ? { openNote: r.openNote } : {}),
    verdict: `${r.rows.length} of ${total ?? "?"}${r.totalIsMinimum ? " or more" : ""} rows of ${d.table}${where ? " that match" : ""}, ordered by ${orderText}`,
  };
}
