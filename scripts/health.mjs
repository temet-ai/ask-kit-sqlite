import { failed, human, plural } from "../lib.mjs";

export const meta = {
  purpose:
    "Whether a SQLite file is sound: PRAGMA quick_check (or integrity_check with `full`), foreign key violations by table, free pages and how much VACUUM would give back, the journal mode and the size of the WAL. For 'is this database corrupt', 'is it healthy', 'should I vacuum it', 'why is the file so big'. It only reads: it never checkpoints, vacuums or repairs.",
  params: { file: "the database; default SQLITE_DB, or the only SQLite file in the folder", full: "true for integrity_check, which also checks indexes against their tables and is slower" },
  returns: "{file, size, check, ok, problems, foreignKeys:{violations, byTable:[{table, references, count, rowids}]}, freelist:{pages, size, percent}, vacuum, journalMode, wal, verdict}",
  example: 'await scripts.run("health", { file: "dev.db" })',
};

export default async function ({ sqlite }, { file, full = false } = {}) {
  const info = await sqlite.info(file);
  if (info.error) return failed(info, "cannot read the database");
  const c = await sqlite.check(file, { full: full === true || full === "true" });
  if (c.error) return { ...failed(c, `${full ? "integrity_check" : "quick_check"} did not finish`), size: human(info.bytes), journalMode: info.journalMode };
  const percent = info.pages ? Math.round((info.freePages / info.pages) * 100) : 0;
  const fk = c.foreignKeys.violations;
  const walNote =
    info.walBytes == null
      ? null
      : info.walBytes === 0
        ? "the -wal file is empty"
        : `the -wal file holds ${human(info.walBytes)} not yet written into the main file${info.shm ? "" : "; there is no -shm file, so no program has it open in the usual way"}`;
  const vacuum = info.freePages ? `VACUUM would give back at least ${human(info.freeBytes)} (${percent}% of the file is free pages)` : "no free pages; VACUUM would only repack partly filled pages";
  const parts = [
    c.ok ? `${c.check} ok` : `${c.check} found ${plural(c.problems.length, "problem")}: ${c.problems[0]}`,
    fk ? `${plural(fk, "foreign key violation")} (${c.foreignKeys.byTable.slice(0, 3).map((b) => `${b.count} in ${b.table} -> ${b.references}`).join(", ")})` : "no foreign key violations",
    info.freePages ? `${plural(info.freePages, "free page")}, ${human(info.freeBytes)} reclaimable by VACUUM` : "no free pages",
    `journal mode ${info.journalMode}${info.walBytes ? `, WAL ${human(info.walBytes)}` : ""}`,
  ];
  return {
    file: info.file,
    size: human(info.bytes),
    check: c.check,
    ok: c.ok,
    problems: c.problems,
    foreignKeys: c.foreignKeys,
    freelist: { pages: info.freePages, size: human(info.freeBytes), percent },
    vacuum,
    journalMode: info.journalMode,
    ...(walNote ? { wal: walNote } : {}),
    ...(info.journalBytes ? { journal: `a -journal file of ${human(info.journalBytes)} lies beside it: a transaction is open or was cut off` } : {}),
    ...(c.openNote ?? info.openNote ? { openNote: c.openNote ?? info.openNote } : {}),
    verdict: `${c.ok && !fk ? "healthy" : c.ok ? "sound, with foreign key violations" : "damaged"}: ${parts.join("; ")}`,
  };
}
