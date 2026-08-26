// The `user` validator — the end customer, the third and last collection you authenticate against.
//
// It mirrors `shopOwner` because role on this platform is which collection you log in against, not a
// field: same `LOGIN`, same `RESET_PWD`, same `EMAIL_VERIFY`, same `deleted`/`disabled` gates. Four
// things differ, and every one of them is deliberate — see `validatorUser` below.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

const { LOGIN, RESET_PWD, EMAIL_VERIFY, DELETED, DISABLED, INDEXES_LOGIN_EMAIL } = require('./account');
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
            disabled: DISABLED,
            resetPwd: RESET_PWD,
            emailVerify: EMAIL_VERIFY,
            __v: {
              bsonType: 'int'
            }
          },
          additionalProperties: false
        }
      },
      DEFAULT_ADDRESS_POINTS_INTO_ADDRESSES
    ]
  };
}

/**
 * Thirty days, in seconds — how long a closed customer account is kept before the database removes
 * it, decided by the platform owner on 2026-08-26 (`phase1/NFR.md` open question 6, GDPR Art.
 * 5(1)(e)). It is the same number as the longest session cap (`SESSION_CAP_DAYS_REMEMBERED`), and
 * that is a coincidence worth not reading anything into: one bounds how long a login survives, this
 * one bounds how long a *closed account's personal data* survives, and either may move without the
 * other.
 */
const CLOSED_ACCOUNT_RETENTION_SECONDS = 30 * 24 * 60 * 60;

/**
 * `user`'s indexes: the shared login unique that all three login collections carry, plus a TTL that
 * no other collection gets.
 *
 * ⚠️ **`deleted_ttl` is what makes `userDel` an erasure rather than a flag.** `funUserDel` stamps
 * `deleted` and stops there — the document, its `personalData` and its `addresses` all stay on disk
 * — so without this index the "soft delete" is a suspension with a different name and the address
 * stays occupied for ever behind `login.email_unique`. The stamp is the decision to erase; this
 * index is the erasure.
 *
 * ⚠️ **It is a second index over `deleted`, and that is not redundancy with `tbl_active_registeredAt`
 * (20260825000000), whose key leads with the same field.** `expireAfterSeconds` is only accepted on a
 * single-field index — MongoDB refuses it on a compound one — so the operator table's index cannot
 * carry the TTL no matter how its keys are ordered. Two indexes is the price of the feature, not a
 * missed merge.
 *
 * ⚠️ **`user` only, deliberately.** `INDEXES_LOGIN_EMAIL` is shared by `admin`, `shopOwner` and
 * `user`; putting the TTL *there* would silently start destroying operator and shop-owner accounts
 * thirty days after they were disabled. Retention was decided for the customer's personal data and
 * for nothing else — a shop owner's closure drags `company` and its Italian registration identifiers
 * behind it, and nobody has decided what happens to those.
 *
 * ⚠️ **On this collection `deleted` is therefore a destruction clock, not a status.** Every path
 * that stamps it is scheduling a delete: `funUserDel` (the customer closing their account) and the
 * abandoned-registration guards in `verifyEmailFlowUser` (five wrong hashes, or a link older than
 * three days). Both want the document gone eventually, so both are correct — but a future write that
 * wants to mark a customer *without* destroying them in a month needs its own field, exactly as
 * ADR-036 says about `disabled`.
 *
 * MongoDB's TTL monitor sweeps once a minute, so removal lands shortly after the thirty days rather
 * than on the second, and it runs on the primary and replicates as ordinary deletes. `deleted` is
 * plaintext on this collection — it is not in `ENCRYPTED_FIELDS_USER` — which is what lets the server
 * read it at all: a CSFLE `binData` would never compare as a date and the index would silently expire
 * nothing.
 *
 * The period is not frozen by the immutability rule. `collMod` changes `expireAfterSeconds` on a
 * live index without a migration rewrite or a rebuild, so a different retention decision is an
 * operational change rather than a schema one.
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
