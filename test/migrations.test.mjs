// Integration tests for the migrate-mongo migrations.
// Runs the REAL migrations against a MongoDB and asserts the resulting DB state:
// collections, validators, indexes, validation enforcement, the demo seed, reversibility.
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
//
// This file is ESM (.mjs) because migrate-mongo is ESM from v12 on. Its CommonJS
// wrapper is a Proxy whose every property access returns a Promise, so under
// `require` the whole API reads as undefined — `mm.config.set` throws
// "is not a function". The migrations themselves stay CommonJS; the config
// declares `moduleSystem: 'commonjs'` and migrate-mongo still loads them.
//
// Runner: vitest (see vitest.config.mjs), not node:test — kept for parity with the
// nine backend services, which all run vitest. node:test's before()/after() map to
// vitest's beforeAll()/afterAll(), NOT beforeEach()/afterEach(): this suite's before/after
// drop and replay the whole database ONCE for the file, and getting the mapping wrong
// would drop and re-migrate the database around every single test instead.
//
// ⚠️ **Every migration here creates a collection, with exactly one exception, and the
// exception adds an index and nothing else.** Each of the six collections is declared once,
// in its final shape, validator and indexes together — there is no widen → backfill →
// narrow ladder anywhere in this directory and no `collMod` at all. `20260825000000` is the
// one alter: it adds `tbl_active_registeredAt` to `user`, because the operator's customers
// table (E19) needs something to page on and `20260301000300` had been applied for months.
// It touches no validator and no document, so it still leaves nothing for this suite to walk
// through: the migrations are applied once at the top, every assertion below reads the one
// state they produce, and the only `down`s in the file are the seed's and the final
// teardown. A test that needs to POP a migration to see what it is testing is still the sign
// of a real alter — a widen/backfill/narrow ladder — and none has crept in.
//
// `expect` alongside assert/strict, and only for the two snapshot tests: `toMatchSnapshot`
// has no node:assert equivalent, and hand-rolling one would mean writing the file-management
// half of it. Every other assertion here stays on node:assert/strict.
import { test, beforeAll, afterAll, expect } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Binary, Double, Int32, ObjectId, Decimal128 } from 'mongodb';
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
 * test/mongoUrl.test.mjs. Same note, same measurements, as the one in test/migrationCalls.test.mjs.
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

// The one migration that writes documents rather than declaring a collection, and the only one
// gated on an environment flag.
const SEED_FILE = '20260301000600-seed-demo.js';
const SEED_PATH = path.join(MIGRATIONS_DIR, SEED_FILE);

// non-_id indexes expected per collection, by the migration that creates them.
const EXPECTED_INDEXES = {
  // 20260301000000 — the shared `login.email_unique`, from the constant all three login collections
  // build from. It works only because `login.email` is DETERMINISTIC ciphertext: a unique index over
  // random ciphertext constrains nothing, since every insert of one address produces different bytes.
  admin: ['login.email_unique'],
  // 20260301000300 — the login unique, and no 2dsphere over `addresses.position`: nothing queries
  // customers by distance, which is what makes encrypting that point free.
  // 20260825000000 — `tbl_active_registeredAt`, added later and alone, for the operator's customers
  // table. ⚠️ It is the ONLY one of `shopOwner`'s five that `user` gets a counterpart to: the other
  // three tbl_active_* sort on names and a city, all of which are ciphertext here, and the chart's
  // `registeredAt_series` has no customers-over-time chart to serve.
  user: ['login.email_unique', 'tbl_active_registeredAt'],
  shopOwner: [
    // 20260301000100 — the login unique, one index per sort column the operator table exposes, and
    // the chart's unfiltered `registeredAt` range, which no tbl_active_* index can seek into because
    // they all lead with deleted/disabled and the chart bounds neither.
    'login.email_unique',
    'tbl_active_registeredAt', 'tbl_active_lastName_firstName', 'tbl_active_firstName', 'tbl_active_city',
    'registeredAt_series',
  ],
  // 20260301000200 — nine, in one migration, because the collection is declared once.
  // `vatNumber_unique` / `certifiedEmail_unique` are global uniques (one VAT number, one certified
  // email per company, whoever registered it); `idShopOwner_list` backs the owner-facing list;
  // `slug_unique` is the URL; `address.position_2dsphere` is what `companiesNearby` and the map run
  // on; `published_list` is the two equality predicates every public read carries; `search_text` is
  // the company half of the public search; and the two `publicName` compounds make /shops and
  // /shops/:city index walks rather than blocking sorts.
  company: [
    'vatNumber_unique', 'certifiedEmail_unique', 'idShopOwner_list',
    'slug_unique', 'address.position_2dsphere', 'published_list',
    'search_text', 'published_publicName', 'published_city_publicName',
  ],
  // 20260301000400 — a plain unique slug (required here, so no null keys and no partial filter) and
  // the level+order index the two listing reads walk.
  itemCategory: ['slug_unique', 'idParent_position'],
  // 20260301000500 — the owner's catalogue, the per-company slug rule that doubles as the
  // /shop/:slug/item/:itemSlug lookup, the public shop page, the category browse, and the text index.
  // ⚠️ The two listing indexes are the FOUR-key `_name` forms. Their three-key prefixes are not
  // installed alongside them — see the head of that migration.
  item: [
    'idCompany_list', 'idCompany_slug_unique', 'idCompany_published_name', 'idCategory_published_name', 'search_text',
  ],
};

const MIGRATION_FILES = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.js')).sort();

