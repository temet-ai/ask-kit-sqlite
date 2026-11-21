import { failed, plural } from "../lib.mjs";

export const meta = {
  purpose:
    "One table or view in full: its columns with type, primary key, not null and default, its indexes, its foreign keys and the tables that point at it, its triggers, its row count and its CREATE statement. For 'what columns does X have', 'is there an index on Y', 'what references this table'. The name is matched exactly, then as a substring.",
  params: { file: "the database; default SQLITE_DB, or the only SQLite file in the folder", table: "table or view name, or a part of it" },
  returns: "{file, table, matched, kind, rows, columns:[one line each: name TYPE pk not null default x], columnCount, indexes:[one line each: name (columns) unique], foreignKeys:[one line each: column -> table(column)], referencedBy:[table.column -> column], triggers, sql, verdict}",
  example: 'await scripts.run("describe", { file: "dev.db", table: "users" })',
};

export default async function ({ sqlite }, { file, table } = {}) {
  if (!table) throw new Error("describe needs `table` (the `overview` script lists the tables)");
  const d = await sqlite.schema(file, String(table));
  if (d.error) return failed(d, "cannot read the table");
  const pk = d.columns.filter((c) => c.pk).sort((a, b) => a.pk - b.pk).map((c) => c.name);
  // One line per column: a wide table stays readable and small.
  const line = (c) => [c.name, c.type, c.pk ? (pk.length > 1 ? `pk ${c.pk}` : "pk") : "", c.notNull ? "not null" : "", c.default != null ? `default ${c.default}` : "", c.generated ? `generated ${c.generated}` : "", c.hidden ? "hidden" : "", c.secret ? "(credential: values are redacted)" : ""].filter(Boolean).join(" ");
  return {
    ...d,
    columns: d.columns.slice(0, 150).map(line),
    ...(d.columns.length > 150 ? { moreColumns: d.columns.length - 150 } : {}),
    columnCount: d.columns.length,
    indexes: d.indexes.map((i) => `${i.name} (${i.columns.join(", ")})${i.primaryKey ? " primary key" : i.unique ? " unique" : ""}${i.partial ? " partial" : ""}`),
    foreignKeys: d.foreignKeys.map((f) => `${f.columns.join(", ")} -> ${f.references}(${f.referencedColumns.join(", ")})${f.onDelete ? ` on delete ${f.onDelete.toLowerCase()}` : ""}${f.onUpdate ? ` on update ${f.onUpdate.toLowerCase()}` : ""}`),
    verdict: `${d.table} (${d.kind}, matched ${d.matched}): ${plural(d.columns.length, "column")}, ${d.rows ?? "?"} rows, ${pk.length ? `primary key ${pk.join(", ")}` : "no primary key"}, ${d.indexes.length} ${d.indexes.length === 1 ? "index" : "indexes"}, ${plural(d.foreignKeys.length, "foreign key")}`,
  };
}
