// The third suite: what each migration ASKS THE DRIVER TO DO, frozen call by call.
//
// `test/migrations.test.mjs` replays every migration against a real MongoDB and asserts the state
// that comes out the other end. That is the right way to test a migration and it stays the main
// suite here — but final state is not the whole of what a migration is, and two classes of mistake
// slip straight through it:
//
//   1. **Intermediate states.** `20260804010000-alter-company-public` is widen → backfill → narrow,
//      and `down` is the same three steps mirrored. Skip the widen and the end state is identical;
//      the migration merely fails on a database that has documents in it. The replay runs against a
//      collection with nothing in it, so it never notices.
//   2. **Everything the final state does not carry.** An `updateMany` filter, a `$set` value, the
//      order two `collMod`s were issued in, a `$unset` that names three fields where the migration
//      added four. All invisible once the dust settles.
//
// So this suite drives every migration's `up` and `down` against a recording fake `db` and freezes
// the ORDERED log of every driver call, arguments included. It is the strongest statement this repo
// can make about a migration short of running it: two migrations that produce the same database are
// still different migrations, and this is where that difference is written down.
//
// ⚠️ It is a backstop, not an argument. A snapshot says "this changed"; it never says "this is
// right". Every rule that matters has a named test of its own in one of the other two suites, and a
// new rule needs one there too — not just a regenerated snapshot.
//
// ⚠️ Regenerate with `yarn test -u` ONLY after reading the diff, hunk by hunk. A snapshot updated
// because the suite went red turns a regression into a committed expectation, which is the one
// failure mode a snapshot suite has.
//
// ⚠️ The log is snapshotted as a JSON STRING, not as an object, and that is not a stylistic choice.
// pretty-format — what vitest serializes objects with — prints object keys in sorted order, and key
// order is load-bearing in half of what is logged here: an index key document IS its ESR ordering,
// so `{ published: 1, deleted: 1, publicName: 1 }` and `{ deleted: 1, publicName: 1, published: 1 }`
// are two different indexes that pretty-format renders identically. `JSON.stringify` preserves
// insertion order, so the snapshot can tell them apart.
import { afterEach, test, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { ObjectId } from 'mongodb';

/*
 * ⚠️ `require`, not `import()` — same reason as the header of test/migrationGuards.test.mjs spells
 * out at length. migrate-mongo loads a migration through node's own loader; an `import()` of the
 * same path goes through vite and hands v8 a second script for one file with different byte
 * offsets, and merging coverage reports whose ranges do not line up drops them rather than unioning
 * them. One loader per file is what keeps the total stable.
 */
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const LIB_DIR = path.join(__dirname, '..', 'lib') + path.sep;

const MIGRATION_FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js')).sort();

const loaded = new Set();

/**
 * Drop every `lib/` module from node's CommonJS cache.
 *
 * ⚠️ This is what makes the builders testable at all, and it is not about `SEED_DEMO`.
 * `lib/schemas/*` is mostly TOP-LEVEL consts — `COORDINATE_TUPLE`, `EMAIL_VERIFY`, `PUBLIC_FIELDS`,
 * `PUBLISHED_IMPLIES_LINKABLE`, `NOTE` — and a top-level const is evaluated exactly once, the first
 * time the module is required in this process. Every later `require` hands back the same frozen
 * object, so re-loading the *migration* alone re-runs the migration's own literals and re-uses the
 * builders' from whenever the process happened to load them first.
 *
 * That is invisible while the shapes are right and fatal to the suite's job when they are not: the
 * first mutation run scored the whole of `lib/schemas/` at 88% with 54 survivors, and they were the
 * const bodies, one for one. `maximum: 180` → `+180`, `description: 'longitude'` → `''`, a whole
 * `items` array → `[]` — all of them reached the snapshot as the value loaded before the mutant was
 * switched on. Only the shapes built inside a FUNCTION body (`position()`, `address()`) were caught,
 * because those bodies re-run per call.
 *
 * Evicting the directory before each load means the builder is re-evaluated inside the test, which
 * is the only point at which the mutant under test exists. The cost is a handful of extra module
 * evaluations per test; the modules are pure data with no side effects, so nothing else observes it.
 */
const evictLib = () => {
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(LIB_DIR)) delete require.cache[key];
  }
};

const load = (file) => {
  const resolved = require.resolve(path.join(MIGRATIONS_DIR, file));
  delete require.cache[resolved];
  evictLib();
  loaded.add(resolved);
  return require(resolved);
};

