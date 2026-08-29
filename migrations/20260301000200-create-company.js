// The `company` collection — the legal entity a shop owner registers, and the thing a customer
// browses.
//
// ⚠️ **A company IS the shop.** There is no `shop` collection and there is not going to be one, so
// the catalogue chain is `shopOwner ──idShopOwner──> company ──idCompany──> item`, and everything a
// storefront renders about a shop hangs off this collection. That is why the registrar's fields
// (`legalName`, `vatNumber`, `certifiedEmail`, `registryExtract`) and the customer's fields
// (`publicName`, `slug`, `description`, `published`) sit side by side here: they describe one thing
// to two audiences.
//
// `idShopOwner` is required. A company with no owner is unreachable — every owner-facing read path
// lists by owner — and no flow anywhere creates one before the shop owner exists. The reference is
// unenforced, as every reference on this platform is; the resolvers check it.
//
// One shop owner owns N companies. That cardinality is the reason `vatNumber_unique` and
// `certifiedEmail_unique` are GLOBAL rather than scoped to an owner: one VAT number is one company,
// whoever registered it, and a company running three shops is one document, not three.
//
// `deleted` is an optional DATE, not a bool — the same spelling `shopOwner` uses, and it means the
// same thing: absent while the company is live, set to the instant of deletion afterwards. A bool
// would answer "is it gone" and nothing else; the date also answers "since when", which is the
// question an admin asks first. Every read path filters `{ $exists: false }` rather than a value,
// so the two spellings cost the same to query and only one carries the timestamp.
//
// ⚠️ Only `contactPerson` and `administrator` are encrypted, and the fourteen fields left alone are
// the point — `lib/schemas/company.js` argues it in full. A company is a matter of public record; the
// two people named inside the record are not.
//
// ⚠️ The validator is an `$and` pair, not a bare `$jsonSchema`: the second clause makes
// `published: true` without a `slug` or a `publicName` unwritable. Anything that ever `collMod`s this
// collection must restate both halves — `collMod` replaces a validator wholesale.
//
// ## The indexes
//
// `vatNumber_unique` / `certifiedEmail_unique` carry no `partialFilterExpression`, which has a
// consequence worth stating out loud: a soft-deleted company keeps its VAT number and its certified
// email occupied, so the same company cannot be registered again while the deleted document is there.
// That is the behaviour `login.email_unique` already has for a soft-deleted account, and matching it
// is deliberate — a partial index would let two companies carry one VAT number, which is exactly the
// state this collection exists to make impossible.
//
// `idShopOwner_list` is not unique: one shop owner may own several companies. It backs
// `shopOwnerCompanies`, the only owner-facing list query on the collection.
//
// `slug_unique` is **partial**, on `{ slug: { $type: 'string' } }`. `slug` is optional — a company is
// registered before it is a shop, and no slug can be derived from a registered legal name without
// inventing one — and a plain unique index treats a missing field as one null key, so the second
// slugless company would be rejected as a duplicate of the first. The partial filter leaves those
// documents out of the index entirely. `$type: 'string'` rather than `$exists: true`, because
// `$exists` also admits an explicit `null`, which would put the null keys straight back.
//
// It is globally unique, and here the scope is forced rather than chosen: the slug is the whole of
// `/shop/:slug`, so two companies sharing one would be two shops at one URL. It stays occupied while
// a company is soft-deleted, which is what a public URL wants — a link that used to be a shop should
// not silently become a different shop.
//
// `address.position_2dsphere` is what `companiesNearby` and the map run on. It builds correctly only
// because the point is stored in proper GeoJSON order, longitude first, from the very first insert: a
// `2dsphere` over `[lat, lng]` data builds without complaint and answers every query with the wrong
// shops.
//
// `published_publicName` and `published_city_publicName` serve `/shops` and `/shops/:city`.
// ⚠️ **An index serves a sort only from the keys *after* the last equality predicate**, which is what
// dictates their shape: `{ published, deleted, publicName }` walks the index in output order and stops
// after `skip + limit`, while `{ published, deleted, publicName, address.city }` would answer the
// filter and then sort in memory despite indexing all four fields. The city equality therefore goes
// **in front of** the sort key. `publicName` rather than `_id` as the order, because a listing sorted
// by insertion time has an order that means nothing to the reader.
//
// The failure mode this avoids at the top end is an **error**, not slowness: a blocking sort is capped
// at 32 MB and `allowDiskUse` is off by default on `find`, so past that the route returns
// `QueryExceededMemoryLimitNoDiskUseAllowed`.
//
// `published_list` (`{ published, deleted }`) is a strict prefix of `published_publicName` and is
// therefore redundant to the planner — every plan that can use it can use the longer one. It is
// installed anyway: `company` is written a handful of times per shop and read on every page view, so
// the spare index costs almost nothing, and the filter-only reads are then served by a two-key index
// instead of walking a three-key one. `item` makes the opposite call for the opposite reason.
//
// `search_text` is the company half of the public `search` query. Three decisions inside it, all
// deliberately identical to `item`'s so the two result sets score on comparable numbers:
//
//   - **Weights 10 / 1.** A shop *named* "Riverside Tailoring" must outrank a shop whose
//     2000-character description mentions the river in passing. Without weights both score alike and
//     the results read as random.
//   - **`default_language: 'english'`.** The language decides stemming and the stopword list, and the
//     platform's market language is English: "tailors" has to match "tailoring", and "of"/"the"/"a"
//     have to be dropped rather than indexed as searchable terms. A market choice, exactly like the
//     `en-GB` locale the frontends format dates with.
//   - **Not compound.** `{ published: 1, publicName: 'text', … }` would let the scan skip drafts
//     inside the index, but MongoDB requires an equality predicate on every non-text prefix key —
//     which forecloses every future search not scoped that way. `published`/`deleted` are applied as
//     an ordinary `$match` next to `$text` instead.
//
// ⚠️ A collection may carry **at most one text index**, so this is the only one `company` will ever
// have; a second fails with `IndexOptionsConflict`, and the fix is always to widen this key rather
// than to add a neighbour.

