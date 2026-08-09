// Unit tests for lib/mongoUrl.js — the only file in this repo that is neither a migration nor a
// one-off setup script, and the only one both entry points share.
//
// It needs a suite of its own because the migration suite exercises exactly one path through it:
// the fully populated MONGO_TEST_* block. Everything the function is careful about — the ordering
// of credentials against the host, percent-encoding, and whether the authSource is the first query
// parameter or an extra one — is invisible from there, and a wrong answer produces a URL that
// merely fails to connect somewhere else.
//
// No MongoDB, no .env: buildMongoUrl is string assembly and is tested as such.
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

// ⚠️ `require`, not `import`. `migrate-mongo-config.js` pulls this file in through node's own
// loader, so an ESM import here would hand v8 a second, vite-transformed script for the same path —
// and two coverage reports with mismatched byte offsets do not merge into a union, they lose
// ranges. Same reasoning, and the same measurements, as the note in `migrations.test.mjs`.
const { buildMongoUrl, required } = createRequire(import.meta.url)('../lib/mongoUrl.js');

// The label object the real callers pass, so an error message here reads exactly like the one a
// half-filled .env produces.
const NAMES = {
  connString: 'MONGO_TEST_CONN_STRING',
  user: 'MONGO_TEST_UDBOWNER',
  password: 'MONGO_TEST_PWDDBOWNER',
};

const PIECES = {
  connString: 'mongodb://db.gio.lan:27017/dbMarketplaceTest',
  user: 'owner',
  password: 'pwd',
  authSource: 'dbMarketplaceTest',
};

test('the credentials go in after the scheme and the authSource on the end', () => {
  assert.equal(
    buildMongoUrl(PIECES, NAMES),
    'mongodb://owner:pwd@db.gio.lan:27017/dbMarketplaceTest?authSource=dbMarketplaceTest'
  );
});

// The whole reason the credentials are injected with replace() rather than concatenated: they
// belong between the scheme and the host, and a URL that carries them anywhere else is not a
// weaker URL, it is a different one.
test('only the scheme separator is replaced, never a later one', () => {
  const url = buildMongoUrl({ ...PIECES, connString: 'mongodb://host/db?tls=true&x=a://b' }, NAMES);

  assert.equal(url, 'mongodb://owner:pwd@host/db?tls=true&x=a://b&authSource=dbMarketplaceTest');
  assert.equal(url.match(/:\/\//g).length, 2, 'the second "://" is data and stays where it is');
});

// A password is chosen by whoever provisioned the user and is routinely full of characters that
// end a URL component. Unencoded, `p@ss` moves the "@" that separates credentials from host and
// the URL silently names a different server.
//
// ⚠️ The expected value is asserted in two halves rather than as one string, and that is not
// stylistic: the whole URL spelled out on one line is `mongodb://<user>:<20+ chars>@host`, which is
// exactly the shape `.githooks/pre-commit`'s secret guard blocks a commit on. It is a false positive
// here — every character of it is a fixture — but the right answer is to keep the guard's pattern
// tight rather than teach it an exception it could later grant to a real credential.
test('user and password are percent-encoded', () => {
  const url = buildMongoUrl({ ...PIECES, user: 'ow ner', password: 'p@ss:/?#[]' }, NAMES);

  assert.equal(url.slice('mongodb://'.length, url.indexOf('@')), 'ow%20ner:p%40ss%3A%2F%3F%23%5B%5D');
  assert.equal(url.slice(url.indexOf('@') + 1), 'db.gio.lan:27017/dbMarketplaceTest?authSource=dbMarketplaceTest');
});

test('the authSource is appended with & when the connection string already has a query', () => {
  assert.equal(
    buildMongoUrl({ ...PIECES, connString: 'mongodb://host/db?retryWrites=true' }, NAMES),
    'mongodb://owner:pwd@host/db?retryWrites=true&authSource=dbMarketplaceTest'
  );
});

// The authSource is genuinely optional — a single-database cluster authenticates against admin by
// default — so an absent one must leave the URL alone rather than append an empty parameter.
test('no authSource, no query parameter', () => {
  for (const authSource of [undefined, '', null]) {
    assert.equal(
      buildMongoUrl({ ...PIECES, authSource }, NAMES),
      'mongodb://owner:pwd@db.gio.lan:27017/dbMarketplaceTest',
      `authSource: ${String(authSource)}`
    );
  }
});

/*
 * The error names the variable the caller has to go and set.
 *
 * That is the entire point of the `names` argument: the same function assembles the dev URL from
 * MONGO_DEV_* and the test URL from MONGO_TEST_*, and "Missing user" would send whoever reads it
 * to the wrong half of .env.
 */
test('a missing piece is reported under the caller`s own variable name', async () => {
  for (const [field, name] of Object.entries(NAMES)) {
    assert.throws(() => buildMongoUrl({ ...PIECES, [field]: undefined }, NAMES), {
      message: `Missing ${name} in .env`,
    });
  }
});

// Empty counts as missing, and this is the case that matters: a variable present in .env with
// nothing after the `=` reads as '' rather than undefined, and an empty password would otherwise
// assemble into a URL that looks complete and is rejected by the server.
test('an empty string is missing, not a value', () => {
  assert.throws(() => buildMongoUrl({ ...PIECES, password: '' }, NAMES), {
    message: 'Missing MONGO_TEST_PWDDBOWNER in .env',
  });
});

test('required hands back what it was given', () => {
  assert.equal(required('X', 'value'), 'value');
  assert.throws(() => required('X', undefined), { message: 'Missing X in .env' });
});
