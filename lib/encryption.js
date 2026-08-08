// Explicit CSFLE, for the four migrations that turn a collection's personal fields from plaintext
// into BinData subtype 6 and back.
//
// This is the only file in the repo that talks to anything but the schema shapes, and it exists
// because a `collMod` alone would leave the documents already stored behind. `collMod` does not
// re-validate what is in the collection, so installing a `binData` shape over a `string` field is
// silent: every stored document stays exactly where it is, valid to the server and unreadable to the
// service, which now encrypts the value it searches by and matches nothing. A demo shop owner who
// cannot log in is the visible half of that; the invisible half is a document that becomes
// unwritable on its next update, weeks later, naming a field nobody touched.
//
// ⚠️ **The field lists live in the migrations, not here, and they are a copy of
// `marketplace-common/src/encryption/encryptedFields.mts`.** Nothing checks that the two agree —
// different repos, different module systems, no shared package between them. A path encrypted there
// and not here is written as ciphertext into a `string` field and refused; a path encrypted here and
// not there is converted once and then overwritten in the clear by the first service that saves the
// document. Change both in the same piece of work.
//
// ⚠️ **`CSFLE_MASTER_KEY_PATH` must name the same file the nine services read.** The data keys in the
// vault are encrypted under it, so a migration run against a different master key mints keys the
// platform cannot use, and every field this file converts comes back as an undecryptable blob. It is
// the one credential here whose loss destroys data rather than requiring a reset — see
// `marketplace-common/src/encryption/fieldEncryption.mts`.

const { readFileSync } = require('node:fs');

const { Binary, ClientEncryption } = require('mongodb');

/** The two algorithm names, spelled exactly as `marketplace-common` spells them. */
const ALGORITHM_DETERMINISTIC = 'AEAD_AES_256_CBC_HMAC_SHA_512-Deterministic';
const ALGORITHM_RANDOM = 'AEAD_AES_256_CBC_HMAC_SHA_512-Random';

const ENV_MASTER_KEY_PATH = 'CSFLE_MASTER_KEY_PATH';
const ENV_KEY_VAULT_NAMESPACE = 'CSFLE_KEY_VAULT_NAMESPACE';

/**
 * 96 bytes, not 32. The `local` KMS provider splits the key into a 32-byte encryption key, a 32-byte
 * MAC key and 32 bytes of reserve, and rejects every other length outright.
 */
const MASTER_KEY_LENGTH = 96;

function requiredEnv(name) {
  const value = process.env[name];

  if (value === undefined || value === '') {
    throw new Error(`${name} is not set — this migration rewrites personal fields and cannot run without it`);
  }

  return value;
}

/**
 * Opens the one `ClientEncryption` this migration needs, and makes sure the collection's data
 * encryption key exists.
 *
 * One key per collection, named after it, exactly as `marketplace-common` names them: a key that
 * leaks then costs one collection rather than every personal field on the platform. Creating it here
 * is idempotent with the services' own startup — whichever runs first mints it, the other finds it.
 *
 * The unique partial index on `keyAltNames` is what makes that true, and it is the driver's own
 * recommendation. It is created here rather than assumed, because a migration may well be the first
 * thing that ever touches the vault. Unlike the services, this file does **not** catch `E11000` on
 * the create: nine services race each other at startup, a migration runs alone, so a duplicate-key
 * branch here would be code no test could reach and a mutation run would report as a survivor for
 * ever.
 */
async function openEncryption(client, keyAltName) {
  const keyVaultNamespace = requiredEnv(ENV_KEY_VAULT_NAMESPACE);
  const masterKey = readFileSync(requiredEnv(ENV_MASTER_KEY_PATH));

  if (masterKey.length !== MASTER_KEY_LENGTH) {
    throw new Error(`The CSFLE master key must be exactly ${MASTER_KEY_LENGTH} bytes, got ${masterKey.length}`);
  }

  const [database, collection] = keyVaultNamespace.split('.');

  await client
    .db(database)
    .collection(collection)
    .createIndex({ keyAltNames: 1 }, { unique: true, partialFilterExpression: { keyAltNames: { $exists: true } } });

  const encryption = new ClientEncryption(client, {
    keyVaultNamespace,
    kmsProviders: { local: { key: masterKey } }
  });

  if ((await encryption.getKeyByAltName(keyAltName)) === null) {
    await encryption.createDataKey('local', { keyAltNames: [keyAltName] });
  }

  return encryption;
}

/**
 * Reads a dotted path out of a document, `undefined` for anything missing along the way.
 *
 * The optional chaining is load-bearing, not defensive: `emailVerify`, `resetPwd` and `contacts` are
 * all optional sub-documents, so half the paths in the shopOwner plan walk through a node that is
 * simply not there on most accounts.
 */
