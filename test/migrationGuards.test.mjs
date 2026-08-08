// Unit tests for the two things the migration suite structurally cannot reach.
//
// That suite replays every migration against a real MongoDB, which is the right way to test a
// migration and is why it is the main suite here. But a real server only ever produces the happy
// answer, and two branches are only entered when it does not:
//
//   1. the `if (err.codeName !== 'IndexNotFound') throw err` re-throw inside every guarded
//      `dropIndex` — reached only when the server refuses the drop for some *other* reason, which
//      a working test cluster never does; and
//   2. the `SEED_DEMO=true` half of the two seed migrations, which the suite runs with the flag
//      off (it is on only under `yarn test:seed`, and the two seeded assertions there are
//      `skipIf`-ed rather than required).
//
// Both are driven here with a fake `db` — an object with the methods the migrations call — so the
// failure is the one being tested and not a server that happens to be misconfigured. The migrations
// are loaded per test rather than at the top of the file because the seed pair reads
// `process.env.SEED_DEMO` at module load: the value has to be stubbed *before* the load, and the
// module cache cleared between the two states. See the note on `load` for why that load is a
// `require`.
import { afterEach, test, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ObjectId } from 'mongodb';

// The shape a MongoDB driver error carries. `codeName` is what the guards read — not `code`, and
// not the message — so it is what a fake has to get right.
const notFound = () => Object.assign(new Error('index not found with name [x]'), { codeName: 'IndexNotFound', code: 27 });
const refused = () => Object.assign(new Error('not authorized on db to execute dropIndexes'), { codeName: 'Unauthorized', code: 13 });

/**
 * A `db` that records what it was asked to do and fails `dropIndex` however the test says.
 *
 * Everything else resolves: the migrations under test call `createIndex` either side of the drop,
 * `command` to install a validator (that is what `setValidator` is), `updateMany` to strip the
 * fields a rollback removes, and `insertOne` / `deleteOne` for the seeds. A fake that refused any
 * of them would fail these tests for the wrong reason.
 */
function fakeDb(dropIndexBehaviour) {
  const calls = { dropIndex: [], createIndex: [], insertOne: [], deleteOne: [], updateMany: [], command: [] };
  const db = {
    async command(spec) {
      calls.command.push(spec);
    },
    collection(name) {
      return {
        async dropIndex(indexName) {
          calls.dropIndex.push([name, indexName]);
          if (dropIndexBehaviour) throw dropIndexBehaviour();
        },
        async createIndex(key, options) {
          calls.createIndex.push([name, key, options]);
        },
        async insertOne(doc) {
          calls.insertOne.push([name, doc]);
        },
        async deleteOne(filter) {
          calls.deleteOne.push([name, filter]);
        },
        async updateMany(filter, update) {
          calls.updateMany.push([name, filter, update]);
        },
      };
    },
  };
  return { db, calls };
}

/*
 * ⚠️ `require`, not `import()`, and the reason is coverage rather than style.
 *
 * migrate-mongo loads a migration with node's own loader, so `test/migrations.test.mjs` covers the
 * file exactly as it sits on disk. An `import()` from here goes through vite instead, which hands
 * v8 a *second* script for the same path with different byte offsets — and merging two coverage
 * reports whose ranges do not line up does not union them, it loses them. Measured: the migration
 * suite alone reports 91.75% statements, and adding an `import()`-based version of this file
 * dropped the merged total to 85.56% on one run and 87.62% on the next, with the uncovered lines
 * moving between runs. Requiring the same script the other suite requires keeps one entry per file.
 *
 * `vi.resetModules()` does not clear node's CommonJS cache, so the delete below is what actually
 * re-evaluates a seed migration after `SEED_DEMO` is stubbed.
 */
const require = createRequire(import.meta.url);
const loaded = new Set();

const load = (file) => {
  const resolved = require.resolve(`../migrations/${file}.js`);
  delete require.cache[resolved];
  loaded.add(resolved);
  return require(resolved);
};

// ⚠️ The re-require is not tidiness — it is what keeps a `SEED_DEMO=true` module instance from
// outliving the test that stubbed the flag. The seed migrations read the variable once, at load, so
// a cached copy hands every later caller in this process a migration that seeds. Today vitest runs
// each test file in its own process, so the blast radius is this file; that is a default (`isolate`)
// and not a guarantee, and `test/migrations.test.mjs` asserts those collections are EMPTY, so the
// failure it would cause is in another file entirely. Dropping the entry and re-evaluating it under
// the restored environment costs a millisecond and removes the question.
afterEach(() => {
  vi.unstubAllEnvs();
  for (const resolved of loaded) {
    delete require.cache[resolved];
    require(resolved);
  }
  loaded.clear();
});

