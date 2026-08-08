// Turns the shop owner's personal fields into ciphertext — the second of four (ADR-029).
//
// Same shape as `20260808000000-alter-admin-encrypted`: validator first, data second, because this
// changes a type rather than removing a field. The header of that file carries the full argument for
// the ordering and for what `down` can and cannot restore.
//
// ⚠️ **Three personal fields are deliberately left in the clear here, and this is the only
// collection where that is true**: `personalData.firstName`, `personalData.lastName` and
// `personalData.address.city`.
//
// `shopOwnersActiveTbl` in the Admin tier is why. It sorts on all three —
// `tbl_active_lastName_firstName`, `tbl_active_firstName`, `tbl_active_city` — and prefix-searches
// them with `/^term/i`. Neither CSFLE algorithm survives either operation. Random ciphertext differs
// on every encryption, so it supports no comparison whatsoever; deterministic ciphertext supports
// equality and only equality, so it answers a sort no better than a `$regex`. Encrypting the three
// would therefore not make the operator table slow — it would make it **wrong, with no error**: the
// table would keep rendering, ordered by the byte values of blobs, and every search box on it would
// return an empty result for a shop owner who exists.
//
// The same three fields on `admin` and `user` ARE encrypted, because nothing sorts or searches those
// two collections. Closing this hole means dropping those three indexes and paging the table some
// other way; ADR-029 records the trade and the conditions for revisiting it. Adding the fields to
// `PLAN` below without doing that in the same change breaks the operator app silently.
//
// Everything else the shop owner declared is encrypted, the address point included: it is an object,
// so random is the only algorithm defined for it, and nothing here queries by distance — this
// collection has no `2dsphere`. `notes` is encrypted too, and it is the one encrypted field on the
// platform its subject never reads: free text an operator wrote *about* a named person is personal
// data about that person whatever it happens to say.

const { setValidator } = require('../lib/schemas/collection');
const { validatorShopOwner } = require('../lib/schemas/shopOwner');
const { ALGORITHM_DETERMINISTIC, ALGORITHM_RANDOM, encryptStored, decryptStored } = require('../lib/encryption');

const COLLECTION = 'shopOwner';

/** The state `20260802000300` left behind — the flags this migration adds `encrypted` on top of. */
const CURRENT = { emailVerify: true, position: true, notes: true };

/**
 * ⚠️ A copy of `ENCRYPTED_FIELDS_SHOP_OWNER` in
 * `marketplace-common/src/encryption/encryptedFields.mts`, and nothing checks that the two agree.
 *
 * Two deterministic fields, for the two equality lookups: `login.email` is the credential and
 * carries a unique index, `emailVerify.newEmailTmp` is what koa-utils' `emailChangeHashVerify` finds
 * the account by. Everything else is random, because nothing filters, sorts or ranges over it.
 *
 * ⚠️ A function rather than a constant — see `20260808000000-alter-admin-encrypted.js`.
 */
const plan = () => ({
  collection: COLLECTION,
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

module.exports = {
  async up(db, client) {
    await setValidator(db, COLLECTION, validatorShopOwner({ ...CURRENT, encrypted: true }));
    await encryptStored(db, client, plan());
  },

  async down(db, client) {
    await setValidator(db, COLLECTION, validatorShopOwner(CURRENT));
    await decryptStored(db, client, plan());
  }
};
