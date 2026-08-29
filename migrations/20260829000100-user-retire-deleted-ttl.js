// **Retires `deleted_ttl`, and with it the last TTL index on the platform.** After this runs, nothing
// anywhere deletes a document on a clock.
//
// **What the index did.** `20260301000300` built it over `user.deleted` with `expireAfterSeconds` set to
// thirty days, and it was what made `userDel` an erasure rather than a flag: `funUserDel` stamps
// `deleted` and stops there, so the document, its `personalData` and its `addresses` all stayed on disk
// and MongoDB's TTL monitor removed the record about a minute after the thirty days were up. The stamp
// was the decision to erase; this index was the erasure.
//
// **Why it goes.** The platform owner reversed the outcome on 2026-08-29 (ADR-041): thirty days after a
// closure the account's personal data is overwritten with placeholders, and the document itself is kept
// **for ever** as the record that a person held an account. A TTL index cannot express that. It has one
// outcome — remove the whole document — and `collMod` can retune `expireAfterSeconds` on a live TTL
// index but has no way at all to strip the TTL-ness off it. Retiring it therefore takes a `dropIndex`,
// which takes a migration, which is this file.
//
// ⚠️ **The two halves must ship together and this one must not ship alone.** Without the sweep that
// replaces it, a closed account is never scrubbed and its `login.email` sits behind
// `login.email_unique` for ever; with the sweep but without this drop, the sweep races a TTL monitor
// that deletes the very documents it is overwriting. Neither half is a smaller version of the feature —
// each is a different bug.
//
// ⚠️ **This runs unconditionally, and `deleted_ttl` is therefore still created by `20260301000300` on a
// fresh replay** — `INDEXES_USER` in `lib/schemas/user.js` still lists it, with the note saying why. A
// database built from empty creates the index and drops it again seconds later, which is the honest
// record of what happened: the index existed, and then it was retired. Editing it out of the create
// migration's list instead would rewrite what an applied migration built and would buy a `dropIndex`
// guarded by "if it is there" — a branch no replay of this repo can execute.
//
// `down` puts the index back exactly as `20260301000300` built it, reading the same
// `CLOSED_ACCOUNT_RETENTION_SECONDS` rather than a copy of the number, so a rollback cannot restore a
// retention period nothing else agrees with. It restores hard deletion along with it: that is what
// rolling back this migration means.

const { CLOSED_ACCOUNT_RETENTION_SECONDS } = require('../lib/schemas/user');

const NAME = 'deleted_ttl';
const COLLECTION = 'user';

const KEY = {
  deleted: 1
};

module.exports = {
  async up(db) {
    await db.collection(COLLECTION).dropIndex(NAME);
  },

  async down(db) {
    await db.collection(COLLECTION).createIndex(KEY, { name: NAME, expireAfterSeconds: CLOSED_ACCOUNT_RETENTION_SECONDS });
  }
};
