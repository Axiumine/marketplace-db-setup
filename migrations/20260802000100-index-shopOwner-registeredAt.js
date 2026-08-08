// Index for the shopOwners-over-time chart (`shopOwnersPerPeriod` on
// marketplace-dev-admin-authenticated-resource).
//
// That query is an aggregation — `$match` on an `registeredAt` range, then `$group` by day or by
// month — and it is the only read on this collection that filters on `registeredAt` ALONE.
//
// WHY THE EXISTING tbl_active_registeredAt DOES NOT SERVE IT. That index is
// `(deleted, disabled, registeredAt, _id)`, and a compound index can only satisfy a predicate on
// `registeredAt` by first bounding its leading keys. The chart deliberately does NOT filter on
// `deleted`/`disabled` — it counts every shopOwner ever registered, so that its points sum to the
// same total the "Total" row shows — so it supplies no bound for either leading field. MongoDB can
// still scan that index end to end, but that is a full index scan, not a range seek: the `registeredAt`
// values are ordered only WITHIN each (deleted, disabled) group, so the three months the chart asks
// for are not one contiguous run of keys. A single-field index on `registeredAt` is one seek plus a
// contiguous scan of exactly the matched range.
//
// It is a plain ascending single-field index. Direction does not matter for a single-field index —
// MongoDB reads it in either order — and there is no sort to serve here anyway: `$group` has no
// ordering guarantee and the resolver sorts nothing, it fills gaps in JavaScript from a Map.
//
// NOT covering, and not meant to be. `$group` reads `registeredAt` and nothing else, so the index
// technically holds every field the pipeline touches; whether MongoDB actually elects a covered plan
// for a `$group` behind a `$match` is a planner decision that has changed between releases and is not
// something this migration should claim. The seek is the point.
//
// The unbounded range (`period: ALL`) has no `$match` at all and reads the whole collection by
// definition. Nothing indexes that away, and nothing should: it is a count of every document.
//
// A new file rather than an edit to 20260801000100-index-shopOwner-tbl.js: migrations are
// immutable and that one already has a changelog entry wherever it has run, so editing it would only
// change what a fresh database gets.
//
// `createIndex` is idempotent for an identical (key, name, options) triple, so re-running this
// against a database that already has it is a no-op rather than an error.

const COLLECTION = 'shopOwner';

// `background` is deliberately absent: it has been a no-op since MongoDB 4.2, which builds every
// index with the optimised hybrid builder regardless. Passing it would only imply a guarantee the
// server no longer reads.
const INDEX = {
  key: {
    registeredAt: 1,
  },
  options: {
    name: 'registeredAt_series',
  },
};

module.exports = {
  async up(db) {
    await db.collection(COLLECTION).createIndex(INDEX.key, INDEX.options);
  },

  // Drops by NAME, not by key pattern, and guards IndexNotFound — same reasoning as the tbl indexes
  // migration: dropping by pattern would also match a hand-created index with the same keys, and an
  // unguarded drop would make `down` fail on a database where `up` never ran.
  async down(db) {
    try {
      await db.collection(COLLECTION).dropIndex(INDEX.options.name);
    } catch (err) {
      if (err.codeName !== 'IndexNotFound') {
        throw err;
      }
    }
  },
};
