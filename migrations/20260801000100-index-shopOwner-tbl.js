// Indexes for the paginated operator table (`shopOwnersActiveTbl` on
// marketplace-dev-admin-authenticated-resource).
//
// That query is offset-paginated with a server-side sort — `(offset, limit, search, sortBy, sortDir)`
// in, one page plus a total out — and that is what makes these indexes load-bearing rather than nice
// to have:
//
//   `sort` + `skip`/`limit` without a supporting index is a BLOCKING in-memory sort. MongoDB caps
//   a non-indexed sort at 32MB and fails the whole operation with
//   `Sort exceeded memory limit of 33554432 bytes` once the filtered set passes it. The failure is
//   sudden and data-dependent: the query works in dev, works for months in production, and starts
//   erroring the day the collection crosses the threshold. Paginating without indexing therefore
//   trades an unbounded response for a latent outage rather than removing the problem.
//
// Every index below is a COMPOUND index led by the two filter fields, in the ESM rule order
// (Equality, Sort, Range). `disabled` and `deleted` are matched with `{ $exists: false }`, which is
// an equality-shaped predicate against the index, so they belong at the front; the sort key
// follows. Leading with the sort key instead would still sort from the index but would scan every
// document in the collection, including the soft-deleted ones the filter is there to exclude.
//
// Why one index per sort field rather than one wide index: a compound index only serves a sort
// whose keys are a PREFIX of it (after the equality fields). `(deleted, disabled, registeredAt,
// lastName)` cannot sort by lastName alone. The four sort options the GraphQL enum exposes are
// mutually exclusive, so they need mutually exclusive indexes.
//
// `personalData.lastName` and `personalData.firstName` share ONE index, in that order, because the resolver
// sorts by lastName with firstName as the tie-breaker — `(lastName, firstName)` serves both `sortBy: LAST_NAME`
// (prefix) and the compound ordering. `sortBy: FIRST_NAME` gets its own index, since firstName is not a
// prefix of that pair.
//
// Every index ends in `_id`, and that is not padding. Offset pagination over a NON-UNIQUE sort key
// is unstable: MongoDB may return equal-keyed documents in any order, and it is free to pick a
// different one per query, so two shopOwners registered in the same second (or sharing a city)
// can appear on both page 1 and page 2, while a third is never returned at all. Appending the
// primary key makes the ordering total, which makes the page boundaries deterministic. It has to be
// in the INDEX as well as in the sort, or the `_id` component alone would force the blocking
// in-memory sort the rest of this migration exists to avoid.
//
// The trailing direction of each index matches the resolver's DEFAULT direction for that field, and
// the opposite direction is served by the same index read backwards — a compound index satisfies
// both a sort and its complete inverse. That only holds because the resolver applies ONE direction
// uniformly to every component of the sort (including `_id`); a mixed sort such as
// `{ lastName: 1, _id: -1 }` is neither the index order nor its inverse and would go back to a
// blocking sort. If someone adds per-column sort directions later, this is the constraint that
// breaks first.
//
// SEARCH IS DELIBERATELY NOT INDEXED. The resolver's `search` argument builds a case-insensitive
// prefix regex (`/^term/i`) over firstName / lastName / city. MongoDB cannot use an index for a
// case-insensitive regex — the `i` flag disqualifies the index scan, and a collation-aware index
// does not help either, because `$regex` ignores collation (it is one of the documented operators
// that always uses simple binary comparison). The honest options were: index it and have the index
// silently not apply, add a `text` index with different matching semantics than a prefix search, or
// denormalise a lowercased copy of every searchable field. None is justified here — `shopOwner`
// holds shop OWNERS, of which there are as many as there are shops on the platform, not the ~50k
// end customers (who have no collection at all yet). A collection scan bounded by the
// disabled/deleted filter is the correct cost at this cardinality, and the paging/sort path — the
// one that actually breaks at scale — is indexed. Revisit if the collection reaches six figures.
//
// A new file rather than an edit to 20260301000100-create-shopOwner.js: migrations are immutable
// and that one already has a changelog entry wherever it has run, so editing it would only change
// what a fresh database gets.
//
// `createIndex` is idempotent for an identical (key, name, options) triple, so re-running this
// against a database that already has them is a no-op rather than an error.

const COLLECTION = 'shopOwner';

// `background` is deliberately absent: it has been a no-op since MongoDB 4.2, which builds every
// index with the optimised hybrid builder regardless. Passing it would only imply a guarantee the
// server no longer reads.
const indexes = [
  {
    key: {
      deleted: 1,
      disabled: 1,
      registeredAt: -1,
      _id: -1,
    },
    options: {
      name: 'tbl_active_registeredAt',
    },
  },
  {
    key: {
      deleted: 1,
      disabled: 1,
      'personalData.lastName': 1,
      'personalData.firstName': 1,
      _id: 1,
    },
    options: {
      name: 'tbl_active_lastName_firstName',
    },
  },
  {
    key: {
      deleted: 1,
      disabled: 1,
      'personalData.firstName': 1,
      _id: 1,
    },
    options: {
      name: 'tbl_active_firstName',
    },
  },
  {
    key: {
      deleted: 1,
      disabled: 1,
      'personalData.address.city': 1,
      _id: 1,
    },
    options: {
      name: 'tbl_active_city',
    },
  },
];

module.exports = {
  async up(db) {
    for (const { key, options } of indexes) {
      await db.collection(COLLECTION).createIndex(key, options);
    }
  },

  // Drops by NAME, not by key pattern. Dropping by pattern would also match an index someone
  // created by hand with the same keys and a different name, and — more importantly — `dropIndex`
  // throws `IndexNotFound` if the index is absent, which would make `down` fail on a database where
  // `up` only partially applied. Each drop is guarded so the rollback converges from any state.
  async down(db) {
    for (const { options } of indexes) {
      try {
        await db.collection(COLLECTION).dropIndex(options.name);
      } catch (err) {
        if (err.codeName !== 'IndexNotFound') {
          throw err;
        }
      }
    }
  },
};
