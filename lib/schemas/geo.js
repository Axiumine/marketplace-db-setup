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

const { encryptedField } = require('./encrypted');

/**
 * The coordinate node: tuple form, longitude then latitude.
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

/**
 * The `position` sub-document — a GeoJSON Point, spelled the same way on every collection that
 * carries one, so the three cannot disagree about the axis order.
 */
const POSITION = {
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
    coordinates: COORDINATE_TUPLE
  },
  additionalProperties: false
};

/**
 * What each address member says about itself once it is a blob.
 *
 * The two bounded ones name the rule they do not have, because that rule is the thing a reader will
 * come looking for: a five-character postal code and a two-character province are enforced by the
 * database wherever they are in the clear, and by the GraphQL input validation alone wherever they
 * are not. `position` says what it is because a ciphertext gives no clue that it decrypts to
 * `{ type, coordinates }` rather than to a string.
 */
const ENCRYPTED_ADDRESS = {
  street: 'street and number, encrypted',
  postalCode: 'postal code, encrypted — the exactly-5 rule cannot survive the ciphertext',
  city: 'city, encrypted',
  province: 'province, encrypted — the exactly-2 rule cannot survive the ciphertext',
  position: 'GeoJSON point, encrypted whole — no 2dsphere index can read it, and none exists here'
};

/**
 * The street-address block.
 *
 * Two axes vary between the three collections that carry one. `position` is required on the company
 * — the registration form geocodes before it submits, and the map is the whole reason that
 * collection carries a point — and merely allowed on the other two, where the coordinate arrives
 * only when the address is picked from the geocoder's autocomplete and an address typed by hand
 * simply has none.
 *
 * `maxLength` bounds the street, and it is read **only where the street is left in the clear**. A
 * ciphertext has no length the server can measure, so the two call sites that encrypt their street
 * pass nothing rather than passing a number the validator would drop on the floor — a bound written
 * down and enforced nowhere is worse than no bound, because it reads as a rule. `company` is the one
 * caller that passes it.
 *
 * `positionRequired` has no default and is not optional, for the same reason `indexes` has none in
 * collection.js: all three call sites pass it, so `= false` would be a branch nothing could reach —
 * untestable by construction and a permanent mutation survivor. It is also the argument that must
 * never be defaulted by accident: `positionRequired` silently false on `company` would make a shop's
 * coordinate optional.
 *
 * `encrypted` names the members stored as ciphertext — any of `street`, `postalCode`, `city`,
 * `province`, `position`. It keeps its `[]` default where `positionRequired` could not, because
 * `company` genuinely passes nothing: its address is public data and encrypting it would take the
 * map, the city listing and the text search with it. Naming a member removes that member's
 * `maxLength`, `minLength` and `pattern` along with its type, which is why the two bounded members
 * say so in their description.
 *
 * ⚠️ **A name that is not an address member at all throws**, and the throw is the point. `includes`
 * answers false for a typo exactly as it does for a member deliberately left in the clear, so
 * `'postCode'` for `'postalCode'` would build a validator that still says `string`, install without
 * complaint, and be discovered when the service writes a blob into it and the write is refused. The
 * vocabulary is five words long and every caller spells them by hand; checking them costs one pass
 * over a five-element array.
 */
function address({ maxLength, positionRequired, encrypted = [] }) {
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
    position: POSITION
  };

  return {
    bsonType: 'object',
    title: 'object',
    required: [
      'street',
      'postalCode',
      'city',
      'province',
      ...(positionRequired ? ['position'] : [])
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

// `COORDINATE_TUPLE` and `POSITION` stay module-internal on purpose. Every collection that carries a
// point carries the *same* point, and the one mistake a reader cannot see in a stored document is a
// swapped axis order — so there is one node, built here, and no call site is given the chance to
// hand `address()` a different one.
module.exports = { address };
