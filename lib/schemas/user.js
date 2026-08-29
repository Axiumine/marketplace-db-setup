// The `user` validator — the end customer, the third and last collection you authenticate against.
//
// It mirrors `shopOwner` because role on this platform is which collection you log in against, not a
// field: same `LOGIN`, same `RESET_PWD`, same `EMAIL_VERIFY`, same `deleted`/`disabled` gates. Four
// things differ, and every one of them is deliberate — see `validatorUser` below.
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
  DISABLED_NEEDS_REASON,
  INDEXES_LOGIN_EMAIL
} = require('./account');
const { encryptedField } = require('./encrypted');
const { address } = require('./geo');

/**
 * One element of `user.addresses`.
 *
 * It is `geo.js`'s street-address block with two fields added on top, so the customer's delivery
 * address and the shop owner's home address stay the same shape — a divergence here would mean two
 * street-address widgets in two frontends.
 *
 * `_id` is REQUIRED, which is what makes `defaultAddress` expressible: a pointer needs something to
 * point at, and an array element with no id can never be named. Mongoose mints one per sub-document
 * by default, so nothing has to be written by hand.
 *
 * `position` is allowed and not required, exactly as on `shopOwner`: the coordinate arrives when the
 * address is picked from the geocoder's autocomplete, and an address typed by hand simply has no map
 * until it is re-picked. Requiring it would make the field unwritable from any other path.
 *
 * ⚠️ **`_id` stays in the clear when everything around it is encrypted, and it has to.** The
 * collection validator's second clause `$map`s the `_id` of every element and checks `defaultAddress`
 * is one of them. Encrypting either side of that comparison makes the rule unsatisfiable — random
 * ciphertext differs on every encryption, so `$in` would never match and *every* write to the
 * collection would be refused. An ObjectId the server minted is not personal data on its own, so
 * nothing is given away by leaving it visible.
 *
 * `city` IS encrypted here where it is not on `shopOwner`: nothing sorts or searches a customer's
 * addresses. The divergence is in `shopOwner.js`, with the operator table that causes it.
 */
// No `maxLength`: every member here is ciphertext, the street included, and a bound the server
// cannot measure is a rule in name only. It holds in the GraphQL input validation instead.
const ADDRESS_BASE = address({
  positionRequired: false,
  encrypted: ['street', 'postalCode', 'city', 'province', 'position']
});

const ADDRESS_ITEM = {
  ...ADDRESS_BASE,
  required: ['_id', ...ADDRESS_BASE.required],
  properties: {
    _id: {
      bsonType: 'objectId'
    },
    label: encryptedField('what the customer calls this address — "home", "office". Encrypted, optional, free text'),
    ...ADDRESS_BASE.properties
  }
};

/**
 * The most addresses one customer may keep, and one of the few bounds on this collection the server
 * can still measure for itself.
 *
 * `maxItems` counts elements, not bytes, so ADR-029 does not reach it: the members are ciphertext and
 * unmeasurable, the *length of the array* is not. That makes this the opposite case from
 * `MAX_ADDRESS`/`MAX_CITY`/`MAX_LABEL`, which the validator gave up on and which now live only in the
 * service's input validation.
 *
 * ⚠️ **Six is spelled in three repositories and cannot be shared between them.** This one, the guard in
 * `marketplace-dev-user-authenticated-resource/src/lib/user/funUserAddressAdd.mts`, and the account
 * area's `MAX_ADDRESSES` in `marketplace-user/src/features/account/AddressList.tsx`. This repo depends
 * on no shared library — not `marketplace-common`, not anything — and the frontend is a browser bundle
 * that could not require a Node one, so there is no module all three can import. Changing the number
 * means changing all three in the same piece of work, plus a `collMod` migration for every database
 * that has already been built.
 *
 * **Which of the three is the rule.** This one. The service refuses the seventh address so the customer
 * gets a sentence instead of a failed write, and the frontend hides the button so they do not fill a
 * form in for nothing — but both are there to produce a better failure, not to be the failure. A
 * client that talks to the service directly still cannot get past this line.
 */
const MAX_ADDRESSES = 6;

