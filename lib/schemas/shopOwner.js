// The `shopOwner` validator, in every shape it has had.
//
// Three migrations restate it in full — `20260301000100` creates it, `20260726000000` adds
// `emailVerify`, `20260802000300` adds the address point and the operator note — because `collMod`
// replaces a validator rather than merging into it. Each of the three passes the flags that describe
// its own point in history, and each `down` passes the flags of the state before it.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

// `EMAIL_VERIFY` was defined here while `shopOwner` was the only collection that verified an
// address. It moved to `account.js` when `user` gained the same slot; the shape is unchanged, so
// every restatement below still produces exactly what it produced before.
const { LOGIN, RESET_PWD, EMAIL_VERIFY, DELETED, DISABLED } = require('./account');
const { COORDINATE_TUPLE, position, address } = require('./geo');

/**
 * What an operator wrote *about* an account — which is why it is at the top level and not inside
 * `personalData`. `personalData` is what the shopOwner declared about themselves; nothing in the
 * ShopOwner tier ever loads this model, so the field cannot leak to the shop owner.
 */
const NOTE = {
  bsonType: 'string',
  maxLength: 2000,
  description: 'internal notes written by an admin about this shop owner, never visible to them'
};

/**
 * @param emailVerify  whether the verify-email slot exists (from `20260726000000`)
 * @param position     whether `personalData.address` carries a GeoJSON point (from `20260802000300`).
 *                     Optional where the shop's is required — see `lib/schemas/geo.js`.
 * @param notes        whether the operator's free-text note exists (same migration)
 */
function validatorShopOwner({ emailVerify = false, position: withPosition = false, notes = false } = {}) {
  return {
    $jsonSchema: {
      bsonType: 'object',
      title: 'shopOwner',
      required: [
        'login',
        'personalData',
        'registeredAt'
      ],
      properties: {
        _id: {
          bsonType: 'objectId'
        },
        login: LOGIN,
        personalData: {
          bsonType: 'object',
          title: 'object',
          required: [
            'firstName',
            'lastName',
            'birth',
            'address',
            'contacts'
          ],
          properties: {
            firstName: {
              bsonType: 'string',
              maxLength: 100
            },
            lastName: {
              bsonType: 'string',
              maxLength: 100
            },
            birth: {
              bsonType: 'object',
              title: 'object',
              required: [
                'date'
              ],
              properties: {
                date: {
                  bsonType: 'date'
                }
              },
              additionalProperties: false
            },
            address: address({
              maxLength: 250,
              position: withPosition ? position(COORDINATE_TUPLE) : null,
              positionRequired: false
            }),
            contacts: {
              bsonType: 'object',
              title: 'object',
              required: [
                'mobile',
                'email'
              ],
              properties: {
                mobile: {
                  bsonType: 'string',
                  maxLength: 12
                },
                landline: {
                  bsonType: 'string',
                  maxLength: 12
                },
                email: {
                  bsonType: 'string',
                  maxLength: 250
                }
              },
              additionalProperties: false
            }
          },
          additionalProperties: false
        },
        registeredAt: {
          bsonType: 'date',
          description: 'sign-up date'
        },
        deleted: DELETED,
        disabled: DISABLED,
        waitApprov: {
          bsonType: 'bool',
          description: 'present and true: awaiting admin approval (flagged by telepromoter) or deleted'
        },
        ...(notes ? { notes: NOTE } : {}),
        resetPwd: RESET_PWD,
        ...(emailVerify ? { emailVerify: EMAIL_VERIFY } : {}),
        __v: {
          bsonType: 'int'
        }
      },
      additionalProperties: false
    }
  };
}

module.exports = { NOTE, validatorShopOwner };
