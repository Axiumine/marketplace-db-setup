// Turns the customer's personal fields into ciphertext — the last of four (ADR-029).
//
// ⚠️ **This one converts no data, and it is the only one of the four that does not.** It installs the
// validator and stops there.
//
// The reason is that no document survives to be converted. `user` was created by `20260804000000`,
// no seed migration writes one — neither `20260301001800-seed-demo` nor `20260803142526-
// seed-demo-company` touches this collection — and a change under `lib/schemas/` is followed by a
// full rebuild of every database that has run these migrations (`lib/schemas/README.md`): down to
// empty, then up again. A customer registered in dev before that rebuild is dropped by the rebuild
// itself, not stranded by this file. Every customer registered after it is written through the
// Mongoose plugin and arrives encrypted already.
//
// So a conversion pass here would be code that has never had an input and never will, which
// `lib/schemas/README.md` names for what it is: a permanent mutation survivor, indistinguishable
// from a live path by any test. `encryptStored` would also have to learn to walk an array to do it —
// `addresses.[].street` and its five siblings are the only encrypted paths on the platform that
// cross one, and the walker deliberately does not handle that case. If a populated `user` collection
// ever does need converting, it needs a new migration and an array-aware walker, both written
// against data that actually exists.
//
// Everything personal here is encrypted, with no exception carved out for query support — the whole
// of `personalData`, the whole of every address element, `city` included. `shopOwner` could not
// afford that (see `20260808000100`); this collection can, because nothing sorts, searches or
// paginates customers. A customer reads their own document by `_id` and there is no operator table
// over them.
//
// ⚠️ **`addresses.[]._id` and `defaultAddress` stay in the clear and must.** The validator's second
// clause `$map`s the `_id` of every address element and checks `defaultAddress` is one of them.
// Random ciphertext differs on every encryption, so encrypting either side would make `$in` match
// nothing and *every* write to this collection would be refused — the failure would be total and
// immediate. An ObjectId the server minted is not personal data on its own, so nothing is given up.
//
// ⚠️ **`collMod` here must restate BOTH clauses**, and `validatorUser()` does: it has returned an
// `$and` pair since the collection was created. Passing the `$jsonSchema` half alone would silently
// drop the dangling-pointer rule, and nothing would fail until a `defaultAddress` pointing at a
// deleted address was written.

const { setValidator } = require('../lib/schemas/collection');
const { validatorUser } = require('../lib/schemas/user');

const COLLECTION = 'user';

module.exports = {
  async up(db) {
    await setValidator(db, COLLECTION, validatorUser({ encrypted: true }));
  },

  async down(db) {
    await setValidator(db, COLLECTION, validatorUser());
  }
};
