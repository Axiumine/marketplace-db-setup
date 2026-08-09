// The shape every migration in this repo is built out of: creating a collection with its validator
// and its indexes, in one call.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here. This helper is shared by migrations
// that may already be applied, so an edit here is not a normal refactor: it changes what a migration
// means retroactively, and the applied databases will not re-run it.

const LEVEL = {
  validationLevel: 'strict',
  validationAction: 'error'
};

/**
 * The `up`/`down` pair of a `<ts>-create-<coll>.js` migration.
 *
 * `down` drops the collection outright, which takes its indexes with it — nothing else is needed,
 * because a create migration is the first thing that ever touched the collection.
 *
 * `indexes` has no default and is not optional. It used to default to `[]`, and all six call sites
 * pass it, so the default was a branch nothing could ever reach — untestable by construction, and
 * the kind of unreachable code a mutation run reports as a survivor forever. Omitting the argument
 * now throws on the `for…of` instead of silently creating an unindexed collection, which is the
 * better failure for a repo whose indexes ARE the design (see CLAUDE.md, *Indexes the public
 * surface depends on*). A collection that genuinely wants none passes `[]` and says so.
 */
function migrationCreation(collection, validator, indexes) {
  return {
    async up(db) {
      await db.createCollection(collection, { validator, ...LEVEL });
      for (const { key, options } of indexes) {
        await db.collection(collection).createIndex(key, options);
      }
    },

    async down(db) {
      await db.collection(collection).drop();
    }
  };
}

module.exports = { migrationCreation };
