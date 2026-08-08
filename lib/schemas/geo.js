// The GeoJSON point and the street-address block, shared by `company`, `shopOwner` and `user` —
// the collections that store an address.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.
//
// ⚠️ **Whether an address is encrypted depends on whose address it is, not on what an address is.**
// `company.address` is the registered seat of a legal entity, published on the shop page, sorted on
// by `published_city_publicName` and queried by distance through `address.position_2dsphere` — none
// of it is encrypted and none of it can be. `shopOwner.personalData.address` and every element of
// `user.addresses` are where a person lives; those are, all but `city` on the shop owner, which the
// operator table sorts and prefix-searches. Hence the `encrypted` list rather than a flag: the same
// builder produces three different masks.
//
// ⚠️ `COORDINATE_DECIMAL` used to live at the top of this file and is gone. It was the
// pre-`20260801000000` coordinate node — one `decimal` schema for both slots, ±180 on each — and the
// rule in README.md that a builder carries every historical shape of its collection is what kept it:
// the migration that created the old shop collection restated it, and the `down` of
// `20260801000000` restored it. **Both were deleted on 2026-08-04 with the old shop collection**, so
// nothing on disk referenced the const any more. It was exported, never imported, and unreachable by
// every migration that still exists — which is exactly the shape a mutation run reports as a
// permanent survivor, because no test can distinguish a dead literal from a live one. Deleting it is
// the fix; do not restore it to "keep the history", because the history it belonged to went first.

const { encryptedField } = require('./encrypted');

/**
 * The current coordinate node: tuple form, longitude then latitude.
 *
 * `items` as an ARRAY applies one schema per position, so element 0 and element 1 are constrained
 * separately and a latitude of 120 is rejected where a longitude of 120 is not. MongoDB's
 * `$jsonSchema` supports this (verified on the server); with `maxItems: 2` there is no third element
 * for `additionalItems` to worry about.
 *
 * `['double', 'int', 'long']` rather than a bare `'double'`: `bson` encodes an integer-valued JS
 * Number inside the int32 range as **int32**, so a point at longitude exactly 9 is written `9`, not
 * `9.0`, and a `'double'`-only validator would accept 9.66721 and reject 9. Decimal128 is
 * deliberately absent — mongoose's `{ type: [Number] }` can never produce one, and after a `.lean()`
 * read `GraphQLFloat.serialize` throws on it.
 */
const COORDINATE_TUPLE = {
  bsonType: 'array',
  minItems: 2,
  maxItems: 2,
  items: [
    {
      bsonType: ['double', 'int', 'long'],
      maximum: 180,
      minimum: -180,
      description: 'longitude'
    },
    {
      bsonType: ['double', 'int', 'long'],
      maximum: 90,
      minimum: -90,
      description: 'latitude'
    }
  ]
};

/** The `position` sub-document, over whichever coordinate node the caller's point in history had. */
function position(coordinates) {
  return {
    bsonType: 'object',
    title: 'object',
    required: [
      'type',
      'coordinates'
    ],
    properties: {
      type: {
        bsonType: 'string',
        maxLength: 5,
        description: 'Point'
      },
      coordinates
    },
    additionalProperties: false
  };
}

/**
 * What each address member says about itself once it is a blob.
 *
 * The two bounded ones name the rule they lost, because that rule is the thing a reader will come
 * looking for: a five-character postal code and a two-character province were enforced by the
 * database until they were encrypted, and they are enforced by the GraphQL input validation alone
 * afterwards. `position` says what it is because a ciphertext gives no clue that it decrypts to
 * `{ type, coordinates }` rather than to a string.
 */
const ENCRYPTED_ADDRESS = {
  street: 'street and number, encrypted',
  postalCode: 'postal code, encrypted — the exactly-5 rule is gone with the plaintext',
  city: 'city, encrypted',
  province: 'province, encrypted — the exactly-2 rule is gone with the plaintext',
  position: 'GeoJSON point, encrypted whole — no 2dsphere index can read it, and none exists here'
};

/**
 * The street-address block.
 *
 * Two axes vary between the three collections that carry one. `maxLength` is 100 on a shop and on a
 * company's legal seat and 250 on an shopOwner's home address. `position` is required on the
 * first two — both are written by a form that geocodes before it submits — and merely allowed on the
 * third: every shopOwner predates the field, `collMod` does not re-validate stored documents, and
 * a coordinate cannot be derived from a stored street address without geocoding every one, so
 * requiring it there would leave the whole collection unwritable.
 *
 * Pass `position: null` for the shape that predates the point entirely.
 *
 * `positionRequired` has no default and is not optional, for the same reason `indexes` lost its `[]`
 * in collection.js: all three call sites pass it, so `= false` was a branch nothing could reach —
 * untestable by construction and a permanent mutation survivor. It is also the argument that must
 * never be defaulted by accident: `positionRequired` silently false on `company` would make a
 * shop's coordinate optional, and the map is the whole reason that collection carries one.
 *
 * `encrypted` names the members stored as ciphertext — any of `street`, `postalCode`, `city`,
 * `province`, `position`. It keeps its `[]` default where `positionRequired` could not, because
 * `company` genuinely passes nothing: its address is public data and encrypting it would take the
 * map, the city listing and the text search with it. Naming a member this address does not carry —
 * `position` on the shape that predates the point — is harmless; naming one it does removes that
 * member's `maxLength`, `minLength` and `pattern` along with its type, which is why the two bounded
 * members say so in their description.
 *
 * ⚠️ **A name that is not an address member at all throws**, and the throw is the point. `includes`
 * answers false for a typo exactly as it does for a member deliberately left in the clear, so
 * `'postCode'` for `'postalCode'` would build a validator that still says `string`, install without
 * complaint, and be discovered when the service writes a blob into it and the write is refused —
 * with the collection half converted. The vocabulary is five words long and every caller spells them
 * by hand; checking them costs one pass over a five-element array.
 */
function address({ maxLength, position = null, positionRequired, encrypted = [] }) {
  for (const member of encrypted) {
    if (!(member in ENCRYPTED_ADDRESS)) {
      throw new Error(`address(): '${member}' is not an address member — expected one of ${Object.keys(ENCRYPTED_ADDRESS).join(', ')}`);
    }
  }

  const clear = {
    street: {
      bsonType: 'string',
      maxLength
    },
    postalCode: {
      bsonType: 'string',
      minLength: 5,
      maxLength: 5
    },
    city: {
      bsonType: 'string',
      maxLength: 100
    },
    province: {
      bsonType: 'string',
      minLength: 2,
      maxLength: 2
    },
    ...(position ? { position } : {})
  };

  return {
    bsonType: 'object',
    title: 'object',
    required: [
      'street',
      'postalCode',
      'city',
      'province',
      ...(position && positionRequired ? ['position'] : [])
    ],
    properties: Object.fromEntries(
      Object.entries(clear).map(([member, shape]) => [
        member,
        encrypted.includes(member) ? encryptedField(ENCRYPTED_ADDRESS[member]) : shape
      ])
    ),
    additionalProperties: false
  };
}

module.exports = { COORDINATE_TUPLE, position, address };
