// The `shopOwner` validator, in every shape it has had.
//
// Four migrations restate it in full — `20260301000100` creates it, `20260726000000` adds
// `emailVerify`, `20260802000300` adds the address point and the operator note, `20260808000100`
// encrypts the personal fields — because `collMod` replaces a validator rather than merging into it.
// Each of the four passes the flags that describe its own point in history, and each `down` passes
// the flags of the state before it.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

// `EMAIL_VERIFY` was defined here while `shopOwner` was the only collection that verified an
// address. It moved to `account.js` when `user` gained the same slot and became `emailVerify()` when
// that slot gained an encrypted state; the unflagged shape is unchanged, so every restatement below
// still produces exactly what it produced before.
const { login, RESET_PWD, emailVerify, DELETED, DISABLED } = require('./account');
const { encryptedField } = require('./encrypted');
const { COORDINATE_TUPLE, position, address } = require('./geo');

/**
 * What an operator wrote *about* an account — which is why it is at the top level and not inside
 * `personalData`. `personalData` is what the shopOwner declared about themselves; nothing in the
 * ShopOwner tier ever loads this model, so the field cannot leak to the shop owner.
 *
 * It is encrypted from `20260808000100`, and it is the one encrypted field on the platform whose
 * subject never gets to read it. Free text an operator wrote about a named person is personal data
 * about that person whatever it says, and it is the field most likely to say something the person
 * would object to.
 *
 * @param encrypted  whether the note is stored as ciphertext; a plain boolean with no default,
 *                   because the only caller is the builder below and it always holds the flag
 */
function note(encrypted) {
  return encrypted
    ? encryptedField('internal notes written by an admin about this shop owner, encrypted, never visible to them')
    : {
        bsonType: 'string',
        maxLength: 2000,
        description: 'internal notes written by an admin about this shop owner, never visible to them'
      };
}

/**
 * ⚠️ **`personalData.firstName`, `personalData.lastName` and `personalData.address.city` stay in the
 * clear, and they are the one deliberate hole in this collection's protection.**
 *
 * All three are personal data and belong in the encrypted set on every ground except one:
 * `shopOwnersActiveTbl` in the Admin tier sorts on them through `tbl_active_lastName_firstName`,
 * `tbl_active_firstName` and `tbl_active_city`, and prefix-searches them with `/^term/i`. Neither
 * CSFLE algorithm survives that. Random ciphertext supports no comparison at all; deterministic
 * supports equality and nothing else, so it answers neither a sort nor a prefix match either.
 * Encrypting them would not make the operator table slower — it would make it *wrong*, silently: the
 * table would keep rendering, ordered by ciphertext, and every search box would return nothing.
 *
 * The same three fields on `admin` and on `user` ARE encrypted, because no table sorts those. ADR-029
 * records the trade and what would have to change to close it — dropping those three indexes and
 * paging the table another way. Adding these fields to the encrypted set without doing that in the
 * same change is the mistake this note exists to prevent.
 *
 * The four flags, written as prose rather than as `@param` tags because two of them are renamed on
 * the way in — `emailVerify` and `position` are already taken in this module by the imports from
 * `account.js` and `geo.js` — and a tag naming the property while the signature names the local is a
 * mismatch every JSDoc checker reports:
 *
 * - `emailVerify` — whether the verify-email slot exists (from `20260726000000`).
 * - `position` — whether `personalData.address` carries a GeoJSON point (from `20260802000300`).
 *   Optional here where the shop's is required; see `lib/schemas/geo.js`.
 * - `notes` — whether the operator's free-text note exists (same migration).
 * - `encrypted` — whether the personal fields are stored as ciphertext (from `20260808000100`).
 */
function validatorShopOwner({
  emailVerify: withEmailVerify = false,
  position: withPosition = false,
  notes = false,
  encrypted = false
} = {}) {
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
        login: login(encrypted),
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
                date: encrypted
                  ? encryptedField('date of birth, encrypted — no range query and no sort can reach it')
                  : {
                      bsonType: 'date'
                    }
              },
              additionalProperties: false
            },
            address: address({
              maxLength: 250,
              position: withPosition ? position(COORDINATE_TUPLE) : null,
              positionRequired: false,
              // `city` is missing on purpose — `tbl_active_city` sorts on it. See the note above.
              encrypted: encrypted ? ['street', 'postalCode', 'province', 'position'] : []
            }),
            contacts: {
              bsonType: 'object',
              title: 'object',
              required: [
                'mobile',
                'email'
              ],
              properties: {
                mobile: encrypted
                  ? encryptedField('mobile number, encrypted')
                  : {
                      bsonType: 'string',
                      maxLength: 12
                    },
                landline: encrypted
                  ? encryptedField('landline number, encrypted')
                  : {
                      bsonType: 'string',
                      maxLength: 12
                    },
                email: encrypted
                  ? encryptedField('contact address, encrypted — randomly, unlike the login address, because nothing looks an account up by it')
                  : {
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
        ...(notes ? { notes: note(encrypted) } : {}),
        resetPwd: RESET_PWD,
        ...(withEmailVerify ? { emailVerify: emailVerify(encrypted) } : {}),
        __v: {
          bsonType: 'int'
        }
      },
      additionalProperties: false
    }
  };
}

module.exports = { note, validatorShopOwner };
