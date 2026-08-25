// The third suite: what each migration ASKS THE DRIVER TO DO, frozen call by call.
//
// `test/migrations.test.mjs` replays every migration against a real MongoDB and asserts the state
// that comes out the other end. That is the right way to test a migration and it stays the main
// suite here — but final state is not the whole of what a migration is, and two classes of mistake
// slip straight through it:
//
//   1. **Order.** Every migration here creates a collection and then builds its indexes, and the
//      resulting database is the same whichever order those calls were issued in — except against a
//      server that has already refused one of them. The replay sees one end state; this sees the
//      sequence that produced it.
//   2. **Everything the final state does not carry.** The exact index `options` document, the
//      `_id`s the seed deletes by, the console line a skipped seed prints. A collection that was
//      created with `unique: true` and a collection that was created without it are two different
//      migrations; only one of them is distinguishable from the database afterwards, and only when
//      somebody inserts the duplicate.
//
// So this suite drives every migration's `up` and `down` against a recording fake `db` and freezes
// the ORDERED log of every driver call, arguments included. It is the strongest statement this repo
// can make about a migration short of running it: two migrations that produce the same database are
// still different migrations, and this is where that difference is written down.
//
// ⚠️ It is a backstop, not an argument. A snapshot says "this changed"; it never says "this is
// right". Every rule that matters has a named test of its own in one of the other suites, and a new
// rule needs one there too — not just a regenerated snapshot.
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
 * ⚠️ `require`, not `import()`, and the reason is coverage rather than style.
 *
 * migrate-mongo loads a migration with node's own loader, so `test/migrations.test.mjs` covers each
 * file exactly as it sits on disk. An `import()` from here goes through vite instead, which hands
 * v8 a *second* script for the same path with different byte offsets — and merging two coverage
 * reports whose ranges do not line up does not union them, it loses them. Measured: 99.48% against
 * 100% on an otherwise identical run, with the uncovered lines moving between runs. Requiring the
 * same script the other suite requires keeps one entry per file.
 */
const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const LIB_DIR = path.join(__dirname, '..', 'lib') + path.sep;

const MIGRATION_FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js')).sort();

// The one migration that reads `SEED_DEMO`, and the only one that writes a document.
const SEED_MIGRATION = '20260301000600-seed-demo.js';

/**
 * Drop every `lib/` module from node's CommonJS cache.
 *
 * ⚠️ This is what makes the builders testable at all. `lib/schemas/*` is mostly TOP-LEVEL consts —
 * `LOGIN`, `EMAIL_VERIFY`, `NOTE`, `ADDRESS_ITEM`, `PUBLISHED_IMPLIES_LINKABLE` — and a top-level
 * const is evaluated exactly once, the first time the module is required in this process. Every
 * later `require` hands back the same frozen object, so re-loading the *migration* alone re-runs the
 * migration's own literals and re-uses the builders' from whenever the process happened to load them
 * first.
 *
 * That is invisible while the shapes are right and fatal to the suite's job when they are not: the
 * first mutation run scored the whole of `lib/schemas/` at 88% with 54 survivors, and they were the
 * const bodies, one for one. `maximum: 180` → `+180`, `description: 'longitude'` → `''`, a whole
 * `items` array → `[]` — all of them reached the snapshot as the value loaded before the mutant was
 * switched on. Only the shapes built inside a FUNCTION body were caught, because those bodies re-run
 * per call.
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
  return require(resolved);
};

afterEach(() => {
  vi.unstubAllEnvs();
  evictLib();
});

/**
 * ObjectId and Date survive JSON.stringify only as bare strings, which would make a hex id
 * indistinguishable from a string that happens to look like one. Tagging them keeps the snapshot
 * honest about the BSON type each literal carries — the seed's fixed `_id`s are the whole mechanism
 * by which its `down` removes exactly what its `up` wrote.
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
 * The ordering across methods is the point: `migrationCreation` issues `createCollection` and then
 * one `createIndex` per entry, and a version that built the indexes first would produce the same
 * call counts, the same final database on an empty server, and an error on any server where the
 * collection already exists. Per-method buckets record both as "one create and nine indexes".
 *
 * The six methods here are every method the eight migrations call between them, and each of them
 * resolves. An unimplemented method is a `TypeError` naming itself, which is the failure a migration
 * that starts calling something new should produce — not a silently recorded no-op. `dropIndex` is
 * the newest and arrived with the first migration that alters rather than creates: a create's `down`
 * drops the whole collection and takes its indexes with it, an alter's has to name what it undoes.
 */
