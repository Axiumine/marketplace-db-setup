// Builds an authenticated MongoDB connection URL from the split MONGO_*_ pieces
// kept in .env: a bare connection string, a user, a password, and an authSource.
//
// Both callers need the exact same assembly and it is easy to get subtly wrong
// (the credentials go before the host, the authSource is a query parameter that
// may or may not be the first one, and either value may contain characters that
// have to be percent-encoded), so it lives here instead of being written twice:
//
//   migrate-mongo-config.js  -> MONGO_DEV_*   (the dev database, real migrations)
//   test/migrations.test.mjs  -> MONGO_TEST_*  (the throwaway database)

function required(name, value) {
  if (!value) throw new Error(`Missing ${name} in .env`);
  return value;
}

// Inject "user:pwd@" after the scheme and append authSource.
// `names` only labels the pieces for the error message, so a missing value
// reports the variable the caller has to set rather than a generic failure.
function buildMongoUrl({ connString, user, password, authSource }, names) {
  const conn = required(names.connString, connString);
  const u = encodeURIComponent(required(names.user, user));
  const p = encodeURIComponent(required(names.password, password));

  // replace() hits the first "://" only, which is the scheme separator.
  let url = conn.replace('://', `://${u}:${p}@`);
  if (authSource) {
    url += (url.includes('?') ? '&' : '?') + `authSource=${authSource}`;
  }
  return url;
}

module.exports = { buildMongoUrl, required };
