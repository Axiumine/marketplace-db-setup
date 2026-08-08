// The GeoJSON point and the street-address block, shared by `company`, `shopOwner` and `user` —
// the collections that store an address.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.
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
 */
function address({ maxLength, position = null, positionRequired }) {
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
    properties: {
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
    },
    additionalProperties: false
  };
}

module.exports = { COORDINATE_TUPLE, position, address };
