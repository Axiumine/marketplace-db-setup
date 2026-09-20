// Optional demo/dev seed: one admin, one shop owner, one company.
//
// Runs ONLY when `SEED_DEMO=true` — otherwise `up`/`down` are no-ops, so this migration is safe to
// apply in every environment. It is last because it is the only file here that writes documents, and
// it writes into three collections the six before it create.
//
// The flag is read **inside** `up`/`down` rather than captured at module load. A constant would be
// evaluated the first time migrate-mongo requires this file, which makes the behaviour depend on when
// the file was loaded rather than on the environment the migration runs in — and it forces every test
// that wants the other branch to evict this module from `require.cache` and re-require it.
//
// ⚠️ **The seed cannot insert what it wants to insert.** Every collection here declares its personal
// fields `bsonType: 'binData'` in its very first validator (ADR-029), so an `insertOne` carrying a
// legible email address is refused by the server — correctly. The documents below are written in the
// clear, encrypted field by field through `lib/encryption.js`, and only then handed to MongoDB. That
// needs a real `MongoClient` (migrate-mongo passes one as the second argument) and a 96-byte master
// key at `CSFLE_MASTER_KEY_PATH`.
//
// ⚠️ **`CSFLE_MASTER_KEY_PATH` must name the same file the nine services read**, or the data keys
// this file mints are keys the platform cannot use and the demo accounts come back as undecryptable
// blobs. A run *without* `SEED_DEMO` needs no master key at all, which is what keeps a plain
// `migrate:up` — and every test database — free of that dependency.
//
// **The `_id`s are fixed literals**, so `down` deletes exactly what `up` wrote:
//   5c9a013fcf1448b9d885e018  admin
//   5c9a013fcf1448b9d885e000  shopOwner
//   5c9a013fcf1448b9d885a000  company
//
// ⚠️ **This file was edited after it had been applied**, which the immutability rule forbids and which
// the platform owner authorised on 2026-08-26: the three demo addresses carried the vendor's trading
// name and now use `example.com`. A database seeded before that date keeps the old addresses — `up`
// inserts by fixed `_id` and never fires again — so roll that seed back and re-apply it with
// `SEED_DEMO=true`, or the login table in `SETUP.md` names credentials the database does not have.
//
// The demo password is bcrypt of "1234567890" for all three accounts. It is a hash of a published
// value in a file that says so, seeded only behind a flag nobody sets in production.
//
// The company is **Northwind Trading Ltd**, registered in New York, owned by the demo shop owner.
// It is seeded `published: false`, which is the honest value: it has no `slug`, no `publicName` and
// no `description`, and the collection's `$expr` rule would refuse to let it go live without them.
// Putting the demo shop on the storefront is a decision about demo *content*, not about the schema.
//
// ⚠️ Coordinates are GeoJSON order, **longitude first**. No validator catches a transposition because
// both orders are well-formed: `[-73.98, 40.74]` is in New York, `[40.74, -73.98]` is in the Southern
// Ocean off Antarctica.

const { ObjectId } = require('mongodb');

const { ALGORITHM_DETERMINISTIC, ALGORITHM_RANDOM, encryptDocument } = require('../lib/encryption');

const seedEnabled = () => process.env.SEED_DEMO === 'true';

// bcrypt of "1234567890" — a published demo password, not a credential: this hash guards demo
// content that only exists when SEED_DEMO=true, and the plaintext is on the line above.
// nosemgrep: generic.secrets.security.detected-bcrypt-hash.detected-bcrypt-hash
const DEMO_PWD = '$2y$14$hzw7O9l5S65nWptPUnMtrOWgEq8CqNej7HZ5ggkaZ2Zspam99y0Ey';

const ID_ADMIN = new ObjectId('5c9a013fcf1448b9d885e018');
const ID_SHOP_OWNER = new ObjectId('5c9a013fcf1448b9d885e000');
const ID_COMPANY = new ObjectId('5c9a013fcf1448b9d885a000');

const admin = {
  _id: ID_ADMIN,
  login: { email: 'info@example.com', password: DEMO_PWD },
  personalData: { firstName: 'John', lastName: 'Carter' }
};

const shopOwner = {
  _id: ID_SHOP_OWNER,
  login: { email: 'shopOwner@example.com', password: DEMO_PWD },
  personalData: {
    firstName: 'John',
    lastName: 'Carter',
    birth: { date: new Date('1970-11-24T00:00:00Z') },
    address: {
      street: '12 Market Street',
      postalCode: '02108',
      city: 'Boston',
      province: 'MA'
    },
    contacts: { mobile: '395458770', email: 'shopOwner@example.com' }
  },
  registeredAt: new Date('2026-01-24T15:17:00Z')
};

