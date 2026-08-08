// Initial schema migration for the `item` collection — what a shop sells, and the collection that
// replaces all 13 dropped product types with one shape plus a taxonomy.
//
// The field shapes and the arguments behind them are at the head of `lib/schemas/item.js`, including
// the two that will surprise a reader: there is no `price` (ordering has no model yet, and a price
// with nothing to buy is a guess), and `slug` is unique per company rather than globally.
//
// ## The indexes
//
// Five, and the shape of the read they serve is the only reason each exists.
//
// `idCompany_list` — the shop owner's own catalogue screen: every live item of one company. Equality
// on `idCompany`, then `deleted` to drop the stamped items.
//
// `idCompany_slug_unique` — enforces the per-company slug rule AND answers
// `/shop/:slug/item/:itemSlug`, which resolves the company first and then looks the item up by this
// exact pair. One index doing both jobs is not a coincidence: a uniqueness constraint is a lookup
// index that also refuses the second one.
//
// `idCompany_published` — the public shop page. `{ idCompany, published, deleted }` in that order:
// equality, equality, equality, most selective first. It is not made redundant by
// `idCompany_list` — that one has `deleted` in second position, so a query filtering on `published`
// would have to fetch and discard every draft the shop has.
//
// `idCategory_published` — `/category/:slug`, the customer-facing filter, which is the entire reason
// `itemCategory` exists. Without it that route collection-scans, and it is the route with the
// broadest fan-out on the platform: one category spans every shop.
//
// `search_text` — the text index behind the `search` query. Three decisions inside it:
//
// - **Not compound.** `{ idCompany: 1, name: 'text', … }` would let a search be scoped to one shop,
//   but MongoDB requires an equality predicate on every non-text prefix key, so a platform-wide
//   search — the one the customer app actually runs — could not use the index at all. Global search
//   is the requirement; per-shop search is a filter applied after it.
// - **`weights: { name: 10, description: 1 }`.** A term in the item's name is what the customer
//   typed; the same term buried in a paragraph usually is not. Without weights both score alike and
//   the results read as random.
// - **`default_language: 'english'`.** The language decides stemming and the stopword list, and the
//   platform's market language is English: "shoes" has to match "shoe", and "the"/"a"/"of" have to be
//   dropped rather than indexed as searchable terms.
//
// A `2dsphere` is deliberately absent: an item has no coordinates of its own. "Items near me" is
// answered by finding companies near a point through `company.address.position_2dsphere` and then
// reading their items, which is correct as well as cheaper — an item is at its shop, and storing a
// copy of the shop's point on every item would be a denormalisation that goes stale on the first
// address change.

const { migrationCreation } = require('../lib/schemas/collection');
const { validatorItem } = require('../lib/schemas/item');

const COLLECTION = 'item';

const validator = validatorItem();

const indexes = [
  {
    key: {
      idCompany: 1,
      deleted: 1
    },
    options: {
      name: 'idCompany_list'
    }
  },
  {
    key: {
      idCompany: 1,
      slug: 1
    },
    options: {
      name: 'idCompany_slug_unique',
      unique: true
    }
  },
  {
    key: {
      idCompany: 1,
      published: 1,
      deleted: 1
    },
    options: {
      name: 'idCompany_published'
    }
  },
  {
    key: {
      idCategory: 1,
      published: 1,
      deleted: 1
    },
    options: {
      name: 'idCategory_published'
    }
  },
  {
    key: {
      name: 'text',
      description: 'text'
    },
    options: {
      name: 'search_text',
      weights: {
        name: 10,
        description: 1
      },
      default_language: 'english'
    }
  }
];

module.exports = migrationCreation(COLLECTION, validator, indexes);
