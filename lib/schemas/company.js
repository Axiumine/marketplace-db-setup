// The `company` validator — the legal entity a shop owner registers, and, since the catalogue
// landed, the thing a customer actually browses. A company IS the shop: there is no `shop`
// collection and there is not going to be one, so every public-facing field a storefront needs
// lives here.
//
// The builder carries both states this collection has had. `validatorCompany()` with no argument
// is `20260803000000-create-company`'s shape verbatim, key order included — it was inlined in that
// migration until the catalogue work needed a second state, and moving it here changed nothing it
// produces. `{ publicFields: true }` is the shape `20260804010000-alter-company-public` installs.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

const { COORDINATE_TUPLE, position, address } = require('./geo');

/**
 * The four fields that turn a legal record into a shop listing.
 *
 * `legalName` is the registered legal name — "Northwind Trading Ltd" — and putting it on a
 * customer-facing card is wrong twice over: it is not what the shop is called, and it carries a
 * corporate form nobody searches for. `publicName` is the trading name over the door.
 *
 * `slug` is the URL segment (`/shop/:slug`). Bounded, lowercase, and shaped by a pattern rather
 * than merely capped, because it lands in a public route: a slug carrying a slash, a space or an
 * uppercase letter is either a different URL after normalisation or a 404, and both are worse than
 * a rejected write. It is optional so that `collMod` does not strand the documents written before this
 * migration — no slug can be derived from a registered legal name without inventing one — and it is
 * required *in practice* by the `$expr` rule below, which refuses to let a company be published
 * without one.
 *
 * `description` is the shop page's body text and the target of the text index. 2000 characters,
 * the same bound `shopOwner.notes` carries.
 *
 * `published` is the only one of the four in `required`, and getting it there takes three steps
 * rather than two — which is the whole reason `publishedRequired` exists as a separate flag.
 *
 * The obvious order, backfill then install, does not work: the backfill is a write, and the
 * validator it is written under is the OLD one, which is `additionalProperties: false` and has never
 * heard of `published`. Every write is rejected. The equally obvious opposite order does not work
 * either: `collMod` does not re-validate stored documents, so installing a shape that requires
 * `published` leaves every existing company valid where it sits and unwritable on its next update —
 * and that failure lands on whoever edits an unrelated field six weeks later, naming a field they
 * never touched.
 *
 * So: widen (`publishedRequired: false` — the field is allowed, nothing demands it), backfill, then
 * narrow. The middle shape exists for the length of one migration and is never the resting state of
 * any database, which is why it is a flag on this builder rather than a state of its own.
 */
const PUBLIC_FIELDS = {
  publicName: {
    bsonType: 'string',
    maxLength: 100,
    description: 'the trading name shown to customers, not the registered legal name'
  },
  slug: {
    bsonType: 'string',
    minLength: 2,
    maxLength: 120,
    pattern: '^[a-z0-9]+(?:-[a-z0-9]+)*$',
    description: 'URL segment of /shop/:slug — lowercase, digits and single hyphens'
  },
  description: {
    bsonType: 'string',
    maxLength: 2000
  },
  published: {
    bsonType: 'bool',
    description: 'false until the owner puts the shop live; nothing public reads a false row'
  }
};

/**
 * A published company must be renderable and linkable.
 *
 * `published: true` with no `slug` is a shop with no URL; with no `publicName` it is a card with no
 * heading. Both are states the storefront cannot draw, and both are cheap to make unrepresentable —
 * a collection validator takes any query expression, so this rides alongside the `$jsonSchema` under
 * `$and`, exactly as `user`'s dangling-pointer rule does.
 *
 * It deliberately says nothing about `deleted`. A soft-deleted company may stay `published: true`,
 * because `companyDel` stamps the date and nothing else, on both tiers, and demanding an unpublish
 * in the same update would break two working mutations to enforce a condition the read paths
 * already enforce: every public query filters `deleted: { $exists: false }` *and* `published: true`.
 *
 * `$ne` against `true` rather than `$eq` against `false`: `published` is absent on nothing once the
 * migration backfills it, but a `$unset` in some future `down` would make it missing, and a missing
 * field must read as "not published" rather than as an error.
 */
const PUBLISHED_IMPLIES_LINKABLE = {
  $expr: {
    $or: [
      { $ne: ['$published', true] },
      {
        $and: [
          { $eq: [{ $type: '$slug' }, 'string'] },
          { $eq: [{ $type: '$publicName' }, 'string'] }
        ]
      }
    ]
  }
};

/**
 * The `company` validator.
 *
 * Returns a bare `{ $jsonSchema }` in its original state and an `$and` pair once `publicFields` is
 * on — the same two-clause shape `user` has, and it carries the same warning: **a `collMod` on this
 * collection must restate both clauses.** `collMod` replaces a validator wholesale, so passing the
 * `$jsonSchema` half alone silently drops the publish rule and nothing fails until an unlinkable
 * company is put live.
 */
function validatorCompany({ publicFields = false, publishedRequired = publicFields } = {}) {
  const schema = {
    bsonType: 'object',
    title: 'company',
    required: [
      'idShopOwner',
      'legalName',
      'vatNumber',
      'contactPerson',
      'administrator',
      'certifiedEmail',
      'registryExtract',
      'address',
      ...(publicFields && publishedRequired ? ['published'] : [])
    ],
    properties: {
      _id: {
        bsonType: 'objectId'
      },
      idShopOwner: {
        bsonType: 'objectId'
      },
      legalName: {
        bsonType: 'string',
        maxLength: 100
      },
      vatNumber: {
        bsonType: 'string',
        maxLength: 11,
        minLength: 11
      },
      taxCode: {
        bsonType: 'string',
        maxLength: 11,
        minLength: 11
      },
      contactPerson: {
        bsonType: 'string',
        maxLength: 50
      },
      administrator: {
        bsonType: 'string',
        maxLength: 50
      },
      uniqueCode: {
        bsonType: 'string',
        minLength: 7,
        maxLength: 7
      },
      certifiedEmail: {
        bsonType: 'string',
        maxLength: 250
      },
      // The old shop collection's `address`, from the same builder — same bounds, same required list,
      // same tuple-form GeoJSON point with longitude first. The two collections describe the same kind
      // of thing and must not disagree about the axis order, which is the one mistake a reader cannot
      // see, and `20260801000000` already had to migrate out of that shape once.
      address: address({
        maxLength: 100,
        position: position(COORDINATE_TUPLE),
        positionRequired: true
      }),
      registryExtract: {
        bsonType: 'string',
        maxLength: 1000
      },
      ...(publicFields ? PUBLIC_FIELDS : {}),
      deleted: {
        bsonType: 'date'
      },
      __v: {
        bsonType: 'int'
      }
    },
    additionalProperties: false
  };

  return publicFields ? { $and: [{ $jsonSchema: schema }, PUBLISHED_IMPLIES_LINKABLE] } : { $jsonSchema: schema };
}

module.exports = { PUBLIC_FIELDS, PUBLISHED_IMPLIES_LINKABLE, validatorCompany };
