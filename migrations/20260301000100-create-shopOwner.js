// Initial schema migration for the `shopOwner` collection.
// Creates the collection with its $jsonSchema validator + indexes.
// Ported from the original mongosh setup script (see CLAUDE.md for the documented fixes applied
// during the migrate-mongo port).
//
// The shape lives in `lib/schemas/shopOwner.js`, which carries all three states the collection has
// had: this one, plus what `20260726000000` and `20260802000300` turned it into. Every flag is off
// here — no `emailVerify`, no address point, no operator note — because none of the three existed in
// March, and each was added by a later `collMod` that restates the whole validator.

const { migrationCreation } = require('../lib/schemas/collection');
const { INDEXES_LOGIN_EMAIL } = require('../lib/schemas/account');
const { validatorShopOwner } = require('../lib/schemas/shopOwner');

const COLLECTION = 'shopOwner';

module.exports = migrationCreation(COLLECTION, validatorShopOwner({}), INDEXES_LOGIN_EMAIL);
