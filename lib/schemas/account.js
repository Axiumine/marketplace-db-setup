// What `admin`, `shopOwner` and `user` have in common: they are the three collections you
// authenticate against, and every field below exists because of that.
//
// Role on this platform is not a field — it is *which collection you logged in against*, so the
// three carry the same login sub-document, the same password-reset slot, the same verify-email slot
// and the same disabled/deleted gates, and differ only in what they know about the person behind
// the account.
//
// ⚠️ `LOGIN` and `EMAIL_VERIFY` were plain constants until `20260808000000` gave them an encrypted
// state; they are `login(encrypted)` and `emailVerify(encrypted)` now. Called with `false` each
// returns exactly what its constant held, key order included, so every migration that predates the
// encryption still installs the shape it installed before. Functions rather than a second constant
// apiece for a reason recorded in `lib/schemas/README.md`: a top-level constant is evaluated once
// per process, so
// a mutation of one is invisible to any suite that does not evict `lib/` from the require cache — a
// shape built inside a function body is re-evaluated on every call and cannot hide.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

const { encryptedField } = require('./encrypted');

/**
 * The login sub-document. `password` is a bcrypt hash and bcrypt hashes are exactly 60 characters,
 * hence the fixed min/max rather than a cap.
 *
 * `onboardingStep` / `onboardingDone` are read by the ShopOwner tier only; they sit here on both
 * collections because the sub-document is one shape, not because an admin is ever onboarded.
 *
 * ⚠️ **`password` is NOT encrypted and must not be.** A bcrypt hash is not personal data — it is a
 * one-way digest of a secret nobody stores — and `bcrypt.compare` reads it back raw, so encrypting
 * it would buy nothing and break the comparison. The same reasoning keeps `resetPwd.resetHash` and
 * `emailVerify.hash` in the clear below: both are comparison hashes, neither is personal data.
 *
 * ⚠️ **`email` is DETERMINISTIC when encrypted, and it is why deterministic encryption exists on
 * this platform at all.** It is the credential every login form matches on —
 * `findOne({ 'login.email': … })` against all three collections — and it carries a unique index.
 * Random ciphertext supports neither: two encryptions of one address differ, so the lookup misses and
 * the index stops constraining anything. The price is the one deterministic CSFLE always charges —
 * equal addresses produce equal blobs, so equality leaks to anyone who can read the collection. That
 * is precisely what the unique index has to be able to see, so it is not a leak this shape could
 * avoid and still keep the constraint.
 *
 * @param encrypted  whether `email` is stored as ciphertext (from `20260808000000` onwards).
 *                   A plain boolean with no default, not an options object: every caller is a
 *                   collection builder that already holds the flag and passes it, so a default here
 *                   would be a branch no test could reach — the same argument `positionRequired` in
 *                   geo.js carries, and the reason `lib/schemas/README.md` bans unreachable defaults.
 */
function login(encrypted) {
  return {
    bsonType: 'object',
    title: 'object',
    required: [
      'email',
      'password'
    ],
    properties: {
      email: encrypted
        ? encryptedField('login address, deterministically encrypted — equality is the only query it supports')
        : {
            bsonType: 'string',
            maxLength: 250
          },
      password: {
        bsonType: 'string',
        minLength: 60,
        maxLength: 60
      },
      firstLogin: {
        bsonType: 'date'
      },
      lastLogin: {
        bsonType: 'date'
      },
      onboardingStep: {
        bsonType: 'string',
        maxLength: 4
      },
      onboardingDone: {
        bsonType: 'bool'
      },
      rememberMe: {
        bsonType: 'bool'
      }
    },
    additionalProperties: false
  };
}

/**
 * The password-reset slot. Kept strictly disjoint from `emailVerify`: while the activation token and
 * the reset token shared one slot, a hash issued by either flow authenticated the other, and an
 * unauthenticated reset request killed every pending activation link.
 *
 * Nothing here is encrypted. `resetDateReq` is a timestamp and `resetHash` is a comparison hash of a
 * token that was mailed once — neither identifies the person, and the hash is matched by value on
 * every reset, which random ciphertext could not answer and deterministic would only make guessable.
 */