function valueAt(document, path) {
  return path.split('.').reduce((node, segment) => node?.[segment], document);
}

/** Encrypted values are `BinData` subtype 6, and nothing else on this platform is. */
function isCiphertext(value) {
  return value instanceof Binary && value.sub_type === Binary.SUBTYPE_ENCRYPTED;
}

/**
 * Plaintext in, ciphertext out. The algorithm is per field and comes from the migration's list.
 */
const TO_CIPHERTEXT = {
  selects: (value) => !isCiphertext(value),
  convert: async (encryption, value, algorithm, keyAltName) => await encryption.encrypt(value, { keyAltName, algorithm })
};

/**
 * Ciphertext in, plaintext out. `decrypt` needs no algorithm and no key name — both are carried
 * inside the blob, which is what makes a rollback possible with nothing but the master key.
 */
const TO_PLAINTEXT = {
  selects: isCiphertext,
  convert: async (encryption, value) => await encryption.decrypt(value)
};

/**
 * The subset of a plan this document still needs converted: every declared field that is present and
 * on the wrong side of `mode`.
 *
 * ⚠️ **One helper rather than the same test written twice.** The walk that decides whether a document
 * needs writing at all and the walk that builds its `$set` have to agree exactly — a document judged
 * pending and then given an empty `$set` is a driver error, and a field judged settled and then
 * converted anyway is a double encryption nothing can undo. The only way to be sure they agree is for
 * there to be one of them.
 */
function pendingFields(document, plan, mode) {
  return plan.fields.filter(([path]) => {
    const value = valueAt(document, path);
    return value !== undefined && mode.selects(value);
  });
}

/**
 * Walks a collection and rewrites every declared field that is on the wrong side of the conversion.
 *
 * ⚠️ **It opens no `ClientEncryption` unless it finds work**, and that is deliberate rather than an
 * optimisation. A database replayed from empty — the test database on every run, and a dev rebuild
 * without `SEED_DEMO` — has nothing to convert, and requiring a 96-byte master key to migrate a
 * collection with no documents in it would make the whole suite depend on a file that only a
 * developer running services has any reason to hold.
 *
 * It is idempotent in both directions: `selects` skips whatever is already converted, so a re-run
 * finds nothing and a half-finished run resumes.
 *
 * ⚠️ **No path here may cross an array**, and none does — `admin`, `shopOwner` and `company` have no
 * array of personal fields between them. `user.addresses` does, and `user` is deliberately not
 * converted: see `20260808000300-alter-user-encrypted.js` for why nothing has ever written a
 * customer document that survives a rebuild. Adding an array path to a list without teaching this
 * walker about it would silently convert nothing.
 */
async function rewrite(db, client, plan, mode) {
  const documents = await db.collection(plan.collection).find({}).toArray();
  const pending = documents
    .map((document) => [document, pendingFields(document, plan, mode)])
    .filter(([, fields]) => fields.length > 0);

  if (pending.length === 0) {
    return;
  }

  const encryption = await openEncryption(client, plan.keyAltName);

  for (const [document, fields] of pending) {
    const values = {};

    for (const [path, algorithm] of fields) {
      values[path] = await mode.convert(encryption, valueAt(document, path), algorithm, plan.keyAltName);
    }

    await db.collection(plan.collection).updateOne({ _id: document._id }, { $set: values });
  }
}

/**
 * The `up` half: plaintext to ciphertext.
 *
 * ⚠️ Call it AFTER the `binData` validator is installed, not before. This writes the new type into
 * fields the stored shape still calls `string`, so the order every other alter migration in this
 * repo uses — data first, validator second — is exactly backwards here. That order is right when a
 * migration *removes* a field; this one changes a type, and a type change has to widen first.
 */
async function encryptStored(db, client, plan) {
  await rewrite(db, client, plan, TO_CIPHERTEXT);
}

/**
 * The `down` half: ciphertext to plaintext. Mirror-image ordering — restore the `string` validator
 * first, then decrypt into it.
 */
async function decryptStored(db, client, plan) {
  await rewrite(db, client, plan, TO_PLAINTEXT);
}

// `openEncryption` is exported for the suite rather than for the migrations, which reach it through
// `encryptStored`/`decryptStored`. `test/migrations.test.mjs` needs the SAME data key a migration
// would mint in order to ask the question deterministic encryption exists to answer — encrypt a
// known address a second time and look the account up by the bytes. Building a second
// `ClientEncryption` there by hand would answer it about a key nothing else uses.
module.exports = {
  ALGORITHM_DETERMINISTIC,
  ALGORITHM_RANDOM,
  ENV_MASTER_KEY_PATH,
  ENV_KEY_VAULT_NAMESPACE,
  MASTER_KEY_LENGTH,
  openEncryption,
  encryptStored,
  decryptStored
};
