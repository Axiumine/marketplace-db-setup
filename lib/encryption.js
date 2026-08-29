// Explicit CSFLE, for the one migration that writes documents into collections whose personal fields
// are `binData` from the moment they are created.
//
// This is the only file in the repo that talks to anything but the schema shapes, and it exists
// because the demo seed cannot insert what it wants to insert. `admin`, `shopOwner`, `company` and
// `user` declare their personal fields `bsonType: 'binData'` in their very first validator, so a
// plain `insertOne` of a legible email address is refused by the server — correctly. The seed has to
// hand MongoDB the ciphertext, which means minting the same data keys the services use, under the
// same master key, before it writes anything.
//
// ⚠️ **The field lists live in the seed migration, not here, and they are a copy of
// `marketplace-common/src/encryption/encryptedFields.mts`.** Nothing checks that the two agree —
// different repos, different module systems, no shared package between them. A path encrypted there
// and not here is written as ciphertext into a `string` field and refused; a path encrypted here and
// not there is written once and then overwritten in the clear by the first service that saves the
// document. Change both in the same piece of work.
//
// ⚠️ **`CSFLE_MASTER_KEY_PATH` must name the same file the nine services read.** The data keys in the
// vault are encrypted under it, so a seed run against a different master key mints keys the platform
// cannot use, and every field this file writes comes back as an undecryptable blob. It is the one
// credential here whose loss destroys data rather than requiring a reset — see
// `marketplace-common/src/encryption/fieldEncryption.mts`.

const { readFileSync } = require('node:fs');

const { ClientEncryption } = require('mongodb');

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
    throw new Error(`${name} is not set — this migration writes encrypted fields and cannot run without it`);
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
 * The optional chaining is load-bearing, not defensive: `emailVerify` and `contacts` are optional
 * sub-documents, so several paths in the shopOwner plan walk through a node the demo account simply
 * does not have.
 */
function valueAt(document, path) {
  return path.split('.').reduce((node, segment) => node?.[segment], document);
}

/**
 * Returns a copy of `document` with the dotted `path` set to `value`, sharing everything it did not
 * have to touch.
 *
 * ⚠️ **A copy rather than an in-place write, and a shallow one rather than `structuredClone`.** In
 * place would mean the seed's own literals mutate as they are encrypted, so `down` could no longer
 * read the addresses it has to delete by. `structuredClone` would be worse: it walks the value and
 * rebuilds it as plain data, which strips the `ObjectId`, `Date` and `Binary` prototypes off
 * everything in the document, and every one of those is a bson type the validator demands.
 */
function setAt(document, path, value) {
  const [head, ...rest] = path.split('.');

  return {
    ...document,
    [head]: rest.length === 0 ? value : setAt(document[head], rest.join('.'), value)
  };
}

/**
 * A document with every declared personal field replaced by its ciphertext, ready to be inserted.
 *
 * `plan` is `{ collection, keyAltName, fields }`, where `fields` is a list of `[dotted path,
 * algorithm]` pairs — the same shape `marketplace-common` keeps its list in.
 *
 * A path the document does not carry is skipped rather than encrypted as `undefined`: the demo shop
 * owner has no landline, no admin note and no pending email change, and encrypting a missing field
 * would write a blob into a slot the validator says is optional and the services expect to be absent.
 *
 * ⚠️ **No path here may cross an array**, and none does — `admin`, `shopOwner` and `company` have no
 * array of personal fields between them, and `user` is not seeded. `user.addresses` would need this
 * walker taught about arrays first; adding such a path to a plan without doing that silently encrypts
 * nothing.
 */
async function encryptDocument(client, plan, document) {
  const encryption = await openEncryption(client, plan.keyAltName);
  const present = plan.fields.filter(([path]) => valueAt(document, path) !== undefined);

  let encrypted = document;

  for (const [path, algorithm] of present) {
    const ciphertext = await encryption.encrypt(valueAt(document, path), { keyAltName: plan.keyAltName, algorithm });
    encrypted = setAt(encrypted, path, ciphertext);
  }

  return encrypted;
}

// `openEncryption` is exported for the suite rather than for the migrations, which reach it through
// `encryptDocument`. `test/migrations.test.mjs` needs the SAME data key the seed mints in order to
// ask the question deterministic encryption exists to answer — encrypt a known address a second time
// and look the account up by the bytes. Building a second `ClientEncryption` there by hand would
// answer it about a key nothing else uses.
module.exports = {
  ALGORITHM_DETERMINISTIC,
  ALGORITHM_RANDOM,
  ENV_MASTER_KEY_PATH,
  ENV_KEY_VAULT_NAMESPACE,
  MASTER_KEY_LENGTH,
  openEncryption,
  encryptDocument
};
