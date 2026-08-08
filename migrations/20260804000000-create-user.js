// Initial schema migration for the `user` collection — the end customer.
//
// The third and last thing you authenticate against. Role on this platform is not a field: it is
// which collection the login form matched in, so this collection exists rather than a `role: 'user'`
// on `shopOwner`. It carries the same `LOGIN`, `RESET_PWD` and `EMAIL_VERIFY` sub-documents and the
// same `deleted`/`disabled` gates as the other two, and `lib/schemas/user.js` argues every place it
// deliberately diverges.
//
// **The validator is not a bare `$jsonSchema`.** It is `$and: [ {$jsonSchema}, {$expr} ]`, and this
// is the first migration here to use one. A collection validator accepts any query expression, not
// only `$jsonSchema`, and the extra clause is what makes `defaultAddress` unable to dangle: the
// pointer is either absent or names an `_id` that exists in this document's own `addresses`. Nothing
// in `lib/schemas/collection.js` had to change for it — `migrationCreation` hands the validator to
// `db.createCollection` opaquely and never inspects its shape.
//
// **Why a top-level pointer rather than a boolean on each address.** The original request was an
// optional `default: true` per element with "only one may be true" as a constraint. That constraint
// is not expressible in `$jsonSchema` and is awkward even in `$expr`, but the deeper problem is that
// the shape can *represent* two defaults at all: every write path would have to clear the others
// first, which is a two-step with a window in it, and every read path would have to decide what to do
// with a document where two are set. A pointer cannot represent a second default, so setting one is a
// single atomic `$set` with no window, and "at most one" stops being a rule anybody can violate.
//
// The cost is recorded rather than hidden: "is this address the default?" is now a comparison against
// a sibling field instead of a local boolean read, and any API that wants to expose a boolean derives
// it. That is a cheap, one-directional trade — the boolean cannot be made safe the same way.
//
// **No `2dsphere` on `addresses.position`.** Nothing queries customers by distance; the geo query
// this platform needs is "shops near me", which is an index on `company.address.position`. The point
// is stored in proper GeoJSON order from the first insert, so adding one later is a one-line
// migration.
//
// **No `waitApprov`.** A shop owner is approved by an operator before the account works; a customer
// self-serves. The only gate between registering and logging in is the email confirmation, which
// `loginUser` checks against `emailVerify.valid`.
//
// The single index is the shared `login.email_unique` from `lib/schemas/account.js` — one account per
// address, the same rule the other two collections have, and it is the credential the login form
// matches on.

const { migrationCreation } = require('../lib/schemas/collection');
const { INDEXES_LOGIN_EMAIL } = require('../lib/schemas/account');
const { validatorUser } = require('../lib/schemas/user');

const COLLECTION = 'user';

module.exports = migrationCreation(COLLECTION, validatorUser(), INDEXES_LOGIN_EMAIL);
