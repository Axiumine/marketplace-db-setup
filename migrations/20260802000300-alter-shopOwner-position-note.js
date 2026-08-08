// Adds two optional fields to `shopOwner`: the GeoJSON point of the address
// (`personalData.address.position`) and the operator's free-text `notes` at the top level.
//
// The point is what lets the operator app draw a map for a shopOwner the way it already does for
// the old shop collection's address — that address has carried coordinates since 20260801000000,
// this one never has. The note is what an operator writes *about* an account, which is why it sits
// at the top level and not inside `personalData`: `personalData` is what the shopOwner declared
// about themselves.
//
// ⚠️ Both are OPTIONAL, and the point is optional here while the old shop collection's was REQUIRED.
// That asymmetry is the whole point of this migration's shape. Every shopOwner in the collection was
// written before either field existed, and `collMod` does not re-validate stored documents — so a
// required `position` would leave every one of them unwritable: the next full-document save of an
// operator fixing a phone number would be rejected for an address nobody has re-picked yet. There is
// no backfill to run either, because there is nothing to backfill *from* — a coordinate cannot be
// derived from a stored street address without geocoding every shopOwner. The field fills in the first
// time an address is chosen from the autocomplete; until then the account simply has no map.
//
// Why a whole new file rather than an edit to 20260301000100-create-shopOwner.js or to
// 20260726000000-alter-shopOwner-emailVerify.js: migrations are immutable — both have a
// `changelog` entry wherever they have run, so they will never run again, and editing one would only
// change what a fresh database gets.
//
// Why the validator is restated in full: `collMod` REPLACES the validator, it does not merge into
// it. Passing only the new blocks would drop every other rule on the collection.
// `validatorShopOwner` in `lib/schemas/shopOwner.js` restates it — the same builder the other
// two call, two flags further on. The point itself comes from `lib/schemas/geo.js`, the same node
// the old shop collection used, because the two collections describe the same GeoJSON point and
// must not disagree about which axis comes first.
//
// ⚠️ `down` is lossy and cannot be otherwise: the fields it removes are the only place the
// coordinates and the operator's note were recorded, and the restored validator is
// `additionalProperties: false`, so leaving the data behind would make every subsequent write to
// those shopOwners fail validation. It therefore `$unset`s both before restoring the validator —
// in that order, since a document is validated as it will be *after* the update, and an unset
// document satisfies both shapes.

const { setValidator } = require('../lib/schemas/collection');
const { validatorShopOwner } = require('../lib/schemas/shopOwner');

const COLLECTION = 'shopOwner';

module.exports = {
  async up(db) {
    // No data migration: both fields are optional, so every existing shopOwner is already valid
    // under the new validator. Nothing to backfill the point from either — see the top of the file.
    await setValidator(db, COLLECTION, validatorShopOwner({ emailVerify: true, position: true, notes: true }));
  },

  async down(db) {
    // Data first, validator second — see the note at the top of the file.
    await db.collection(COLLECTION).updateMany(
      { 'personalData.address.position': { $exists: true } },
      { $unset: { 'personalData.address.position': '' } }
    );
    await db.collection(COLLECTION).updateMany({ notes: { $exists: true } }, { $unset: { notes: '' } });
    await setValidator(db, COLLECTION, validatorShopOwner({ emailVerify: true }));
  }
};
