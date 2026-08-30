// Unit tests for `migrate-mongo-config.js` — the file that decides which database every
// `yarn migrate:up` on this repo actually writes to.
//
// It had no test of any kind, and the coverage gate did not notice: v8 only reports files that were
// loaded, no suite loaded this one, so it was absent from the report rather than shown at 0% and
// `thresholds: { 100: true }` passed over a file nothing had ever executed. The mutation run is
// what surfaced it — 18 mutants, all "no coverage".
//
// That is worth more than a formality. This file is the only place the dev connection is assembled,
// and every one of its literals is load-bearing in a way that fails quietly rather than loudly:
// `changelogCollectionName` naming the wrong collection makes migrate-mongo believe nothing has ever
// been applied and re-run all of them; `lockTtl: 0` switches locking off; `moduleSystem` set to
// anything but 'commonjs' makes every migration in `migrations/` unloadable; and `migrationsDir`
// pointing anywhere else silently applies nothing at all.
//
// ⚠️ The MONGO_DEV_* block is stubbed with obvious fakes BEFORE the file is loaded, and that is a
// secrecy requirement, not a convenience. dotenv does not override a variable already present in
// the environment, so stubbing first is what keeps the real credentials in `.env` out of this
// process's assertions, out of any failure diff, and out of the terminal.
import { afterEach, test, expect, vi } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

/*
 * ⚠️ `require`, not `import()`. migrate-mongo loads this file through node's own loader; an
 * `import()` here would go through vite and hand v8 a second script for the same path with
 * different byte offsets, and merging coverage reports whose ranges do not line up drops them
 * instead of unioning them. The long form of this is at the head of test/migrations.test.mjs.
 */
const require = createRequire(import.meta.url);
const CONFIG = require.resolve('../migrate-mongo-config.js');

// Deliberately unmistakable values: if one of these ever shows up in a diff, a log or a bug report,
// it is obvious at a glance that it is not a credential.
//
// ⚠️ `MONGO_DEV_PWD` is SHORT on purpose — under ten characters — and lengthening it breaks the
// commit rather than a test. The assembled URL is spelled out in full below, and
// `.githooks/pre-commit`'s secret guard blocks any diff line matching
// `mongodb://<user>:<10+ chars>@host`. It is a false positive here, every character being a fixture,
// but the right answer is to keep the guard's pattern tight rather than teach it an exception it
// could later grant to a real credential — same call, same reasoning, as the two-halves assertion in
// test/mongoUrl.test.mjs.
const FAKE = {
  MONGO_DEV_CONN_STRING: 'mongodb://db.invalid:27017/dbFake',
  MONGO_DEV_UDBOWNER: 'fake-owner',
  MONGO_DEV_PWD: 'fakepwd',
  MONGO_DEV_AUTH_ADMIN: 'dbFakeAuth',
  MONGO_DEV_DB: 'dbFake'
};

// The module reads process.env once, at load, so every test has to drop the cache entry and
// re-evaluate it under its own stubs. `vi.resetModules()` does not clear node's CommonJS cache.
const loadWith = (env) => {
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  delete require.cache[CONFIG];
  return require(CONFIG);
};

afterEach(() => {
  vi.unstubAllEnvs();
  delete require.cache[CONFIG];
});

