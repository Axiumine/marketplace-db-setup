// **The second migration in this repo that alters a collection instead of creating one, and the first
// that touches a validator.** It caps `user.addresses` at six elements — `maxItems: 6`, added to
// `lib/schemas/user.js` in the same piece of work — on a database that has already been built.
//
// **Why the cap exists at all.** `addresses` was unbounded, and the only ceiling under it was BSON's
// 16 MB document limit: an address is a handful of short ciphertexts, so a scripted client could have
// pushed tens of thousands of them into one customer's document before anything refused. Every read of
// that account — `me`, and the admin's customers table — loads the whole document, so the cost is
// not the storage, it is that one account can make its own reads slow and nobody else's. Six is a
// number for a person: home, work, and four more.
//
// **Why a `collMod` and not a line in `20260301000300-create-user.js`.** That migration has been
// applied, and an applied migration is immutable — editing it changes what a changelog entry means
// retroactively, and every database that has already run it would keep the uncapped validator while
// the file claimed otherwise. Same argument as `20260825000000`, one file earlier.
//
// ⚠️ **On a fresh replay this migration changes nothing, and that is correct rather than a defect.**
// The shape lives in `lib/schemas/user.js`, which `20260301000300` also reads, so a database built from
// empty is already capped by the time this runs and the `collMod` re-installs a validator identical to
// the one in place. The create migration stays the statement of record for what `user` looks like; this
// file exists only to move a database that predates the cap onto it. A reader who wants to know the
// shape of the collection should not have to replay a ladder in their head, and still does not.
//
// ⚠️ **`collMod` replaces a validator wholesale — it never merges.** `user` is one of the two
// collections whose validator is an `$and` pair rather than a bare `$jsonSchema`, and handing MongoDB
// the `$jsonSchema` half alone would silently drop the rule that `defaultAddress` names an element of
// this document's own `addresses`. Nothing would fail at that moment; the first symptom would be a
// dangling pointer written weeks later. `validatorUser()` returns the whole pair and there is no way to
// obtain half of it, which is why it is called here rather than assembled.
//
// ⚠️ **`collMod` does not re-validate what is already stored.** A customer holding seven addresses when
// this runs stays valid where it sits and becomes unwritable on its next update — including an update
// that has nothing to do with addresses, such as the admin disabling the account. It was checked
// before this was written: `user` held no document with more than six addresses. **Check again before
// running this against any database it has not yet been applied to**, and if one exists, trim it first;
// the alternative is an account nobody can edit and a 500 landing on whoever tries.
//
// `down` puts the uncapped validator back by rebuilding today's shape and removing the one keyword this
// migration added, rather than by carrying a frozen copy of the old one. The copy would be the more
// literal rollback and is the worse one: `lib/schemas/user.js` is shared, so a copy would drift from it
// silently and a rollback would quietly revert unrelated later changes along with this one.

const { LEVEL } = require('../lib/schemas/collection');
const { validatorUser } = require('../lib/schemas/user');

const COLLECTION = 'user';

/**
 * Today's validator without the cap — see the note on `down` in the header.
 *
 * One `delete` and no second edit, because `maxItems` is the whole of what `up` adds: the array's
 * `description` deliberately does not repeat the number, so removing the keyword removes the rule
 * without leaving a sentence behind that still claims it.
 */
const uncapped = () => {
  const validator = validatorUser();
  delete validator.$and[0].$jsonSchema.properties.addresses.maxItems;
  return validator;
};

const setValidator = async (db, validator) => {
  await db.command({ collMod: COLLECTION, validator, ...LEVEL });
};

module.exports = {
  async up(db) {
    await setValidator(db, validatorUser());
  },

  async down(db) {
    await setValidator(db, uncapped());
  }
};
