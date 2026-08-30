// The `admin` collection — the platform admin, and the first of the three things you can
// authenticate against.
//
// Role on this platform is not a field: it is which collection the login form matched in (ADR-002).
// So this collection exists rather than a `role: 'admin'` on `shopOwner`, and it carries the same
// `LOGIN` and `RESET_PWD` sub-documents and the same `deleted`/`disabled` gates as the other two.
// What is left is the whole difference between an admin and a shop owner: an admin has a name and
// nothing else — no `waitApprov` (nobody approves an admin), no `emailVerify` (the account is
// created by hand), no `registeredAt`.
//
// ⚠️ **`login.email` and both names are `binData` from this line onwards** (ADR-029). MongoDB
// Community has neither automatic CSFLE nor Queryable Encryption, so the encryption is explicit:
// `marketplace-common`'s Mongoose plugin replaces the value before the query leaves the service, and
// the server stores a BinData subtype 6 blob it knows nothing else about. The validator's whole
// contribution is to demand that blob and refuse a legible one — which is also why the demo seed
// cannot simply `insertOne` a plaintext document; see `20260301000600-seed-demo.js`.
//
// Both names are encrypted here where `shopOwner`'s are not, and the asymmetry is argued in
// `lib/schemas/shopOwner.js`: nothing sorts, searches or paginates admins, so encryption costs
// this collection nothing and would cost that one its admin table.
//
// The single index is `login.email_unique` from `lib/schemas/account.js` — one account per address,
// the same rule all three collections have. It survives the encryption only because `login.email` is
// DETERMINISTIC: a unique index over random ciphertext constrains nothing at all, since every insert
// of the same address produces different bytes.

const { migrationCreation } = require('../lib/schemas/collection');
const { INDEXES_LOGIN_EMAIL } = require('../lib/schemas/account');
const { validatorAdmin } = require('../lib/schemas/admin');

const COLLECTION = 'admin';

module.exports = migrationCreation(COLLECTION, validatorAdmin(), INDEXES_LOGIN_EMAIL);
