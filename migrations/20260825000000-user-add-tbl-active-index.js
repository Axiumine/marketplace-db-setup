// **The first migration in this repo that alters a collection instead of creating one**, and the
// header of `test/migrations.test.mjs` used to say none did. It adds one index to `user`:
// `tbl_active_registeredAt`, the only index the operator's customers table (E19-S02,
// `usersActiveTbl`) can page on.
//
// It is a separate file rather than a fifth line in `20260301000300-create-user.js` because that
// migration has been applied and an applied migration is immutable — editing it changes what a
// changelog entry means retroactively, and every database that has already run it would keep the
// single index while the file claimed two.
//
// **Why `user` had one index and `shopOwner` has five.** The create migration says it outright:
// nothing sorted, searched or paginated customers, so the collection was free to encrypt every
// personal field it has. That is still true of the personal fields and is not being reopened — see
// ADR-029 and `docs/devprotocol/phase3/adr/ADR-INDEX.md` §4, which refuses making a name or a city
// queryable "so the table can search them". What changed is narrower: an operator now needs to *list*
// customers and disable one, and listing needs an ordering that survives paging.
//
// **`registeredAt` is the sort key because it is the only clear field worth sorting on.**
// `login.email` is deterministic ciphertext — equality only, and its byte order is not alphabetical
// order — so an index on it would page the table in an order no operator can predict. `firstName`,
// `lastName` and every address member are random ciphertext and preserve nothing at all.
//
// **ESR order, and `_id` as the tiebreak.** Equality first (`deleted`, `disabled`), then the sort
// (`registeredAt`), then a unique tail. Without the tail two customers registered in the same
// millisecond have no defined order between pages, so one can be shown twice and another skipped —
// the failure that looks like data loss and is really an unstable sort. `-1` on both sort keys
// because the table opens newest-first; a compound index walks forwards or backwards as a whole, so
// `{registeredAt: -1, _id: -1}` serves ASC by scanning the other way and no second index is needed.
//
// **`emailVerify.valid` is a filter the table offers and is deliberately NOT in this index.** It is a
// third equality field, and adding it would make the index serve a filter combination the operator
// reaches occasionally at the cost of one more key in every entry of the one they reach always. An
// unconfirmed-only view is a bounded scan behind the two leading keys, which is the right cost.
//
// `down` drops the index and nothing else — the collection is `20260301000300`'s to remove.

const NAME = 'tbl_active_registeredAt';
const COLLECTION = 'user';

// Same shape and same name as `shopOwner`'s: the two operator tables page identically, and a reader
// comparing them should find one difference, not two.
const KEY = {
  deleted: 1,
  disabled: 1,
  registeredAt: -1,
  _id: -1
};

module.exports = {
  async up(db) {
    await db.collection(COLLECTION).createIndex(KEY, { name: NAME });
  },

  async down(db) {
    await db.collection(COLLECTION).dropIndex(NAME);
  }
};
