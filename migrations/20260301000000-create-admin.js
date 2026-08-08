// Initial schema migration for the `admin` collection.
// Creates the collection with its $jsonSchema validator + indexes.
// Ported from the original mongosh setup script (see CLAUDE.md for the documented fixes applied
// during the migrate-mongo port).
//
// The login sub-document, the password-reset slot and the deleted/disabled gates come from
// `lib/schemas/account.js`: an admin and an shopOwner are the same thing seen from the auth side —
// role here is which collection you authenticate against, not a field — so those four are one shape
// by definition. What is left below is the whole difference between the two: an admin has a name and
// nothing else. No `waitApprov` (nobody approves an operator), no `emailVerify` (the account is
// created by hand), no `registeredAt`.

const { migrationCreation } = require('../lib/schemas/collection');
const { LOGIN, RESET_PWD, DELETED, DISABLED, INDEXES_LOGIN_EMAIL } = require('../lib/schemas/account');

const COLLECTION = 'admin';

const validator = {
  $jsonSchema: {
    bsonType: 'object',
    title: COLLECTION,
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
          firstName: {
            bsonType: 'string',
            maxLength: 100
          },
          lastName: {
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

module.exports = migrationCreation(COLLECTION, validator, INDEXES_LOGIN_EMAIL);