const { migrationCreation } = require('../lib/schemas/collection');
const { validatorCompany } = require('../lib/schemas/company');

const COLLECTION = 'company';

const indexes = [
  {
    key: {
      vatNumber: 1
    },
    options: {
      name: 'vatNumber_unique',
      unique: true
    }
  },
  {
    key: {
      certifiedEmail: 1
    },
    options: {
      name: 'certifiedEmail_unique',
      unique: true
    }
  },
  {
    key: {
      idShopOwner: 1
    },
    options: {
      name: 'idShopOwner_list'
    }
  },
  {
    key: {
      slug: 1
    },
    options: {
      name: 'slug_unique',
      unique: true,
      partialFilterExpression: {
        slug: {
          $type: 'string'
        }
      }
    }
  },
  {
    key: {
      'address.position': '2dsphere'
    },
    options: {
      name: 'address.position_2dsphere'
    }
  },
  {
    key: {
      published: 1,
      deleted: 1
    },
    options: {
      name: 'published_list'
    }
  },
  {
    key: {
      published: 1,
      deleted: 1,
      publicName: 1
    },
    options: {
      name: 'published_publicName'
    }
  },
  {
    key: {
      published: 1,
      deleted: 1,
      'address.city': 1,
      publicName: 1
    },
    options: {
      name: 'published_city_publicName'
    }
  },
  {
    key: {
      publicName: 'text',
      description: 'text'
    },
    options: {
      name: 'search_text',
      weights: {
        publicName: 10,
        description: 1
      },
      default_language: 'english'
    }
  }
];

module.exports = migrationCreation(COLLECTION, validatorCompany(), indexes);
