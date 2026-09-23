// **The third migration that alters a collection instead of creating one, the second that touches a
// validator, and the first that touches two collections at once.** It adds the four account-lifecycle
// paths of ADR-041/ADR-044 — `deletedBy`, `disabledBy`, `disabledReason`, `scrubbedAt` — to `user` and
// to `shopOwner`, and with them the rule that a suspended account must say why it was suspended.
//
// The shapes live in `lib/schemas/account.js` and are wired into both validators there; this file only
// moves databases that predate them. Same argument as `20260826000000`: `20260301000100` and
// `20260301000300` have been applied, and an applied migration is immutable.
//
// **Why both collections in one file rather than two.** The four paths are one decision of the platform
// owner ("and for shopOwner too", 2026-08-29) and they are byte-identical on the two collections,
// because role here is which collection you authenticate against rather than a field. Splitting them
// would let a database exist in which a customer's suspension records who did it and a shop owner's
// does not, which is not a state anybody decided on — it is just a half-applied changelog.
//
// ⚠️ **`admin` deliberately gets none of this.** It carries `deleted` and `disabled` like the other two,
// so the paths would fit, but nobody has said who suspends an admin or what a retention sweep should
// do to one. Adding the fields "for symmetry" would invent that answer in a schema.
//
// ⚠️ **`collMod` replaces a validator wholesale — it never merges.** `user`'s validator is an `$and`
// pair, not a bare `$jsonSchema`, and handing MongoDB the `$jsonSchema` half alone would silently drop
// the rule that `defaultAddress` names an element of this document's own `addresses`. `validatorUser()`
// returns the whole pair and there is no way to obtain half of it, which is why it is called here rather
// than assembled.
//
// ⚠️ **`collMod` does not re-validate what is already stored, and this migration adds a rule that
// existing documents can fail.** `dependencies: { disabled: ['disabledReason'] }` demands a reason
// beside a `disabled: true`, and no document written before today can have one — the path did not exist.
// Such a document stays valid where it sits and becomes UNWRITABLE on its next update, including an
// update with nothing to do with suspension, such as the admin lifting it. `refuseIfStranded` below
// is why that cannot happen quietly.
//
// ⚠️ **The check refuses; it does not backfill, and that is the decision rather than the easy way out.**
// A backfill would have to write a reason no admin wrote into a field whose whole content is an
// admin's words about a named person — encrypted, and read back by the Admin tier as if somebody had
// typed it. A database should not vouch for a sentence nobody said. Refusing hands the choice to whoever
// runs the migration: lift the suspension and re-apply it through `userUpdateStatus` /
// `shopOwnerUpdateStatus`, which now demand a reason, or clear it. Both are one admin action, and
// both produce a true record.
//
// `down` rebuilds today's shape and removes exactly the keywords this migration added, rather than
// carrying a frozen copy of the old validator — the copy would drift from `lib/schemas/` silently and a
// rollback would revert unrelated later changes along with this one.

const { LEVEL } = require('../lib/schemas/collection');
const { validatorShopOwner } = require('../lib/schemas/shopOwner');
const { validatorUser } = require('../lib/schemas/user');

// The two collections, each with the accessor for its own validator and the path into the
// `$jsonSchema` node that carries the properties — `user`'s sits inside an `$and`, `shopOwner`'s is the
// validator itself.
const TARGETS = [
  { collection: 'user', validator: validatorUser, schemaOf: (v) => v.$and[0].$jsonSchema },
  { collection: 'shopOwner', validator: validatorShopOwner, schemaOf: (v) => v.$jsonSchema }
];

/** Exactly what `up` adds to each validator's `properties`, and what `down` takes back out. */
const ADDED_PATHS = ['deletedBy', 'disabledBy', 'disabledReason', 'scrubbedAt'];

/**
 * Today's validator with this migration's additions removed — the `down` shape.
 *
 * The four properties and the one `dependencies` clause are the whole of what `up` adds, so removing
 * them leaves the validator that was in place before it ran, rebuilt from the current shared shapes
 * rather than remembered.
 */
const withoutLifecycle = (target) => {
  const validator = target.validator();
  const schema = target.schemaOf(validator);

  for (const path of ADDED_PATHS) {
    delete schema.properties[path];
  }

  delete schema.dependencies;

  return validator;
};

const setValidator = async (db, collection, validator) => {
  await db.command({ collMod: collection, validator, ...LEVEL });
};

/**
 * Refuses the whole migration if this collection holds a suspension the new rule would strand.
 *
 * The count is of documents that are suspended and carry no reason, which before this migration is
 * every suspended document there is. One is enough to stop: the failure it prevents is an account that
 * no admin can edit and a 500 landing on whoever tries, weeks later, with nothing pointing back here.
 */
const refuseIfStranded = async (db, collection) => {
  const stranded = await db.collection(collection).countDocuments({ disabled: true, disabledReason: { $exists: false } });

  if (stranded > 0) {
    throw new Error(
      `${collection}: ${stranded} suspended document(s) carry no disabledReason. ` +
        'This migration makes a reason mandatory beside disabled:true and collMod does not re-validate ' +
        'stored documents, so each of them would become unwritable on its next update. Lift and re-apply ' +
        'those suspensions through the Admin tier, which records a reason, then run this again.'
    );
  }
};

/**
 * `down` cannot leave the four paths in place: the validator it reinstalls carries
 * `additionalProperties: false` without them, so a document that still holds one becomes unwritable on
 * its next update — the exact failure `up` refuses to create.
 *
 * ⚠️ **It therefore destroys the actor and reason records this migration exists to keep**, on every
 * document that has them. That is what rolling this back means; there is no version of it that keeps the
 * data and leaves a consistent database.
 */
const unsetLifecycle = async (db, collection) => {
  await db
    .collection(collection)
    .updateMany({}, { $unset: Object.fromEntries(ADDED_PATHS.map((path) => [path, ''])) });
};

module.exports = {
  async up(db) {
    // Both collections are checked before either is written, so a refusal leaves the database exactly
    // as it found it rather than half-migrated.
    for (const { collection } of TARGETS) {
      await refuseIfStranded(db, collection);
    }

    for (const target of TARGETS) {
      await setValidator(db, target.collection, target.validator());
    }
  },

  async down(db) {
    // ⚠️ Validator first, fields second — NOT the mirror of `up`'s order. `up` checks before it writes
    // because both of its writes happen under the SAME (new) validator; `down` has two different
    // validators in play and picking the wrong one to unset under is the whole bug this order avoids.
    //
    // The strict validator this migration installed is still active until `setValidator` runs, and it
    // carries `dependencies: { disabled: ['disabledReason'] }`. Unsetting the fields first, as an
    // earlier version of this function did, ran that `$unset` against a currently-suspended account
    // (`disabled: true`, and now no `disabledReason`) while that very rule was still enforced — the
    // updateMany threw on exactly the account this migration exists to describe, mid-batch, leaving
    // the collection half-stripped with the strict validator still installed. Swapping to the
    // permissive validator FIRST retires the dependency rule before any document is touched, so the
    // `$unset` that follows can never trip it: `collMod` does not re-validate what is already stored
    // (see `refuseIfStranded` above), so the still-added fields on existing documents raise nothing at
    // the swap, and the subsequent `$unset` only ever removes properties the new validator has no
    // opinion on.
    for (const target of TARGETS) {
      await setValidator(db, target.collection, withoutLifecycle(target));
      await unsetLifecycle(db, target.collection);
    }
  }
};