/**
 * "At most one default address" — enforced by the database, and not as a rule that has to be checked.
 *
 * A boolean `default` on each element can express two defaults, so every write path would have to
 * clear the others first and every read path would have to cope with a document where two are set.
 * A pointer at the top level cannot express a second default at all: setting one is a single atomic
 * `$set`, with no clear-then-set window for a concurrent write to interleave into.
 *
 * The one thing a pointer *can* get wrong is dangling, and unlike "exactly one true" that is
 * checkable — a collection validator accepts any query expression, not only `$jsonSchema`, so this
 * rides alongside it under `$and`. Absent, or naming an `_id` that exists in this document's own
 * `addresses`; nothing else is writable. Deleting the default address therefore has to `$unset` the
 * pointer in the same update, and if it does not, the write is refused by MongoDB rather than by an
 * application path someone can forget to call.
 *
 * `$ifNull` matters: `addresses` is optional, and `$map` over a missing field yields null, which
 * `$in` rejects with an error instead of a false — that would turn "no addresses yet" into an
 * unwritable document.
 */
const DEFAULT_ADDRESS_POINTS_INTO_ADDRESSES = {
  $expr: {
    $or: [
      { $eq: [{ $type: '$defaultAddress' }, 'missing'] },
      {
        $in: [
          '$defaultAddress',
          { $map: { input: { $ifNull: ['$addresses', []] }, in: '$$this._id' } }
        ]
      }
    ]
  }
};

/**
 * The `user` validator.
 *
 * Three divergences from `shopOwner`, all intentional, and one that used to be a fourth:
 *
 * 0. **`personalData` is optional** — and no longer a divergence. It was one while a shop owner could
 *    only be Admin-provisioned by a person who collected every field up front; `shopOwnerRegister`
 *    ended that, so both sign-up collections now register an address and a password and fill the rest
 *    in later. What still differs is what "later" means: a customer may never fill it in and can still
 *    place an order, while a shop owner is walked through onboarding before they can sell anything.
 * 1. **`addresses` is an array**, where `shopOwner` has one `personalData.address`. A customer has a
 *    home, an office and a friend's flat; a shop owner has a residence. It is bounded — `MAX_ADDRESSES`,
 *    six, above — and that bound is the one length rule on this collection the server can still measure.
 * 2. **`defaultAddress`** has no counterpart at all. See above.
 * 3. **No `waitApprov`.** Customers self-serve: there is no operator approval gate between
 *    registering and using the account, only the email confirmation `loginUser` checks. A shop owner
 *    who self-serves through `shopOwnerRegister` gets both gates; one an Admin created gets neither.
 *
 * `personalData.contacts` requires none of its members, which `shopOwner.personalData.contacts` does
 * (`mobile` and `email`). The account's address is `login.email` and is the credential; `contacts` is
 * for a *different* address or a number to be reached on, so demanding either would be asking the
 * customer to retype what they already gave.
 *
 * ⚠️ **Every personal field on this collection is encrypted, with no exception for query support** —
 * the whole of `personalData` and the whole of every address element. It can afford that where
 * `shopOwner` cannot because nothing sorts, searches or paginates customers *by one of these fields*:
 * a customer reads their own document by `_id`, and the operator table that does exist over this
 * collection since E19-S02 — `usersActiveTbl`, paging on the `tbl_active_registeredAt` index — reads
 * `registeredAt`, `disabled`, `deleted` and `emailVerify.valid` and nothing else. Every column it
 * renders was already in the clear. `addresses.[]._id` and `defaultAddress` are the only fields left
 * visible, for the validator's sake — see `ADDRESS_ITEM`.
 *
 * ⚠️ **That table is the reason this list may not grow a "just one deterministic field" exception.**
 * The day a search over a name or a city is wanted, the answer is that the field stays encrypted and
 * the box is not built (E19-S05): deterministic encryption gives equal ciphertext for equal plaintext,
 * which is an equality oracle for anyone holding a read, and the five deterministic fields are the ones
 * a login or a verification link has to *find*.
 *
 * ⚠️ It returns an `$and` pair rather than a bare `$jsonSchema`, so **a `collMod` on this collection
 * must restate both clauses.** `collMod` replaces a validator wholesale; passing the `$jsonSchema`
 * half alone silently drops the dangling-pointer rule, and nothing fails until one is written.
 */