test('it hands migrate-mongo the whole configuration, value for value', () => {
  const config = loadWith(FAKE);

  // Asserted as one object rather than field by field on purpose: migrate-mongo reads keys it is
  // given and ignores the rest, so a misspelled key is not an error — it is a default silently
  // taking over. deepEqual is what catches `changelogCollection` where `changelogCollectionName`
  // was meant.
  assert.deepEqual(config, {
    mongodb: {
      // Credentials injected after the scheme, authSource appended as the first query parameter —
      // lib/mongoUrl.js does the assembly and test/mongoUrl.test.mjs covers its branches.
      url: 'mongodb://fake-owner:fakepwd@db.invalid:27017/dbFake?authSource=dbFakeAuth',
      databaseName: 'dbFake',
      options: {}
    },
    migrationsDir: 'migrations',
    changelogCollectionName: 'changelog',
    lockCollectionName: 'changelog_lock',
    // 90 seconds: longer than a full `up` (~0.5s), short enough that a crashed run clears itself
    // instead of wedging the database. 0 would turn locking off entirely, which is the mutation
    // this literal exists to make visible.
    lockTtl: 90,
    migrationFileExtension: '.js',
    useFileHash: false,
    // migrate-mongo loads every file in `migrations/` through this setting, and all of them are
    // CommonJS. 'esm' here makes the whole directory unloadable.
    moduleSystem: 'commonjs'
  });
});

test('the database name falls back to the authSource when MONGO_DEV_DB is unset', () => {
  // `MONGO_DEV_DB || MONGO_DEV_AUTH_ADMIN` — the fallback is not decoration. Every database in this
  // deployment authenticates against ITSELF rather than against `admin` (see CLAUDE.md, *Testing*),
  // so the authSource is the database name in every configuration that actually works here, and an
  // .env missing the explicit name still resolves to the right place instead of to undefined.
  const config = loadWith({ ...FAKE, MONGO_DEV_DB: '' });

  assert.equal(config.mongodb.databaseName, 'dbFakeAuth');
});

test('a missing piece is reported under the variable name the admin has to set', () => {
  // The whole point of the `names` argument buildUrl() passes: 'Missing connString in .env' would
  // send someone looking for a variable that does not exist in any .env on this platform.
  assert.throws(() => loadWith({ ...FAKE, MONGO_DEV_CONN_STRING: '' }), /Missing MONGO_DEV_CONN_STRING in \.env/);
  assert.throws(() => loadWith({ ...FAKE, MONGO_DEV_UDBOWNER: '' }), /Missing MONGO_DEV_UDBOWNER in \.env/);
  assert.throws(() => loadWith({ ...FAKE, MONGO_DEV_PWD: '' }), /Missing MONGO_DEV_PWD in \.env/);
});

test('the authSource is optional and simply drops out of the URL', () => {
  // buildMongoUrl appends `authSource` only when there is one, and nothing here demands it — a
  // cluster that authenticates against `admin` needs no parameter at all. Asserted from this side
  // as well as from test/mongoUrl.test.mjs because it is this file that decides the value is
  // allowed to be absent: it passes no name for it, so `required()` never sees it.
  const config = loadWith({ ...FAKE, MONGO_DEV_AUTH_ADMIN: '' });

  assert.equal(config.mongodb.url, 'mongodb://fake-owner:fakepwd@db.invalid:27017/dbFake');
});

test('it never leaks a real credential into this process', () => {
  // A guard on the guard. The stubs above only keep `.env` out of the assertions because dotenv
  // leaves an already-set variable alone; if that ever changes, every test in this file starts
  // comparing against — and printing, on failure — the live dev password. Failing here first says
  // so in one line instead of leaving it to whoever reads the diff.
  const { url } = loadWith(FAKE).mongodb;

  expect(url).toContain('fakepwd');
  // Split at the `@` rather than written as one template literal, for the reason recorded above
  // FAKE: a whole credential URL on one line is the shape the secret guard blocks, and
  // `${FAKE.MONGO_DEV_PWD}` is twenty-odd characters of non-`@` text however short the value it
  // interpolates. Neither half is a credential shape on its own.
  expect(url.slice(0, url.indexOf('@'))).toBe(`mongodb://${FAKE.MONGO_DEV_UDBOWNER}:${FAKE.MONGO_DEV_PWD}`);
  expect(url.slice(url.indexOf('@') + 1)).toBe(`db.invalid:27017/dbFake?authSource=${FAKE.MONGO_DEV_AUTH_ADMIN}`);
});
