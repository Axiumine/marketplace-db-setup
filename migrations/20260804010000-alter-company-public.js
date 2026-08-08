// Turn `company` from a legal record into a shop listing: four public-facing fields, a URL index, a
// listing index and the `2dsphere` the map needs.
//
// **A company IS the shop.** There is no `shop` collection — the old shop collection was dropped on
// 2026-08-04 and is not coming back — so the catalogue chain is
// `shopOwner ──idShopOwner──> company ──idCompany──> item`. Everything a storefront renders about a
// shop therefore has to hang off this collection, and until this migration none of it did:
// `legalName`, `vatNumber`, `certifiedEmail` and `registryExtract` describe an entity to a registrar,
// not a shop to a customer.
//
// The four fields and the reasoning behind each bound are at the head of `lib/schemas/company.js`,
// alongside the `$expr` rule that makes `published: true` without a `slug` or a `publicName`
// unwritable. Two things about the shape are worth repeating here, because they are what this file
// has to get right rather than merely declare:
//
// **Adding a required field takes three steps, not two.** Backfilling first fails outright — the
// write happens under the OLD validator, which is `additionalProperties: false` and rejects
// `published` as an unknown field (`Document failed validation`, which is exactly what this
// migration did on its first run). Installing the final shape first fails later and worse:
// `collMod` does not re-validate stored documents, so every existing company stays valid where it
// sits and becomes unwritable on its next update, and the error surfaces weeks later on whoever
// edits an address. So the order is widen, backfill, narrow — `publishedRequired: false` allows the
// field without demanding it, the backfill fills it, and the second `collMod` closes it. `false` is
// the right backfill value because it is the honest answer: no company registered before the
// catalogue existed has ever been reviewed for public display.
//
// **`down` has to `$unset` all four**, for the mirror-image reason: the reverted shape is
// `additionalProperties: false`, so a document still carrying `publicName` would be unwritable under the
// restored validator. `20260802000300-alter-shopOwner-position-note` does exactly this for the same
// reason.
//
// And `down` needs the same three steps as `up`, in the same order, for the exactly symmetric
// reason: the `$unset` runs under the validator that is installed at that moment, which *requires*
// `published` — so removing it is a rejected write, and `down` fails with the same
// `Document failed validation` that a naive `up` does. Widen first (`publishedRequired: false`),
// `$unset` second, restore the original shape third. Anything that adds a required field has to
// unwind through the same intermediate state it wound up through; there is no shortcut in either
// direction.
//
// ## The indexes
//
// `slug_unique` is **partial**, on `{ slug: { $type: 'string' } }`. A plain unique index treats a
// missing field as null and stores one null key per document, so the second company without a slug — and
// every company predates this migration — would be rejected as a duplicate of the first. The
// partial filter simply leaves those documents out of the index. `$type: 'string'` rather than
// `$exists: true` because `$exists` also admits an explicit `null`, which would put the null keys
// back.
//
// It is GLOBALLY unique, not per shop owner, matching `vatNumber_unique` and `certifiedEmail_unique`
// — and here the scope is forced rather than chosen: the slug is the whole of `/shop/:slug`, so two
// companies sharing one would be two shops at one URL. It also stays occupied while a company is
// soft-deleted, exactly as the VAT number does, which means a slug is not recycled after a shop
// closes. That is the behaviour a public URL wants: a link that used to be a shop should not
// silently become a different shop.
//
// `address.position_2dsphere` is what `companiesNearby` and the map run on, and the reason it did
// not exist before is written into `20260803000000-create-company`: "nothing queries companies by
// distance". Something does now. That migration also promised this would be a one-line addition
// rather than the four-step repair `20260801000000` needed on the old shop collection, and it is — because
// the point was stored in proper GeoJSON order, longitude first, from the very first insert. A
// `2dsphere` index over `[lat, lng]` data builds without complaint and answers every query with the
// wrong shops.
//
// `published_list` is `{ published: 1, deleted: 1 }` — the two equality predicates every public read
// carries, in the order they are selective. It exists so the anonymous listing does not collection-scan
// at the traffic this platform is being built for.

const { setValidator } = require('../lib/schemas/collection');
const { validatorCompany } = require('../lib/schemas/company');

const COLLECTION = 'company';

const PUBLIC_FIELD_NAMES = ['publicName', 'slug', 'description', 'published'];

const indexes = [
  {
    key: {
      slug: 1
    },
    options: {
      name: 'slug_unique',
      unique: true,
      partialFilterExpression: {
        slug: {
          $type: 'string'
        }
      }
    }
  },
  {
    key: {
      'address.position': '2dsphere'
    },
    options: {
      name: 'address.position_2dsphere'
    }
  },
  {
    key: {
      published: 1,
      deleted: 1
    },
    options: {
      name: 'published_list'
    }
  }
];

module.exports = {
  async up(db) {
    // Widen: the four fields become legal, none of them demanded. Without this the backfill below
    // is rejected by the validator that is still installed.
    await setValidator(db, COLLECTION, validatorCompany({ publicFields: true, publishedRequired: false }));

    // Backfill. `$exists: false` rather than an unconditional `$set` so a re-run does not un-publish
    // a company an operator has since put live.
    await db.collection(COLLECTION).updateMany({ published: { $exists: false } }, { $set: { published: false } });

    // Narrow: `published` joins `required` now that every stored company carries it.
    await setValidator(db, COLLECTION, validatorCompany({ publicFields: true }));

    for (const { key, options } of indexes) {
      await db.collection(COLLECTION).createIndex(key, options);
    }
  },

  async down(db) {
    // Indexes first: `slug_unique` is partial on a field the `$unset` below is about to remove, and
    // dropping it afterwards would work but leaves a window where the index describes nothing.
    // Guarded by name, so the rollback converges from a partially applied `up`.
    for (const { options } of indexes) {
      try {
        await db.collection(COLLECTION).dropIndex(options.name);
      } catch (err) {
        if (err.codeName !== 'IndexNotFound') {
          throw err;
        }
      }
    }

    // Widen before removing: the `$unset` below strips `published`, which the currently installed
    // shape requires, and a validator does not make an exception for the update that is trying to
    // undo it. Same intermediate state `up` passes through, in the same place.
    await setValidator(db, COLLECTION, validatorCompany({ publicFields: true, publishedRequired: false }));

    const unset = Object.fromEntries(PUBLIC_FIELD_NAMES.map((field) => [field, '']));
    await db.collection(COLLECTION).updateMany({}, { $unset: unset });

    await setValidator(db, COLLECTION, validatorCompany());
  }
};
