// The `user` collection — the end customer, and the third and last thing you can authenticate
// against.
//
// Role on this platform is not a field: it is which collection the login form matched in, so this
// collection exists rather than a `role: 'user'` on `shopOwner`. It carries the same `LOGIN`,
// `RESET_PWD` and `EMAIL_VERIFY` sub-documents and the same `deleted`/`disabled` gates as the other
// two, and `lib/schemas/user.js` argues every place it deliberately diverges.
//
// **The validator is not a bare `$jsonSchema`.** It is `$and: [ {$jsonSchema}, {$expr} ]`. A
// collection validator accepts any query expression, not only `$jsonSchema`, and the extra clause is
// what makes `defaultAddress` unable to dangle: the pointer is either absent or names an `_id` that
// exists in this document's own `addresses`. Nothing in `lib/schemas/collection.js` has to know —
// `migrationCreation` hands the validator to `db.createCollection` opaquely and never inspects its
// shape.
//
// **Why a top-level pointer rather than a boolean on each address.** The feature was first specified
// as an optional `default: true` per element with "only one may be true" as a constraint. That
// constraint is not expressible in `$jsonSchema` and is awkward even in `$expr`, but the deeper
// problem is that the shape can *represent* two defaults at all: every write path would have to clear
// the others first, which is a two-step with a window in it, and every read path would have to decide
// what to do with a document where two are set. A pointer cannot represent a second default, so
// setting one is a single atomic `$set` with no window, and "at most one" stops being a rule anybody
// can violate.
//
// The cost is recorded rather than hidden: "is this address the default?" is a comparison against a
// sibling field instead of a local boolean read, and any API that wants to expose a boolean derives
// it. That is a cheap, one-directional trade — the boolean cannot be made safe the same way.
//
// ⚠️ **Every personal field here is encrypted, with no exception for query support** — the whole of
// `personalData` and the whole of every address element, `city` included, where `shopOwner` has to
// leave three fields in the clear. This collection can afford it because nothing sorts, searches or
// paginates customers: a customer reads their own document by `_id`, and there is no operator table
// over it. The two fields left visible — `addresses.[]._id` and `defaultAddress` — are the two sides
// of the `$expr` comparison above, and encrypting either would make the rule unsatisfiable and every
// write to the collection refused.
//
// **No `2dsphere` on `addresses.position`.** Nothing queries customers by distance; the geo query this
// platform needs is "shops near me", which is an index on `company.address.position`.
//
// **No `waitApprov`.** A shop owner is approved by an operator before the account works; a customer
// self-serves. The only gate between registering and logging in is the email confirmation, which
// `loginUser` checks against `emailVerify.valid`.
//
// **Two indexes, from `lib/schemas/user.js`'s `INDEXES_USER`.** The first is the shared
// `login.email_unique` from `lib/schemas/account.js` — one account per address, the same rule the
// other two collections have, and it is the credential the login form matches on. The second is
// `deleted_ttl`, and it belongs to this collection alone: thirty days after `funUserDel` stamps
// `deleted`, the database removes the document. Without it the stamp erases nothing and the address
// stays occupied for ever — see `INDEXES_USER` for why the TTL cannot ride on the operator table's
// compound index and why it is not put on the shared constant.
//
// ⚠️ **This file was EDITED after it had been applied, on 2026-08-26, which the rest of this repo
// forbids.** The platform owner chose it over a follow-up migration and rebuilt the database in the
// same piece of work; `20260825000000` is the counter-example, adding an index to this very
// collection from its own file for exactly the reason this edit ignores. What the choice costs is
// worth naming, because nothing enforces it: `migrate-mongo-config.js` sets `useFileHash: false`, so
// a database that already ran `20260301000300` sees no change here at all. It keeps ONE index, its
// changelog entry keeps saying this migration ran, and this file keeps claiming two. **Any database
// not rebuilt on or after 2026-08-26 is silently missing `deleted_ttl`** and its closed accounts are
// never purged. Verify with `db.user.getIndexes()` rather than with the changelog.

const { migrationCreation } = require('../lib/schemas/collection');
const { validatorUser, INDEXES_USER } = require('../lib/schemas/user');

const COLLECTION = 'user';

module.exports = migrationCreation(COLLECTION, validatorUser(), INDEXES_USER);
