// Integration tests for the migrate-mongo migrations.
// Runs the REAL migrations against a MongoDB and asserts the resulting DB state:
// collections, validators, indexes, validation enforcement, seed, reversibility.
//
// Connection is resolved from .env — no need to pass it on the command line.
// Precedence (URL):  TEST_MONGO_URL (inline)  >  MONGO_TEST_URL (.env, one ready-made
//                    URL)  >  assembled from MONGO_TEST_CONN_STRING +
//                    MONGO_TEST_UDBOWNER + MONGO_TEST_PWDDBOWNER +
//                    MONGO_TEST_AUTH_ADMIN (.env — what the `env` template is laid
//                    out for, and the RECOMMENDED way)  >  the dev URL that
//                    migrate-mongo-config.js builds from MONGO_DEV_* (.env)
// Precedence (DB):   TEST_MONGO_DB  >  MONGO_TEST_DB (.env)  >  'marketplace_migration_test'
//
//   yarn test                                       # everything from .env
//   yarn test:seed                                  # same, with SEED_DEMO=true
//   TEST_MONGO_URL='mongodb://localhost:27017' yarn test
//
// The test database is dropped before AND after the run, and can NEVER be the dev DB
// (guarded). Whatever user the URL carries must be allowed to create+drop that DB — so
// fill in the MONGO_TEST_* block rather than letting this fall through to the dev owner,
// which on a single-db dev cluster is not authorized on the test DB and fails every test
// on the first dropDatabase().
// This file is ESM (.mjs) because migrate-mongo is ESM from v12 on. Its CommonJS
// wrapper is a Proxy whose every property access returns a Promise, so under
// `require` the whole API reads as undefined — `mm.config.set` throws
// "is not a function". The migrations themselves stay CommonJS; the config
// declares `moduleSystem: 'commonjs'` and migrate-mongo still loads them.
//
// Runner: vitest (see vitest.config.mjs), not node:test — kept for parity with the
// seven backend services, which all run vitest. node:test's before()/after() map to
// vitest's beforeAll()/afterAll(), NOT beforeEach()/afterEach(): this suite's before/after
// drop and replay the whole database ONCE for the file, and getting the mapping wrong
// would drop and re-migrate the database around every single test instead.
// assert/strict is kept as-is — vitest runs node:assert fine, and rewriting every
// assertion to expect() would be churn with no behavioural gain.
//
// ⚠️ The old shop collection and its per-shop taxonomy collection were dropped outright on
// 2026-08-04, along with every migration that created or altered either (see CLAUDE.md). This
// suite used to spend most of its length on the shop: a 2dsphere geo index, five wholesale
// collMods, a required-field backfill, and the embedded-company extraction that emptied the
// collection twice over. None of that exists to test any more. What is left below covers
// `admin`, `shopOwner` and `company` only.
// `expect` alongside assert/strict, and only for the two snapshot tests: `toMatchSnapshot` has no
// node:assert equivalent, and hand-rolling one would mean writing the file-management half of it.
// Every other assertion here stays on node:assert/strict — see the header note above.
import { test, beforeAll, afterAll, expect } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Double, Int32, ObjectId, Decimal128 } from 'mongodb';
import mm from 'migrate-mongo';

const require = createRequire(import.meta.url);

/*
 * ⚠️ `require`, not the `import { buildMongoUrl } from '../lib/mongoUrl.js'` this line used to be,
 * and the reason is coverage rather than style.
 *
 * `migrate-mongo-config.js` — required natively below and by migrate-mongo itself — pulls the same
 * file in through node's loader. An ESM import here goes through vite instead, so v8 sees TWO
 * scripts for one path with different byte offsets, and merging coverage reports whose ranges do
 * not line up does not union them, it drops them. The symptom was a run that reported
 * lib/mongoUrl.js at 90.9% statements / 50% branches with lines 13-28 — both function bodies —
 * uncovered, roughly one run in six, while the file is exhaustively tested by
 * test/mongoUrl.test.mjs. Same note, same measurements, as the one in migrationGuards.test.mjs.
 */
const { buildMongoUrl } = require('../lib/mongoUrl.js');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env so the connection can be reused from it. Unguarded: dotenv is a hard dependency, so a
// catch here could only fire on a broken install — where vitest is missing too and this file never
// runs. Same change, same argument, as the head of migrate-mongo-config.js.
require('dotenv').config();

// Returns null if nothing is configured -> suite skips instead of failing.
//
// The MONGO_TEST_* branch is the one the `env` template is set up for: the test
// connection is stored split into pieces, exactly like MONGO_DEV_*, not as one
// ready-made URL. Assembling it here is what makes those variables do anything —
// without this branch a fully populated MONGO_TEST_* block is silently ignored
// and the suite falls through to the dev URL below.
//
// It uses the DB OWNER pair, not the R/W pair: `before` calls dropDatabase() and
// the migrations create collections, validators and indexes, none of which a
// read/write user may do. MONGO_TEST_UDBRW / MONGO_TEST_PWDDBRW are deliberately
// unread by this suite.
function resolveUrl() {
  if (process.env.TEST_MONGO_URL) return process.env.TEST_MONGO_URL;
  if (process.env.MONGO_TEST_URL) return process.env.MONGO_TEST_URL;
  if (process.env.MONGO_TEST_CONN_STRING) {
    return buildMongoUrl(
      {
        connString: process.env.MONGO_TEST_CONN_STRING,
        user: process.env.MONGO_TEST_UDBOWNER,
        password: process.env.MONGO_TEST_PWDDBOWNER,
        authSource: process.env.MONGO_TEST_AUTH_ADMIN,
      },
      {
        connString: 'MONGO_TEST_CONN_STRING',
        user: 'MONGO_TEST_UDBOWNER',
        password: 'MONGO_TEST_PWDDBOWNER',
      }
    );
  }
  try { return require('../migrate-mongo-config.js').mongodb.url; } catch (_) { return null; }
}
const URL = resolveUrl();
const DB = process.env.TEST_MONGO_DB || process.env.MONGO_TEST_DB || 'marketplace_migration_test';
const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

const APP_COLLECTIONS = ['admin', 'shopOwner', 'company', 'user', 'item', 'itemCategory'];

// non-_id indexes expected per collection
const EXPECTED_INDEXES = {
  admin: ['login.email_unique'],
  // 20260804000000 — the same single index the other two login collections carry, from the same
  // shared constant. No 2dsphere over `addresses.position`: nothing queries customers by distance.
  user: ['login.email_unique'],
  shopOwner: [
    'login.email_unique',
    // 20260801000100 — one per sort column the operator table exposes.
    'tbl_active_registeredAt', 'tbl_active_lastName_firstName', 'tbl_active_firstName', 'tbl_active_city',
    // 20260802000100 — the chart's unfiltered `registeredAt` range, which no tbl_active_* index
    // can seek into because they all lead with deleted/disabled and the chart bounds neither.
    'registeredAt_series',
  ],
  // 20260803000000 — `vatNumber_unique` / `certifiedEmail_unique` are global uniques (one VAT number, one certified email,
  // per company, whoever registered it); `idShopOwner_list` backs the only list query on the
  // collection. All three were created directly on `company` — see CLAUDE.md for the now-removed
  // old shop collection's history the first two carried before this collection existed.
  //
  // 20260804010000 adds the other three, when the company stopped being only a legal record and
  // became the shop a customer browses. `slug_unique` is the URL; `address.position_2dsphere` is
  // what `companiesNearby` and the map run on, and the create migration explicitly deferred it on
  // the grounds that nothing queried companies by distance — something does now; `published_list`
  // is the two equality predicates every public read carries.
  // 20260804040000 adds the last three: the company half of the public text search, and the two
  // compound indexes that make /shops and /shops/:city index walks instead of blocking sorts. Note
  // `published_list` is still here — it is a strict prefix of `published_publicName` and therefore
  // redundant, and that migration argues why it is left installed rather than dropped.
  company: [
    'vatNumber_unique', 'certifiedEmail_unique', 'idShopOwner_list',
    'slug_unique', 'address.position_2dsphere', 'published_list',
    'search_text', 'published_publicName', 'published_city_publicName',
  ],
  // 20260804020000 — a plain unique slug (required here, so no null keys and no partial filter) and
  // the level+order index the two listing reads walk.
  itemCategory: ['slug_unique', 'idParent_position'],
  // 20260804030000 — the owner's catalogue, the per-company slug rule that doubles as the
  // /shop/:slug/item/:itemSlug lookup, the public shop page, the category browse, and the text index.
  // ⚠️ The public shop page and category browse are the `_name` pair, not the three-key indexes that
  // migration created: `20260804050000` replaced both, because the listings sort by `name` and a sort
  // key absent from the index is a blocking SORT over every match. The short forms are dropped there,
  // being exact prefixes of these — so naming them here would assert the state of a superseded
  // migration.
  item: [
    'idCompany_list', 'idCompany_slug_unique', 'idCompany_published_name', 'idCategory_published_name', 'search_text',
  ],
};