// The demo seed is gated on this, so the three counts it touches have two right answers and the
// suite has to be run twice (`yarn test` and `yarn test:seed`) to see both. Read once here rather
// than at each call site.
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
  let keyDir;
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

    // ---- CSFLE (ADR-029) ---------------------------------------------------
    //
    // Every collection here declares its personal fields `bsonType: 'binData'` in its very first
    // validator, so the only migration that needs a master key is the one that writes documents: the
    // demo seed encrypts field by field before it inserts. Under `yarn test` that never runs through
    // migrate-mongo; the seeded-up test near the foot of this file drives it by hand, with the flag
    // forced on, so BOTH invocations exercise the real ClientEncryption against a real 96-byte key.
    //
    // ⚠️ Both variables are OVERWRITTEN, not defaulted, and that is a safety rule rather than
    // tidiness. `.env` may well carry the real pair — dotenv has already loaded it — and honouring
    // them would point a suite that calls `dropDatabase()` at the platform's own key vault and mint
    // throwaway data keys into it.
    keyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-csfle-test-'));
    process.env.CSFLE_MASTER_KEY_PATH = path.join(keyDir, 'master.key');
    fs.writeFileSync(process.env.CSFLE_MASTER_KEY_PATH, crypto.randomBytes(96), { mode: 0o600 });
    // ⚠️ The vault goes INSIDE the test database so `dropDatabase` takes it along, and it has to: a
    // fresh master key is minted on every run, and a data key left behind by the previous one is
    // encrypted under a master key that no longer exists — every encrypt against it would fail.
    process.env.CSFLE_KEY_VAULT_NAMESPACE = `${DB}.__keyVault`;
  });

  afterAll(async () => {
    if (db) await db.dropDatabase();
    if (client) await client.close();
    if (keyDir) fs.rmSync(keyDir, { recursive: true, force: true });
  });

  const collNames = async () => (await db.listCollections().toArray()).map((c) => c.name);
  const collInfo = async (name) => (await db.listCollections({ name }).toArray())[0];

  const indexKeys = async (coll, name) =>
    (await db.collection(coll).indexes()).find((i) => i.name === name)?.key;

  // Two collections have a validator that is not a bare `$jsonSchema` but
  // `$and: [{ $jsonSchema }, { $expr }]`, because each carries one rule JSON Schema cannot state at
  // all. On `user` it is "defaultAddress points into this document's own addresses"; on `company` it
  // is "a published company has a slug and a publicName". Both are cross-field, and a collection
  // validator accepts any query expression, so the two clauses ride together. Unwrapping is done here
  // once rather than at each call site, and it deliberately throws rather than returning undefined if
  // a collection ever has neither — a silently undefined schema would pass every assertion below.
  const jsonSchemaOf = (validator) => {
    if (validator.$jsonSchema) return validator.$jsonSchema;
    return validator.$and.find((clause) => clause.$jsonSchema).$jsonSchema;
  };

  // ---- helpers to build minimal VALID documents -----------------------------

  /**
   * Stored ciphertext, in the shape the platform writes: BSON binData, subtype 6.
   *
   * The bytes are not a real CSFLE blob and do not need to be. Everything the fixtures below
   * exercise happens server-side — `bsonType: 'binData'` accepts the value or refuses it, and a
   * unique index treats two different byte strings as two different keys — and the server never
   * looks inside subtype 6. Minting real ciphertext would make every fixture async, and every one of
   * the sixty-odd `{ ...validCompany(), … }` call sites below with it, for a property no assertion
   * here reads. The real thing is driven once, against a real key, by the seeded-up test at the foot
   * of this file.
   */
  const cipher = () => new Binary(Buffer.from(`ciphertext-${uid()}`), Binary.SUBTYPE_ENCRYPTED);

  // Both names and the login address are ciphertext. `password` is not: a bcrypt hash is not personal
  // data, and it is compared by the application, never by a query.
  const validAdmin = () => ({
    _id: new ObjectId(),
    login: { email: cipher(), password: 'x'.repeat(60) },
    personalData: { firstName: cipher(), lastName: cipher() },
  });

  // `published: false` is in here rather than at the call sites because it is in `required` — a
  // fixture without it is not a valid company, and every one of the two dozen `accepts('company', …)`
  // assertions below would fail for a reason that has nothing to do with what each is testing.
  const validCompany = () => {
    const n = uid();
    return {
      _id: new ObjectId(),
      idShopOwner: new ObjectId(),
      // ⚠️ `contactPerson` and `administrator` are the only two encrypted here, and the other
      // fourteen are in the clear on purpose: a company is a legal entity, and its VAT number,
      // certified email and registry extract are a matter of public record. These two are the names
      // of two natural persons. See the head of lib/schemas/company.js.
      legalName: 'R', vatNumber: n.padStart(11, '0'), contactPerson: cipher(),
      administrator: cipher(), certifiedEmail: `certified${n}@example.com`, registryExtract: 'v.pdf',
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
    const doc = {
      _id: new ObjectId(),
      login: { email: cipher(), password: 'x'.repeat(60) },
      personalData: {
        // ⚠️ `firstName`, `lastName` and `address.city` stay in the CLEAR, and are the only personal
        // fields on this collection that do. They are the sort keys of tbl_active_lastName_firstName,
        // tbl_active_firstName and tbl_active_city and the targets of the operator table's `/^term/i`
        // prefix search, and no CSFLE algorithm preserves an ordering or a prefix — deterministic
        // preserves equality and nothing else. Encrypting them would not slow the operator table
        // down, it would silently falsify it. See lib/schemas/shopOwner.js.
        firstName: 'M', lastName: 'R',
        birth: { date: cipher() },
        address: { street: cipher(), postalCode: cipher(), city: 'C', province: cipher() },
        contacts: { mobile: cipher(), email: cipher() },
      },
      registeredAt: new Date(),
    };
    if (emailVerify !== undefined) doc.emailVerify = emailVerify;
    return doc;
  };

  // One element of `user.addresses`. Every member is ciphertext except `_id`, which MUST stay an
  // ObjectId — the collection's `$expr` clause compares `defaultAddress` against these ids, and
  // random ciphertext differs on every encryption, so encrypting either side would refuse every write.
  const addressElement = (over = {}) => ({
    _id: new ObjectId(),
    street: cipher(), postalCode: cipher(), city: cipher(), province: cipher(),
    ...over,
  });

  const validUser = (over = {}) => ({
    _id: new ObjectId(),
    login: { email: cipher(), password: 'x'.repeat(60) },
    registeredAt: new Date(),
    ...over,
  });

  const rejects = async (coll, doc) => {
    await assert.rejects(() => db.collection(coll).insertOne(doc), `expected ${coll} insert to be rejected by validator`);
  };
  const accepts = async (coll, doc) => {
    await db.collection(coll).insertOne(doc);
    await db.collection(coll).deleteOne({ _id: doc._id }); // keep collections clean for later assertions
  };

  // The point as `company` declares it: tuple form, one schema per axis, longitude first, and not
  // decimal. `shopOwner` and `user` build the same node from the same helper and then encrypt it
  // whole, so `company` is the one collection where the shape is still legible at rest — which makes
  // this the only place those per-axis bounds can be asserted at all.
  const assertGeoJsonTuple = (coords) => {
    assert.ok(Array.isArray(coords.items), 'tuple-form coordinates, one schema per position');
    assert.equal(coords.items[0].maximum, 180, 'longitude first');
    assert.equal(coords.items[1].maximum, 90, 'latitude second');
    assert.deepEqual(coords.items[1].bsonType, ['double', 'int', 'long'], 'not decimal — mongoose writes a double');
  };

  const at = (document, dotted) => dotted.split('.').reduce((node, segment) => node[segment], document);
  const isCiphertext = (value) => value instanceof Binary && value.sub_type === Binary.SUBTYPE_ENCRYPTED;

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
  // ⚠️ Position matters: both run while every migration is applied and before the seeded-up test
  // below pops the seed. Moving either past it would snapshot a half-reverted database.
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
    // One migration writes all three, in owner-before-company order, and is a no-op without the flag.
    for (const c of ['admin', 'shopOwner', 'company']) {
      assert.equal(await db.collection(c).countDocuments(), expected, `${c} seed count`);
    }
  });

  test('validator enforces required fields', async () => {
    await rejects('admin', { login: { email: cipher(), password: 'x'.repeat(60) } }); // missing personalData
    await accepts('admin', validAdmin());
  });

  // ---- shopOwner -------------------------------------------------------------

  test('the shopOwner validator declares the verify-email slot, and requires no member of it', async () => {
    const { $jsonSchema } = (await collInfo('shopOwner')).options.validator;

    assert.deepEqual($jsonSchema.required, ['login', 'registeredAt'], 'top-level required');
    assert.equal($jsonSchema.additionalProperties, false, 'strict object');
    // `resetPwd` and `emailVerify` are strictly disjoint slots and must not be merged: sharing one
    // between the activation token and the reset token would let a hash issued by either flow
    // authenticate the other.
    assert.deepEqual($jsonSchema.properties.resetPwd.required, ['resetDateReq', 'resetHash'], 'resetPwd rules');
    assert.equal($jsonSchema.properties.personalData.properties.contacts.required.includes('mobile'), true);
    assert.equal($jsonSchema.properties.login.properties.password.minLength, 60);

    const ev = $jsonSchema.properties.emailVerify;
    assert.ok(ev, 'emailVerify declared');
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
    // no emailVerify at all — a shop owner who never requested a link
    await accepts('shopOwner', validShopOwner(undefined));
    // post-setEmailHash: hash + requestTimes + dateLastReq, and deliberately no `valid`
    await accepts('shopOwner', validShopOwner({
      hash: 'x'.repeat(50), requestTimes: new Int32(1), dateLastReq: new Date(),
    }));
    // post-enableEmailAccess: `valid` alone, the other three unset
    await accepts('shopOwner', validShopOwner({ valid: true }));
    // mid email-change: everything at once. `hash` is a comparison token the flow generates and is
    // not personal data, so it stays a string; `newEmailTmp` is an address the customer typed and is
    // ciphertext — deterministic ciphertext, because koa-utils finds the account by it.
    await accepts('shopOwner', validShopOwner({
      valid: true, hash: 'y'.repeat(50), requestTimes: new Int32(4),
      dateLastReq: new Date(), newEmailTmp: cipher(),
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
    // ⚠️ `newEmailTmp` is an address, so it is ciphertext and a string is the wrong type at ANY
    // length. There is no character bound on it and there cannot be: a ciphertext has no length the
    // server can measure. That rule holds in the GraphQL input validation instead.
    await rejects('shopOwner', validShopOwner({ newEmailTmp: 'fresh@t.co' }));
    await rejects('shopOwner', validShopOwner({ newEmailTmp: 'n'.repeat(251) }));
    await accepts('shopOwner', validShopOwner({ newEmailTmp: cipher() }));
  });

  test('the shopOwner address point is optional, and opaque', async () => {
    // Absent is valid, and deliberately: a coordinate arrives only when the address is picked from
    // the operator app's autocomplete, and an address typed by hand simply has none. Requiring it
    // would make the field unwritable from every other path.
    await accepts('shopOwner', validShopOwner());

    const withPosition = (position) => {
      const doc = validShopOwner();
      doc.personalData.address.position = position;
      return doc;
    };
    await accepts('shopOwner', withPosition(cipher()));

    // ⚠️ The point is encrypted WHOLE — one blob, not a `type` beside an encrypted `coordinates` —
    // so the GeoJSON document is itself a rejected write here, per-axis bounds and all. That is
    // affordable on this collection and only on this one: nothing queries a shop owner by distance
    // and no 2dsphere index exists over the field. `company.address.position` backs the map and
    // `companiesNearby`, so it stays in the clear and keeps every rule asserted below.
    await rejects('shopOwner', withPosition({ type: 'Point', coordinates: [new Double(9.6), new Double(45.6)] }));
  });

  // ⚠️ The document `shopOwnerRegister` writes, asserted as a whole rather than through the `required`
  // array above: a stranger signing themselves up on the public site gives an address, a password and
  // nothing else, and everything `personalData` holds — the name, the date of birth, the home address,
  // the contacts — arrives later through onboarding. Putting `personalData` back into `required` makes
  // this document unwritable, which turns public seller sign-up into a 500 on the insert, and no test
  // reading the validator's shape would say why.
  test('shopOwner accepts a self-registration, which is credentials and nothing else', async () => {
    const selfRegistered = () => ({
      _id: new ObjectId(),
      login: { email: cipher(), password: 'x'.repeat(60) },
      emailVerify: { hash: 'x'.repeat(50), requestTimes: new Int32(1), dateLastReq: new Date() },
      registeredAt: new Date(),
      // Set by that mutation and by no other creation path: an account an operator adds by hand is
      // approved by the act of adding it. Never `false` anywhere — approval `$unset`s the field.
      waitApprov: true,
    });

    await accepts('shopOwner', selfRegistered());

    // The block stays all-or-nothing. Optional does not mean partial: an onboarded shop owner is a
    // complete record, so a half-filled one is still refused.
    const halfFilled = selfRegistered();
    halfFilled.personalData = { firstName: 'M', lastName: 'R' };
    await rejects('shopOwner', halfFilled);
  });

  test('the shopOwner operator note is optional, top level, and opaque', async () => {
    const { $jsonSchema } = (await collInfo('shopOwner')).options.validator;
    // Top level, not inside personalData: `personalData` is what the shop owner declared about
    // themselves, the note is what an operator wrote about them — and nothing in the ShopOwner tier
    // loads this model, so the field cannot leak to its subject.
    assert.equal($jsonSchema.properties.notes.bsonType, 'binData', 'the operator note is ciphertext');
    assert.equal($jsonSchema.required.includes('notes'), false, 'and not required');
    assert.equal($jsonSchema.properties.personalData.properties.notes, undefined, 'and not under personalData');

    const withNotes = (notes) => ({ ...validShopOwner(), notes });
    await accepts('shopOwner', withNotes(cipher()));
    // Optional: nothing obliges an operator to have written anything about an account.
    await accepts('shopOwner', validShopOwner());
    // Under `additionalProperties: false` a value of the wrong type is refused rather than coerced,
    // whether it is a string or a number.
    await rejects('shopOwner', withNotes('Call back in September'));
    await rejects('shopOwner', withNotes(7));
  });

  test('the table indexes lead with the filter fields and end on _id', async () => {
    // These four back the paginated operator table, and their KEYS are what matters rather than
    // their existence: a sorted+skipped query whose sort keys are not a prefix of some index falls
    // back to a blocking in-memory sort, which MongoDB caps at 32 MB and then fails outright. That
    // failure is data-dependent — it appears the day the collection outgrows the cap, not the day the
    // index is wrong — so the shape is asserted here rather than discovered in production.
    //
    // Key ORDER is significant, so deepEqual on the whole document — not a membership check.
    // `deleted`/`disabled` first because `{ $exists: false }` is equality-shaped (the ESR rule);
    // leading with the sort key instead would still sort from the index but scan the soft-deleted
    // documents the filter exists to exclude.
    assert.deepEqual(await indexKeys('shopOwner', 'tbl_active_registeredAt'), {
      deleted: 1, disabled: 1, registeredAt: -1, _id: -1,
    });
    // lastName and firstName share one index in that order: it serves `sortBy: LAST_NAME` (which
    // tie-breaks on firstName) and, as a prefix, nothing else. firstName alone is NOT a prefix of it,
    // which is why it gets an index of its own.
    assert.deepEqual(await indexKeys('shopOwner', 'tbl_active_lastName_firstName'), {
      deleted: 1, disabled: 1, 'personalData.lastName': 1, 'personalData.firstName': 1, _id: 1,
    });
    assert.deepEqual(await indexKeys('shopOwner', 'tbl_active_firstName'), {
      deleted: 1, disabled: 1, 'personalData.firstName': 1, _id: 1,
    });
    assert.deepEqual(await indexKeys('shopOwner', 'tbl_active_city'), {
      deleted: 1, disabled: 1, 'personalData.address.city': 1, _id: 1,
    });
    // ⚠️ The chart's index is NOT one of the four and cannot be a prefix of any of them: it bounds a
    // `registeredAt` range with no `deleted`/`disabled` equality in front of it, and every
    // tbl_active_* index leads with both.
    assert.deepEqual(await indexKeys('shopOwner', 'registeredAt_series'), { registeredAt: 1 });

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

    // None of them is unique: two shop owners may perfectly well share a city, and a unique
    // index here would reject the second one at insert time.
    const built = (await db.collection('shopOwner').indexes()).filter((i) => i.name.startsWith('tbl_active_'));
    assert.equal(built.length, 4, 'exactly four table indexes');
    for (const i of built) assert.equal(i.unique, undefined, `${i.name} must not be unique`);
  });

  // ---- company ---------------------------------------------------------------
  //
  // A company is a legal entity AND the shop a customer browses — there is no `shop` collection and
  // there is not going to be one, so the registrar's fields and the storefront's sit side by side.

  test('the company validator declares the company fields', async () => {
    // `jsonSchemaOf`, not a destructure: this validator is the `$and` pair, so
    // `options.validator.$jsonSchema` is undefined and every assertion below would read a property
    // of undefined.
    const $jsonSchema = jsonSchemaOf((await collInfo('company')).options.validator);

    assert.deepEqual(
      $jsonSchema.required,
      ['idShopOwner', 'legalName', 'vatNumber', 'contactPerson', 'administrator', 'certifiedEmail', 'registryExtract', 'address',
        'published'],
      'required list'
    );
    assert.equal($jsonSchema.additionalProperties, false, 'strict object');
    assert.deepEqual($jsonSchema.properties.idShopOwner, { bsonType: 'objectId' }, 'owned by a shop owner');

    assert.equal($jsonSchema.properties.legalName.maxLength, 100, 'legalName bound');
    assert.equal($jsonSchema.properties.vatNumber.minLength, 11, 'vatNumber lower bound');
    assert.equal($jsonSchema.properties.vatNumber.maxLength, 11, 'vatNumber upper bound');
    // ⚠️ The two natural persons are the only encrypted fields on the collection, and they carry no
    // character bound for exactly that reason — a ciphertext has no length the server can measure.
    // Everything else on a company identifies a legal entity or is published to anonymous visitors.
    assert.equal($jsonSchema.properties.contactPerson.bsonType, 'binData', 'contactPerson is ciphertext');
    assert.equal($jsonSchema.properties.administrator.bsonType, 'binData', 'administrator is ciphertext');
    assert.equal($jsonSchema.properties.uniqueCode.minLength, 7, 'uniqueCode lower bound');
    assert.equal($jsonSchema.properties.uniqueCode.maxLength, 7, 'uniqueCode upper bound');
    assert.equal($jsonSchema.properties.certifiedEmail.maxLength, 250, 'certifiedEmail bound');
    assert.equal($jsonSchema.properties.registryExtract.maxLength, 1000, 'registryExtract is capped');

    // `taxCode` is optional by omission from the required list above — the 11-character company
    // form, not the 16-character personal one.
    assert.equal($jsonSchema.properties.taxCode.minLength, 11, 'taxCode lower bound');
    assert.equal($jsonSchema.properties.taxCode.maxLength, 11, 'taxCode upper bound');
    assert.equal($jsonSchema.required.includes('taxCode'), false, 'taxCode is optional');

    // Only `published` joins `required` of the four storefront fields. The other three cannot: a
    // company is registered before it is a shop, and no slug or trading name can be derived from a
    // registered legal name without inventing one. The `$expr` clause is what keeps that from
    // producing a broken storefront — asserted in its own test below.
    for (const field of ['publicName', 'slug', 'description', 'published']) {
      assert.ok(field in $jsonSchema.properties, `${field} declared`);
    }
    assert.ok($jsonSchema.required.includes('published'), 'published is required');
    for (const field of ['publicName', 'slug', 'description']) {
      assert.equal($jsonSchema.required.includes(field), false, `${field} stays optional`);
    }

    // `deleted` is a DATE, the spelling `shopOwner` already uses — a bool would answer whether
    // the document is gone and not when. Optional, and it has to be: a live company has no deletion
    // instant to carry, so requiring it would make every insert fail.
    assert.deepEqual($jsonSchema.properties.deleted, { bsonType: 'date' }, 'deleted is an optional date');
    assert.equal($jsonSchema.required.includes('deleted'), false, 'deleted is optional');

    // The registered seat: required, position included, since the collection is created empty and
    // there is no stored document for the requirement to strand.
    assert.deepEqual(
      $jsonSchema.properties.address.required,
      ['street', 'postalCode', 'city', 'province', 'position'],
      'position is required'
    );
    assertGeoJsonTuple($jsonSchema.properties.address.properties.position.properties.coordinates);
  });

  test('company enforces its field rules', async () => {
    await accepts('company', validCompany());

    // A company with no owner is unreachable — every owner-facing read path lists by owner — so the
    // field is required, and it is an objectId, not the string a GraphQL ID would arrive as.
    const withoutOwner = validCompany();
    delete withoutOwner.idShopOwner;
    await rejects('company', withoutOwner);
    await rejects('company', { ...validCompany(), idShopOwner: String(new ObjectId()) });

    // vatNumber is fixed at 11, both bounds.
    await rejects('company', { ...validCompany(), vatNumber: '1'.repeat(10) });
    await rejects('company', { ...validCompany(), vatNumber: '1'.repeat(12) });

    // taxCode is the same fixed width and optional, so its absence from every helper above is not an
    // oversight.
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
    // The two natural persons are ciphertext, so a plain string is refused at any length.
    await rejects('company', { ...validCompany(), contactPerson: 'R' });
    await rejects('company', { ...validCompany(), administrator: 'A' });
    await rejects('company', { ...validCompany(), certifiedEmail: `${'p'.repeat(245)}@mail.example` });
    // bsonType string under additionalProperties:false — a number is refused, not coerced.
    await rejects('company', { ...validCompany(), legalName: 7 });

    // A field the validator does not declare is refused outright, whatever it is called.
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
    // The consequence of leaving `vatNumber_unique` / `certifiedEmail_unique` global rather than partial,
    // asserted rather than left to be discovered: the document is still indexed once `deleted` is set, so
    // the same company cannot be registered a second time while the deleted one is there. That matches
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

    // Required, `position` included. The collection is created empty, so there is no stored document
    // for the requirement to strand.
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

    // ⚠️ The street bound, the exactly-5 postal code and the exactly-2 province are enforced HERE and
    // nowhere else on the platform: `shopOwner` and `user` encrypt all three, and a ciphertext has no
    // length the server can measure. This is the one collection whose address is public data.
    await rejects('company', withAddress({ ...base(), street: 'V'.repeat(101) }));
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
    // NOT unique: one shop owner owning several companies is the whole point of the collection, and
    // a unique index here would reject the second one at insert time.
    assert.deepEqual(byName.idShopOwner_list.key, { idShopOwner: 1 }, 'list index key');
    assert.equal(byName.idShopOwner_list.unique, undefined, 'the list index must not be unique');
  });

  test('company refuses a duplicate VAT number or certified email, whoever owns it', async () => {
    const first = validCompany();
    await db.collection('company').insertOne(first);

    // Different owner, different certified email, same VAT number — still refused. The index is global,
    // not scoped per shop owner: one VAT number is one company, whoever registered it.
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

    // A second company under the SAME owner is accepted — one shop owner may own several companies.
    await accepts('company', { ...validCompany(), idShopOwner: first.idShopOwner });

    await db.collection('company').deleteOne({ _id: first._id });
  });

  test('a published company must be linkable, on insert and on update', async () => {
    // `published: true` with no slug is a shop with no URL; with no publicName it is a card with no
    // heading. Neither is a state the storefront can draw, and the `$expr` half makes both
    // unwritable — which is the whole reason the validator is a pair.
    const validator = (await collInfo('company')).options.validator;
    assert.ok(Array.isArray(validator.$and) && validator.$and.length === 2, 'validator is the $and pair');

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
    // without a slug would be refused as a duplicate of the first — and a company is registered
    // before it is a shop, so slugless is the normal state.
    // `partialFilterExpression: { slug: { $type: 'string' } }` leaves them out of the index entirely.
    // `$type: 'string'` rather than `$exists: true`, which would admit an explicit null and put the
    // null keys back.
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

  test('the company listing indexes put the sort key after the last equality predicate', async () => {
    // ⚠️ An index serves a sort only from the keys AFTER the last equality predicate, which is what
    // dictates these shapes. `{ published, deleted, publicName }` walks the index in output order and
    // stops after skip + limit; `{ published, deleted, publicName, address.city }` would index all
    // four fields, answer the same filter, and still hand every match to a blocking in-memory SORT.
    // So the city equality goes IN FRONT of the sort key.
    assert.deepEqual(await indexKeys('company', 'published_list'), { published: 1, deleted: 1 },
      'the two equality predicates every public read carries');
    assert.deepEqual(await indexKeys('company', 'published_publicName'), { published: 1, deleted: 1, publicName: 1 },
      '/shops, sorted by trading name from the index');
    assert.deepEqual(await indexKeys('company', 'published_city_publicName'),
      { published: 1, deleted: 1, 'address.city': 1, publicName: 1 },
      '/shops/:city — the city equality before the sort key, not after it');

    // `published_list` is a strict prefix of `published_publicName` and therefore redundant to the
    // planner. It is installed anyway, deliberately: `company` is written a handful of times per shop
    // and read on every page view, so the spare index costs almost nothing and the filter-only reads
    // walk two keys instead of three. `item` makes the opposite call, for the opposite reason.
    const names = (await db.collection('company').indexes()).map((i) => i.name);
    assert.ok(names.includes('published_list'), 'the prefix index is kept on the read-heavy collection');
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

  // ---- user ------------------------------------------------------------------
  //
  // The end customer. It mirrors `shopOwner` — role here is which collection you authenticate
  // against, not a field — and diverges in exactly four places, all deliberate.

  test('the user validator mirrors shopOwner and diverges in four places', async () => {
    const $jsonSchema = jsonSchemaOf((await collInfo('user')).options.validator);

    // 1. `personalData` is OPTIONAL. Registration is an email and a password and nothing else; the
    //    name and the contact details are filled in afterwards. `shopOwner` requires it because a
    //    shop owner is onboarded by a person who collects it all up front.
    assert.deepEqual($jsonSchema.required, ['login', 'registeredAt'], 'only the credential and the sign-up date');
    // 2. `addresses` is an ARRAY where `shopOwner` has one `personalData.address`: a customer has a
    //    home, an office and a friend's flat; a shop owner has a residence.
    assert.equal($jsonSchema.properties.addresses.bsonType, 'array', 'addresses is a list');
    assert.equal($jsonSchema.properties.personalData.properties.address, undefined, 'and not a single block');
    // 3. `defaultAddress` has no counterpart at all — see the `$expr` test below.
    assert.equal($jsonSchema.properties.defaultAddress.bsonType, 'objectId', 'the default is a pointer');
    // 4. No `waitApprov`. Customers self-serve: there is no operator approval gate between
    //    registering and using the account, only the email confirmation.
    assert.equal($jsonSchema.properties.waitApprov, undefined, 'no approval gate on a customer');

    // `contacts` requires none of its members, where `shopOwner`'s requires `mobile` and `email`. The
    // account's address is `login.email` and is the credential; `contacts` is for a *different*
    // address, so demanding it would ask the customer to retype what they already gave.
    assert.equal($jsonSchema.properties.personalData.properties.contacts.required, undefined,
      'no contact detail is mandatory');

    // ⚠️ Every personal field here is ciphertext, `city` included — which is where this collection
    // diverges from `shopOwner`, and it can afford to because nothing sorts, searches or paginates
    // customers. `_id` is the exception, and has to be: the `$expr` clause compares it.
    const element = $jsonSchema.properties.addresses.items;
    for (const member of ['label', 'street', 'postalCode', 'city', 'province', 'position']) {
      assert.equal(element.properties[member].bsonType, 'binData', `addresses[].${member} is ciphertext`);
    }
    assert.equal(element.properties._id.bsonType, 'objectId', 'the address id stays an objectId');
    assert.deepEqual(element.required, ['_id', 'street', 'postalCode', 'city', 'province'],
      'an element needs an id, and its point stays optional');
  });

  test('the customers table index is shopOwner\'s registeredAt index and nothing else', async () => {
    // Added by 20260825000000, months after the collection, and the only index on `user` that is not
    // the login unique. Key ORDER is the assertion, as it is for `shopOwner`: equality fields first
    // (`deleted`/`disabled`, both `{ $exists: false }`-shaped), then the sort, then `_id` as the
    // tiebreak — without which two customers registered in the same millisecond have no order
    // between pages and one can be shown twice while another is skipped.
    assert.deepEqual(await indexKeys('user', 'tbl_active_registeredAt'), {
      deleted: 1, disabled: 1, registeredAt: -1, _id: -1,
    });
    // Byte-identical to shopOwner's, and deliberately so: the two operator tables page the same way.
    assert.deepEqual(await indexKeys('user', 'tbl_active_registeredAt'),
      await indexKeys('shopOwner', 'tbl_active_registeredAt'));

    // ⚠️ **The three sort columns the shop-owner table has and this one must never grow.** Every one
    // of them is ciphertext on `user` — `firstName` and `lastName` random, `addresses[].city` random
    // — and an index over random ciphertext orders by bytes that change on every encryption. It
    // would not error; it would page in an order nobody can predict. ADR-029, and ADR-INDEX §4,
    // which refuses making one of them queryable to get the column back.
    const names = (await db.collection('user').indexes()).map((i) => i.name);
    for (const absent of ['tbl_active_lastName_firstName', 'tbl_active_firstName', 'tbl_active_city']) {
      assert.ok(!names.includes(absent), `${absent} must not exist on user`);
    }
    // `registeredAt_series` is absent for a different and much duller reason: there is no
    // customers-over-time chart. It is not a boundary, and adding one would need no decision.
    assert.ok(!names.includes('registeredAt_series'), 'no chart index without a chart');

    // Sort directions uniform across the sort components, so the one index serves newest-first and
    // oldest-first alike; `deleted`/`disabled` are matched rather than sorted and are excluded.
    const keys = await indexKeys('user', 'tbl_active_registeredAt');
    const sortDirections = Object.entries(keys)
      .filter(([field]) => field !== 'deleted' && field !== 'disabled')
      .map(([, direction]) => direction);
    assert.equal(new Set(sortDirections).size, 1, 'tbl_active_registeredAt mixes sort directions');

    // Not unique: two customers may register in the same millisecond, and a unique index would
    // refuse the second one.
    const built = (await db.collection('user').indexes()).find((i) => i.name === 'tbl_active_registeredAt');
    assert.equal(built.unique, undefined, 'the table index must not be unique');
  });

  test('user refuses a defaultAddress that points nowhere', async () => {
    // "At most one default address", enforced by the database rather than by every write path. A
    // boolean per element can represent two defaults; a pointer cannot represent a second one at all,
    // so setting one is a single atomic `$set` with no clear-then-set window to interleave into. What
    // a pointer CAN get wrong is dangling — and unlike "exactly one true", that is checkable.
    const home = addressElement();

    // Absent is valid, with or without addresses. `$ifNull` in the rule is what makes the second case
    // work: `$map` over a missing field yields null, and `$in` against null is an ERROR rather than a
    // false, which would turn "no addresses yet" into an unwritable document.
    await accepts('user', validUser());
    await accepts('user', validUser({ addresses: [home] }));
    await accepts('user', validUser({ addresses: [home], defaultAddress: home._id }));

    // Naming an id that is in no element of THIS document is refused — including the case where the
    // array is missing entirely.
    await rejects('user', validUser({ defaultAddress: new ObjectId() }));
    await rejects('user', validUser({ addresses: [home], defaultAddress: new ObjectId() }));

    // And on the way through, not only on the way in: deleting the default address has to `$unset`
    // the pointer in the same update, and if it does not, MongoDB refuses the write rather than an
    // application path somebody can forget to call.
    const customer = validUser({ addresses: [home], defaultAddress: home._id });
    await db.collection('user').insertOne(customer);
    await assert.rejects(
      () => db.collection('user').updateOne({ _id: customer._id }, { $pull: { addresses: { _id: home._id } } }),
      /failed validation/,
      'removing the element the pointer names is refused'
    );
    await db.collection('user').deleteOne({ _id: customer._id });
  });

  // ---- itemCategory ----------------------------------------------------------
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

  // ---- item ------------------------------------------------------------------
  //
  // What a shop sells. One collection plus the taxonomy above, for every kind of product the
  // platform will ever carry (ADR-008).

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

  test('the item picture is an optional file name, and only a file name', async () => {
    // Optional, and absent on every item that predates the field. `itemAdd` names the file after the
    // item's own _id, which is what the 24-hex half of the pattern says.
    await accepts('item', validItem());
    await accepts('item', validItem({ image: `${new ObjectId().toHexString()}.webp` }));

    // The extension is deliberately open at 3-4 characters rather than pinned to webp: uploadTempImage
    // re-encodes everything to webp today, and a second format later must not need a rebuild.
    await accepts('item', validItem({ image: `${new ObjectId().toHexString()}.jpg` }));

    // ⚠️ The assertions that matter. Three frontends interpolate this value straight into a URL, so a
    // path — relative, absolute or traversing — must not be storable in the first place.
    const id = new ObjectId().toHexString();
    await rejects('item', validItem({ image: `../../${id}.webp` }));
    await rejects('item', validItem({ image: `/etc/passwd` }));
    await rejects('item', validItem({ image: `item/${id}.webp` }));
    await rejects('item', validItem({ image: `${id.toUpperCase()}.webp` }));
    await rejects('item', validItem({ image: `${id}.webpx` }));
    await rejects('item', validItem({ image: id }));
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
    // ⚠️ The trailing `name` is the load-bearing key. Both listings sort by `name`, and an index
    // serves a sort only from the keys AFTER the last equality predicate — so a three-key form would
    // answer the filter and then hand every match to an in-memory SORT stage. Measured at 100 000
    // items in one category: 100 000 docs examined and 170 ms against 24 and 3 ms, for the same 24
    // items. Asserted as a key document rather than by name because the position of `name` is the
    // whole point; an index on the same four fields in any other order does not serve the sort.
    assert.deepEqual(await indexKeys('item', 'idCompany_published_name'),
      { idCompany: 1, published: 1, deleted: 1, name: 1 },
      'the public shop page, sorted by name from the index');
    assert.deepEqual(await indexKeys('item', 'idCategory_published_name'),
      { idCategory: 1, published: 1, deleted: 1, name: 1 },
      'the category browse — the route with the broadest fan-out, one category across every shop');

    // ⚠️ The three-key prefixes are NOT installed alongside them, which is the opposite call from
    // `company.published_list` and deliberately so: every plan that could use the short index can use
    // the long one, and `item` is the write-heavy collection of the three — a shop owner edits a
    // catalogue continuously, where a registration happens once.
    const names = (await db.collection('item').indexes()).map((i) => i.name);
    assert.ok(!names.includes('idCompany_published'), 'no redundant three-key shop-page index');
    assert.ok(!names.includes('idCategory_published'), 'no redundant three-key category index');
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

  // ---- the encryption census (ADR-029) ---------------------------------------
  //
  // Explicit CSFLE: MongoDB Community supports neither automatic encryption nor Queryable Encryption,
  // so a value is encrypted by the application before it is written and decrypted after it is read,
  // and the server only ever sees `binData` subtype 6. Every collection here declares that in its
  // FIRST validator — there is no conversion migration and no plaintext era to convert from.
  //
  // ⚠️ A field-level rule cannot survive encryption. `maxLength`, `minLength`, `pattern` and the
  // per-axis coordinate bounds all describe a value the server can read, and it reads a byte string.
  // Wherever a field is ciphertext here, its bound holds in the GraphQL input validation instead —
  // which is why `lib/schemas/geo.js` refuses to attach a `maxLength` to an encrypted street at all.

  test('every personal field is ciphertext, and the ones that are not are argued', async () => {
    // The census: what this platform treats as personal data, in one place, per collection. A field
    // that arrives later and belongs on the left must be added to a validator, not to this list.
    const CIPHERTEXT = {
      admin: ['login.email', 'personalData.firstName', 'personalData.lastName'],
      shopOwner: [
        'login.email', 'notes', 'emailVerify.newEmailTmp',
        'personalData.birth.date', 'personalData.address.street', 'personalData.address.postalCode',
        'personalData.address.province', 'personalData.address.position',
        'personalData.contacts.mobile', 'personalData.contacts.landline', 'personalData.contacts.email',
      ],
      company: ['contactPerson', 'administrator'],
      user: [
        'login.email', 'emailVerify.newEmailTmp',
        'personalData.firstName', 'personalData.lastName', 'personalData.birth.date',
        'personalData.contacts.mobile', 'personalData.contacts.landline', 'personalData.contacts.email',
      ],
    };

    // The other half, and the half worth arguing. Every entry here is a field somebody could
    // reasonably expect to be encrypted and which deliberately is not.
    const CLEARTEXT = {
      // A bcrypt hash is not personal data and is never a query filter — the application compares it.
      // Encrypting it would buy nothing and cost the login path a decrypt.
      admin: ['login.password', 'resetPwd.resetHash'],
      // ⚠️ The three sort keys of the operator table. `tbl_active_lastName_firstName`,
      // `tbl_active_firstName` and `tbl_active_city` sort on them and the table's search matches
      // `/^term/i` against them. Deterministic CSFLE preserves equality and NOTHING else — no
      // ordering, no prefix — so encrypting these would not slow the table down, it would silently
      // return the wrong rows in the wrong order.
      shopOwner: ['personalData.firstName', 'personalData.lastName', 'personalData.address.city',
        'login.password', 'resetPwd.resetHash', 'emailVerify.hash', 'registeredAt'],
      // A company is a legal entity and these identify it publicly. `address` in particular backs
      // `address.position_2dsphere`, `published_city_publicName` and the storefront map.
      company: ['legalName', 'vatNumber', 'taxCode', 'uniqueCode', 'certifiedEmail', 'registryExtract',
        'publicName', 'slug', 'description', 'address.street', 'address.city', 'address.position'],
      // ⚠️ `defaultAddress` and every `addresses._id` MUST stay clear: the second half of this
      // collection's validator `$map`s the element ids and checks `defaultAddress` is `$in` them.
      // Random ciphertext differs on every encryption, so encrypting either side would make that
      // match nothing and refuse every write to the collection. A server-minted ObjectId is not
      // personal data on its own, so nothing is given up.
      user: ['defaultAddress', 'login.password', 'resetPwd.resetHash', 'emailVerify.hash'],
    };

    const nodeAt = ($jsonSchema, dotted) =>
      dotted.split('.').reduce((node, segment) => node.properties[segment], $jsonSchema);

    for (const [collection, paths] of Object.entries(CIPHERTEXT)) {
      const $jsonSchema = jsonSchemaOf((await collInfo(collection)).options.validator);
      for (const p of paths) {
        assert.equal(nodeAt($jsonSchema, p).bsonType, 'binData', `${collection}.${p} must be ciphertext`);
      }
      for (const p of CLEARTEXT[collection]) {
        assert.notEqual(nodeAt($jsonSchema, p).bsonType, 'binData', `${collection}.${p} must stay in the clear`);
      }
    }

    // The catalogue holds no personal data at all. Asserted rather than left implicit: an `item` is
    // domain-neutral by ADR-008 and a personal field arriving in one would be a design mistake before
    // it was an encryption one.
    for (const collection of ['item', 'itemCategory']) {
      const { properties } = jsonSchemaOf((await collInfo(collection)).options.validator);
      const encrypted = Object.entries(properties).filter(([, shape]) => shape.bsonType === 'binData');
      assert.deepEqual(encrypted, [], `${collection} carries no personal data and must have no ciphertext`);
    }
  });

  // ---- the demo seed ---------------------------------------------------------

  test('the demo seed encrypts before it writes, and its down removes exactly what it wrote', async () => {
    // ⚠️ The one test in this repo that runs a real `ClientEncryption` against a real 96-byte key —
    // see the CSFLE block in `beforeAll`. Everything above uses the opaque `cipher()` fixture, which
    // the server cannot tell from the real thing but libmongocrypt can.
    //
    // The seed is popped and driven by hand with `SEED_DEMO` forced on, so this runs identically
    // under `yarn test` and `yarn test:seed` — the flag decides whether a *developer* gets demo data,
    // and it must not decide whether the encryption path is ever exercised. Under `yarn test` the pop
    // is a no-op; under `yarn test:seed` it deletes the three documents the run inserted. Either way
    // the three collections are empty of demo data at this line.
    await mm.down(db, client); // 20260301000600-seed-demo
    for (const c of ['admin', 'shopOwner', 'company']) {
      assert.equal(await db.collection(c).countDocuments(), 0, `${c} empty before the seed is driven by hand`);
    }

    // ⚠️ **Evicted from `require.cache` first, and that is not hygiene.** Everything above the
    // exports in that file — the bcrypt hash, the three demo documents, the three encryption plans —
    // is top-level code, evaluated once per process, and migrate-mongo already loaded it in
    // `beforeAll`. A plain `require` hands back that first evaluation, so nothing in the module body
    // executes while this test is the running test, `yarn test:mutation` attributes every literal in
    // it to whichever suite happened to load it first, and 45 mutants this test would otherwise kill
    // are reported as survivors instead. `test/migrationCalls.test.mjs` carries `evictLib()` for the
    // same reason, and `lib/schemas/README.md` states the rule.
    delete require.cache[require.resolve(SEED_PATH)];
    const seed = require(SEED_PATH);
    const savedFlag = process.env.SEED_DEMO;
    process.env.SEED_DEMO = 'true';

    try {
      await seed.up(db, client);

      // The operator: both names as well as the login address, because nothing sorts or searches this
      // collection. The bcrypt hash stays readable — it is not personal data, and it is compared by
      // the application rather than by a query.
      const admin = await db.collection('admin').findOne({});
      for (const p of ['login.email', 'personalData.firstName', 'personalData.lastName']) {
        assert.ok(isCiphertext(at(admin, p)), `admin.${p} is subtype 6`);
      }
      assert.match(admin.login.password, /^\$2y\$14\$/, 'the bcrypt hash is stored as written');

      // The shop owner. Seven of the eleven planned paths are present on this document and all seven
      // are subtype 6 — whatever they were before: a string, or a Date.
      const owner = await db.collection('shopOwner').findOne({});
      for (const p of ['login.email', 'personalData.birth.date', 'personalData.address.street',
        'personalData.address.postalCode', 'personalData.address.province',
        'personalData.contacts.mobile', 'personalData.contacts.email']) {
        assert.ok(isCiphertext(at(owner, p)), `shopOwner.${p} is subtype 6`);
      }
      // ⚠️ And the other four are ABSENT rather than encrypted-from-nothing. The plan names every
      // path the collection can carry; the document carries some of them. A plan applied blindly
      // would write four `null`s into fields typed `binData` and be refused by the validator — so
      // "encrypt what is there" is the behaviour, and this is where it is pinned.
      assert.equal('notes' in owner, false, 'no operator note was written, so none was encrypted');
      assert.equal('emailVerify' in owner, false, 'and no pending email change');
      assert.equal('landline' in owner.personalData.contacts, false, 'and no landline');
      assert.equal('position' in owner.personalData.address, false, 'and no coordinate — the seed types the address');
      // Nothing outside the plan moved. The three sort keys above all: a conversion that took them
      // would leave the operator table sorting on ciphertext, which fails silently rather than loudly.
      assert.equal(owner.personalData.firstName, 'John', 'the given name is in the clear');
      assert.equal(owner.personalData.lastName, 'Carter', 'the family name is in the clear');
      assert.equal(owner.personalData.address.city, 'Boston', 'and so is the city');
      assert.deepEqual(owner.registeredAt, new Date('2026-01-24T15:17:00Z'), 'the registration instant is untouched');

      // The company: the two people named on it, and nothing else. Everything left readable is either
      // a matter of public record or what the storefront hands to anonymous visitors — and the point
      // below is an index key, so a conversion that took it would break a read rather than slow one.
      const company = await db.collection('company').findOne({});
      for (const p of ['contactPerson', 'administrator']) {
        assert.ok(isCiphertext(at(company, p)), `company.${p} is subtype 6`);
      }
      // The registry record, value for value. All of it is in the clear and all of it is meant to
      // be: it is what a registrar already publishes about the entity, and three of these fields
      // carry a `pattern` or a length the server can only enforce on a value it can read.
      assert.equal(company.legalName, 'Northwind Trading Ltd', 'the registered name is in the clear');
      assert.equal(company.vatNumber, '02554785963', 'and the VAT number');
      assert.equal(company.taxCode, '02554785963', 'and the tax code, which is the same 11 digits here');
      assert.equal(company.uniqueCode, '548XS3W', 'and the e-invoicing recipient code');
      assert.equal(company.certifiedEmail, 'certified@northwind.example', 'and the certified address');
      assert.equal(company.registryExtract, 'registryExtract.pdf', 'and the path to the registry extract');
      // The registered seat, likewise clear and likewise deliberate — `published_city_publicName`
      // sorts on the city and `address.position_2dsphere` reads the point, and neither survives
      // ciphertext. Asserted whole rather than field by field, because a missing member of this
      // block is as wrong as a changed one.
      assert.deepEqual(company.address, {
        street: '350 Fifth Avenue',
        postalCode: '10118',
        city: 'New York',
        province: 'NY',
        position: { type: 'Point', coordinates: [-73.98566, 40.74844] }
      }, 'the seat is stored as written, point included');
      // Seeded unpublished, and honestly so: it has no slug and no publicName, and the `$expr` clause
      // would refuse to let it go live without them. Putting the demo shop on the storefront is a
      // decision about demo content, not about the schema.
      assert.equal(company.published, false, 'the demo shop is not live');
      // Nothing enforces this reference, which is precisely why it is asserted. A demo database whose
      // reference dangles looks identical from the outside until something tries to follow it.
      assert.ok(company.idShopOwner.equals(owner._id), 'the company belongs to the seeded shop owner');

      // ⚠️ The one thing about a seeded coordinate pair that no validator can catch: [-73.98, 40.74]
      // and [40.74, -73.98] are both well-formed, both in range, and only one of them is on land.
      // Asserted through the index, which is what actually interprets the pair — MongoDB reads
      // element zero as longitude whatever the seed meant, so a transposed point sits on the far side
      // of the planet and falls outside the radius.
      const near = await db.collection('company')
        .find({
          'address.position': {
            $near: { $geometry: { type: 'Point', coordinates: [-73.9772, 40.7527] }, $maxDistance: 20000 }
          }
        })
        .toArray();
      assert.equal(near.length, 1, 'the seeded company is within 20 km of midtown Manhattan');
      assert.ok(near[0]._id.equals(company._id), 'and it is the seeded company that answered');

      // ⚠️ One data key per seeded collection, named after it, and NOT one shared key. Asserted
      // before anything below mints one of its own, because `openEncryption` creates a key the moment
      // it fails to find one — after that line this count proves nothing.
      const vault = await db.collection('__keyVault').find({}, { projection: { keyAltNames: 1 } }).toArray();
      assert.deepEqual(vault.flatMap(({ keyAltNames }) => keyAltNames).sort(), ['admin', 'company', 'shopOwner'],
        'one data key per seeded collection, under its own alt name');

      // ⚠️ The reason `login.email` is DETERMINISTIC and the rest are not: encrypting the same address
      // again produces the same bytes, so the account is still findable by it and `login.email_unique`
      // still constrains something. Every login on the platform is this query.
      const { openEncryption, ALGORITHM_DETERMINISTIC, ALGORITHM_RANDOM } = require('../lib/encryption.js');
      const encryption = await openEncryption(client, 'shopOwner');
      const lookup = await encryption.encrypt('shopOwner@thedoctorweb.com',
        { keyAltName: 'shopOwner', algorithm: ALGORITHM_DETERMINISTIC });
      const found = await db.collection('shopOwner').findOne({ 'login.email': lookup });
      assert.ok(found, 'the account is findable by deterministically encrypted login address');
      assert.ok(found._id.equals(owner._id), 'and it is the right account');

      // The mirror of that claim, and the reason everything else is random: a random ciphertext of the
      // same value differs every time, so no equality query can reach it — which is what makes it the
      // right default for anything nothing looks up.
      const twice = await Promise.all([0, 1].map(() =>
        encryption.encrypt('395458770', { keyAltName: 'shopOwner', algorithm: ALGORITHM_RANDOM })));
      assert.equal(Buffer.from(twice[0].buffer).equals(Buffer.from(twice[1].buffer)), false,
        'random ciphertext differs on every encryption');

      // ⚠️ **Subtype 6 is not evidence that the right value went in.** A plan that encrypted an
      // empty string, or the field next to the one it meant, produces a blob no assertion above can
      // tell from the correct one — so every path this test can only see as ciphertext is read back
      // through the same key here. The clear fields need none of this: they are compared value for
      // value where they are read. One `ClientEncryption` decrypts all three collections, because a
      // ciphertext names the data key that made it and the vault holds all three.
      for (const [document, field, expected] of [
        [admin, 'login.email', 'info@thedoctorweb.com'],
        [admin, 'personalData.firstName', 'John'],
        [admin, 'personalData.lastName', 'Carter'],
        [owner, 'personalData.birth.date', new Date('1970-11-24T00:00:00Z')],
        [owner, 'personalData.address.street', '12 Market Street'],
        [owner, 'personalData.address.postalCode', '02108'],
        [owner, 'personalData.address.province', 'MA'],
        [owner, 'personalData.contacts.mobile', '395458770'],
        [owner, 'personalData.contacts.email', 'shopOwner@thedoctorweb.com'],
        [company, 'contactPerson', 'John Carter'],
        [company, 'administrator', 'John Carter']
      ]) {
        assert.deepEqual(await encryption.decrypt(at(document, field)), expected,
          `${field} decrypts to what the seed wrote`);
      }

      // ⚠️ `down` deletes by the same fixed `_id`s `up` inserted, and takes no client and no master
      // key — deleting needs neither, and requiring one would make a rollback impossible on a machine
      // that has the seeded database but not the key.
      await seed.down(db);
      for (const c of ['admin', 'shopOwner', 'company']) {
        assert.equal(await db.collection(c).countDocuments(), 0, `${c} emptied by the seed's down`);
      }
    } finally {
      if (savedFlag === undefined) delete process.env.SEED_DEMO;
      else process.env.SEED_DEMO = savedFlag;
    }

    // Back to the state the run as a whole is in: re-applying restores the demo data under
    // `yarn test:seed` and writes nothing under `yarn test`.
    assert.equal((await mm.up(db, client)).length, 1, 'the seed migration re-applied');
    const expected = SEEDED ? 1 : 0;
    for (const c of ['admin', 'shopOwner', 'company']) {
      assert.equal(await db.collection(c).countDocuments(), expected, `${c} back to the run's seeded state`);
    }
  });

  test('down reverts every migration', async () => {
    for (let i = 0; i < MIGRATION_FILES.length; i++) await mm.down(db, client);
    const names = new Set(await collNames());
    for (const c of APP_COLLECTIONS) assert.ok(!names.has(c), `collection ${c} dropped`);
    assert.equal(await db.collection('changelog').countDocuments(), 0, 'changelog emptied');
  });
}
