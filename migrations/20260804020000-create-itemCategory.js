// Initial schema migration for the `itemCategory` collection — the two-level taxonomy items are
// filed under, written only by the Admin tier.
//
// The shape and the reasoning behind each field are at the head of `lib/schemas/itemCategory.js`,
// including the one rule it cannot express: depth is capped at two by the resolver, because a
// validator cannot read the parent document to find out whether the parent is itself a subcategory.
//
// ⚠️ **This is not the old per-shop taxonomy coming back.** That collection carried a pointer to the
// old shop collection, it existed once per shop, and it was dropped with the shop on 2026-08-04.
// This one is platform-wide, has no owner column at all, and exists so that two shops selling the
// same kind of thing land under the same customer-facing filter. Same English word, different
// cardinality, different tier writing it.
//
// ## The indexes
//
// `slug_unique` is a plain unique index, unlike `company.slug_unique` which had to be partial. The
// difference is that `slug` is REQUIRED here — the collection is created empty, so there is no
// stored document to strand — and a required field never produces the null keys that made a plain unique
// index collide on `company`.
//
// `idParent_position` backs the only two reads there are: the top-level list (`idParent` missing)
// and one parent's children, both ordered. Putting `position` in the index makes the sort an index
// walk rather than an in-memory sort — which matters less at this cardinality than at `item`'s, but
// costs nothing and means the listing does not degrade if the taxonomy grows.
//
// There is no index on `deleted`. The collection is small by construction — an operator curates it
// by hand — so the filter is applied to an already-indexed result rather than driving the plan.

const { migrationCreation } = require('../lib/schemas/collection');
const { validatorItemCategory } = require('../lib/schemas/itemCategory');

const COLLECTION = 'itemCategory';

const validator = validatorItemCategory();

const indexes = [
  {
    key: {
      slug: 1
    },
    options: {
      name: 'slug_unique',
      unique: true
    }
  },
  {
    key: {
      idParent: 1,
      position: 1
    },
    options: {
      name: 'idParent_position'
    }
  }
];

module.exports = migrationCreation(COLLECTION, validator, indexes);
