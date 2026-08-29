// What `admin`, `shopOwner` and `user` have in common: they are the three collections you
// authenticate against, and every field below exists because of that.
//
// Role on this platform is not a field — it is *which collection you logged in against*, so the
// three carry the same login sub-document, the same password-reset slot, the same verify-email slot
// and the same disabled/deleted gates, and differ only in what they know about the person behind
// the account.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

const { encryptedField } = require('./encrypted');

/**
 * The login sub-document. `password` is a bcrypt hash and bcrypt hashes are exactly 60 characters,
 * hence the fixed min/max rather than a cap.
 *
 * `onboardingStep` / `onboardingDone` are read by the ShopOwner tier only; they sit here on all
 * three collections because the sub-document is one shape, not because an admin is ever onboarded.
 *
 * ⚠️ **`password` is NOT encrypted and must not be.** A bcrypt hash is not personal data — it is a
 * one-way digest of a secret nobody stores — and `bcrypt.compare` reads it back raw, so encrypting
 * it would buy nothing and break the comparison. The same reasoning keeps `resetPwd.resetHash` and
 * `emailVerify.hash` in the clear below: both are comparison hashes, neither is personal data.
 *
 * ⚠️ **`email` is DETERMINISTIC, and it is why deterministic encryption exists on this platform at
 * all.** It is the credential every login form matches on — `findOne({ 'login.email': … })` against
 * all three collections — and it carries a unique index. Random ciphertext supports neither: two
 * encryptions of one address differ, so the lookup misses and the index stops constraining
 * anything. The price is the one deterministic CSFLE always charges — equal addresses produce equal
 * blobs, so equality leaks to anyone who can read the collection. That is precisely what the unique
 * index has to be able to see, so it is not a leak this shape could avoid and still keep the
 * constraint.
 */
const LOGIN = {
  bsonType: 'object',
  title: 'object',
  required: [
    'email',
    'password'
  ],
  properties: {
    email: encryptedField('login address, deterministically encrypted — equality is the only query it supports'),
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

/**
 * The password-reset slot. Strictly disjoint from `emailVerify`: sharing one slot between the
 * activation token and the reset token would let a hash issued by either flow authenticate the
 * other, and would let an unauthenticated reset request kill every pending activation link.
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
 * ⚠️ **`newEmailTmp` is the second and last deterministic field on the platform.** It is a real email
 * address — the one the account is moving to — so it is personal data and has to be encrypted, and
 * koa-utils' `emailChangeHashVerify` finds the account by it: `findOne({ 'emailVerify.newEmailTmp':
 * <address> })`. That is an equality lookup on a value the service holds in plaintext, which is the
 * one query deterministic ciphertext answers. It carries no unique index, so unlike `login.email` the
 * equality leak buys only the lookup.
 */
const EMAIL_VERIFY = {
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
    newEmailTmp: encryptedField('new email awaiting confirmation, deterministically encrypted — koa-utils looks the account up by it')
  },
  additionalProperties: false
};

const DELETED = {
  bsonType: 'date',
  description: 'deletion date'
};

const DISABLED = {
  bsonType: 'bool',
  description: 'present and true: disabled, absent: login allowed'
};

/**
 * Who closed the account, and the only thing that distinguishes the two closures from each other.
 *
 * ⚠️ **Absence is meaningful and is not "unknown".** `deleted` with no `deletedBy` beside it means the
 * account holder closed their own account; `deleted` *with* one means an operator did, and the value is
 * an `admin._id`. Reading absence as missing data — and backfilling it with something — destroys the
 * only record of which of the two happened (ADR-044).
 *
 * There is no second field saying which collection the id points into, deliberately: `deletedBy` is
 * written by the Admin tier and by nothing else, so `admin` is the only collection it can name. A
 * self-closure writes no id at all rather than the holder's own, because an account pointing at itself
 * and an operator's decision would then be told apart by comparing two ObjectIds instead of by looking.
 */
const DELETED_BY = {
  bsonType: 'objectId',
  description: 'the admin who closed this account; absent means the holder closed it themselves'
};

/**
 * Who suspended the account. Always an `admin._id` — suspension is an Admin-tier act and there is no
 * self-suspend anywhere on the platform, the account holder's only self-service exit being closure.
 *
 * Unlike `deletedBy`, absence here carries no second meaning: before ADR-044 nothing recorded the actor,
 * so a document suspended by an older build simply has none.
 */
const DISABLED_BY = {
  bsonType: 'objectId',
  description: 'the admin who suspended this account'
};

/**
 * Why the account was suspended, in the operator's own words.
 *
 * ⚠️ **The 1000-character cap the platform owner asked for is NOT here and cannot be.** This is
 * ciphertext to the server, so `maxLength` would bound the blob rather than the sentence inside it —
 * the same trade `encrypted.js` describes for every other encrypted field. The bound holds in the
 * GraphQL input validation of the two Admin-tier mutations that write it, and there alone.
 *
 * Encrypted `ALGORITHM_RANDOM`, not deterministic: nothing looks an account up by its reason and
 * nothing compares two of them, so the equality leak deterministic charges would buy nothing. That
 * keeps the deterministic set at the five fields ADR-029 pins.
 *
 * It is the second field on `shopOwner`, after `notes`, whose subject never reads it — and the first
 * such field on `user`.
 */
const DISABLED_REASON = encryptedField('why an admin suspended this account, encrypted, never visible to the account holder');

/**
 * When the retention sweep overwrote this document's personal data (ADR-041).
 *
 * Its presence is what stops the sweep doing the work twice, so it is the sweep's own idempotence
 * marker rather than a date anybody displays. In the clear because the sweeper selects on it —
 * `{ scrubbedAt: { $exists: false } }` — and a `binData` would answer that question about the
 * ciphertext rather than about the account.
 */
const SCRUBBED_AT = {
  bsonType: 'date',
  description: 'when the retention sweep overwrote this account\'s personal data'
};

/**
 * A suspended account must say why it was suspended — the platform owner's rule of 2026-08-29, enforced
 * by the server rather than only by the mutation that writes it.
 *
 * ⚠️ **`dependencies` demands the field is PRESENT and reads nothing.** That is exactly what makes the
 * rule expressible over an encrypted path: the server cannot see whether the reason says anything, only
 * that a reason was written. A `required` array could not be used instead — `disabled` is optional, and
 * requiring its sibling unconditionally would refuse every account that was never suspended.
 *
 * ⚠️ **`disabledBy` is deliberately NOT demanded here.** A document suspended before ADR-044 has no
 * actor and inventing one would be a lie the database then vouches for; the reason has an honest
 * placeholder available and the actor has none. Its presence on new suspensions is a code invariant of
 * the single mutation that writes them, not a database one.
 */
const DISABLED_NEEDS_REASON = {
  disabled: ['disabledReason']
};

/**
 * One account per address, on all three collections — it is the credential the login form matches on.
 *
 * ⚠️ It works only because `login.email` is deterministic. A unique index over random ciphertext
 * constrains nothing at all: every insert of the same address produces a different blob and every one
 * of them is accepted, so the collection would silently start admitting duplicate accounts. Making
 * that field random is therefore not a "weaker but safer" choice — it is a correctness bug with no
 * error message.
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

module.exports = {
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
};