const MIGRATION_FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js')).sort();

// Both seed migrations are gated on this, so every count they touch has two right answers and the
// suite has to be run twice (`yarn test` and `yarn test:seed`) to see both. Read once here rather
// than spelled out at each call site: the two seeds share one flag, and a test that checked only
// one of them would pass under a half-applied seed.
const SEEDED = process.env.SEED_DEMO === 'true';

if (!URL) {
  // node:test's `{ skip: 'reason' }` third-argument form has no vitest equivalent — vitest's
  // test() takes (name, fn, timeout), not an options object. test.skip() is the vitest way to
  // report a skipped test (shows as "skipped" in the reporter, same as node:test did), so the
  // reason goes in the test name instead of a skip option.
  test.skip('migration integration tests — no MongoDB configured — fill the MONGO_TEST_* block in .env (or pass TEST_MONGO_URL inline); see test/migrations.test.mjs header', () => {});
} else {
  let db;
  let client;
  let counter = 0;
  const uid = () => String(counter++);

  beforeAll(async () => {
    if (DB === process.env.MONGO_DEV_DB) throw new Error(`refusing to run against MONGO_DEV_DB (${DB})`);
    mm.config.set({
      mongodb: { url: URL, databaseName: DB, options: {} },
      migrationsDir: MIGRATIONS_DIR,
      changelogCollectionName: 'changelog',
      lockCollectionName: 'changelog_lock',
      lockTtl: 90,
      migrationFileExtension: '.js',
      useFileHash: false,
      moduleSystem: 'commonjs',
    });
    const conn = await mm.database.connect();
    db = conn.db;
    client = conn.client;
    await db.dropDatabase(); // clean slate
  });

  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (client) await client.close();
  });

  const collNames = async () => (await db.listCollections().toArray()).map((c) => c.name);
  const collInfo = async (name) => (await db.listCollections({ name }).toArray())[0];

  // Two collections have a validator that is not a bare `$jsonSchema` but
  // `$and: [{ $jsonSchema }, { $expr }]`, because each carries one rule JSON Schema cannot state at
  // all. On `user` it is "defaultAddress points into this document's own addresses"; on `company`,
  // since 20260804010000, it is "a published company has a slug and a publicName". Both are
  // cross-field, and a collection validator accepts any query expression, so the two clauses ride
  // together. Unwrapping is done here once rather than at each call site, and it deliberately throws
  // rather than returning undefined if a collection ever has neither — a silently undefined schema
  // would pass every assertion below.
  const jsonSchemaOf = (validator) => {
    if (validator.$jsonSchema) return validator.$jsonSchema;
    return validator.$and.find((clause) => clause.$jsonSchema).$jsonSchema;
  };

  // ---- helpers to build minimal VALID documents -----------------------------
  const validAdmin = () => ({
    _id: new ObjectId(),
    login: { email: `a${uid()}@t.co`, password: 'x'.repeat(60) },
    personalData: { firstName: 'A', lastName: 'B' },
  });

  // `published: false` is in here rather than at the call sites because 20260804010000 put it in
  // `required` — a fixture without it stopped being a valid company, and every one of the two dozen
  // `accepts('company', …)` assertions below would have started failing for a reason that has
  // nothing to do with what each of them is testing.
  const validCompany = () => {
    const n = uid();
    return {
      _id: new ObjectId(),
      idShopOwner: new ObjectId(),
      legalName: 'R', vatNumber: n.padStart(11, '0'), contactPerson: 'R',
      administrator: 'A', certifiedEmail: `certified${n}@example.com`, registryExtract: 'v.pdf',
      address: {
        street: 'Via', postalCode: '24030', city: 'C', province: 'BG',
        // GeoJSON order, [lng, lat], and doubles — the shape every collection with an address
        // point stores, deliberately (see lib/schemas/geo.js).
        position: { type: 'Point', coordinates: [new Double(9.6), new Double(45.6)] },
      },
      published: false,
    };
  };

  // A category and an item, both minimal. `validItem` takes its two references rather than
  // minting them: nothing in MongoDB checks them, but a test that asserts on the category browse
  // needs the item to actually be filed under the category it queries.
  const validItemCategory = (over = {}) => {
    const n = uid();
    return { _id: new ObjectId(), name: `C${n}`, slug: `cat-${n}`, position: 0, ...over };
  };

  const validItem = (over = {}) => {
    const n = uid();
    return {
      _id: new ObjectId(),
      idCompany: new ObjectId(),
      idCategory: new ObjectId(),
      name: `I${n}`, description: 'd', slug: `item-${n}`, published: false,
      ...over,
    };
  };

  const validShopOwner = (emailVerify) => {
    const n = uid();
    const doc = {
      _id: new ObjectId(),
      login: { email: `i${n}@t.co`, password: 'x'.repeat(60) },
      personalData: {
        firstName: 'M', lastName: 'R',
        birth: { date: new Date('1970-11-24T00:00:00Z') },
        address: { street: 'Via', postalCode: '24030', city: 'C', province: 'BG' },
        contacts: { mobile: '333', email: `c${n}@t.co` },
      },
      registeredAt: new Date(),
    };
    if (emailVerify !== undefined) doc.emailVerify = emailVerify;
    return doc;
  };

  const rejects = async (coll, doc) => {
    await assert.rejects(() => db.collection(coll).insertOne(doc), `expected ${coll} insert to be rejected by validator`);
  };
  const accepts = async (coll, doc) => {
    await db.collection(coll).insertOne(doc);
    await db.collection(coll).deleteOne({ _id: doc._id }); // keep collections clean for later assertions
  };

  // The point as both `company` and `shopOwner` declare it: tuple form, one schema per axis,
  // longitude first, and not decimal. The two collections describe the same GeoJSON value and must
  // not disagree — asserting it from one place is what makes that a single claim.
  const assertGeoJsonTuple = (coords) => {
    assert.ok(Array.isArray(coords.items), 'tuple-form coordinates, one schema per position');
    assert.equal(coords.items[0].maximum, 180, 'longitude first');
    assert.equal(coords.items[1].maximum, 90, 'latitude second');
    assert.deepEqual(coords.items[1].bsonType, ['double', 'int', 'long'], 'not decimal — mongoose writes a double');
  };

  // ---- tests (run sequentially, in order) -----------------------------------

  test('up applies every migration', async () => {
    const applied = await mm.up(db, client);
    assert.equal(applied.length, MIGRATION_FILES.length, 'all migration files applied');
    const logged = await db.collection('changelog').countDocuments();
    assert.equal(logged, MIGRATION_FILES.length, 'changelog has one entry per migration');
  });

  test('up is idempotent (re-run applies nothing)', async () => {
    const applied = await mm.up(db, client);
    assert.equal(applied.length, 0, 'second up applies zero migrations');
  });

  test('all expected collections exist', async () => {
    const names = new Set(await collNames());
    for (const c of APP_COLLECTIONS) assert.ok(names.has(c), `collection ${c} exists`);
  });

  test('each collection has a strict $jsonSchema validator', async () => {
    for (const c of APP_COLLECTIONS) {
      const info = await collInfo(c);
      const v = info.options && info.options.validator;
      assert.ok(v && (v.$jsonSchema || v.$and), `${c} has a validator`);
      assert.equal(jsonSchemaOf(v).title, c, `${c} validator title`);
      assert.equal(info.options.validationLevel, 'strict', `${c} strict`);
      assert.equal(info.options.validationAction, 'error', `${c} error action`);
    }
  });

  test('expected indexes exist with exact names', async () => {
    for (const [c, expected] of Object.entries(EXPECTED_INDEXES)) {
      const names = (await db.collection(c).indexes()).map((i) => i.name);
      for (const idx of expected) assert.ok(names.includes(idx), `${c} has index ${idx}`);
    }
  });

  // The two assertions above are deliberately partial — one names the collections it wants, the
  // other names the indexes it wants — and every test below them is partial by construction too:
  // each picks the one field it is about. That is readable, and it leaves the *rest* of every
  // shape unasserted. The cost is not theoretical: a mutation run over lib/ + migrations/ found
  // that changing `maxLength: 150` to `maxLength: 151`, `unique: true` to `unique: false`,
  // `'2dsphere'` to `''` or a `bsonType` list to `[]` broke no test at all, because no test ever
  // looked at those bytes.
  //
  // These two close that hole wholesale. They freeze the ENTIRE validator and the ENTIRE index
  // list of every collection, so any edit anywhere under lib/schemas/ or migrations/ that changes
  // what the database ends up holding shows up here as a diff. They are not a substitute for the
  // named tests below — a snapshot says "this changed", not "this is wrong", and the named tests
  // are what carry the argument for each rule. They are the backstop underneath them.
  //
  // ⚠️ Regenerate with `yarn test -u` ONLY after reading the diff. A snapshot updated because "the
  // test went red" launders a schema regression into a committed expectation, which is the exact
  // failure mode these exist to catch. Every hunk in that diff has to be a change someone meant.
  //
  // ⚠️ Position matters: both run while every migration is applied and before the first down-test
  // pops anything. Moving either below the `down` tests would snapshot a half-reverted database.
  // ⚠️ Both snapshot a JSON STRING rather than the object itself. pretty-format — what vitest
  // serializes objects with — prints object keys in sorted order, and key order is the whole
  // meaning of an index key document: `{ published: 1, deleted: 1, publicName: 1 }` IS the ESR
  // ordering, and a version with the keys shuffled is a different index that pretty-format renders
  // identically. `JSON.stringify` preserves insertion order. Same reasoning, same note, as
  // test/migrationCalls.test.mjs.
  const frozen = (value) => JSON.stringify(value, null, 2);

  test('the full validator of every collection is frozen', async () => {
    for (const c of APP_COLLECTIONS) {
      const info = await collInfo(c);
      expect(frozen(info.options.validator)).toMatchSnapshot(`${c} validator`);
      expect(frozen({ validationLevel: info.options.validationLevel, validationAction: info.options.validationAction }))
        .toMatchSnapshot(`${c} validation mode`);
    }
  });

  test('the full index set of every collection is frozen', async () => {
    for (const c of APP_COLLECTIONS) {
      // `v` is the index-format version the SERVER chose, not something these migrations state, so
      // it is dropped — leaving it in would make the snapshot fail on a MongoDB upgrade and say
      // nothing about this repo. Everything else (key order included, which is the ESR ordering)
      // is exactly what the migrations asked for and is asserted verbatim.
      const indexes = (await db.collection(c).indexes()).map(({ v, ...rest }) => rest);
      expect(frozen(indexes)).toMatchSnapshot(`${c} indexes`);
    }
  });

  test('seed demo present only when SEED_DEMO=true', async () => {
    const expected = SEEDED ? 1 : 0;
    // admin + shopOwner come from 20260301001800-seed-demo; company comes from
    // 20260803142526-seed-demo-company, ordered after 20260803000000-create-company so the
    // collection it inserts into already exists. Both files are gated on the same flag.
    for (const c of ['admin', 'shopOwner', 'company']) {
      assert.equal(await db.collection(c).countDocuments(), expected, `${c} seed count`);
    }
  });

  test('validator enforces required fields', async () => {
    await rejects('admin', { login: { email: 'x@t.co', password: 'x'.repeat(60) } }); // missing personalData
    await accepts('admin', validAdmin());
  });

  // ---- 20260726000000-alter-shopOwner-emailVerify ------------------------
  //
  // The alter migration replaces the whole `shopOwner` validator via collMod, which is the risk
  // worth testing: passing only the new block would silently drop every other rule on the collection.
  // So the first assertion is that the pre-existing rules are still there, and only then that the new
  // ones are.

  test('emailVerify collMod keeps the rest of the shopOwner validator intact', async () => {
    const { $jsonSchema } = (await collInfo('shopOwner')).options.validator;

    assert.deepEqual($jsonSchema.required, ['login', 'personalData', 'registeredAt'], 'top-level required survives');
    assert.equal($jsonSchema.additionalProperties, false, 'strict object survives');
    // resetPwd is the neighbour most likely to be clobbered by a partial collMod — and the one that
    // must NOT be merged with emailVerify.
    assert.deepEqual($jsonSchema.properties.resetPwd.required, ['resetDateReq', 'resetHash'], 'resetPwd rules survive');
    assert.equal($jsonSchema.properties.personalData.properties.contacts.required.includes('mobile'), true);
    assert.equal($jsonSchema.properties.login.properties.password.minLength, 60);

    const ev = $jsonSchema.properties.emailVerify;
    assert.ok(ev, 'emailVerify block added');
    assert.equal(ev.additionalProperties, false, 'emailVerify is strict');
    // No `required` array at all — every member is written independently by the koa-utils flow, so
    // requiring any of them makes the flow reject its own next write.
    assert.equal(ev.required, undefined, 'emailVerify has no required array');
    assert.deepEqual(
      Object.keys(ev.properties).sort(),
      ['dateLastReq', 'hash', 'newEmailTmp', 'requestTimes', 'valid'],
      'emailVerify members'
    );
  });

  test('shopOwner accepts every emailVerify state the verify-email flow produces', async () => {
    // no emailVerify at all — an shopOwner who never requested a link
    await accepts('shopOwner', validShopOwner(undefined));
    // post-setEmailHash: hash + requestTimes + dateLastReq, and deliberately no `valid`
    await accepts('shopOwner', validShopOwner({
      hash: 'x'.repeat(50), requestTimes: new Int32(1), dateLastReq: new Date(),
    }));
    // post-enableEmailAccess: `valid` alone, the other three unset
    await accepts('shopOwner', validShopOwner({ valid: true }));
    // mid email-change: everything at once
    await accepts('shopOwner', validShopOwner({
      valid: true, hash: 'y'.repeat(50), requestTimes: new Int32(4),
      dateLastReq: new Date(), newEmailTmp: 'fresh@t.co',
    }));
  });

  test('shopOwner.emailVerify enforces its own field rules', async () => {
    // additionalProperties: false — a typo'd member is a rejected write, not a silently stored one
    await rejects('shopOwner', validShopOwner({ hash: 'x'.repeat(50), requestTime: new Int32(1) }));
    // the hash is fixed-width: EMAIL_HASH_LEN is 50 in koa-utils, both bounds enforced
    await rejects('shopOwner', validShopOwner({ hash: 'x'.repeat(49) }));
    await rejects('shopOwner', validShopOwner({ hash: 'x'.repeat(51) }));
    // requestTimes is `bsonType: 'int'`, so a BSON double fails — this is the one that bites, because
    // a JS number is only serialized as int32 when the driver sees it as integral.
    await rejects('shopOwner', validShopOwner({ requestTimes: new Double(1.5) }));
    await accepts('shopOwner', validShopOwner({ requestTimes: new Int32(5) }));
    // wrong types on the remaining members
    await rejects('shopOwner', validShopOwner({ valid: 'true' }));
    await rejects('shopOwner', validShopOwner({ dateLastReq: '2026-07-20' }));
    await rejects('shopOwner', validShopOwner({ newEmailTmp: 'n'.repeat(251) }));
  });

  test('emailVerify down strips the field and restores the narrower validator', async () => {
    const kept = validShopOwner({ valid: true, hash: 'z'.repeat(50) });
    await db.collection('shopOwner').insertOne(kept);

    // Every migration that sorts above this one has to come off first — `down` reverts the most
    // recently applied migration. Every migration added after this one has to extend this list and
    // the count below.
    await mm.down(db, client); // 20260804050000-index-item-listing-sort
    await mm.down(db, client); // 20260804040000-index-company-public-read
    await mm.down(db, client); // 20260804030000-create-item
    await mm.down(db, client); // 20260804020000-create-itemCategory
    await mm.down(db, client); // 20260804010000-alter-company-public
    await mm.down(db, client); // 20260804000000-create-user
    await mm.down(db, client); // 20260803142526-seed-demo-company
    await mm.down(db, client); // 20260803000000-create-company
    await mm.down(db, client); // 20260802000300-alter-shopOwner-position-note
    await mm.down(db, client); // 20260802000100-index-shopOwner-registeredAt
    await mm.down(db, client); // 20260801000100-index-shopOwner-tbl
    await mm.down(db, client); // 20260726000000-alter-shopOwner-emailVerify
    const popped = 12;

    const { $jsonSchema } = (await collInfo('shopOwner')).options.validator;
    assert.equal($jsonSchema.properties.emailVerify, undefined, 'emailVerify removed from validator');
    assert.deepEqual($jsonSchema.properties.resetPwd.required, ['resetDateReq', 'resetHash'], 'resetPwd still intact');

    // down() unsets the field on the way out. Without that, this document would still carry `emailVerify`
    // under a validator that no longer allows it, and its next full-document write would be rejected.
    const stored = await db.collection('shopOwner').findOne({ _id: kept._id });
    assert.equal('emailVerify' in stored, false, 'stored emailVerify unset by down()');

    await db.collection('shopOwner').deleteOne({ _id: kept._id });
    const applied = await mm.up(db, client);
    assert.equal(applied.length, popped, 'every migration popped above re-applied');
  });

  // ---- 20260802000300-alter-shopOwner-position-note ----------------------
  //
  // The first wholesale collMod on `shopOwner` since emailVerify, adding two optional fields: the
  // GeoJSON point of the address and the operator's free-text note. Optional is the whole design —
  // `collMod` does not re-validate stored documents, so a required point would leave every
  // shopOwner written before this migration unwritable, and there is nothing to backfill it from
  // without geocoding every stored street address.

  test('the shopOwner alter keeps the rest of its validator intact', async () => {
    const { $jsonSchema } = (await collInfo('shopOwner')).options.validator;

    assert.deepEqual($jsonSchema.required, ['login', 'personalData', 'registeredAt'], 'top-level required survives');
    assert.equal($jsonSchema.additionalProperties, false, 'strict object survives');
    // The emailVerify alter was restated on top of, so its work has to still be here — including its
    // deliberate absence of a `required` array, which is what lets the verify flow write it in pieces.
    assert.equal($jsonSchema.properties.emailVerify.properties.hash.maxLength, 50, 'the emailVerify alter survives');
    assert.equal($jsonSchema.properties.emailVerify.required, undefined, 'emailVerify still requires no member');
    assert.deepEqual($jsonSchema.properties.resetPwd.required, ['resetDateReq', 'resetHash'], 'resetPwd intact');
    // `personalData.address`, whose own `street` is the 250-bounded one. Both of these named
    // `properties.street` at the outer level until now, which is the wrong level: the assertion threw
    // on `undefined` rather than failing, so it read as one broken test rather than as a rule nobody
    // was checking.
    assert.equal($jsonSchema.properties.personalData.properties.address.properties.street.maxLength, 250,
      "the shopOwner street bound (250, not company's 100) survives");

    const address = $jsonSchema.properties.personalData.properties.address;
    assert.deepEqual(address.required, ['street', 'postalCode', 'city', 'province'], 'position is NOT required');
    // Same tuple form as company.
    assertGeoJsonTuple(address.properties.position.properties.coordinates);

    // Top level, not inside personalData: `personalData` is what the shopOwner declared about
    // themselves, the note is what an operator wrote about them.
    assert.equal($jsonSchema.properties.notes.bsonType, 'string', 'note added as a string');
    assert.equal($jsonSchema.properties.notes.maxLength, 2000, 'note capped at 2000');
    assert.equal($jsonSchema.required.includes('notes'), false, 'note is not required');
    assert.equal($jsonSchema.properties.personalData.properties.notes, undefined, 'note is not under personalData');
  });

  test('shopOwner takes the address point as optional, in GeoJSON order, as a double', async () => {
    const withPosition = (coordinates) => {
      const doc = validShopOwner();
      doc.personalData.address.position = { type: 'Point', coordinates };
      return doc;
    };

    // Absent is valid, and that is the assertion the whole migration rests on: every shopOwner in
    // the collection is shaped exactly like this one.
    await accepts('shopOwner', validShopOwner());
    await accepts('shopOwner', withPosition([new Double(9.6), new Double(45.6)]));
    // A whole-degree coordinate arrives as an int32 — `int` is in the bsonType list for that reason.
    await accepts('shopOwner', withPosition([9, 45]));

    // 120 is impossible as a latitude, so this is the pair written the wrong way round. No validator
    // can catch a transposition inside the legal range, but this one is out of it.
    await rejects('shopOwner', withPosition([new Double(9.6), new Double(120)]));
    // Decimal128 is a rejected write, deliberately: `{ type: [Number] }` in the model can never
    // produce one, and GraphQLFloat.serialize throws on it after a `.lean()` read.
    await rejects('shopOwner', withPosition([Decimal128.fromString('9.6'), Decimal128.fromString('45.6')]));
    await rejects('shopOwner', withPosition([new Double(9.6)]));

    const withoutType = validShopOwner();
    withoutType.personalData.address.position = { coordinates: [new Double(9.6), new Double(45.6)] };
    await rejects('shopOwner', withoutType);
  });

  test('shopOwner takes the operator note as an optional string of at most 2000', async () => {
    const withNotes = (notes) => ({ ...validShopOwner(), notes });

    await accepts('shopOwner', withNotes('Call back in September'));
    await accepts('shopOwner', withNotes('N'.repeat(2000)));
    await rejects('shopOwner', withNotes('N'.repeat(2001)));
    // bsonType string under additionalProperties:false — a number is refused, not coerced.
    await rejects('shopOwner', withNotes(7));
  });

  test('the shopOwner alter down strips both fields and restores the previous validator', async () => {
    const annotated = validShopOwner();
    annotated.notes = 'Operator note';
    annotated.personalData.address.position = { type: 'Point', coordinates: [new Double(9.6), new Double(45.6)] };
    await db.collection('shopOwner').insertOne(annotated);

    // No longer the newest migration — `user`, company and its seed sort above it and come off
    // first. None of the three touches `shopOwner`, so the document planted above is unaffected.
    await mm.down(db, client); // 20260804050000-index-item-listing-sort
    await mm.down(db, client); // 20260804040000-index-company-public-read
    await mm.down(db, client); // 20260804030000-create-item
    await mm.down(db, client); // 20260804020000-create-itemCategory
    await mm.down(db, client); // 20260804010000-alter-company-public
    await mm.down(db, client); // 20260804000000-create-user
    await mm.down(db, client); // 20260803142526-seed-demo-company
    await mm.down(db, client); // 20260803000000-create-company
    await mm.down(db, client); // 20260802000300-alter-shopOwner-position-note

    const { $jsonSchema } = (await collInfo('shopOwner')).options.validator;
    assert.equal($jsonSchema.properties.notes, undefined, 'note removed from the validator');
    assert.equal($jsonSchema.properties.personalData.properties.address.properties.position, undefined,
      'position removed from the validator');
    // What this migration did not add, its revert must leave behind.
    assert.equal($jsonSchema.properties.emailVerify.properties.hash.maxLength, 50, 'emailVerify survives the revert');

    // down() unsets both on the way out: the restored validator is additionalProperties:false at both
    // levels, so a document still carrying either would be refused on its next full-document write.
    const stripped = await db.collection('shopOwner').findOne({ _id: annotated._id });
    assert.equal('notes' in stripped, false, 'stored note unset by down()');
    assert.equal('position' in stripped.personalData.address, false, 'stored position unset by down()');

    await db.collection('shopOwner').deleteOne({ _id: annotated._id });
    const applied = await mm.up(db, client);
    assert.equal(applied.length, 9,
      'the shopOwner alter, the company creation, its seed, the user creation, the three catalogue migrations and the two index migrations re-applied');
  });

  // ---- 20260803000000-create-company -----------------------------------------
  //
  // A company is a legal entity and a point of sale is a shop — `company` used to be an object
  // embedded inside the (now-removed) old shop collection, one copy per shop, until two unique indexes on
  // its VAT number and certified email made a company's second shop a rejected duplicate. This migration lifts
  // it into a collection of its own, owned by an shopOwner, so one company can run N shops.

  test('the company validator declares the company fields', async () => {
    // `jsonSchemaOf`, not a destructure: 20260804010000 made this validator the `$and` pair, so
    // `options.validator.$jsonSchema` is undefined here and every assertion below would have read a
    // property of undefined.
    const $jsonSchema = jsonSchemaOf((await collInfo('company')).options.validator);

    // `published` is last because the alter appends it — the create migration's eight, then the one
    // field that had to join `required` for the shop listing to mean anything.
    assert.deepEqual(
      $jsonSchema.required,
      ['idShopOwner', 'legalName', 'vatNumber', 'contactPerson', 'administrator', 'certifiedEmail', 'registryExtract', 'address',
        'published'],
      'required list'
    );
    assert.equal($jsonSchema.additionalProperties, false, 'strict object');
    assert.deepEqual($jsonSchema.properties.idShopOwner, { bsonType: 'objectId' }, 'owned by an shopOwner');

    assert.equal($jsonSchema.properties.legalName.maxLength, 100, 'legalName bound');
    assert.equal($jsonSchema.properties.vatNumber.minLength, 11, 'vatNumber lower bound');
    assert.equal($jsonSchema.properties.vatNumber.maxLength, 11, 'vatNumber upper bound');
    assert.equal($jsonSchema.properties.contactPerson.maxLength, 50, 'contactPerson bound');
    assert.equal($jsonSchema.properties.administrator.maxLength, 50, 'administrator bound');
    assert.equal($jsonSchema.properties.uniqueCode.minLength, 7, 'uniqueCode lower bound');
    assert.equal($jsonSchema.properties.uniqueCode.maxLength, 7, 'uniqueCode upper bound');
    assert.equal($jsonSchema.properties.certifiedEmail.maxLength, 250, 'certifiedEmail bound');
    assert.equal($jsonSchema.properties.registryExtract.maxLength, 1000, 'registryExtract is capped');

    // `taxCode` is optional by omission from the required list above: `collMod` does not re-validate
    // stored documents, and no company carries the field.
    assert.equal($jsonSchema.properties.taxCode.minLength, 11, 'taxCode lower bound');
    assert.equal($jsonSchema.properties.taxCode.maxLength, 11, 'taxCode upper bound');
    assert.equal($jsonSchema.required.includes('taxCode'), false, 'taxCode is optional');

    // `deleted` is a DATE, the spelling `shopOwner` already uses — a bool would answer whether
    // the document is gone and not when. Optional, and it has to be: a live company has no deletion
    // instant to carry, so requiring it would make every insert fail.
    assert.deepEqual($jsonSchema.properties.deleted, { bsonType: 'date' }, 'deleted is an optional date');
    assert.equal($jsonSchema.required.includes('deleted'), false, 'deleted is optional');

    // The registered seat: required, position included, since the collection is created empty and
    // there is no stored document for the requirement to strand.
    assert.deepEqual(
      // `address`, not `street` — same rename leftover as in the shopOwner alter test above.
      $jsonSchema.properties.address.required,
      ['street', 'postalCode', 'city', 'province', 'position'],
      'position is required'
    );
    assertGeoJsonTuple($jsonSchema.properties.address.properties.position.properties.coordinates);
  });

  test('company enforces its field rules', async () => {
    await accepts('company', validCompany());

    // An company with no owner is unreachable — every read path lists by shopOwner — so the field
    // is required, and it is an objectId, not the string a GraphQL ID would arrive as.
    const withoutOwner = validCompany();
    delete withoutOwner.idShopOwner;
    await rejects('company', withoutOwner);
    await rejects('company', { ...validCompany(), idShopOwner: String(new ObjectId()) });

    // vatNumber is fixed at 11, both bounds.
    await rejects('company', { ...validCompany(), vatNumber: '1'.repeat(10) });
    await rejects('company', { ...validCompany(), vatNumber: '1'.repeat(12) });

    // taxCode is the same fixed width — the tax code of a legal entity, not the 16-character
    // personal form — and optional, so its absence from every helper above is not an oversight.
    await accepts('company', { ...validCompany(), taxCode: '1'.repeat(11) });
    await rejects('company', { ...validCompany(), taxCode: '1'.repeat(10) });
    await rejects('company', { ...validCompany(), taxCode: '1'.repeat(12) });

    // uniqueCode stays optional and exactly 7 wide.
    await accepts('company', { ...validCompany(), uniqueCode: 'A'.repeat(7) });
    await rejects('company', { ...validCompany(), uniqueCode: 'A'.repeat(8) });

    // registryExtract holds the uploaded file's path, not the file.
    await accepts('company', { ...validCompany(), registryExtract: 'v'.repeat(1000) });
    await rejects('company', { ...validCompany(), registryExtract: 'v'.repeat(1001) });

    await rejects('company', { ...validCompany(), legalName: 'R'.repeat(101) });
    await rejects('company', { ...validCompany(), contactPerson: 'R'.repeat(51) });
    await rejects('company', { ...validCompany(), administrator: 'A'.repeat(51) });
    await rejects('company', { ...validCompany(), certifiedEmail: `${'p'.repeat(245)}@mail.example` });
    // bsonType string under additionalProperties:false — a number is refused, not coerced.
    await rejects('company', { ...validCompany(), legalName: 7 });

    // The shop's own trading name named nothing here even while the old shop collection existed, and
    // still names nothing now that it does not: `additionalProperties: false` refuses any field
    // the validator does not declare.
    await rejects('company', { ...validCompany(), firstName: 'Shop Sign' });
  });

  test('company takes a deletion instant, and only a date', async () => {
    // Soft delete: `companyDel` stamps the field rather than removing the document, and every read path
    // filters on `{ $exists: false }`. Both states have to be storable, which is the whole point of
    // leaving it out of `required`.
    await accepts('company', validCompany());
    await accepts('company', { ...validCompany(), deleted: new Date('2026-08-04T10:00:00Z') });

    // A bool is the shape this field is most likely to be written as by mistake — it is what "deleted"
    // reads like — and `bsonType: 'date'` under additionalProperties:false refuses it rather than
    // coercing. Same for the epoch-milliseconds number and the ISO string a JSON client would send.
    await rejects('company', { ...validCompany(), deleted: true });
    await rejects('company', { ...validCompany(), deleted: 1754301600000 });
    await rejects('company', { ...validCompany(), deleted: '2026-08-04T10:00:00Z' });
  });

  test('a soft-deleted company keeps its VAT number and certified email occupied', async () => {
    // The consequence of leaving `vatNumber_unique` / `certifiedEmail_unique` global rather than partial, asserted
    // rather than left to be discovered: the document is still indexed once `deleted` is set, so the same
    // company cannot be registered a second time while the deleted one is there. That matches
    // `shopOwner.login.email_unique`, which behaves the same way for a soft-deleted owner.
    const removed = { ...validCompany(), deleted: new Date() };
    await db.collection('company').insertOne(removed);

    await assert.rejects(
      () => db.collection('company').insertOne({ ...validCompany(), vatNumber: removed.vatNumber }),
      /duplicate key/,
      'the deleted company still holds its VAT number'
    );
    await assert.rejects(
      () => db.collection('company').insertOne({ ...validCompany(), certifiedEmail: removed.certifiedEmail }),
      /duplicate key/,
      'and its certified email'
    );

    await db.collection('company').deleteOne({ _id: removed._id });
  });

  test('company takes a full street-address block, position included', async () => {
    const base = () => ({
      street: 'Via', postalCode: '24030', city: 'C', province: 'BG',
      position: { type: 'Point', coordinates: [new Double(9.6), new Double(45.6)] },
    });
    const withAddress = (address) => ({ ...validCompany(), address });
    const withPosition = (coordinates) => withAddress({ ...base(), position: { type: 'Point', coordinates } });

    await accepts('company', withAddress(base()));

    // Required, `position` included. The collection is created empty, so unlike the shopOwner
    // alter there is no stored document for the requirement to strand.
    const withoutAddress = validCompany();
    delete withoutAddress.address;
    await rejects('company', withoutAddress);
    const withoutPosition = base();
    delete withoutPosition.position;
    await rejects('company', withAddress(withoutPosition));

    // Per-axis ranges, longitude first: 120 is a legal longitude and an impossible latitude, and that
    // asymmetry is the whole reason for the tuple form.
    await accepts('company', withPosition([new Double(120), new Double(45)]));
    await rejects('company', withPosition([new Double(9), new Double(120)]));
    // A whole-degree coordinate arrives as int32 — 'int' is in the bsonType list for that reason.
    await accepts('company', withPosition([9, 45]));
    // Decimal128 is a rejected write, deliberately: `{ type: [Number] }` can never produce one, and
    // GraphQLFloat.serialize throws on it after a `.lean()` read.
    await rejects('company', withPosition([Decimal128.fromString('9.6'), Decimal128.fromString('45.6')]));
    await rejects('company', withPosition([new Double(9.6)]));

    await rejects('company', withAddress({ ...base(), postalCode: '2403' }));
    await rejects('company', withAddress({ ...base(), province: 'BGX' }));
    await rejects('company', withAddress({ ...base(), city: 'C'.repeat(101) }));
  });

  test('company has its own VAT-number / certified email uniques and a list index', async () => {
    const byName = Object.fromEntries((await db.collection('company').indexes()).map((i) => [i.name, i]));
    assert.deepEqual(byName.vatNumber_unique.key, { vatNumber: 1 }, 'vatNumber index key');
    assert.equal(byName.vatNumber_unique.unique, true, 'vatNumber index is unique');
    assert.deepEqual(byName.certifiedEmail_unique.key, { certifiedEmail: 1 }, 'certifiedEmail index key');
    assert.equal(byName.certifiedEmail_unique.unique, true, 'certifiedEmail index is unique');
    // NOT unique: one shopOwner owning several companies is the whole point of the collection, and
    // a unique index here would reject the second one at insert time.
    assert.deepEqual(byName.idShopOwner_list.key, { idShopOwner: 1 }, 'list index key');
    assert.equal(byName.idShopOwner_list.unique, undefined, 'the list index must not be unique');
  });

  test('company refuses a duplicate VAT number or certified email, whoever owns it', async () => {
    const first = validCompany();
    await db.collection('company').insertOne(first);

    // Different owner, different certified email, same VAT number — still refused. The index is global,
    // not scoped per shopOwner: one VAT number is one company, whoever registered it.
    await assert.rejects(
      () => db.collection('company').insertOne({ ...validCompany(), vatNumber: first.vatNumber }),
      /duplicate key/,
      'vatNumber is globally unique'
    );
    await assert.rejects(
      () => db.collection('company').insertOne({ ...validCompany(), certifiedEmail: first.certifiedEmail }),
      /duplicate key/,
      'certifiedEmail is globally unique'
    );

    // A second company under the SAME owner is accepted — one shopOwner may own several companies.
    await accepts('company', { ...validCompany(), idShopOwner: first.idShopOwner });

    await db.collection('company').deleteOne({ _id: first._id });
  });

  // ---- 20260804010000-alter-company-public -----------------------------------
  //
  // The migration that turns the legal record into a shop listing. Three things it does are worth
  // asserting rather than trusting: the four fields arrived, the pre-existing shape survived a
  // wholesale `collMod`, and the publish rule is enforced by the database rather than by whoever
  // remembers to check it.

  test('the company alter adds the four public fields and requires only published', async () => {
    const validator = (await collInfo('company')).options.validator;

    // The validator is the `$and` pair now, not a bare `$jsonSchema`. Asserted explicitly because a
    // future `collMod` that passes only the schema half would silently drop the publish rule, and
    // nothing else in this suite would notice.
    assert.ok(Array.isArray(validator.$and) && validator.$and.length === 2, 'validator is the $and pair');

    const $jsonSchema = jsonSchemaOf(validator);
    for (const field of ['publicName', 'slug', 'description', 'published']) {
      assert.ok(field in $jsonSchema.properties, `${field} declared`);
    }
    // Only `published` joins `required`. The other three cannot: `collMod` does not re-validate
    // stored documents, but it does govern their next write, and no slug or trading name can be
    // derived from a registered legal name without inventing one.
    assert.ok($jsonSchema.required.includes('published'), 'published is required');
    for (const field of ['publicName', 'slug', 'description']) {
      assert.equal($jsonSchema.required.includes(field), false, `${field} stays optional`);
    }

    // The wholesale replace kept everything 20260803000000 declared — including the per-axis
    // coordinate bounds, which are the part a careless restatement loses first.
    assert.equal($jsonSchema.properties.legalName.maxLength, 100, 'the create shape survives the collMod');
    assert.equal($jsonSchema.properties.vatNumber.minLength, 11, 'and so do its exact-length rules');
    assertGeoJsonTuple($jsonSchema.properties.address.properties.position.properties.coordinates);
  });

  test('a published company must be linkable, on insert and on update', async () => {
    // `published: true` with no slug is a shop with no URL; with no publicName it is a card with no
    // heading. Neither is a state the storefront can draw, and the `$expr` half makes both
    // unwritable — which is the whole reason the validator is a pair.
    await rejects('company', { ...validCompany(), published: true, publicName: 'Shop' });
    await rejects('company', { ...validCompany(), published: true, slug: `shop-${uid()}` });
    await accepts('company', { ...validCompany(), published: true, publicName: 'Shop', slug: `shop-${uid()}` });

    // The rule holds on the way in AND on the way through. An `$expr` in a collection validator runs
    // on every write, not only on insert — which is what makes it a constraint rather than a
    // create-time check the update path can walk around.
    const draft = validCompany();
    await db.collection('company').insertOne(draft);
    await assert.rejects(
      () => db.collection('company').updateOne({ _id: draft._id }, { $set: { published: true, publicName: 'Shop' } }),
      /failed validation/,
      'publishing without a slug is refused by the update path too'
    );
    await db.collection('company').deleteOne({ _id: draft._id });
  });

  test('the company slug is shaped for a URL', async () => {
    // Bounded and patterned, not merely capped: the value is the whole of /shop/:slug, so an
    // uppercase letter, a space or a slash is a different URL after normalisation or a 404.
    await rejects('company', { ...validCompany(), slug: 'Shop-Name' });
    await rejects('company', { ...validCompany(), slug: 'shop name' });
    await rejects('company', { ...validCompany(), slug: 'shop/name' });
    await rejects('company', { ...validCompany(), slug: 'shop--name' });
    await rejects('company', { ...validCompany(), slug: '-shop' });
    await rejects('company', { ...validCompany(), slug: 's' });
    await rejects('company', { ...validCompany(), slug: `s${'l'.repeat(120)}` });
    await accepts('company', { ...validCompany(), slug: 'northwind-trading-ltd-2' });
  });

  test('the slug unique index is partial, so slugless companies coexist', async () => {
    // A plain unique index stores one null key per document missing the field, so the SECOND company
    // without a slug would be refused as a duplicate of the first — and every company written before
    // this migration is one. `partialFilterExpression: { slug: { $type: 'string' } }` leaves them out
    // of the index entirely. `$type: 'string'` rather than `$exists: true`, which would admit an
    // explicit null and put the null keys back.
    const idx = (await db.collection('company').indexes()).find((i) => i.name === 'slug_unique');
    assert.equal(idx.unique, true, 'slug_unique is unique');
    assert.deepEqual(idx.partialFilterExpression, { slug: { $type: 'string' } }, 'and partial on a string slug');

    const a = validCompany();
    const b = validCompany();
    await db.collection('company').insertOne(a);
    await db.collection('company').insertOne(b);

    const taken = { ...validCompany(), slug: `taken-${uid()}`, publicName: 'X' };
    await db.collection('company').insertOne(taken);
    await assert.rejects(
      () => db.collection('company').insertOne({ ...validCompany(), slug: taken.slug }),
      /duplicate key/,
      'two companies cannot share a slug — it is the whole of /shop/:slug'
    );

    await db.collection('company').deleteMany({ _id: { $in: [a._id, b._id, taken._id] } });
  });

  test('the 2dsphere answers a $near rather than scanning', async () => {
    // `$near` on a collection with no 2dsphere index is an ERROR, not a slow query
    // ("unable to find index for $geoNear query"), so the query completing at all is half the
    // assertion. The other half is the plan: the index-backed stage is GEO_NEAR_2DSPHERE — not an
    // IXSCAN, which is what a reader expects and does not get — and it names the index it chose.
    const plan = await db.collection('company')
      .find({
        'address.position': {
          $near: { $geometry: { type: 'Point', coordinates: [-73.9772, 40.7527] }, $maxDistance: 20000 }
        }
      })
      .explain('queryPlanner');

    const winning = JSON.stringify(plan.queryPlanner.winningPlan);
    assert.ok(winning.includes('GEO_NEAR_2DSPHERE'), 'the geo stage is index-backed');
    assert.ok(winning.includes('address.position_2dsphere'), 'and it is the index this migration built');
  });

  // ---- 20260804020000-create-itemCategory ------------------------------------
  //
  // The platform-wide taxonomy, two levels deep, written only by the Admin tier. It has no owner
  // column at all, because a category spans every shop.

  test('the itemCategory validator declares a two-level taxonomy', async () => {
    const { $jsonSchema } = (await collInfo('itemCategory')).options.validator;

    assert.deepEqual($jsonSchema.required, ['name', 'slug', 'position'], 'required is name, slug and position');
    assert.equal($jsonSchema.additionalProperties, false, 'strict object');
    // `idParent` absent = top level, present = subcategory. That is the entire level mechanism, and
    // the depth cap is NOT here: "my parent must itself be top-level" reads another document, which
    // no validator can do. `itemCategoryAdd` enforces it.
    assert.equal($jsonSchema.properties.idParent.bsonType, 'objectId', 'idParent is an ObjectId');
    assert.equal($jsonSchema.required.includes('idParent'), false, 'and optional — absent means top level');
    // `position` here is a sort ordinal, NOT the GeoJSON point every other collection spells the same
    // way. Asserted so the two never get conflated by someone reading the field list.
    assert.equal($jsonSchema.properties.position.bsonType, 'int', 'position is an int sort ordinal');

    const parent = validItemCategory();
    await db.collection('itemCategory').insertOne(parent);
    await accepts('itemCategory', validItemCategory({ idParent: parent._id }));
    await db.collection('itemCategory').deleteOne({ _id: parent._id });
  });

  test('itemCategory enforces its field rules', async () => {
    await rejects('itemCategory', validItemCategory({ position: new Double(1.5) }));
    await accepts('itemCategory', validItemCategory({ position: new Int32(3) }));
    await rejects('itemCategory', validItemCategory({ slug: 'Not-Lower' }));
    await rejects('itemCategory', validItemCategory({ name: 'n'.repeat(101) }));
    await rejects('itemCategory', validItemCategory({ idParent: 'not-an-objectid' }));
    // No owner column — this is a platform-wide taxonomy, and additionalProperties:false is what
    // keeps someone from re-adding one by writing it.
    await rejects('itemCategory', validItemCategory({ idShopOwner: new ObjectId() }));
  });

  test('the itemCategory slug is unique across BOTH levels', async () => {
    // One flat URL space: /category/:slug and /category/:slug/:subSlug both resolve through this
    // field, so a subcategory may not take a slug a top-level category already holds. The index is a
    // plain unique rather than a partial one — `slug` is required here, so there are no null keys to
    // collide.
    const idx = (await db.collection('itemCategory').indexes()).find((i) => i.name === 'slug_unique');
    assert.equal(idx.unique, true, 'slug_unique is unique');
    assert.equal(idx.partialFilterExpression, undefined, 'and not partial — slug is required');
    assert.deepEqual(await indexKeys('itemCategory', 'idParent_position'), { idParent: 1, position: 1 },
      'the listing index leads with the level, then the order within it');

    const parent = validItemCategory();
    await db.collection('itemCategory').insertOne(parent);
    await assert.rejects(
      () => db.collection('itemCategory').insertOne(validItemCategory({ slug: parent.slug, idParent: parent._id })),
      /duplicate key/,
      'a subcategory cannot reuse a top-level slug'
    );
    await db.collection('itemCategory').deleteOne({ _id: parent._id });
  });

  // ---- 20260804030000-create-item --------------------------------------------
  //
  // What a shop sells. One collection plus the taxonomy above, replacing the 13 product-type
  // collections dropped on 2026-08-04 — they differed in their category, not in their shape.

  test('the item validator is domain-neutral and has no price', async () => {
    const { $jsonSchema } = (await collInfo('item')).options.validator;

    assert.deepEqual($jsonSchema.required, ['idCompany', 'idCategory', 'name', 'description', 'slug', 'published'],
      'the six required fields');
    assert.equal($jsonSchema.additionalProperties, false, 'strict object');
    assert.equal($jsonSchema.properties.deleted.bsonType, 'date', 'soft delete is a stamped date, like company');

    // ⚠️ The absence is the assertion. Cart, order, delivery and payment have no model anywhere on
    // this platform, so a price would be a guess at a currency, a precision, a VAT treatment and a
    // discount model at once — and Decimal128, the type it wants, is a rejected write everywhere here
    // because it cannot survive `.lean()` into GraphQL. This test fails the moment someone adds it
    // without the ordering tier, which is the point.
    assert.equal('price' in $jsonSchema.properties, false, 'no price until the ordering tier exists');
    await rejects('item', validItem({ price: new Double(9.5) }));

    // Both references are required and neither is enforced by the database — the resolvers check them,
    // exactly as they do for company.idShopOwner. Deleted rather than set to undefined: the driver
    // serialises undefined as null by default, which would test the bsonType rule instead of the
    // required one.
    const noCompany = validItem();
    delete noCompany.idCompany;
    await rejects('item', noCompany);
    const noCategory = validItem();
    delete noCategory.idCategory;
    await rejects('item', noCategory);
  });

  test('item enforces its field rules', async () => {
    await rejects('item', validItem({ name: 'n'.repeat(151) }));
    await rejects('item', validItem({ description: 'd'.repeat(2001) }));
    await rejects('item', validItem({ slug: 'Not-Lower' }));
    await rejects('item', validItem({ slug: 'a' }));
    await rejects('item', validItem({ published: 'false' }));
    await accepts('item', validItem({ deleted: new Date() }));
  });

  test('the item slug is unique per company, not globally', async () => {
    // The route is /shop/:slug/item/:itemSlug, so the company segment already disambiguates. A global
    // unique would put one shop's URLs at the mercy of another shop's catalogue: the second shop to
    // sell a "blue shirt" would be forced to "blue-shirt-2" by a name it cannot see.
    const idCompany = new ObjectId();
    const other = new ObjectId();
    const first = validItem({ idCompany, slug: 'same-slug' });
    await db.collection('item').insertOne(first);

    await assert.rejects(
      () => db.collection('item').insertOne(validItem({ idCompany, slug: 'same-slug' })),
      /duplicate key/,
      'the same slug twice in one company collides'
    );
    const elsewhere = validItem({ idCompany: other, slug: 'same-slug' });
    await db.collection('item').insertOne(elsewhere);

    await db.collection('item').deleteMany({ _id: { $in: [first._id, elsewhere._id] } });
  });

  test('the item indexes lead with the field the read filters on', async () => {
    assert.deepEqual(await indexKeys('item', 'idCompany_list'), { idCompany: 1, deleted: 1 },
      "the owner's catalogue: the company, then the soft-delete filter");
    assert.deepEqual(await indexKeys('item', 'idCompany_slug_unique'), { idCompany: 1, slug: 1 },
      'the per-company slug rule doubles as the /shop/:slug/item/:itemSlug lookup');
    // Not made redundant by idCompany_list: that one has `deleted` in second position, so a query
    // filtering on `published` would fetch and discard every draft the shop has.
    //
    // ⚠️ The trailing `name` is the load-bearing key and the reason `20260804050000` exists. Both
    // listings sort by `name`, and an index serves a sort only from the keys AFTER the last equality
    // predicate — so the three-key forms these replaced answered the filter and then handed every
    // match to an in-memory SORT stage. Measured at 100 000 items in one category: 100 000 docs
    // examined and 170 ms became 24 and 3 ms. Asserted as a key document rather than by name because
    // the position of `name` is the whole point; an index on the same four fields in any other order
    // does not serve the sort.
    assert.deepEqual(await indexKeys('item', 'idCompany_published_name'),
      { idCompany: 1, published: 1, deleted: 1, name: 1 },
      'the public shop page, sorted by name from the index');
    assert.deepEqual(await indexKeys('item', 'idCategory_published_name'),
      { idCategory: 1, published: 1, deleted: 1, name: 1 },
      'the category browse — the route with the broadest fan-out, one category across every shop');

    // The superseded prefixes are gone, not merely unused: an exact prefix of a longer index earns
    // nothing and costs a write on every catalogue edit.
    const names = (await db.collection('item').indexes()).map((i) => i.name);
    assert.ok(!names.includes('idCompany_published'), 'the three-key shop-page index was dropped');
    assert.ok(!names.includes('idCategory_published'), 'the three-key category index was dropped');
  });

  test('the text index is weighted and English, and deliberately not compound', async () => {
    const idx = (await db.collection('item').indexes()).find((i) => i.name === 'search_text');

    // A term in the name is what the customer typed; the same term buried in a paragraph usually is
    // not. Unweighted, both score alike and the results read as random.
    assert.deepEqual(idx.weights, { description: 1, name: 10 }, 'the name outweighs the body text');
    // The language decides stemming and the stopword list: "shoes" has to match "shoe", and every
    // article has to be dropped rather than indexed as a searchable term.
    assert.equal(idx.default_language, 'english', 'stemming and stopwords follow the market');
    // ⚠️ No non-text prefix key. MongoDB requires an EQUALITY predicate on every prefix key of a
    // compound text index, so `{ idCompany: 1, name: 'text' }` would scope a search to one shop and
    // make the platform-wide search — the one the customer app actually runs — unable to use the
    // index at all. Per-shop search is a filter applied after it, not a different index.
    assert.deepEqual(Object.keys(idx.key).filter((k) => k !== '_fts' && k !== '_ftsx'), [],
      'no prefix key — a platform-wide search has nothing to be equal to');

    const doc = validItem({ name: 'Walnut side table', description: 'Solid oak frame with a walnut veneer top' });
    await db.collection('item').insertOne(doc);
    const hits = await db.collection('item').find({ $text: { $search: 'walnut' } }).toArray();
    assert.equal(hits.length, 1, 'a term from the description matches');
    assert.equal(String(hits[0]._id), String(doc._id), 'and it is the document that carries it');
    await db.collection('item').deleteOne({ _id: doc._id });
  });

  // ---- 20260803142526-seed-demo-company --------------------------------------
  //
  // The second demo seed: one company, Northwind Trading Ltd, pointed at the shopOwner the first seed
  // inserts. Ordered after `create-company` because it writes into a collection that migration
  // creates — a timestamp before it would run against a collection that does not exist yet.

  const COUNT_COMPANY = () => db.collection('company').countDocuments();

  test('the demo seed down removes exactly what it wrote, and up puts it back', async () => {
    const before = await COUNT_COMPANY();
    assert.equal(before, SEEDED ? 1 : 0, 'the seeded state going in');

    // No longer the newest migration: four sort above it and come off first. Three of them drop
    // collections this test never looks at; the fourth, `alter-company-public`, `$unset`s four fields
    // from every company but removes none, so the count below still reads exactly what the seed
    // did or did not write.
    await mm.down(db, client); // 20260804050000-index-item-listing-sort
    await mm.down(db, client); // 20260804040000-index-company-public-read
    await mm.down(db, client); // 20260804030000-create-item
    await mm.down(db, client); // 20260804020000-create-itemCategory
    await mm.down(db, client); // 20260804010000-alter-company-public
    await mm.down(db, client); // 20260804000000-create-user
    await mm.down(db, client); // 20260803142526-seed-demo-company
    assert.equal(await COUNT_COMPANY(), 0, 'down leaves company empty');

    const applied = await mm.up(db, client);
    assert.equal(applied.length, 7,
      'the seed, the user creation, the three catalogue migrations and the two index migrations re-applied');
    assert.equal(await COUNT_COMPANY(), before, 'up restores exactly the state it removed');
  });

  test.skipIf(!SEEDED)('the demo seed wires the company to the seeded shopOwner', async () => {
    const company = await db.collection('company').findOne({});
    const owner = await db.collection('shopOwner').findOne({});

    // Nothing enforces this reference, which is precisely why it is
    // asserted. A demo database whose reference dangles looks identical from the outside until
    // something tries to follow it.
    assert.equal(String(company.idShopOwner), String(owner._id), 'the company belongs to the seeded shopOwner');
  });

  test.skipIf(!SEEDED)('the seeded company is in New York, not in the Southern Ocean', async () => {
    // The one thing about a seeded coordinate pair that no validator can catch: [-73.98, 40.74] and
    // [40.74, -73.98] are both well-formed, both in range, and only one of them is on land.
    //
    // Read directly first — longitude first means the first element is the one that cannot exceed 90
    // without being absurd.
    const seeded = await db.collection('company').findOne({});
    const [lng, lat] = seeded.address.position.coordinates;
    assert.ok(lng > -74 && lng < -73, 'the registered seat is at longitude ~-74, not latitude ~40.7');
    assert.ok(lat > 40 && lat < 41, 'and at latitude ~40.7');

    // Then through the index `20260804010000-alter-company-public` added, which is what actually
    // interprets the pair. This is the assertion the transposed reading fails: MongoDB reads element
    // zero as longitude whatever the seed meant, so a [lat, lng] point sits on the far side of the
    // planet and falls outside the radius.
    const near = await db.collection('company')
      .find({
        'address.position': {
          $near: { $geometry: { type: 'Point', coordinates: [-73.9772, 40.7527] }, $maxDistance: 20000 }
        }
      })
      .toArray();
    assert.equal(near.length, 1, 'the seeded company is within 20 km of midtown Manhattan');
    assert.equal(String(near[0]._id), String(seeded._id), 'and it is the seeded company that answered');
  });

  // ---- 20260801000100-index-shopOwner-tbl --------------------------------
  //
  // These four back the paginated operator table. Their KEYS are what matters, not merely their
  // existence: a sorted+skipped query whose sort keys are not a prefix of some index falls back to a
  // blocking in-memory sort, which MongoDB caps at 32MB and then fails outright. That failure is
  // data-dependent — it appears the day the collection outgrows the cap, not the day the index is
  // wrong — so the shape has to be asserted here rather than discovered in production.

  const indexKeys = async (coll, name) =>
    (await db.collection(coll).indexes()).find((i) => i.name === name)?.key;

  test('the table indexes lead with the filter fields and end on _id', async () => {
    // Key ORDER is significant, so deepEqual on the whole document — not a membership check.
    // `deleted`/`disabled` first because `{ $exists: false }` is equality-shaped (the ESR rule);
    // leading with the sort key instead would still sort from the index but scan the soft-deleted
    // documents the filter exists to exclude.
    assert.deepEqual(await indexKeys('shopOwner', 'tbl_active_registeredAt'), {
      deleted: 1, disabled: 1, registeredAt: -1, _id: -1,
    });
    // lastName and firstName share one index in that order: it serves `sortBy: LAST_NAME` (which
    // tie-breaks on firstName) and, as a prefix, nothing else. firstName alone is NOT a prefix of it, which
    // is why it gets an index of its own.
    assert.deepEqual(await indexKeys('shopOwner', 'tbl_active_lastName_firstName'), {
      deleted: 1, disabled: 1, 'personalData.lastName': 1, 'personalData.firstName': 1, _id: 1,
    });
    assert.deepEqual(await indexKeys('shopOwner', 'tbl_active_firstName'), {
      deleted: 1, disabled: 1, 'personalData.firstName': 1, _id: 1,
    });
    assert.deepEqual(await indexKeys('shopOwner', 'tbl_active_city'), {
      deleted: 1, disabled: 1, 'personalData.address.city': 1, _id: 1,
    });

    // One direction applied uniformly across every SORT component, `_id` included. That is what
    // lets a single index serve both ASC and DESC — a compound index satisfies a sort and its
    // complete inverse, but a mixed sort like `{ lastName: 1, _id: -1 }` is neither, and goes back
    // to the blocking sort. Per-column sort directions would break here first.
    //
    // `deleted`/`disabled` are excluded because they are matched, not sorted: their direction is
    // irrelevant to whether the index serves an ordering, which is why tbl_active_registeredAt can
    // pair `{ deleted: 1, disabled: 1 }` with `{ registeredAt: -1, _id: -1 }` and still be uniform.
    for (const name of ['tbl_active_registeredAt', 'tbl_active_lastName_firstName', 'tbl_active_firstName', 'tbl_active_city']) {
      const keys = await indexKeys('shopOwner', name);
      const sortDirections = Object.entries(keys)
        .filter(([field]) => field !== 'deleted' && field !== 'disabled')
        .map(([, direction]) => direction);
      assert.equal(new Set(sortDirections).size, 1, `${name} mixes sort directions`);
    }

    // None of them is unique: two shopOwners may perfectly well share a city, and a unique
    // index here would reject the second one at insert time.
    const built = (await db.collection('shopOwner').indexes()).filter((i) => i.name.startsWith('tbl_active_'));
    assert.equal(built.length, 4, 'exactly four table indexes');
    for (const i of built) assert.equal(i.unique, undefined, `${i.name} must not be unique`);
  });

  test('the table indexes drop on down, and down converges from a partial state', async () => {
    // Everything listed below sorts newer than the tbl indexes and has to come off before they are
    // the head.
    await mm.down(db, client); // 20260804050000-index-item-listing-sort
    await mm.down(db, client); // 20260804040000-index-company-public-read
    await mm.down(db, client); // 20260804030000-create-item
    await mm.down(db, client); // 20260804020000-create-itemCategory
    await mm.down(db, client); // 20260804010000-alter-company-public
    await mm.down(db, client); // 20260804000000-create-user
    await mm.down(db, client); // 20260803142526-seed-demo-company
    await mm.down(db, client); // 20260803000000-create-company
    await mm.down(db, client); // 20260802000300-alter-shopOwner-position-note
    await mm.down(db, client); // 20260802000100-index-shopOwner-registeredAt
    await mm.down(db, client); // 20260801000100-index-shopOwner-tbl

    const names = (await db.collection('shopOwner').indexes()).map((i) => i.name);
    for (const n of ['tbl_active_registeredAt', 'tbl_active_lastName_firstName', 'tbl_active_firstName', 'tbl_active_city']) {
      assert.equal(names.includes(n), false, `${n} dropped`);
    }
    // The collection's own index is untouched — `down` drops by name, so it cannot take anything
    // this migration did not create.
    assert.ok(names.includes('login.email_unique'), 'unrelated index survives the revert');

    // Re-apply everything, then take the newer migrations back off so the tbl-index migration is
    // once more the head to revert — the partial-state convergence below has to exercise *its* down,
    // not theirs. Then drop ONE index by hand and revert: `dropIndex` throws IndexNotFound on a
    // missing index, so an unguarded loop would fail here — which is exactly the state a partially
    // applied `up` leaves behind. Reverting has to converge from it rather than wedge the database.
    await mm.up(db, client);
    await mm.down(db, client); // 20260804050000-index-item-listing-sort
    await mm.down(db, client); // 20260804040000-index-company-public-read
    await mm.down(db, client); // 20260804030000-create-item
    await mm.down(db, client); // 20260804020000-create-itemCategory
    await mm.down(db, client); // 20260804010000-alter-company-public
    await mm.down(db, client); // 20260804000000-create-user
    await mm.down(db, client); // 20260803142526-seed-demo-company
    await mm.down(db, client); // 20260803000000-create-company
    await mm.down(db, client); // 20260802000300-alter-shopOwner-position-note
    await mm.down(db, client); // 20260802000100-index-shopOwner-registeredAt
    await db.collection('shopOwner').dropIndex('tbl_active_firstName');
    await mm.down(db, client); // 20260801000100-index-shopOwner-tbl — converges from a partial state

    const after = (await db.collection('shopOwner').indexes()).map((i) => i.name);
    assert.equal(after.some((n) => n.startsWith('tbl_active_')), false, 'revert converges from a partial state');

    const applied = await mm.up(db, client);
    assert.equal(applied.length, 11,
      'the tbl indexes, the registeredAt index, the shopOwner alter, the company creation, its seed, the user creation, the three catalogue migrations and the two index migrations re-applied');
  });

  test('up is idempotent for indexes that already exist', async () => {
    // createIndex is a no-op for an identical (key, name, options) triple, which is what makes
    // re-running the migration against a database that already has them safe. Asserted by calling
    // the migration's own up() twice against the applied state — a second `mm.up` would skip it.
    // require, not import(): the migrations are CommonJS and migrate-mongo loads them that way too
    // (`moduleSystem: 'commonjs'`), so this exercises the same module object the runner gets.
    const migration = require(path.join(MIGRATIONS_DIR, '20260801000100-index-shopOwner-tbl.js'));

    await migration.up(db);
    await migration.up(db);

    const names = (await db.collection('shopOwner').indexes()).filter((i) => i.name.startsWith('tbl_active_'));
    assert.equal(names.length, 4, 'no duplicate indexes after a second up');
  });

  test('down reverts every migration', async () => {
    for (let i = 0; i < MIGRATION_FILES.length; i++) await mm.down(db, client);
    const names = new Set(await collNames());
    for (const c of APP_COLLECTIONS) assert.ok(!names.has(c), `collection ${c} dropped`);
    assert.equal(await db.collection('changelog').countDocuments(), 0, 'changelog emptied');
  });
}
