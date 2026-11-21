import { failed, human, plural } from "../lib.mjs";

export const meta = {
  purpose:
    "What a SQLite file holds: its size, pages and free pages, journal mode and WAL size, and every table and view with its rows, columns, indexes and size on disk, biggest first. Start here for 'what is in this database', 'which tables are there', 'how many rows', 'how big is it'. With no file and several databases in the folder, it lists them.",
  params: { file: "the database, relative to the working folder or absolute; default SQLITE_DB, or the only SQLite file in the folder", max: "tables listed, default 40" },
  returns: "{file, size, bytes, pageSize, pages, freePages, journalMode, wal, userVersion, modified, tables:[{name, kind (only when not a plain table: view, virtual, shadow), rows, columns, indexes, size (with its indexes)}], more, verdict} or {files:[{file, bytes, modified}], verdict} when no file was named",
  example: 'await scripts.run("overview", { file: "dev.db" })',
};

export default async function ({ sqlite }, { file, max = 40 } = {}) {
  if (!file && !sqlite.default) {
    const found = sqlite.files();
    if (found.files.length !== 1) {
      return {
        folder: found.root,
        files: found.files.slice(0, 30).map((f) => ({ ...f, size: human(f.bytes) })),
        more: Math.max(0, found.total - 30),
        ...(found.note ? { note: found.note } : {}),
        verdict: found.files.length ? `${plural(found.total, "SQLite file")} under ${found.root}; name one with \`file\`` : `no SQLite file under ${found.root}; pass \`file\` with a path`,
      };
    }
    file = found.files[0].file;
  }
  const info = await sqlite.info(file);
  if (info.error) return failed(info, "cannot read the database");
  const t = await sqlite.tables(file, { max: 1000 });
  if (t.error) return failed(t, "cannot list the tables");
  const tables = t.tables.map((x) => ({ name: x.name, ...(x.kind === "table" ? {} : { kind: x.kind }), rows: x.rows, columns: x.columns, indexes: x.indexes, ...(x.bytes != null ? { size: human(x.bytes + (x.indexBytes ?? 0)) } : {}), ...(x.error ? { error: x.error } : {}) }));
  const real = t.tables.filter((x) => x.kind === "table");
  const rows = real.reduce((n, x) => n + (x.rows ?? 0), 0);
  const top = t.tables[0];
  return {
    file: info.file,
    size: human(info.bytes),
    bytes: info.bytes,
    pageSize: info.pageSize,
    pages: info.pages,
    freePages: info.freePages,
    journalMode: info.journalMode,
    ...(info.walBytes != null ? { wal: human(info.walBytes) } : {}),
    userVersion: info.userVersion,
    modified: info.modified,
    counts: { tables: info.tables, views: info.views, indexes: info.indexes, triggers: info.triggers },
    tables: tables.slice(0, max),
    more: Math.max(0, tables.length - max),
    ...(t.note ? { note: t.note } : {}),
    ...(info.openNote ? { openNote: info.openNote } : {}),
    verdict: `${info.file}: ${human(info.bytes)}, ${plural(info.tables, "table")}, ${plural(info.views, "view")}, ${rows} rows in all${top ? `; biggest is ${top.name} (${top.rows ?? "?"} rows${top.bytes != null ? `, ${human(top.bytes + (top.indexBytes ?? 0))} with its indexes` : ""})` : ""}`,
  };
}