const RESET_PWD = {
  bsonType: 'object',
  title: 'object',
  required: [
    'resetDateReq',
    'resetHash'
  ],
  properties: {
    resetDateReq: {
      bsonType: 'date',
      description: 'request date'
    },
    resetHash: {
      bsonType: 'string',
      minLength: 50,
      maxLength: 50,
      description: 'comparison hash'
    }
  },
  additionalProperties: false
};

/**
 * The verify-email slot, bound to the `@axiumine/koa-utils` flow.
 *
 * It carries NO `required` array, and that is load-bearing rather than lax: the flow never writes
 * the sub-document whole. `setEmailHash` sets hash + requestTimes + dateLastReq and never touches
 * `valid`; `enableEmailAccess` sets `valid` and `$unset`s the other three; `confirmNewEmail`
 * additionally clears `newEmailTmp`. Each of those is a document Mongo has to accept, so requiring
 * any member — `valid` included — would make the flow reject its own next write.
 *
 * It lived in `shopOwner.js` while `shopOwner` was the only collection that verified an address.
 * `user` verifies one too, through the same koa-utils flow, so the shape sits here with the rest of
 * what "a thing you log in as" means. Moving it changed no validator, and neither did turning it
 * into a function: `validatorShopOwner()` produces the same object it always did, byte for byte.
 *
 * ⚠️ **`newEmailTmp` is the second and last deterministic field on the platform.** It is a real email
 * address — the one the account is moving to — so it is personal data and has to be encrypted, and
 * koa-utils' `emailChangeHashVerify` finds the account by it: `findOne({ 'emailVerify.newEmailTmp':
 * <address> })`. That is an equality lookup on a value the service holds in plaintext, which is the
 * one query deterministic ciphertext answers. It carries no unique index, so unlike `login.email` the
 * equality leak buys only the lookup.
 *
 * @param encrypted  whether `newEmailTmp` is stored as ciphertext (from `20260808000000` onwards);
 *                   a plain boolean with no default, for the reason given on `login` above
 */
function emailVerify(encrypted) {
  return {
    bsonType: 'object',
    title: 'object',
    properties: {
      valid: {
        bsonType: 'bool',
        description: 'true once a verification link has been used'
      },
      hash: {
        bsonType: 'string',
        minLength: 50,
        maxLength: 50,
        description: 'comparison hash, EMAIL_HASH_LEN in koa-utils'
      },
      dateLastReq: {
        bsonType: 'date',
        description: 'request date, sets the 3-day window'
      },
      requestTimes: {
        bsonType: 'int',
        description: 'wrong-hash attempts, the fifth deletes the account'
      },
      newEmailTmp: encrypted
        ? encryptedField('new email awaiting confirmation, deterministically encrypted — koa-utils looks the account up by it')
        : {
            bsonType: 'string',
            maxLength: 250,
            description: 'new email awaiting confirmation during an email change'
          }
    },
    additionalProperties: false
  };
}

const DELETED = {
  bsonType: 'date',
  description: 'deletion date'
};

const DISABLED = {
  bsonType: 'bool',
  description: 'present and true: disabled, absent: login allowed'
};

/**
 * One account per address, on all three collections — it is the credential the login form matches on.
 *
 * ⚠️ It survives the encryption unchanged, and only because `login.email` is deterministic. A unique
 * index over random ciphertext constrains nothing at all: every insert of the same address produces a
 * different blob and every one of them is accepted, so the collection would silently start admitting
 * duplicate accounts. Making that field random is therefore not a "weaker but safer" choice — it is a
 * correctness bug with no error message.
 */
const INDEXES_LOGIN_EMAIL = [
  {
    key: {
      'login.email': 1
    },
    options: {
      name: 'login.email_unique',
      unique: true
    }
  }
];

module.exports = { login, RESET_PWD, emailVerify, DELETED, DISABLED, INDEXES_LOGIN_EMAIL };
