// The `company` validator — the legal entity a shop owner registers, and the thing a customer
// actually browses. A company IS the shop: there is no `shop` collection and there is not going to
// be one, so every public-facing field a storefront needs lives here.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

const { encryptedField } = require('./encrypted');
const { address } = require('./geo');

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
 * `$ne` against `true` rather than `$eq` against `false`: a company that has never been put live may
 * carry no `published` at all, and a missing field must read as "not published" rather than as an
 * error.
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
 * Returns an `$and` pair, not a bare `$jsonSchema` — a collection validator is a query expression and
 * `$jsonSchema` is only one admin you may put in one. ⚠️ **A `collMod` on this collection must
 * therefore restate both clauses.** `collMod` replaces a validator wholesale, so passing the
 * `$jsonSchema` half alone silently drops the publish rule, and nothing fails until an unlinkable
 * company is put live. `user` carries the same warning for the same reason.
 *
 * The four storefront fields are what turn a legal record into a shop listing. `legalName` is the
 * registered legal name — "Northwind Trading Ltd" — and putting it on a customer-facing card is
 * wrong twice over: it is not what the shop is called, and it carries a corporate form nobody
 * searches for. `publicName` is the trading name over the door. `slug` is the URL segment
 * (`/shop/:slug`), shaped by a pattern rather than merely capped because it lands in a public route:
 * a slug carrying a slash, a space or an uppercase letter is either a different URL after
 * normalisation or a 404, and both are worse than a rejected write. `description` is the shop page's
 * body text and the target of the text index.
 *
 * Of those four only `published` is required. `publicName`, `slug` and `description` cannot be: a
 * company is registered before it is a shop, and no slug can be derived from a registered legal name
 * without inventing one. What keeps that from producing a broken storefront is the `$expr` clause
 * above, which requires them of a company that is actually live.
 *
 * ⚠️ **Encryption covers exactly two fields, and the fourteen it leaves alone are the point.**
 * `contactPerson` and `administrator` are the names of two natural persons hiding inside a legal
 * record; everything else here describes the *entity* or is published to anonymous visitors.
 * `legalName`, `vatNumber`, `taxCode` — the 11-character company form, not the 16-character personal
 * one — `uniqueCode`, `certifiedEmail` and `registryExtract` identify a company, which is a matter of
 * public record and not personal data. `publicName`, `slug`, `description` and the whole of `address`
 * are what the storefront *renders*, and they are read by `search_text`,
 * `published_city_publicName` and `address.position_2dsphere`. Encrypting any of those would be
 * encrypting data the platform hands out for free, and paying for it with the map, the city listing
 * and the search.
 */
function validatorCompany() {
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
      'published'
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
      contactPerson: encryptedField('the person to contact at this company, encrypted — a natural person inside a legal record'),
      administrator: encryptedField('the administrator of this company, encrypted — a natural person inside a legal record'),
      uniqueCode: {
        bsonType: 'string',
        minLength: 7,
        maxLength: 7
      },
      certifiedEmail: {
        bsonType: 'string',
        maxLength: 250
      },
      // The same builder `shopOwner` and `user` use — same required list, same tuple-form GeoJSON
      // point with longitude first. The three collections describe the same kind of thing and must
      // not disagree about the axis order, which is the one mistake a reader cannot see in a stored
      // document. `positionRequired: true` only here: the registration form geocodes before it
      // submits, and the map is the whole reason this collection carries a point.
      address: address({
        maxLength: 100,
        positionRequired: true
      }),
      registryExtract: {
        bsonType: 'string',
        maxLength: 1000
      },
      publicName: {
        bsonType: 'string',
        minLength: 1,
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
      },
      deleted: {
        bsonType: 'date'
      },
      __v: {
        bsonType: 'int'
      }
    },
    additionalProperties: false
  };

  return { $and: [{ $jsonSchema: schema }, PUBLISHED_IMPLIES_LINKABLE] };
}

module.exports = { validatorCompany };
