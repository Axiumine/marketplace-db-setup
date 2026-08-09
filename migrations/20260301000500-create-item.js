// The `item` collection — what a shop sells. One shape plus a taxonomy, for every kind of product
// the platform will ever carry (ADR-008).
//
// The field shapes and the arguments behind them are at the head of `lib/schemas/item.js`, including
// the two that will surprise a reader: **there is no `price`** — cart, order, delivery and payment
// have no model anywhere on this platform, so a price would be a guess at a currency, a precision, a
// VAT treatment and a discount model at once — and `slug` is unique **per company** rather than
// globally. Both references (`idCompany`, `idCategory`) are unenforced, as `company.idShopOwner` is;
// the resolvers check them.
//
// ## The indexes
//
// Five, and the shape of the read each serves is the only reason it exists.
//
// `idCompany_list` — the shop owner's own catalogue screen: every live item of one company. Equality
// on `idCompany`, then `deleted` to drop the stamped ones. `companyItems` on both authenticated tiers
// runs on exactly this key order.
//
// `idCompany_slug_unique` — enforces the per-company slug rule AND answers
// `/shop/:slug/item/:itemSlug`, which resolves the company first and then looks the item up by this
// exact pair. One index doing both jobs is not a coincidence: a uniqueness constraint is a lookup
// index that also refuses the second one.
//
// `idCompany_published_name` — the public shop page. It is not made redundant by `idCompany_list`:
// that one has `deleted` in second position, so a query filtering on `published` would have to fetch
// and discard every draft the shop has.
//
// `idCategory_published_name` — `/category/:slug`, the customer-facing filter, which is the entire
// reason `itemCategory` exists. Without it that route collection-scans, and it is the route with the
// broadest fan-out on the platform: one category spans every shop. `funItemCategoryDelete` in the
// Admin tier filters `{ idCategory, deleted }` with no sort and is served by the `idCategory` prefix.
//
// ⚠️ **Both listing indexes end in `name`, and that trailing key is load-bearing.** An index serves a
// sort only from the keys **after** the last equality predicate, and both listings sort by `name`, so
// a three-key `{ idCategory, published, deleted }` would answer the *filter* and then hand every match
// to a blocking in-memory SORT stage. Measured on 100 000 items in one category, on this machine:
//
//   { idCategory, published, deleted }         SORT=blocking  keysExamined=100000  docsExamined=100000  170 ms
//   { idCategory, published, deleted, name }   SORT=none      keysExamined=24      docsExamined=24        3 ms
//
// The 24 items returned are the same 24 either way — this is purely how they are found. And the
// failure mode at the top end is an **error**, not slowness: a blocking sort is capped at 32 MB and
// `allowDiskUse` is off by default on `find`, so a popular category on a platform sized for half a
// million customers starts returning `QueryExceededMemoryLimitNoDiskUseAllowed`.
//
// ⚠️ The three-key prefixes are **not** installed alongside them. Every plan that could use the short
// index can use the long one — an index is usable from any leading subset of its keys — and `item` is
// the write-heavy collection of the three: a shop owner edits a catalogue continuously, where a
// registration happens once. This is the opposite call from `company.published_list`, deliberately so
// rather than inconsistently, and the write volume is the whole difference.
//
// `search_text` — the item half of the public `search` query. Three decisions inside it, identical to
// `company.search_text` so the two result sets score on comparable numbers:
//
//   - **Not compound.** `{ idCompany: 1, name: 'text', … }` would let a search be scoped to one shop,
//     but MongoDB requires an equality predicate on every non-text prefix key, so a platform-wide
//     search — the one the customer app actually runs — could not use the index at all. Global search
//     is the requirement; per-shop search is a filter applied after it.
//   - **`weights: { name: 10, description: 1 }`.** A term in the item's name is what the customer
//     typed; the same term buried in a paragraph usually is not. Without weights both score alike and
//     the results read as random.
//   - **`default_language: 'english'`.** The language decides stemming and the stopword list, and the
//     platform's market language is English: "shoes" has to match "shoe", and "the"/"a"/"of" have to
//     be dropped rather than indexed as searchable terms.
//
// A `2dsphere` is deliberately absent: an item has no coordinates of its own. "Items near me" is
// answered by finding companies near a point through `company.address.position_2dsphere` and then
// reading their items, which is correct as well as cheaper — an item is at its shop, and storing a
// copy of the shop's point on every item would be a denormalisation that goes stale on the first
// address change.

const { migrationCreation } = require('../lib/schemas/collection');
const { validatorItem } = require('../lib/schemas/item');

const COLLECTION = 'item';

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
      deleted: 1,
      name: 1
    },
    options: {
      name: 'idCompany_published_name'
    }
  },
  {
    key: {
      idCategory: 1,
      published: 1,
      deleted: 1,
      name: 1
    },
    options: {
      name: 'idCategory_published_name'
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

module.exports = migrationCreation(COLLECTION, validatorItem(), indexes);
