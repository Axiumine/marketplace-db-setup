// The three indexes the anonymous, SEO-indexed shop pages read through, none of which existed.
//
// `20260804010000-alter-company-public` gave `company` its storefront fields and two indexes:
// `slug_unique` for `/shop/:slug` and `published_list` (`{ published: 1, deleted: 1 }`) so the public
// listing "does not collection-scan at the traffic this platform is being built for". That claim was
// half true. The listing's *filter* is covered; its **sort** is not, and a sort MongoDB cannot serve
// from an index is a blocking SORT stage over every matching document. At half a million published
// companies `/shops` — the most requested route on the site — fetches all of them per request to
// return 24.
//
// Index-only, so `lib/schemas/` is untouched and the "rebuild every database that has run these
// migrations" rule attached to that directory does not fire. `migrate:up` is enough.
//
// ## The indexes
//
// `search_text` — the company half of the public `search` query. `item` got one in
// `20260804030000-create-item` and `company` got nothing, so a customer typing "riverside tailoring" could
// be answered with item names and not with shop names; the only alternative was a `$regex` over
// every published company, which is the scan this file exists to remove. Three decisions inside it,
// all deliberately identical to item's so the two result sets score on comparable numbers:
//
//   - **Weights 10 / 1.** A shop *named* "Riverside Tailoring" must outrank a shop whose
//     2000-character description mentions the river in passing.
//   - **`default_language: 'english'`.** The stemmer and stop-word list have to match the market
//     language or "tailors" does not match "tailoring" and "of"/"the"/"a" are indexed as content. A
//     market choice, exactly like the `en-GB` locale the operator SPA formats dates with.
//   - **Not compound.** `{ published: 1, publicName: 'text', … }` would let the scan skip drafts
//     inside the index, but MongoDB requires an equality predicate on every non-text prefix key —
//     which forecloses every future search not scoped that way. `published`/`deleted` are applied as
//     an ordinary `$match` next to `$text` instead.
//
// ⚠️ A collection may carry **at most one text index**. `company` has none today so this installs
// cleanly; a second one added later fails with `IndexOptionsConflict`, and the fix is always to
// widen this key rather than to add a neighbour.
//
// `published_publicName` — `/shops`, unfiltered. `{ published: 1, deleted: 1, publicName: 1 }`:
// equality, equality, then the sort key. That trailing key is the whole point — with it the server
// walks the index in output order and stops after `skip + limit` entries; without it, it fetches
// every match and sorts them. `publicName` rather than `_id` as the order because a listing sorted
// by insertion time is a listing whose order is meaningless to the reader, and because `_id` cannot
// be appended to a compound index as a sort key the planner will use here anyway.
//
// `published_city_publicName` — `/shops/:city`. Same shape with the city equality slotted in front
// of the sort key, which is the only position that works: an index serves a sort only from the keys
// **after** the last equality predicate, so `{ published, deleted, publicName, address.city }` would
// answer the filter and then sort in memory regardless of being an index on all four fields.
//
// ## What is deliberately NOT done here
//
// `published_list` is now a strict prefix of `published_publicName` and is therefore redundant: any
// plan that can use it can use the longer one. It is left installed. Dropping it is a legal forward
// migration — nothing here would be editing an applied file — but the win is one index's worth of
// write amplification on a collection written a handful of times per shop and read on every page
// view, against a rollback path that has to recreate it exactly. Not worth the surface today.
// Recorded here rather than left for someone to rediscover.

const COLLECTION = 'company';

const indexes = [
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
  }
];

module.exports = {
  async up(db) {
    for (const { key, options } of indexes) {
      await db.collection(COLLECTION).createIndex(key, options);
    }
  },

  async down(db) {
    // Guarded by name so the rollback converges from a partially applied `up`, the same way
    // 20260804010000's does.
    for (const { options } of indexes) {
      try {
        await db.collection(COLLECTION).dropIndex(options.name);
      } catch (err) {
        if (err.codeName !== 'IndexNotFound') {
          throw err;
        }
      }
    }
  }
};
