// The `itemCategory` validator — the platform-wide taxonomy items are filed under.
//
// **Two levels, and only an admin may write one.** A document with no `idParent` is a category;
// one whose `idParent` names a category is a subcategory; one whose `idParent` names a
// *subcategory* is the thing this collection must not contain. That last rule is the one shape this file cannot
// express — the parent's own `idParent` lives in a different document, and a MongoDB validator sees
// exactly one document at a time — so the depth cap is enforced in `itemCategoryAdd` and
// `itemCategoryUpdate` in the Admin resource service, and nowhere else. Written down here because a
// reader who finds `idParent` unconstrained will otherwise assume the depth is arbitrary.
//
// The taxonomy is platform-wide rather than per shop owner: two shops selling the same kind of thing
// have to land in the same category or the customer-facing filter means nothing. That is why writes
// are Admin-only and why there is no `idShopOwner` here.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

/**
 * The `itemCategory` validator.
 *
 * `slug` is required and globally unique — it is the whole of `/category/:slug` and of
 * `/category/:slug/:subSlug`, so uniqueness is across both levels, not within a parent. Two
 * subcategories called "drinks" under two different parents would be two URLs that cannot both
 * exist. Same lowercase pattern as `company.slug`, and for the same reason: a slug with a slash or
 * an uppercase letter is a 404 rather than a page.
 *
 * `position` is a SORT ORDINAL — an integer the admin reorders the menu with — and is **not** the
 * GeoJSON `position` that `lib/schemas/geo.js` builds for `company.address` and `user.addresses`.
 * The two share a name and nothing else; this collection stores no coordinates at all. It is
 * required because the collection is created empty, so nothing is stranded by requiring it, and
 * because the alternative is a listing whose order changes between two reads of the same data.
 *
 * `deleted` is the platform's soft-delete date, spelled the way `company` and `shopOwner` spell it.
 * A category cannot be hard-deleted: `item.idCategory` is required, so removing the document
 * outright would leave every item filed under it pointing at nothing, and nothing enforces the
 * reference. Stamping the date lets the read paths hide it while the items stay resolvable.
 */
function validatorItemCategory() {
  return {
    $jsonSchema: {
      bsonType: 'object',
      title: 'itemCategory',
      required: [
        'name',
        'slug',
        'position'
      ],
      properties: {
        _id: {
          bsonType: 'objectId'
        },
        name: {
          bsonType: 'string',
          maxLength: 100
        },
        slug: {
          bsonType: 'string',
          minLength: 2,
          maxLength: 120,
          pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
          description: 'URL segment of /category/:slug — unique across both levels'
        },
        idParent: {
          bsonType: 'objectId',
          description: 'absent = top-level category; present = subcategory. Depth beyond 2 is refused by the resolver'
        },
        position: {
          bsonType: 'int',
          minimum: 0,
          description: 'sort ordinal within the level — NOT the GeoJSON position from lib/schemas/geo.js'
        },
        deleted: {
          bsonType: 'date'
        },
        __v: {
          bsonType: 'int'
        }
      },
      additionalProperties: false
    }
  };
}

module.exports = { validatorItemCategory };
