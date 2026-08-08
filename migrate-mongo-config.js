// migrate-mongo configuration.
// Reads dev credentials from .env and builds an authenticated connection URL
// from the existing MONGO_DEV_* variables (same ones the old runner used).
//
// `require('dotenv')` is unguarded. It used to sit in a `try/catch` whose comment read "dotenv is
// optional: if it isn't installed yet, fall back to variables already present in the environment",
// and that stopped being true the moment dotenv became a hard `dependency` in package.json rather
// than something a developer might not have got to yet. A catch that can only fire when
// node_modules is missing — in which case `migrate-mongo` itself is missing too and nothing here
// runs — is a branch no test can enter and no mutation can be caught in. Failing loudly on a broken
// install is also the better behaviour: the swallowed version carries on with an empty environment
// and dies further down on `Missing MONGO_DEV_CONN_STRING in .env`, which points at the wrong file.
//
// ⚠️ dotenv does NOT override a variable already present in the environment, which is what lets the
// unit suite stub the MONGO_DEV_* block and load this file without the real .env values reaching an
// assertion.
require('dotenv').config();

const { buildMongoUrl } = require('./lib/mongoUrl');

const {
  MONGO_DEV_UDBOWNER,
  MONGO_DEV_PWD,
  MONGO_DEV_AUTH_ADMIN,
  MONGO_DEV_CONN_STRING,
  MONGO_DEV_DB,
} = process.env;

// The URL assembly is shared with test/migrations.test.mjs, which does the same
// thing with MONGO_TEST_* — see lib/mongoUrl.js.
function buildUrl() {
  return buildMongoUrl(
    {
      connString: MONGO_DEV_CONN_STRING,
      user: MONGO_DEV_UDBOWNER,
      password: MONGO_DEV_PWD,
      authSource: MONGO_DEV_AUTH_ADMIN,
    },
    {
      connString: 'MONGO_DEV_CONN_STRING',
      user: 'MONGO_DEV_UDBOWNER',
      password: 'MONGO_DEV_PWD',
    }
  );
}

module.exports = {
  mongodb: {
    url: buildUrl(),
    databaseName: MONGO_DEV_DB || MONGO_DEV_AUTH_ADMIN,
    options: {},
  },
  migrationsDir: 'migrations',
  changelogCollectionName: 'changelog',
  // migrate-mongo only grew a lock in v12 — v11 accepted `lockCollectionName` and
  // silently ignored it. `lockTtl` is now mandatory whenever the lock collection is
  // named: without it the TTL index is created with `expireAfterSeconds: null` and
  // Mongo rejects it ("must be numeric"). 0 would switch locking back off; a positive
  // value is what this config always meant, and the TTL is what keeps a crashed run
  // from wedging the database — the lock expires instead of having to be deleted by hand.
  lockCollectionName: 'changelog_lock',
  lockTtl: 90,
  migrationFileExtension: '.js',
  useFileHash: false,
  moduleSystem: 'commonjs',
};
