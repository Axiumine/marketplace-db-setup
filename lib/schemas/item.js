// The `item` validator — what a shop sells. The bottom of the catalogue chain
// `shopOwner ──idShopOwner──> company ──idCompany──> item`.
//
// ⚠️ **This is the extension seam the docs keep pointing at, and it is deliberately domain-neutral.**
// One collection plus a taxonomy (`itemCategory`), rather than a collection per product type: product
// types differ in their *category*, not in their shape, so a collection each would be N validators
// restating one base shape, and encoding a category as a collection name makes adding the next product
// type a migration instead of a document.
// **Nothing here may presume what is sold**, and do not add a per-type collection.
//
// ⚠️ **There is no `price`, and there never will be.** Cart, order, delivery and payment are permanently
// out of scope on this platform — ADR-038, the platform owner's decision of 2026-08-27 — so a price
// would be a guess at a currency, a precision, a VAT treatment and a discount model all at once, with
// nothing to resolve the guess against. Decimal128, the type a price wants, is a *rejected* write
// everywhere else here because it cannot survive `.lean()` into GraphQL. It does not go in later: there
// is no ordering tier to go in with, and a display-only price was offered and refused on the same day
// (ADR-009 §Note 2026-08-27).
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

/**
 * The `item` validator.
 *
 * `idCompany` and `idCategory` are both required and both unenforced by the database, so nothing
 * here stops an item pointing at a company that was never created. The resolvers check both before
 * writing, which is the same arrangement `company.idShopOwner` has and the reason `companyDel`
 * looks the company up in application code before stamping it.
 *
 * `name` is capped at 150 and `description` at 2000 — the same bound `company.description` and
 * `shopOwner.notes` carry, so the three long-text fields on the platform agree.
 *
 * `slug` is unique PER COMPANY, not globally, which is the one place this collection's URL rules
 * differ from `company`'s and `itemCategory`'s. The route is `/shop/:slug/item/:itemSlug`, so the
 * company segment already disambiguates: two shops may both sell a "blue shirt", and forcing the
 * second to be "blue-shirt-2" would put one shop's URL at the mercy of another shop's catalogue. It
 * is required, unlike `company.slug` — the collection is created empty, so nothing is stranded by
 * requiring it, and an item with no URL is an item no page can link to.
 *
 * `published` is required for the same reason and means the same thing it means on `company`: a
 * draft is invisible to every public read. The two compose — an item is publicly visible only if its
 * own `published` is true AND its company's is, which is a filter the public resolvers apply rather
 * than a rule this validator could state.
 *
 * `image` is a **file name**, never a path and never a URL, and it is optional: an item may have no
 * picture, and every item that existed before this field did has none. The bytes live on disk under
 * `STATIC_FOLDER/item/<idCompany>/`, put there by `itemAdd` through koa-utils' `moveFileStaticDomain`,
 * and the two path segments are already on the document — so storing the whole path would store the
 * same two ids twice and go stale the moment either one moves.
 *
 * ⚠️ **The name is derivable, and the field is here anyway.** `itemAdd` names the file after the
 * item's own `_id`, so `<_id>.webp` could be computed by any reader without a field at all. What a
 * computed name cannot answer is *whether there is a file*, and a catalogue card has to choose between
 * a picture and a placeholder before it can render. The alternative is a 404 per imageless item on the
 * one page that lists them all.
 *
 * The `pattern` restates that naming rule rather than trusting it: 24 lowercase hex characters, a dot
 * and a 3-4 character extension. It is what stops a traversal segment or an absolute path being
 * written into a field three frontends interpolate into a URL. The extension is left open at 3-4
 * characters instead of pinned to `webp` — `uploadTempImage` re-encodes everything to webp today, and
 * a second format later is then a resolver change rather than a rebuild of every database.
 */
function validatorItem() {
  return {
    $jsonSchema: {
      bsonType: 'object',
      title: 'item',
      required: [
        'idCompany',
        'idCategory',
        'name',
        'description',
        'slug',
        'published'
      ],
      properties: {
        _id: {
          bsonType: 'objectId'
        },
        idCompany: {
          bsonType: 'objectId',
          description: 'the company that sells this — the shop, since a company IS the shop here'
        },
        idCategory: {
          bsonType: 'objectId',
          description: 'an itemCategory row, at either of its two levels'
        },
        name: {
          bsonType: 'string',
          maxLength: 150
        },
        description: {
          bsonType: 'string',
          maxLength: 2000
        },
        slug: {
          bsonType: 'string',
          minLength: 2,
          maxLength: 160,
          pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
          description: 'URL segment of /shop/:slug/item/:itemSlug — unique within the company, not globally'
        },
        published: {
          bsonType: 'bool',
          description: 'false while a draft; a public read also requires the company to be published'
        },
        image: {
          // No `maxLength`, unlike every other string here: the pattern is anchored at both ends and
          // already fixes the length at 28-29 characters, so a bound would be a number no test could
          // ever move — an equivalent mutant, and a permanent hole in a gate that breaks at 100.
          bsonType: 'string',
          pattern: '^[a-f0-9]{24}\\.[a-z0-9]{3,4}$',
          description: 'file name of the item picture under STATIC_FOLDER/item/<idCompany>/ — absent while it has none'
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

module.exports = { validatorItem };