// Both seed migrations read `process.env.SEED_DEMO` at MODULE LOAD, so the stub has to be in place
// before the require above and the module cache has to be dropped afterwards — a cached copy that
// was evaluated with the flag on hands every later caller in this process a migration that seeds,
// and `test/migrations.test.mjs` asserts those collections are empty. Same shape, same reason, as
// the afterEach in test/migrationGuards.test.mjs.
afterEach(() => {
  vi.unstubAllEnvs();
  evictLib();
  for (const resolved of loaded) {
    delete require.cache[resolved];
    require(resolved);
  }
  loaded.clear();
});

/**
 * ObjectId and Date survive JSON.stringify only as bare strings, which would make a hex id
 * indistinguishable from a string that happens to look like one. Tagging them keeps the snapshot
 * honest about the BSON type each literal carries — the seeds' fixed `_id`s are the whole mechanism
 * by which a `down` removes exactly what its `up` wrote, and `birth.date` being a Date rather than
 * a string is what the shopOwner validator demands.
 *
 * Key order is preserved throughout: `Object.entries` yields insertion order, and the caller
 * stringifies rather than pretty-prints. See the header.
 */
const normalize = (value) => {
  if (value instanceof ObjectId) return `ObjectId(${value.toHexString()})`;
  if (value instanceof Date) return `Date(${value.toISOString()})`;
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalize(v)]));
  }
  return value;
};

/**
 * A `db` that records every call in ONE ordered list rather than one list per method.
 *
 * The ordering across methods is the point, and it is exactly what `fakeDb` in
 * test/migrationGuards.test.mjs cannot express: `20260804010000-alter-company-public` issues
 * command → updateMany → command, and a version that backfilled before widening would produce the
 * same three calls in a different order and the same final database. Per-method buckets record both
 * as "two commands and one updateMany".
 *
 * Every method the migrations call is here and every one resolves. `dropIndex` resolving matters:
 * against a real server it throws `IndexNotFound` for an index that was never created, and the
 * guards around it are covered in test/migrationGuards.test.mjs with a fake that throws. This one
 * is about the calls that get made, not about how failures are handled.
 *
 * `find` returns an EMPTY cursor, which is what pins the three `*-encrypted` migrations to the shape
 * they must have against a collection with nothing in it: read the collection, find nothing to
 * convert, open no `ClientEncryption` and write nothing. That is the path every replay from empty
 * takes — the test database on every run — and the reason those migrations need no master key to
 * apply. The conversion itself is driven in test/migrationGuards.test.mjs, with documents.
 */
function recordingDb() {
  const log = [];
  const db = {
    async createCollection(name, options) {
      log.push({ call: 'createCollection', name, options });
    },
    async command(spec) {
      log.push({ call: 'command', spec });
    },
    collection(name) {
      return {
        async createIndex(key, options) {
          log.push({ call: 'createIndex', name, key, options });
        },
        async dropIndex(indexName) {
          log.push({ call: 'dropIndex', name, indexName });
        },
        async drop() {
          log.push({ call: 'drop', name });
        },
        async insertOne(doc) {
          log.push({ call: 'insertOne', name, doc });
        },
        async deleteOne(filter) {
          log.push({ call: 'deleteOne', name, filter });
        },
        async updateMany(filter, update) {
          log.push({ call: 'updateMany', name, filter, update });
        },
        find(filter) {
          log.push({ call: 'find', name, filter });
          return {
            async toArray() {
              return [];
            }
          };
        }
      };
    }
  };
  return { db, log };
}

/**
 * One direction of one migration, as a frozen string: every driver call in order, plus anything the
 * migration said on stdout.
 *
 * `logged` is in there because for a skipped seed the console line is the ENTIRE observable effect —
 * no driver call is made at all, so a snapshot of the call log alone cannot tell "skipped and said
 * so" from "skipped silently" from "the guard was removed and the message is dead code".
 */
const record = async (migration, direction) => {
  const { db, log } = recordingDb();
  const logged = [];
  const spy = vi.spyOn(console, 'log').mockImplementation((...args) => logged.push(args.join(' ')));

  try {
    await migration[direction](db);
  } finally {
    spy.mockRestore();
  }

  return JSON.stringify(normalize({ calls: log, logged }), null, 2);
};

