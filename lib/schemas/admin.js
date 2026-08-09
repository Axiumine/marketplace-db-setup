// The `admin` validator — the platform operator, the smallest of the three collections you
// authenticate against.
//
// An admin and a shop owner are the same thing seen from the auth side — role here is which
// collection you authenticate against, not a field — so the login sub-document, the password-reset
// slot and the deleted/disabled gates come from `account.js`. What is left is the whole difference
// between the two: an admin has a name and nothing else. No `waitApprov` (nobody approves an
// operator), no `emailVerify` (the account is created by hand), no `registeredAt`.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

const { LOGIN, RESET_PWD, DELETED, DISABLED } = require('./account');
const { encryptedField } = require('./encrypted');

/**
 * The `admin` validator.
 *
 * ⚠️ Both names are encrypted where the shop owner's are not, and the asymmetry is deliberate rather
 * than an oversight — see `shopOwner.js`. Nothing sorts, searches or paginates this collection:
 * there is no operator table over the operators, and the Admin tier reads its own document by `_id`.
 * So the two names cost nothing to encrypt here and would cost `shopOwnersActiveTbl` its ordering
 * there.
 */
function validatorAdmin() {
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
        login: LOGIN,
        personalData: {
          bsonType: 'object',
          title: 'object',
          required: [
            'firstName',
            'lastName'
          ],
          properties: {
            firstName: encryptedField('given name, encrypted'),
            lastName: encryptedField('family name, encrypted')
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
