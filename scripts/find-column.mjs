import { failed } from "../lib.mjs";

export const meta = {
  purpose:
    "Which tables hold something, by name: columns whose name contains a word (or every one of several words), and tables or views whose name contains it. For 'which table has a session_id column', 'where is the email stored', 'is there a table about patrols'. Exact column names come first. It looks at names only; for a value use `where-value`.",
  params: {
    file: "the database; default SQLITE_DB, or the only SQLite file in the folder",
    words: "one or more words, e.g. 'guard_id' or 'email' or 'created at'. A column matches when its name contains any word; with `all`, every word",
    all: "true to require every word in the column name",
    max: "columns listed, default 80",
  },
  returns: "{file, words, columns:[{table, column, type, pk, exact, kind}], tables:[{name, kind}], total, more, verdict}",
  example: 'await scripts.run("find-column", { file: "dev.db", words: "guard_id" })',
};

export default async function ({ sqlite }, { file, words, all = false, max = 80 } = {}) {
  const ws = String(words ?? "").toLowerCase().split(/[\s,]+/).filter(Boolean);
  if (!ws.length) throw new Error("find-column needs `words`: a word or a part of a column or table name");
  const r = await sqlite.query(
    file,
    `select m.name as tbl, m.type as kind, p.name as col, p.type as type, p.pk as pk
       from sqlite_schema m, pragma_table_xinfo(m.name) p
      where m.type in ('table','view') and m.name not like 'sqlite\\_%' escape '\\'
      order by m.name, p.cid`,
    null,
    { max: 5000 },
  );
  if (r.error) return failed(r, "cannot read the schema");
  const hit = (name) => (all ? ws.every((w) => name.includes(w)) : ws.some((w) => name.includes(w)));
  const columns = r.rows
    .filter((x) => hit(String(x.col).toLowerCase()))
    .map((x) => ({ table: x.tbl, column: x.col, type: x.type || null, ...(x.pk ? { pk: true } : {}), exact: ws.includes(String(x.col).toLowerCase()), kind: x.kind }))
    .sort((a, b) => b.exact - a.exact);
  const kinds = new Map(r.rows.map((x) => [x.tbl, x.kind]));
  const tables = [...kinds].filter(([name]) => hit(name.toLowerCase())).map(([name, kind]) => ({ name, kind }));
  const exact = columns.filter((c) => c.exact).length;
  return {
    file: r.file,
    words: ws,
    columns: columns.slice(0, max),
    tables: tables.slice(0, 40),
    total: columns.length,
    more: Math.max(0, columns.length - max),
    ...(r.complete ? {} : { note: "the schema has more than 5000 columns; only the first 5000 were looked at" }),
    verdict: columns.length || tables.length
      ? `${columns.length} columns match (${exact} by exact name, ${columns.length - exact} by substring) in ${new Set(columns.map((c) => c.table)).size} tables; ${tables.length} table names match`
      : `no column or table name contains ${ws.map((w) => `"${w}"`).join(all ? " and " : " or ")}; ${kinds.size} tables were looked at: ${[...kinds.keys()].slice(0, 40).join(", ")}`,
  };
}
