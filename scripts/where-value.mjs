import { failed } from "../lib.mjs";

export const meta = {
  purpose:
    "Which tables and columns hold a value: searches every table's columns for a text (as a substring, any case) or, with `exact`, for the whole value or number, and returns the columns that have it with the count and a few rows. For 'where is WATCH-12 stored', 'which table mentions this id', 'where does this email appear'. Views, blobs and columns that hold credentials are not searched. Big tables are searched in their first 200000 rows.",
  params: {
    file: "the database; default SQLITE_DB, or the only SQLite file in the folder",
    value: "the text or number to look for",
    exact: "true to match the whole cell instead of a substring",
    tables: "only these tables: a name or a list of names",
    scan: "rows searched per table, default 200000",
  },
  returns: "{file, value, match, hits:[{table, column, rows, examples:[{row, value}]}], tablesSearched, partial, notSearched, skippedSecret, verdict}",
  example: 'await scripts.run("where-value", { file: "dev.db", value: "WATCH-12" })',
};

export default async function ({ sqlite }, { file, value, exact = false, tables, scan } = {}) {
  if (value == null || value === "") throw new Error("where-value needs `value`: the text or number to look for");
  const list = tables == null ? undefined : Array.isArray(tables) ? tables : String(tables).split(",").map((s) => s.trim()).filter(Boolean);
  const r = await sqlite.search(file, value, { exact: exact === true || exact === "true", tables: list, scan });
  if (r.error) return failed(r, "cannot search the database");
  const where = r.hits.map((h) => `${h.table}.${h.column} (${h.rows})`);
  const caveat = [r.partial ? `${r.partial.length} big tables searched in part` : "", r.notSearched ? `${r.notSearched.length} tables not reached` : "", r.skippedSecret ? `${r.skippedSecret.length} credential columns not searched` : ""].filter(Boolean).join("; ");
  return {
    ...r,
    verdict: `${where.length ? `"${r.value}" is in ${where.slice(0, 12).join(", ")}${where.length > 12 ? ` and ${where.length - 12} more columns` : ""}` : `"${r.value}" was not found in ${r.tablesSearched} tables (${r.match})`}${caveat ? `; ${caveat}` : ""}`,
  };
}
