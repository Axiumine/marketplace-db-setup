// Initial schema migration for the `admin` collection.
// Creates the collection with its $jsonSchema validator + indexes.
// Ported from the original mongosh setup script (see CLAUDE.md for the documented fixes applied
// during the migrate-mongo port).
//
// The shape it installs lived in this file until `20260808000000-alter-admin-encrypted` needed a
// second state of it; it is `validatorAdmin()` in `lib/schemas/admin.js` now, with no argument. That
// call produces what was inlined here byte for byte, key order included — the migration-call snapshot
// is what proves it, and a diff in that snapshot is the only way this edit could have gone wrong.
// Why the shapes live in `lib/schemas/` at all, and what that costs: `lib/schemas/README.md`.

const { migrationCreation } = require('../lib/schemas/collection');
const { INDEXES_LOGIN_EMAIL } = require('../lib/schemas/account');
const { validatorAdmin } = require('../lib/schemas/admin');

const COLLECTION = 'admin';

module.exports = migrationCreation(COLLECTION, validatorAdmin(), INDEXES_LOGIN_EMAIL);
