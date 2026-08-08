// The `admin` validator — the platform operator, the smallest of the three collections you
// authenticate against.
//
// It was inlined in `20260301000000-create-admin.js` until `20260808000000` needed a second state,
// and it moves here for the same reason and under the same rule `company.js` records:
// `validatorAdmin()` with no argument is that migration's shape verbatim, key order included, so the
// create migration installs exactly what it always installed and the snapshot suite is what proves
// it. Adding a parameter so a *new* migration can express a *new* shape is normal work; changing
// what the existing call site produces would be the forbidden edit, one file further away.
//
// An admin and a shop owner are the same thing seen from the auth side — role here is which
// collection you authenticate against, not a field — so the login sub-document, the password-reset
// slot and the deleted/disabled gates come from `account.js`. What is left is the whole difference
// between the two: an admin has a name and nothing else. No `waitApprov` (nobody approves an
// operator), no `emailVerify` (the account is created by hand), no `registeredAt`.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

const { login, RESET_PWD, DELETED, DISABLED } = require('./account');
const { encryptedField } = require('./encrypted');

/**
 * The `admin` validator.
 *
 * ⚠️ Both names are encrypted where the shop owner's are not, and the asymmetry is deliberate rather
 * than an oversight — see `shopOwner.js`. Nothing sorts, searches or paginates this collection:
 * there is no operator table over the operators, and the Admin tier reads its own document by `_id`.
 * So the two names cost nothing to encrypt here and would cost `shopOwnersActiveTbl` its ordering
 * there.
 *
 * @param encrypted  whether the personal fields are stored as ciphertext (from `20260808000000`)
 */
function validatorAdmin({ encrypted = false } = {}) {
  return {
    $jsonSchema: {
      bsonType: 'object',
      title: 'admin',
      required: [
        'login',
        'personalData'
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
            'lastName'
          ],
          properties: {
            firstName: encrypted
              ? encryptedField('given name, encrypted')
              : {
                  bsonType: 'string',
                  maxLength: 100
                },
            lastName: encrypted
              ? encryptedField('family name, encrypted')
              : {
                  bsonType: 'string',
                  maxLength: 100
                }
          },
          additionalProperties: false
        },
        deleted: DELETED,
        disabled: DISABLED,
        resetPwd: RESET_PWD,
        __v: {
          bsonType: 'int'
        }
      },
      additionalProperties: false
    }
  };
}

module.exports = { validatorAdmin };