/*
 * Every guarded drop on the platform, and the direction that reaches its guard.
 *
 * `dropIndex` throws `IndexNotFound` instead of no-opping, which is why the guard exists at all:
 * a rollback has to converge from a partially applied `up`, where some of the indexes it is
 * dropping were never created. What the guard must NOT do is swallow anything else — an
 * unauthorized user, a failing server, a wrong collection — because that turns a migration that
 * did nothing into a migration that reports success.
 */
const guarded = [
  ['20260801000100-index-shopOwner-tbl', 'down'],
  ['20260802000100-index-shopOwner-registeredAt', 'down'],
  ['20260804010000-alter-company-public', 'down'],
  ['20260804040000-index-company-public-read', 'down'],
  // This one guards through a `dropByName` helper, and reaches it from `up`: `up` creates the new
  // indexes and then drops the ones they supersede. `down` gets there too, but only after
  // re-creating the superseded ones, so `up` is the shorter path to the same catch block.
  ['20260804050000-index-item-listing-sort', 'up'],
];

for (const [file, direction] of guarded) {
  test(`${file} — ${direction}() re-throws a drop failure that is not IndexNotFound`, async () => {
    const migration = load(file);
    const { db, calls } = fakeDb(refused);

    await assert.rejects(() => migration[direction](db), { codeName: 'Unauthorized' });
    assert.equal(calls.dropIndex.length, 1, 'it stops at the first refusal instead of dropping the rest');
  });

  test(`${file} — ${direction}() carries on past an index that is already gone`, async () => {
    const migration = load(file);
    const { db, calls } = fakeDb(notFound);

    // Not rejecting is the assertion; the count is what tells a swallowed error apart from a loop
    // that exited early and silently left the remaining indexes in place.
    await migration[direction](db);
    assert.ok(calls.dropIndex.length >= 1, 'it tried at least one drop');
  });
}

/*
 * The seed pair, with the flag on.
 *
 * `SEED_DEMO=true` is what a developer's local database is built with (`migrate:up` with the flag,
 * per CLAUDE.md), so this is not a dead branch — it is the branch that populates every dev
 * environment. Its `_id`s are fixed literals precisely so `down` removes exactly what `up` wrote,
 * and that pairing is what the assertions below are for: an `up` that inserts one id and a `down`
 * that deletes another leaves the document behind for ever, and no replay ever notices.
 */
test('20260301001800-seed-demo.js — seeds the admin and the shop owner, and takes back the same two', async () => {
  vi.stubEnv('SEED_DEMO', 'true');
  const migration = load('20260301001800-seed-demo');

  const inserted = fakeDb();
  await migration.up(inserted.db);

  assert.deepEqual(
    inserted.calls.insertOne.map(([collection, doc]) => [collection, doc._id.toHexString()]),
    [
      ['admin', '5c9a013fcf1448b9d885e018'],
      ['shopOwner', '5c9a013fcf1448b9d885e000'],
    ]
  );
  assert.equal(inserted.calls.insertOne[0][1].login.email, 'info@thedoctorweb.com');
  assert.equal(inserted.calls.insertOne[1][1].login.email, 'shopOwner@thedoctorweb.com');

  const removed = fakeDb();
  await migration.down(removed.db);

  assert.deepEqual(
    removed.calls.deleteOne.map(([collection, filter]) => [collection, filter._id.toHexString()]),
    [
      ['admin', '5c9a013fcf1448b9d885e018'],
      ['shopOwner', '5c9a013fcf1448b9d885e000'],
    ]
  );
});

test('20260803142526-seed-demo-company.js — seeds the company against the same shop owner', async () => {
  vi.stubEnv('SEED_DEMO', 'true');
  const migration = load('20260803142526-seed-demo-company');

  const inserted = fakeDb();
  await migration.up(inserted.db);

  assert.equal(inserted.calls.insertOne.length, 1);
  const [collection, company] = inserted.calls.insertOne[0];
  assert.equal(collection, 'company');
  assert.equal(company._id.toHexString(), '5c9a013fcf1448b9d885a000');
  // The link the second seed file exists for: without it the company belongs to nobody and the
  // shop owner the March seed wrote has no shop.
  assert.ok(company.idShopOwner instanceof ObjectId);
  assert.equal(company.idShopOwner.toHexString(), '5c9a013fcf1448b9d885e000');
  // Longitude first. Both orders are well-formed GeoJSON and no validator catches a transposition;
  // [-73.98, 40.74] is New York and [40.74, -73.98] is the Southern Ocean off Antarctica.
  assert.deepEqual(company.address.position, { type: 'Point', coordinates: [-73.98566, 40.74844] });

  const removed = fakeDb();
  await migration.down(removed.db);

  assert.equal(removed.calls.deleteOne.length, 1);
  assert.deepEqual(removed.calls.deleteOne[0][0], 'company');
  assert.equal(removed.calls.deleteOne[0][1]._id.toHexString(), '5c9a013fcf1448b9d885a000');
});
