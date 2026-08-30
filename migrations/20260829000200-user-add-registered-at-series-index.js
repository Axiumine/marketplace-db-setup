// **The customers-over-time chart gets the index it needs**, and `user` reaches four indexes to
// `shopOwner`'s five. It adds one: `registeredAt_series`, `{ registeredAt: 1 }`, the exact shape and
// name `20260301000100` gave `shopOwner`.
//
// It exists because the platform owner decided on 2026-08-29 to build the customer counterparts of
// `shopOwnersStats` and `shopOwnersPerPeriod`. The decision was never blocked on anything: both numbers
// are counted off fields that were never encrypted, so ADR-029 has nothing to say about either, and the
// only thing missing was the decision and this index.
//
// A separate file rather than a line in `20260301000300-create-user.js`, for the reason
// `20260825000000` gives at length: that migration has been applied, an applied migration is
// immutable, and every database that already ran it would keep the indexes it built while the file
// claimed one more.
//
// **Why `tbl_active_registeredAt` cannot serve the chart**, restated here because the answer is the
// whole justification for a fourth index rather than a reuse of the third. `tbl_active_registeredAt`
// leads with `deleted` and `disabled`; a compound index bounds a predicate on a later key only after
// its leading keys are bound, and the chart deliberately bounds neither — it counts every customer
// ever registered so that its points sum to the same total the "Total" tile shows beside it. MongoDB
// can still walk that index end to end, but `registeredAt` is ordered only WITHIN each
// (deleted, disabled) group, so a three-month range is not one contiguous run of keys and the read
// degrades to a full index scan. A single-field index is one seek and a scan of exactly the range
// asked for.
//
// **Direction is not a decision here.** A single-field index is walked forwards or backwards at the
// same cost, and there is no sort to serve in any case: the resolver `$group`s — which has no
// ordering guarantee at all — and fills the gaps in JavaScript from a Map.
//
// **Not unique, and not partial.** Two customers may register in the same millisecond; and a partial
// filter excluding closed accounts would answer a different question from the one the chart asks,
// which is how many people ever registered. Since ADR-041 a closed account keeps its document for
// ever, so the series is stable in a way it never was under the TTL — a bucket's height does not
// change thirty days later.
//
// `down` drops the index and nothing else — the collection belongs to `20260301000300`.

const NAME = 'registeredAt_series';
const COLLECTION = 'user';

// Byte-identical to `shopOwner`'s, deliberately: the two charts are the same chart over two
// collections, and a reader comparing them should find no difference to explain.
const KEY = {
  registeredAt: 1
};

module.exports = {
  async up(db) {
    await db.collection(COLLECTION).createIndex(KEY, { name: NAME });
  },

  async down(db) {
    await db.collection(COLLECTION).dropIndex(NAME);
  }
};
