// Builds watch.db, the bench fixture: the Ankh-Morpork City Watch. Run from anywhere:
//   node --disable-warning=ExperimentalWarning bench/fixture/build.mjs
// The content is fixed (no clock, no random numbers), so a rebuild gives the same rows.
// Deliberate flaws, for the `health` script to find: one patrol whose guard does not exist, and
// free pages left by a dropped table. The credentials in `accounts` and `settings` are made up;
// they are there to prove that the kit never prints them.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "watch.db");
for (const ext of ["", "-wal", "-shm", "-journal"]) fs.rmSync(file + ext, { force: true });
const db = new DatabaseSync(file);
db.exec(`
pragma page_size = 4096;
pragma journal_mode = delete;
pragma user_version = 12;

create table posts (
  id integer primary key,
  name text not null unique,
  district text not null
);

create table guards (
  id integer primary key,
  name text not null,
  rank text not null default 'Constable',
  species text not null default 'human',
  post_id integer references posts(id),
  joined_on text not null
);
create index guards_post on guards(post_id);

create table patrols (
  id integer primary key,
  guard_id integer not null references guards(id),
  post_id integer not null references posts(id),
  started_at text not null,
  ended_at text,
  notes text
);
create index patrols_guard on patrols(guard_id);
create index patrols_started on patrols(started_at);

create table incidents (
  id integer primary key,
  ref text not null unique,
  title text not null,
  reported_by integer references guards(id),
  opened_at text not null,
  status text not null default 'open',
  report text
);

create table accounts (
  id integer primary key,
  guard_id integer not null references guards(id),
  username text not null unique,
  password_hash text not null,
  api_token text,
  last_login text
);

create table settings (
  key text primary key,
  value text
) without rowid;

create view on_patrol as
  select g.name as guard, p.name as post, t.started_at
    from patrols t join guards g on g.id = t.guard_id join posts p on p.id = t.post_id
   where t.ended_at is null;
`);

const posts = [
  ["Pseudopolis Yard", "Isle of Gods"],
  ["Treacle Mine Road", "The Shades"],
  ["Cable Street", "Dolly Sisters"],
  ["Chitterling Street", "Dimwell"],
];
const ip = db.prepare("insert into posts (name, district) values (?, ?)");
for (const p of posts) ip.run(...p);

const guards = [
  ["Sam Vimes", "Commander", "human", 1, "1985-03-01"],
  ["Carrot Ironfoundersson", "Captain", "dwarf", 1, "1989-06-12"],
  ["Angua von Uberwald", "Sergeant", "werewolf", 3, "1993-09-20"],
  ["Fred Colon", "Sergeant", "human", 1, "1981-01-15"],
  ["Nobby Nobbs", "Corporal", "human", 2, "1982-11-02"],
  ["Detritus", "Sergeant", "troll", 2, "1993-09-20"],
  ["Cheery Littlebottom", "Sergeant", "dwarf", 1, "1996-04-08"],
  ["Reg Shoe", "Constable", "zombie", 4, "1997-05-25"],
  ["Dorfl", "Constable", "golem", 3, "1996-11-30"],
  ["Visit-the-Infidel-with-Explanatory-Pamphlets", "Constable", "human", 4, "1994-02-14"],
];
const ig = db.prepare("insert into guards (name, rank, species, post_id, joined_on) values (?, ?, ?, ?, ?)");
for (const g of guards) ig.run(...g);

// 120 finished patrols over twelve days, then four that are still out.
const it = db.prepare("insert into patrols (guard_id, post_id, started_at, ended_at, notes) values (?, ?, ?, ?, ?)");
const pad = (n) => String(n).padStart(2, "0");
for (let i = 0; i < 120; i++) {
  const day = 1 + (i % 12);
  const hour = (6 + i * 5) % 24;
  const guard = 1 + (i % 10);
  const post = 1 + ((i * 3) % 4);
  const note = i === 37 ? "Followed up WATCH-12: the dragon was not at home." : i % 9 === 0 ? "All quiet. Twelve o'clock and all's well." : null;
  it.run(guard, post, `2026-10-${pad(day)}T${pad(hour)}:00:00Z`, `2026-10-${pad(day)}T${pad(Math.min(hour + 4, 23))}:30:00Z`, note);
}
it.run(3, 3, "2026-10-13T20:00:00Z", null, "Night patrol, Cable Street.");
it.run(5, 2, "2026-10-13T21:00:00Z", null, null);
it.run(6, 2, "2026-10-13T21:00:00Z", null, null);
it.run(1, 1, "2026-10-13T22:15:00Z", null, "Could not sleep.");
// The flaw: a patrol signed by a guard who is not on the roll, written as most apps write, with
// foreign keys not enforced.
db.exec("pragma foreign_keys = off");
it.run(99, 2, "2026-10-09T03:00:00Z", "2026-10-09T05:00:00Z", "Signature illegible.");

const ii = db.prepare("insert into incidents (ref, title, reported_by, opened_at, status, report) values (?, ?, ?, ?, ?, ?)");
ii.run("WATCH-7", "Theft of a gonne from the Assassins' Guild", 1, "2026-10-02T09:00:00Z", "closed", "Recovered. Do not ask where it is now.");
ii.run("WATCH-12", "Dragon sighted over the Patrician's Palace", 2, "2026-10-05T23:40:00Z", "open", "A noble dragon, about sixty feet long. " + "The roof of the palace is no longer where it was. ".repeat(12));
ii.run("WATCH-19", "Golem found working without a chem", 7, "2026-10-08T14:10:00Z", "open", null);
ii.run("WATCH-23", "Unlicensed thieving in Dolly Sisters", 3, "2026-10-11T02:30:00Z", "closed", "Referred to the Thieves' Guild.");

const ia = db.prepare("insert into accounts (guard_id, username, password_hash, api_token, last_login) values (?, ?, ?, ?, ?)");
ia.run(1, "vimes", "$2b$12$FIXTUREONLYvimesvimesvimesvimesvimesvimesvimesvimesvi", "tok_fixture_vimes_0001", "2026-10-13T22:10:00Z");
ia.run(2, "carrot", "$2b$12$FIXTUREONLYcarrotcarrotcarrotcarrotcarrotcarrotcarro", "tok_fixture_carrot_0002", "2026-10-13T08:00:00Z");
ia.run(3, "angua", "$2b$12$FIXTUREONLYanguaanguaanguaanguaanguaanguaanguaangua", null, "2026-10-12T19:45:00Z");
ia.run(7, "cheery", "$2b$12$FIXTUREONLYcheerycheerycheerycheerycheerycheerychee", "tok_fixture_cheery_0007", null);

const is = db.prepare("insert into settings (key, value) values (?, ?)");
is.run("city", "Ankh-Morpork");
is.run("clacks_host", "clacks.example.com");
is.run("clacks_password", "fixture-only-swordfish");
is.run("night_shift_starts", "20:00");

// Free pages: a table that was filled and dropped, as an app's migration leaves behind.
db.exec("create table old_duty_roster (id integer primary key, body text)");
const ir = db.prepare("insert into old_duty_roster (body) values (?)");
for (let i = 0; i < 8; i++) ir.run(`roster ${i} `.repeat(120));
db.exec("drop table old_duty_roster");
db.close();
console.log(`${file}: ${fs.statSync(file).size} bytes`);