function validatorUser() {
  return {
    $and: [
      {
        $jsonSchema: {
          bsonType: 'object',
          title: 'user',
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
                'lastName'
              ],
              properties: {
                firstName: encryptedField('given name, encrypted'),
                lastName: encryptedField('family name, encrypted'),
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
                contacts: {
                  bsonType: 'object',
                  title: 'object',
                  properties: {
                    mobile: encryptedField('mobile number, encrypted'),
                    landline: encryptedField('landline number, encrypted'),
                    email: encryptedField('a second address to be reached on, encrypted — the credential is login.email')
                  },
                  additionalProperties: false
                }
              },
              additionalProperties: false
            },
            addresses: {
              bsonType: 'array',
              maxItems: MAX_ADDRESSES,
              items: ADDRESS_ITEM,
              description: 'every address this customer has saved; the default is named by defaultAddress'
            },
            defaultAddress: {
              bsonType: 'objectId',
              description: 'the _id of one element of addresses — see the $expr rule alongside this schema'
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
            resetPwd: RESET_PWD,
            emailVerify: EMAIL_VERIFY,
            __v: {
              bsonType: 'int'
            }
          },
          additionalProperties: false,
          dependencies: DISABLED_NEEDS_REASON
        }
      },
      DEFAULT_ADDRESS_POINTS_INTO_ADDRESSES
    ]
  };
}

/**
 * Thirty days, in seconds — how long a closed account keeps its personal data, decided by the platform
 * owner on 2026-08-26 (`phase1/NFR.md` open question 6, GDPR Art. 5(1)(e)) and left at thirty when the
 * mechanism underneath it changed on 2026-08-29.
 *
 * ⚠️ **It no longer bounds the life of the document, only of the data inside it** (ADR-041). Until
 * 2026-08-29 this number was the `expireAfterSeconds` of a TTL index and the database used it to remove
 * the whole record. The platform owner reversed that: the row recording that an account existed is kept
 * for ever, and a sweep overwrites its personal fields in place at this age. `20260829000100` retires
 * the index; the number outlives it because the sweep runs on exactly the same clock.
 *
 * It is the same number as the longest session cap (`SESSION_CAP_DAYS_REMEMBERED`), and that is a
 * coincidence worth not reading anything into: one bounds how long a login survives, this one bounds how
 * long a closed account's personal data survives, and either may move without the other.
 */
const CLOSED_ACCOUNT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * **What `20260301000300` creates, which since 2026-08-29 is no longer what `user` ends up with.**
 *
 * ⚠️ **`deleted_ttl` is still built here and is dropped again by `20260829000100`, so no live database
 * carries it.** It is left in this array on purpose rather than deleted: the constant is read by exactly
 * one migration, the create, and an applied migration is immutable — quietly rewriting what it built
 * would make the changelog describe a database that never existed. The alternative also costs a branch
 * nothing can execute, since a `dropIndex` guarded by "if it is there" is guarded against a state no
 * replay of this repo can produce.
 *
 * ⚠️ **Read the retirement, not the array, for what the collection has.** `test/migrations.test.mjs`
 * asserts the end state — that no index on any collection carries `expireAfterSeconds` — and that
 * assertion, not this list, is the statement of what is live.
 *
 * **Why it went.** The TTL index was what made `userDel` an erasure rather than a flag: `funUserDel`
 * stamps `deleted` and stops, so without it the closure was a suspension with another name. The platform
 * owner reversed the outcome on 2026-08-29 (ADR-041) — the document is kept for ever as the record that
 * a person held an account, and only the personal fields inside it are overwritten, at
 * `CLOSED_ACCOUNT_RETENTION_SECONDS`. A TTL index cannot express that: it removes whole documents and
 * has no other mode, and `collMod` can retune `expireAfterSeconds` but cannot strip TTL-ness from a live
 * index. So it had to be dropped rather than adjusted.
 *
 * ⚠️ **Reintroducing one breaks the design silently and in two places.** It would destroy the rows the
 * scrub exists to keep, and take each closed account's `login.email` with them — the address a
 * re-registration inside the thirty days is meant to find, rename and step over (ADR-042). Nothing would
 * log an error; accounts would just stop being there.
 *
 * ⚠️ **The scrub sweep needs no index of its own.** Its candidate query is `{deleted: {$lte: cutoff},
 * scrubbedAt: {$exists: false}}`, and `tbl_active_registeredAt` (20260825000000) leads with `deleted`, so
 * the range walks that index's prefix. A dedicated index would be a second copy of the same key for a job
 * that runs once a day.
 *
 * ⚠️ **`user` only, as before.** `INDEXES_LOGIN_EMAIL` is shared by `admin`, `shopOwner` and `user`; the
 * TTL never went there, and retention was decided for a closed account's personal data rather than for
 * operator accounts.
 */
const INDEXES_USER = [
  ...INDEXES_LOGIN_EMAIL,
  {
    key: {
      deleted: 1
    },
    options: {
      name: 'deleted_ttl',
      expireAfterSeconds: CLOSED_ACCOUNT_RETENTION_SECONDS
    }
  }
];

module.exports = { validatorUser, INDEXES_USER, CLOSED_ACCOUNT_RETENTION_SECONDS };