const company = {
  _id: ID_COMPANY,
  idShopOwner: ID_SHOP_OWNER,
  legalName: 'Northwind Trading Ltd',
  vatNumber: '02554785963',
  taxCode: '02554785963',
  contactPerson: 'John Carter',
  administrator: 'John Carter',
  uniqueCode: '548XS3W',
  certifiedEmail: 'certified@northwind.example',
  // The registered seat, in New York.
  address: {
    street: '350 Fifth Avenue',
    postalCode: '10118',
    city: 'New York',
    province: 'NY',
    position: {
      type: 'Point',
      coordinates: [-73.98566, 40.74844]
    }
  },
  registryExtract: 'registryExtract.pdf',
  published: false
};

/**
 * ⚠️ The three field lists below are a copy of `ENCRYPTED_FIELDS_*` in
 * `marketplace-common/src/encryption/encryptedFields.mts`, and nothing checks that the two agree —
 * different repos, different module systems, no shared package between them. `lib/encryption.js` says
 * what each kind of drift does. Change both in the same piece of work.
 *
 * Deterministic only where an equality lookup depends on it: `login.email` is the credential every
 * login form matches on and carries a unique index, and `emailVerify.newEmailTmp` is what koa-utils'
 * `emailChangeHashVerify` finds an account by. Everything else is random, because nothing filters,
 * sorts or ranges over it — and deterministic ciphertext leaks which documents share a value, which
 * is a price worth paying only for a query that could not otherwise exist.
 *
 * `shopOwner`'s three clear fields are absent from its list on purpose, not by omission:
 * `personalData.firstName`, `personalData.lastName` and `personalData.address.city` are sorted and
 * prefix-searched by the admin table. `lib/schemas/shopOwner.js` carries the full argument.
 *
 * ⚠️ Functions rather than constants. A top-level constant is evaluated once per process, the first
 * time migrate-mongo requires this file, so a mutation of one of these strings is baked in before any
 * test switches it on and survives every assertion. A body that re-runs per call cannot hide that
 * way.
 */
const planAdmin = () => ({
  collection: 'admin',
  keyAltName: 'admin',
  fields: [
    ['login.email', ALGORITHM_DETERMINISTIC],
    ['personalData.firstName', ALGORITHM_RANDOM],
    ['personalData.lastName', ALGORITHM_RANDOM]
  ]
});

const planShopOwner = () => ({
  collection: 'shopOwner',
  keyAltName: 'shopOwner',
  fields: [
    ['login.email', ALGORITHM_DETERMINISTIC],
    ['emailVerify.newEmailTmp', ALGORITHM_DETERMINISTIC],
    ['personalData.birth.date', ALGORITHM_RANDOM],
    ['personalData.address.street', ALGORITHM_RANDOM],
    ['personalData.address.postalCode', ALGORITHM_RANDOM],
    ['personalData.address.province', ALGORITHM_RANDOM],
    ['personalData.address.position', ALGORITHM_RANDOM],
    ['personalData.contacts.mobile', ALGORITHM_RANDOM],
    ['personalData.contacts.landline', ALGORITHM_RANDOM],
    ['personalData.contacts.email', ALGORITHM_RANDOM],
    ['notes', ALGORITHM_RANDOM]
  ]
});

const planCompany = () => ({
  collection: 'company',
  keyAltName: 'company',
  fields: [
    ['contactPerson', ALGORITHM_RANDOM],
    ['administrator', ALGORITHM_RANDOM]
  ]
});

module.exports = {
  async up(db, client) {
    if (!seedEnabled()) {
      console.log('[seed-demo] SEED_DEMO !== "true" — skipping demo seed.');
      return;
    }

    // Owner before company: `idShopOwner` is required and points at the shop owner above. Nothing
    // enforces the reference, but a seed that writes a dangling one is a seed nobody can trust.
    await db.collection('admin').insertOne(await encryptDocument(client, planAdmin(), admin));
    await db.collection('shopOwner').insertOne(await encryptDocument(client, planShopOwner(), shopOwner));
    await db.collection('company').insertOne(await encryptDocument(client, planCompany(), company));
  },

  // No client and no master key: deleting by `_id` needs neither, and requiring one would make a
  // rollback impossible on a machine that has the seeded database but not the key.
  async down(db) {
    if (!seedEnabled()) {
      return;
    }

    await db.collection('company').deleteOne({ _id: ID_COMPANY });
    await db.collection('shopOwner').deleteOne({ _id: ID_SHOP_OWNER });
    await db.collection('admin').deleteOne({ _id: ID_ADMIN });
  }
};
