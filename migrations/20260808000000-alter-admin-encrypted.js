// Turns the operator's personal fields into ciphertext — the first of four, one per collection that
// holds personal data (ADR-029).
//
// MongoDB Community has neither automatic CSFLE nor Queryable Encryption, so the encryption is
// explicit: `marketplace-common`'s Mongoose plugin replaces the value before the query leaves the
// service, and the server stores a BinData subtype 6 blob it knows nothing else about. All this
// migration does is make the collection accept that blob, and convert what is already stored.
//
// **Order: validator first, data second.** That is the opposite of every other alter migration here,
// and the difference is that those *remove* a field while this one changes a type. Removing needs
// the data gone before the shape narrows; widening a type needs the shape to accept the new type
// before the first write of it. `collMod` never re-validates what is already in the collection, so
// the plaintext documents sitting there between the two calls are not rejected — they are simply
// converted a line later.
//
// **`down` is exact, not lossy**, which is unusual for this repo: `decrypt` needs neither the
// algorithm nor the key name, because both travel inside the blob. Given the master key, every field
// comes back as the value that was encrypted. Without the master key, nothing does — and that is
// worth saying plainly rather than discovering: `CSFLE_MASTER_KEY_PATH` is the one credential on
// this platform whose loss destroys data instead of requiring a reset.
//
// Why `admin` gets both names encrypted while `shopOwner` does not: nothing sorts or searches
// operators. `20260808000100` carries the full argument.

const { setValidator } = require('../lib/schemas/collection');
const { validatorAdmin } = require('../lib/schemas/admin');
const { ALGORITHM_DETERMINISTIC, ALGORITHM_RANDOM, encryptStored, decryptStored } = require('../lib/encryption');

const COLLECTION = 'admin';

/**
 * ⚠️ A copy of `ENCRYPTED_FIELDS_ADMIN` in
 * `marketplace-common/src/encryption/encryptedFields.mts`, and nothing checks that the two agree.
 * Change both together — `lib/encryption.js` says what each kind of drift does.
 *
 * `login.email` is deterministic because the login form matches on it and `login.email_unique`
 * constrains it; random ciphertext would break the lookup and quietly stop the index constraining
 * anything at all. The two names are random: nothing queries them.
 *
 * ⚠️ A function, not a constant, and for the reason `lib/schemas/README.md` gives for `login()` and
 * `emailVerify()`: a top-level constant is evaluated once per process, the first time migrate-mongo
 * requires this file, so a mutation of one of these strings is baked in before any test switches it
 * on and survives every assertion. A body that re-runs per call cannot hide that way.
 */
const plan = () => ({
  collection: COLLECTION,
  keyAltName: 'admin',
  fields: [
    ['login.email', ALGORITHM_DETERMINISTIC],
    ['personalData.firstName', ALGORITHM_RANDOM],
    ['personalData.lastName', ALGORITHM_RANDOM]
  ]
});

module.exports = {
  async up(db, client) {
    await setValidator(db, COLLECTION, validatorAdmin({ encrypted: true }));
    await encryptStored(db, client, plan());
  },

  async down(db, client) {
    await setValidator(db, COLLECTION, validatorAdmin());
    await decryptStored(db, client, plan());
  }
};