const recordBoth = async (file, seedDemo) => {
  vi.stubEnv('SEED_DEMO', seedDemo);
  const migration = load(file);

  return { up: await record(migration, 'up'), down: await record(migration, 'down') };
};

/**
 * The migrations that read `SEED_DEMO` — the whole list, asserted as the whole list.
 *
 * ⚠️ Every other migration is required to be IDENTICAL in both states, and that is the half of this
 * worth having. `SEED_DEMO` is an environment flag a developer flips to get a usable dev database;
 * a schema migration that quietly changed shape under it would produce two different databases from
 * one changelog, and nothing downstream would ever say which one it was looking at. Freezing the
 * seeds and equating everything else says both things at once.
 */
const FLAG_SENSITIVE = ['20260301001800-seed-demo.js', '20260803142526-seed-demo-company.js'];

for (const file of MIGRATION_FILES) {
  test(`${file} — up() and down() issue exactly these driver calls`, async () => {
    const seeded = await recordBoth(file, 'true');

    expect(seeded.up).toMatchSnapshot('up');
    expect(seeded.down).toMatchSnapshot('down');

    const off = await recordBoth(file, 'false');

    if (FLAG_SENSITIVE.includes(file)) {
      expect(off.up).toMatchSnapshot('up — SEED_DEMO off');
      expect(off.down).toMatchSnapshot('down — SEED_DEMO off');
      // Belt and braces over the two snapshots above: a seed whose guard stopped working would
      // regenerate into a pair of identical snapshots and read as a clean diff of "nothing moved".
      expect(off.up, `${file} seeds regardless of SEED_DEMO`).not.toBe(seeded.up);
      expect(off.down, `${file} unseeds regardless of SEED_DEMO`).not.toBe(seeded.down);
    } else {
      expect(off.up, `${file} must not read SEED_DEMO`).toBe(seeded.up);
      expect(off.down, `${file} must not read SEED_DEMO`).toBe(seeded.down);
    }
  });
}

// A FLAG_SENSITIVE entry naming a file that no longer exists is silent: the loop above simply never
// matches it, and the two seeds it was meant to cover would quietly fall through to the
// "must not read SEED_DEMO" branch — which they fail loudly, but under a message that describes the
// opposite problem. Name the mismatch here instead.
test('FLAG_SENSITIVE names migrations that exist', () => {
  for (const file of FLAG_SENSITIVE) {
    expect(MIGRATION_FILES, `${file} is in FLAG_SENSITIVE but not on disk`).toContain(file);
  }
});

// Every migration file is picked up by the loop above rather than listed by hand, so a new
// migration gets a frozen call log for free. This asserts the glob actually found them: an empty
// MIGRATION_FILES would make every test above vanish and the suite would pass with nothing in it,
// which is the failure mode a directory-driven suite has.
test('every migration on disk is covered by this suite', () => {
  expect(MIGRATION_FILES.length).toBeGreaterThan(0);
  for (const file of MIGRATION_FILES) {
    const migration = load(file);
    expect(typeof migration.up, `${file} exports up()`).toBe('function');
    expect(typeof migration.down, `${file} exports down()`).toBe('function');
  }
});

// ⚠️ `address({ encrypted: [...] })` names its members as STRINGS, and a misspelt one is the one
// mistake in this repo that no other test can see: `encrypted.includes('postCode')` answers false
// exactly as it does for a member deliberately left in the clear, so the builder would return a
// perfectly valid validator with `postalCode` still typed `string` — and the collection would be
// half converted before anything noticed, at the first service write of a blob into a string field.
// Hence the guard, and hence this: it is the only assertion that a typo is louder than a decision.
test('address() refuses a member name it does not have', () => {
  evictLib();
  const { address } = require(path.join(LIB_DIR, 'schemas', 'geo.js'));

  // The whole message, list included: a reader who misspelt one member needs to be told the five
  // that exist, and the separator is part of that — `join('')` would answer
  // "streetpostalCodecityprovinceposition", which is a worse error than the one it is diagnosing.
  expect(() => address({ maxLength: 100, positionRequired: false, encrypted: ['postCode'] }))
    .toThrow("address(): 'postCode' is not an address member — expected one of street, postalCode, city, province, position");
  // And the four real ones do not throw — a guard that rejected everything would pass the line above.
  expect(() => address({ maxLength: 100, positionRequired: false, encrypted: ['street', 'postalCode', 'city', 'province'] }))
    .not.toThrow();
});
