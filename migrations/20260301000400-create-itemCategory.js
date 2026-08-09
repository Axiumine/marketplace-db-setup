// The `itemCategory` collection — the two-level taxonomy items are filed under, written only by the
// Admin tier.
//
// The shape and the reasoning behind each field are at the head of `lib/schemas/itemCategory.js`,
// including the one rule it cannot express: depth is capped at two by the resolver, because a
// validator cannot read the parent document to find out whether the parent is itself a subcategory.
//
// ⚠️ **This is the extension seam of a domain-neutral catalogue** (ADR-008). A new kind of product is
// an `itemCategory` *document*, not a migration and not a collection: `item` presumes nothing about
// what is sold, and a new collection would need a shape `item` genuinely cannot hold.
//
// ⚠️ `position` here is an **int sort ordinal**, not the GeoJSON point every other collection spells
// the same way.
//
// ## The indexes
//
// `slug_unique` is a plain unique index, unlike `company.slug_unique` which has to be partial. The
// difference is that `slug` is REQUIRED here — the collection is created empty, so there is no stored
// document for the requirement to strand — and a required field never produces the null keys that
// would make a plain unique index collide. It is unique across **both** levels, because
// `/category/:slug` and `/category/:slug/:subSlug` resolve through one flat URL space.
//
// `idParent_position` backs the only two reads there are: the top-level list (`idParent` missing) and
// one parent's children, both ordered. Putting `position` in the index makes the sort an index walk
// rather than an in-memory sort — which matters less at this cardinality than at `item`'s, but costs
// nothing and means the listing does not degrade if the taxonomy grows.
//
// There is no index on `deleted`. The collection is small by construction — an operator curates it by
// hand — so the filter is applied to an already-indexed result rather than driving the plan.

const { migrationCreation } = require('../lib/schemas/collection');
const { validatorItemCategory } = require('../lib/schemas/itemCategory');

const COLLECTION = 'itemCategory';

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

module.exports = migrationCreation(COLLECTION, validatorItemCategory(), indexes);
