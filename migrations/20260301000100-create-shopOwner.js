// The `shopOwner` collection — the person who owns one or more companies, and the second of the
// three things you can authenticate against.
//
// The shape and every argument behind it are at the head of `lib/schemas/shopOwner.js`, including the
// one that matters most: **`personalData.firstName`, `personalData.lastName` and
// `personalData.address.city` are the only personal fields on this platform left in the clear**, and
// the four `tbl_active_*` indexes below are why. Encrypting them would not make the admin table
// slow, it would make it wrong with no error.
//
// ## The indexes
//
// `login.email_unique` comes from `lib/schemas/account.js` — one account per address, the credential
// the login form matches on, and the reason `login.email` is deterministically encrypted rather than
// randomly.
//
// The four `tbl_active_*` indexes serve `shopOwnersActiveTbl` on
// marketplace-dev-admin-authenticated-resource. That query is offset-paginated with a server-side
// sort — `(offset, limit, search, sortBy, sortDir)` in, one page plus a total out — and that is what
// makes them load-bearing rather than nice to have:
//
//   `sort` + `skip`/`limit` without a supporting index is a BLOCKING in-memory sort. MongoDB caps a
//   non-indexed sort at 32 MB and fails the whole operation with
//   `Sort exceeded memory limit of 33554432 bytes` once the filtered set passes it. The failure is
//   sudden and data-dependent: the query works in dev, works for months in production, and starts
//   erroring the day the collection crosses the threshold. Paginating without indexing therefore
//   trades an unbounded response for a latent outage rather than removing the problem.
//
// Every one of them is a COMPOUND index led by the two filter fields, in ESR order (Equality, Sort,
// Range). `disabled` and `deleted` are matched with `{ $exists: false }`, which is an equality-shaped
// predicate against the index, so they belong at the front; the sort key follows. Leading with the
// sort key instead would still sort from the index but would scan every document in the collection,
// including the soft-deleted ones the filter is there to exclude.
//
// Why one index per sort field rather than one wide index: a compound index only serves a sort whose
// keys are a PREFIX of it (after the equality fields). `(deleted, disabled, registeredAt, lastName)`
// cannot sort by `lastName` alone. The four sort options the GraphQL enum exposes are mutually
// exclusive, so they need mutually exclusive indexes. `personalData.lastName` and
// `personalData.firstName` share ONE index, in that order, because the resolver sorts by lastName
// with firstName as the tie-breaker — `(lastName, firstName)` serves both `sortBy: LAST_NAME`
// (prefix) and the compound ordering. `sortBy: FIRST_NAME` gets its own, since firstName is not a
// prefix of that pair.
//
// Every one of them ends in `_id`, and that is not padding. Offset pagination over a NON-UNIQUE sort
// key is unstable: MongoDB may return equal-keyed documents in any order, and it is free to pick a
// different one per query, so two shop owners registered in the same second (or sharing a city) can
// appear on both page 1 and page 2 while a third is never returned at all. Appending the primary key
// makes the ordering total, which makes the page boundaries deterministic. It has to be in the INDEX
// as well as in the sort, or the `_id` component alone would force the blocking sort the rest of this
// list exists to avoid.
//
// The trailing direction of each matches the resolver's DEFAULT direction for that field, and the
// opposite direction is served by the same index read backwards — a compound index satisfies both a
// sort and its complete inverse. That only holds because the resolver applies ONE direction uniformly
// to every component of the sort (including `_id`); a mixed sort such as `{ lastName: 1, _id: -1 }`
// is neither the index order nor its inverse and would go back to a blocking sort. If someone adds
// per-column sort directions later, this is the constraint that breaks first.
//
// `registeredAt_series` serves the shopOwners-over-time chart (`shopOwnersPerPeriod`, same service),
// which is the only read on this collection that filters on `registeredAt` ALONE.
// `tbl_active_registeredAt` cannot answer it: a compound index can only satisfy a predicate on
// `registeredAt` by first bounding its leading keys, and the chart deliberately does not filter on
// `deleted`/`disabled` — it counts every shop owner ever registered, so that its points sum to the
// same total the "Total" row shows. MongoDB can still scan that index end to end, but that is a full
// index scan rather than a range seek: the `registeredAt` values are ordered only WITHIN each
// (deleted, disabled) group, so the three months the chart asks for are not one contiguous run of
// keys. A single-field index is one seek plus a contiguous scan of exactly the matched range.
// Direction is irrelevant on a single-field index and there is no sort to serve anyway — `$group` has
// no ordering guarantee and the resolver fills gaps in JavaScript from a Map.
//
// ⚠️ **SEARCH IS DELIBERATELY NOT INDEXED.** The resolver's `search` argument builds a
// case-insensitive prefix regex (`/^term/i`) over firstName / lastName / city. MongoDB cannot use an
// index for a case-insensitive regex — the `i` flag disqualifies the index scan, and a
// collation-aware index does not help either, because `$regex` ignores collation. The honest options
// were: index it and have the index silently not apply, add a `text` index with different matching
// semantics than a prefix search, or denormalise a lowercased copy of every searchable field. None is
// justified here — this collection holds shop OWNERS, of which there are as many as there are shops
// on the platform, not the ~50k end customers. A collection scan bounded by the disabled/deleted
// filter is the correct cost at this cardinality, and the paging/sort path — the one that actually
// breaks at scale — is indexed. Revisit if the collection reaches six figures.

const { migrationCreation } = require('../lib/schemas/collection');
const { INDEXES_LOGIN_EMAIL } = require('../lib/schemas/account');
const { validatorShopOwner } = require('../lib/schemas/shopOwner');

const COLLECTION = 'shopOwner';

// `background` is deliberately absent throughout: it has been a no-op since MongoDB 4.2, which builds
// every index with the optimised hybrid builder regardless. Passing it would only imply a guarantee
// the server no longer reads.
const indexes = [
  ...INDEXES_LOGIN_EMAIL,
  {
    key: {
      deleted: 1,
      disabled: 1,
      registeredAt: -1,
      _id: -1
    },
    options: {
      name: 'tbl_active_registeredAt'
    }
  },
  {
    key: {
      deleted: 1,
      disabled: 1,
      'personalData.lastName': 1,
      'personalData.firstName': 1,
      _id: 1
    },
    options: {
      name: 'tbl_active_lastName_firstName'
    }
  },
  {
    key: {
      deleted: 1,
      disabled: 1,
      'personalData.firstName': 1,
      _id: 1
    },
    options: {
      name: 'tbl_active_firstName'
    }
  },
  {
    key: {
      deleted: 1,
      disabled: 1,
      'personalData.address.city': 1,
      _id: 1
    },
    options: {
      name: 'tbl_active_city'
    }
  },
  {
    key: {
      registeredAt: 1
    },
    options: {
      name: 'registeredAt_series'
    }
  }
];

module.exports = migrationCreation(COLLECTION, validatorShopOwner(), indexes);
