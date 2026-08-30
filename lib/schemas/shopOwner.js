// The `shopOwner` validator — the person who owns one or more companies, and the account the
// ShopOwner tier authenticates against.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

const {
  LOGIN,
  RESET_PWD,
  EMAIL_VERIFY,
  DELETED,
  DELETED_BY,
  DISABLED,
  DISABLED_BY,
  DISABLED_REASON,
  SCRUBBED_AT,
  DISABLED_NEEDS_REASON
} = require('./account');
const { encryptedField } = require('./encrypted');
const { address } = require('./geo');

/**
 * What an admin wrote *about* an account — which is why it is at the top level and not inside
 * `personalData`. `personalData` is what the shopOwner declared about themselves; nothing in the
 * ShopOwner tier ever loads this model, so the field cannot leak to the shop owner.
 *
 * It is the one encrypted field on the platform whose subject never gets to read it. Free text an
 * admin wrote about a named person is personal data about that person whatever it says, and it is
 * the field most likely to say something the person would object to.
 */
const NOTE = encryptedField('internal notes written by an admin about this shop owner, encrypted, never visible to them');

/**
 * The `shopOwner` validator.
 *
 * ⚠️ **`personalData.firstName`, `personalData.lastName` and `personalData.address.city` stay in the
 * clear, and they are the one deliberate hole in this collection's protection.**
 *
 * All three are personal data and belong in the encrypted set on every ground except one:
 * `shopOwnersActiveTbl` in the Admin tier sorts on them through `tbl_active_lastName_firstName`,
 * `tbl_active_firstName` and `tbl_active_city`, and prefix-searches them with `/^term/i`. Neither
 * CSFLE algorithm survives that. Random ciphertext supports no comparison at all; deterministic
 * supports equality and nothing else, so it answers neither a sort nor a prefix match either.
 * Encrypting them would not make the admin table slower — it would make it *wrong*, silently: the
 * table would keep rendering, ordered by ciphertext, and every search box would return nothing.
 *
 * The same three fields on `admin` and on `user` ARE encrypted, because no table sorts those. ADR-029
 * records the trade and what would have to change to close it — dropping those three indexes and
 * paging the table another way. Adding these fields to the encrypted set without doing that in the
 * same change is the mistake this note exists to prevent.
 *
 * `personalData.address.position` is **optional** where the company's is required: a coordinate
 * arrives only when the address is picked from the admin app's autocomplete, and an address typed
 * by hand simply has none. It carries no `2dsphere` index either — nothing queries shop owners by
 * distance — which is what makes encrypting it free.
 */
function validatorShopOwner() {
  return {
    $jsonSchema: {
      bsonType: 'object',
      title: 'shopOwner',
      // ⚠️ `personalData` is NOT here, and stopped being here on 2026-08-12. A shop owner used to be
      // Admin-provisioned only, by a person who collected every field up front, so requiring the whole
      // block cost nothing. `shopOwnerRegister` on the public service creates one from an address and a
      // password like `userRegister` does, and the name, the date of birth, the home address and the
      // contacts arrive afterwards, through onboarding — a required block would make that document
      // unwritable and the sign-up form would have to ask a stranger for their home address before
      // they had confirmed they can read mail at their own.
      //
      // Everything *inside* `personalData` stays required: the block is all-or-nothing, so an
      // onboarded shop owner is still a complete record and a half-filled one cannot be written.
      required: [
        'login',
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
                date: encryptedField('date of birth, encrypted — no range query and no sort can reach it')
              },
              additionalProperties: false
            },
            // No `maxLength`: the street is ciphertext here, and a bound the server cannot measure
            // is a rule in name only. It holds in the GraphQL input validation instead.
            address: address({
              positionRequired: false,
              // `city` is missing on purpose — `tbl_active_city` sorts on it. See the note above.
              encrypted: ['street', 'postalCode', 'province', 'position']
            }),
            contacts: {
              bsonType: 'object',
              title: 'object',
              required: [
                'mobile',
                'email'
              ],
              properties: {
                mobile: encryptedField('mobile number, encrypted'),
                landline: encryptedField('landline number, encrypted'),
                email: encryptedField('contact address, encrypted — randomly, unlike the login address, because nothing looks an account up by it')
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
        deletedBy: DELETED_BY,
        disabled: DISABLED,
        disabledBy: DISABLED_BY,
        disabledReason: DISABLED_REASON,
        scrubbedAt: SCRUBBED_AT,
        waitApprov: {
          bsonType: 'bool',
          // Present and true: this account may not log in until an admin approves it. Written true
          // by `shopOwnerRegister` (a stranger signed themselves up) and by `shopOwnerUpdateStatus`
          // (an admin parked an existing account); `$unset` by the same mutation on approval, which
          // is why every reader tests presence rather than equality — the field is never `false`.
          // `shopOwnerAdd` writes nothing here on purpose: an account an admin created by hand has
          // already been approved by the act of creating it.
          description: 'present and true: may not log in until an admin approves this account'
        },
        notes: NOTE,
        resetPwd: RESET_PWD,
        emailVerify: EMAIL_VERIFY,
        __v: {
          bsonType: 'int'
        }
      },
      additionalProperties: false,
      dependencies: DISABLED_NEEDS_REASON
    }
  };
}

module.exports = { validatorShopOwner };