function recordingDb() {
  const log = [];
  const db = {
    async createCollection(name, options) {
      log.push({ call: 'createCollection', name, options });
    },
    collection(name) {
      return {
        async createIndex(key, options) {
          log.push({ call: 'createIndex', name, key, options });
        },
        async drop() {
          log.push({ call: 'drop', name });
        },
        async dropIndex(indexName) {
          log.push({ call: 'dropIndex', name, indexName });
        },
        async insertOne(doc) {
          log.push({ call: 'insertOne', name, doc });
        },
        async deleteOne(filter) {
          log.push({ call: 'deleteOne', name, filter });
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
 *
 * ⚠️ The migration is called with `db` alone and no client. Seven of the eight take nothing else; the
 * eighth takes a `MongoClient` and uses it only on the branch this fake cannot drive — see the seed
 * tests at the foot of the file.
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

/*
 * The seven schema migrations — the six that create a collection and the one that adds an index to
 * `user` after the fact.
 *
 * ⚠️ Each is required to be IDENTICAL in both states of `SEED_DEMO`, and that is the half of this
 * worth having. `SEED_DEMO` is an environment flag a developer flips to get a usable dev database; a
 * schema migration that quietly changed shape under it would produce two different databases from
 * one changelog, and nothing downstream would ever say which one it was looking at. Freezing the
 * seed separately and equating everything else says both things at once.
 */
for (const file of MIGRATION_FILES.filter((f) => f !== SEED_MIGRATION)) {
  test(`${file} — up() and down() issue exactly these driver calls`, async () => {
    const seeded = await recordBoth(file, 'true');

    expect(seeded.up).toMatchSnapshot('up');
    expect(seeded.down).toMatchSnapshot('down');

    const off = await recordBoth(file, 'false');

    expect(off.up, `${file} must not read SEED_DEMO`).toBe(seeded.up);
    expect(off.down, `${file} must not read SEED_DEMO`).toBe(seeded.down);
  });
}

// A `SEED_MIGRATION` naming a file that no longer exists is silent: the filter above simply removes
// nothing, and the seed would quietly fall through to the "must not read SEED_DEMO" branch — which
// it fails loudly, but under a message describing the opposite problem. Name the mismatch here.
test('SEED_MIGRATION names a migration that exists', () => {
  expect(MIGRATION_FILES, `${SEED_MIGRATION} is the flagged migration but is not on disk`).toContain(SEED_MIGRATION);
});

// Every migration file is picked up by the loop above rather than listed by hand, so a new migration
// gets a frozen call log for free. This asserts the glob actually found them: an empty
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

/*
 * The seed, whose two branches cannot both be recorded here.
 *
 * With the flag OFF both directions are pure no-ops and are frozen below. With it ON, `down` is
 * three `deleteOne`s by fixed `_id` and is frozen too — that pairing is the whole mechanism by which
 * a rollback removes exactly what the seed wrote, and an `up` that inserts one id against a `down`
 * that deletes another leaves a document behind for ever with no replay ever noticing.
 *
 * `up` with the flag ON is the one direction this fake cannot drive: it encrypts every personal
 * field before inserting it, which needs a real `MongoClient`, a real key vault and a real 96-byte
 * master key. It is driven for real, against all three, in `test/migrations.test.mjs` — which is
 * also the only place the ciphertext/plaintext split can actually be checked. What is asserted here
 * instead is the one thing that does not need a database: that the flag lets it THROUGH, and that it
 * gets as far as the encryption layer before it touches the collection.
 */
test(`${SEED_MIGRATION} — with SEED_DEMO off, both directions are no-ops`, async () => {
  const off = await recordBoth(SEED_MIGRATION, 'false');

  expect(off.up).toMatchSnapshot('up — SEED_DEMO off');
  expect(off.down).toMatchSnapshot('down — SEED_DEMO off');
});

test(`${SEED_MIGRATION} — with SEED_DEMO on, down deletes the three documents up wrote`, async () => {
  vi.stubEnv('SEED_DEMO', 'true');
  const migration = load(SEED_MIGRATION);
  const seeded = await record(migration, 'down');

  expect(seeded).toMatchSnapshot('down');

  // Belt and braces over the two snapshots: a seed whose guard stopped working would regenerate into
  // a pair of identical ones and read as a clean diff of "nothing moved".
  const { down: off } = await recordBoth(SEED_MIGRATION, 'false');
  expect(off, 'the seed unseeds regardless of SEED_DEMO').not.toBe(seeded);
});

test(`${SEED_MIGRATION} — with SEED_DEMO on, up encrypts before it writes`, async () => {
  vi.stubEnv('SEED_DEMO', 'true');
  // Emptying the vault namespace is the cheapest way to stop `openEncryption` at its first line. The
  // failure is the assertion: reaching that guard proves the flag let `up` through, and reaching it
  // *before* any `insertOne` proves the seed never offers a legible email address to a collection
  // whose `login.email` is `binData` — a plain insert would be refused by the server, and refused is
  // a far worse outcome than encrypted only because it happens in front of whoever ran the seed.
  vi.stubEnv('CSFLE_KEY_VAULT_NAMESPACE', '');
  const migration = load(SEED_MIGRATION);
  const { db, log } = recordingDb();

  await expect(migration.up(db, null)).rejects.toThrow(
    'CSFLE_KEY_VAULT_NAMESPACE is not set — this migration writes encrypted fields and cannot run without it'
  );
  expect(log, 'nothing is written before the encryption handle is open').toEqual([]);
});

// ⚠️ `address({ encrypted: [...] })` names its members as STRINGS, and a misspelt one is the one
// mistake in this repo that no other test can see: `encrypted.includes('postCode')` answers false
// exactly as it does for a member deliberately left in the clear, so the builder would return a
// perfectly valid validator with `postalCode` still typed `string` — and the collection would be
// created half converted, with nothing noticing until the first service write of a blob into a
// string field. Hence the guard, and hence this: it is the only assertion that a typo is louder than
// a decision.
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
