// What `admin`, `shopOwner` and `user` have in common: they are the three collections you
// authenticate against, and every field below exists because of that.
//
// Role on this platform is not a field — it is *which collection you logged in against*, so the
// three carry the same login sub-document, the same password-reset slot, the same verify-email slot
// and the same disabled/deleted gates, and differ only in what they know about the person behind
// the account.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

/**
 * The login sub-document. `password` is a bcrypt hash and bcrypt hashes are exactly 60 characters,
 * hence the fixed min/max rather than a cap.
 *
 * `onboardingStep` / `onboardingDone` are read by the ShopOwner tier only; they sit here on both
 * collections because the sub-document is one shape, not because an admin is ever onboarded.
 */
const LOGIN = {
  bsonType: 'object',
  title: 'object',
  required: [
    'email',
    'password'
  ],
  properties: {
    email: {
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

/**
 * The password-reset slot. Kept strictly disjoint from `emailVerify`: while the activation token and
 * the reset token shared one slot, a hash issued by either flow authenticated the other, and an
 * unauthenticated reset request killed every pending activation link.
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
 * `user` verifies one too, through the same koa-utils flow, so the constant sits here with the rest
 * of what "a thing you log in as" means. Moving it changed no validator: `validatorShopOwner`
 * produces the same object it always did, byte for byte.
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
    newEmailTmp: {
      bsonType: 'string',
      maxLength: 250,
      description: 'new email awaiting confirmation during an email change'
    }
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

/** One account per address, on all three collections — it is the credential the login form matches on. */
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

module.exports = { LOGIN, RESET_PWD, EMAIL_VERIFY, DELETED, DISABLED, INDEXES_LOGIN_EMAIL };
