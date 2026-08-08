// The item listings sort by `name`, and neither index `20260804030000-create-item` installed carries
// it. Measured, not reasoned about, against 100 000 items in one category on this machine:
//
//   idCategory_published            SORT=blocking   keysExamined=100000  docsExamined=100000  170 ms
//   idCategory_published_name       SORT=none       keysExamined=24      docsExamined=24        3 ms
//
// The 24 items returned are the same 24 either way — this is purely how they are found. An index
// serves a sort only from the keys **after** the last equality predicate, so `{ idCategory, published,
// deleted }` answers the *filter* and then hands every match to an in-memory SORT stage; appending
// `name` lets the server walk the index in output order and stop at `skip + limit`.
//
// ⚠️ **The failure mode at the top end is not slowness, it is an error.** A blocking sort is capped at
// 32 MB and `allowDiskUse` is off by default on `find`, so a popular category on a platform sized for
// half a million customers stops returning `QueryExceededMemoryLimitNoDiskUseAllowed` instead of
// returning late. That is the whole reason this is a migration and not a note.
//
// ## Why the two short indexes are dropped rather than left alongside
//
// Both are **exact prefixes** of their replacements, so every plan that could use the short one can
// use the long one — an index is usable from any leading subset of its keys. Their three consumers
// were checked before dropping, not assumed:
//
//   - `items` / `itemsOfShop` (public, 4027)          `{ idCompany, published, deleted }` + sort
//   - `items` / `itemsOfCategory` (public, 4027)      `{ idCategory, published, deleted }` + sort
//   - `funItemCategoryDelete` (Admin, 4024)           `{ idCategory, deleted }`, no sort — served by
//                                                      the `idCategory` prefix before and after
//
// `companyItems` on both authenticated tiers filters `{ idCompany, deleted }` and is served by
// `idCompany_list`, which is a different key order and is not touched here.
//
// This is the opposite call from the one `20260804040000-index-company-public-read` made about
// `published_list`, and deliberately so rather than inconsistently: there the redundant prefix was
// left installed because `company` is written a handful of times per shop, so a spare index costs
// almost nothing. `item` is the write-heavy collection of the three — a shop owner edits a catalogue,
// not a registration — and here the replacement is created in the same migration, so the drop needs
// no separate audit later.
//
// Index-only: `lib/schemas/` is untouched, so the "rebuild every database that has run these
// migrations" rule attached to that directory does not fire. `migrate:up` is enough.

const COLLECTION = 'item';

// Created by `up`, dropped by `down`.
const added = [
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
  }
];

// Dropped by `up`, recreated by `down` — the exact shapes `20260804030000-create-item` installed, so
// the rollback lands on the state that migration left behind rather than on an approximation of it.
const superseded = [
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
  }
];

// `dropIndex` throws `IndexNotFound` rather than no-opping, so both directions guard by name and
// converge from a partially applied run — the same shape `20260804010000` and `20260804040000` use.
async function dropByName(db, name) {
  try {
    await db.collection(COLLECTION).dropIndex(name);
  } catch (err) {
    if (err.codeName !== 'IndexNotFound') {
      throw err;
    }
  }
}

module.exports = {
  async up(db) {
    // Create before dropping: for the moments in between, every read is still served by an index.
    for (const { key, options } of added) {
      await db.collection(COLLECTION).createIndex(key, options);
    }

    for (const { options } of superseded) {
      await dropByName(db, options.name);
    }
  },

  async down(db) {
    for (const { key, options } of superseded) {
      await db.collection(COLLECTION).createIndex(key, options);
    }

    for (const { options } of added) {
      await dropByName(db, options.name);
    }
  }
};
