// Adds the `emailVerify` sub-document to the `shopOwner` validator, so the
// `@axiumine/koa-utils` verify-email flow can be bound to this collection.
//
// Why a whole new file rather than an edit to 20260301000100-create-shopOwner.js: migrations are
// immutable — that one has a `changelog` entry everywhere it has run, so it will never run again and
// editing it would only change what a fresh database gets, silently diverging the two.
//
// Why the validator is restated in full: `collMod` REPLACES the validator, it does not merge into it.
// Passing only the new block would drop every other rule on the collection. `validatorShopOwner`
// in `lib/schemas/shopOwner.js` is what restates it — the same builder 20260301000100 calls, one
// flag further on. The `emailVerify` block itself, and why it carries no `required` array, is
// documented there.

const { setValidator } = require('../lib/schemas/collection');
const { validatorShopOwner } = require('../lib/schemas/shopOwner');

const COLLECTION = 'shopOwner';

module.exports = {
  async up(db) {
    // No data migration: `emailVerify` is optional, so every existing shopOwner is already valid
    // under the new validator.
    await setValidator(db, COLLECTION, validatorShopOwner({ emailVerify: true }));
  },

  async down(db) {
    // Strip the field BEFORE narrowing the validator. `collMod` does not re-validate documents that
    // are already stored, so a document still carrying `emailVerify` would survive the revert and then
    // fail on its next write — under `additionalProperties: false` the key is no longer allowed, and
    // a full-document replace sends it straight back. Unsetting first leaves the collection in a
    // state the reverted validator actually accepts.
    await db.collection(COLLECTION).updateMany({ emailVerify: { $exists: true } }, { $unset: { emailVerify: '' } });
    await setValidator(db, COLLECTION, validatorShopOwner({}));
  }
};
