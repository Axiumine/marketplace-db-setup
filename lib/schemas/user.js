// The `user` validator — the end customer, the third and last collection you authenticate against.
//
// It mirrors `shopOwner` because role on this platform is which collection you log in against, not a
// field: same `LOGIN`, same `RESET_PWD`, same `EMAIL_VERIFY`, same `deleted`/`disabled` gates. Four
// things differ, and every one of them is deliberate — see `validatorUser` below.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

const { login, RESET_PWD, emailVerify, DELETED, DISABLED } = require('./account');
const { encryptedField } = require('./encrypted');
const { COORDINATE_TUPLE, position, address } = require('./geo');

/**
 * One element of `user.addresses`.
 *
 * It is `geo.js`'s street-address block with two fields added on top, so the customer's delivery
 * address and the shop owner's home address stay the same shape and the same 250-character cap —
 * a divergence here would mean two street-address widgets in two frontends.
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
 *
 * @param encrypted  whether the address members are stored as ciphertext (from `20260808000300`);
 *                   a plain boolean with no default, because the only caller is the builder below
 */
function addressItem(encrypted) {
  const base = address({
    maxLength: 250,
    position: position(COORDINATE_TUPLE),
    positionRequired: false,
    encrypted: encrypted ? ['street', 'postalCode', 'city', 'province', 'position'] : []
  });

  return {
    ...base,
    required: ['_id', ...base.required],
    properties: {
      _id: {
        bsonType: 'objectId'
      },
      label: encrypted
        ? encryptedField('what the customer calls this address — "home", "office". Encrypted, optional, free text')
        : {
            bsonType: 'string',
            maxLength: 50,
            description: 'what the customer calls this address — "home", "office". Optional and free text'
          },
      ...base.properties
    }
  };
}

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
 * Four divergences from `shopOwner`, all intentional:
 *
 * 1. **`personalData` is optional.** Registration is an email and a password and nothing else — the
 *    name and the contact details are filled in after the address is confirmed, and a customer who
 *    never fills them in can still place an order. `shopOwner` requires it because a shop owner is
 *    onboarded by a person who collects it all up front.
 * 2. **`addresses` is an array**, where `shopOwner` has one `personalData.address`. A customer has a
 *    home, an office and a friend's flat; a shop owner has a residence.
 * 3. **`defaultAddress`** has no counterpart at all. See above.
 * 4. **No `waitApprov`.** Customers self-serve: there is no operator approval gate between
 *    registering and using the account, only the email confirmation `loginUser` checks.
 *
 * `personalData.contacts` requires none of its members, which `shopOwner.personalData.contacts` does
 * (`mobile` and `email`). The account's address is `login.email` and is the credential; `contacts` is
 * for a *different* address or a number to be reached on, so demanding either would be asking the
 * customer to retype what they already gave.
 *
 * ⚠️ **Every personal field on this collection is encrypted, with no exception for query support** —
 * the whole of `personalData` and the whole of every address element. It can afford that where
 * `shopOwner` cannot because nothing sorts, searches or paginates customers: a customer reads their
 * own document by `_id`, and there is no operator table over this collection. `addresses.[]._id` and
 * `defaultAddress` are the only fields left visible, for the validator's sake — see `addressItem`.
 *
 * @param encrypted  whether the personal fields are stored as ciphertext (from `20260808000300`)
 */
function validatorUser({ encrypted = false } = {}) {
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
            login: login(encrypted),
            personalData: {
              bsonType: 'object',
              title: 'object',
              required: [
                'firstName',
                'lastName'
              ],
              properties: {
                firstName: encrypted
                  ? encryptedField('given name, encrypted')
                  : {
                      bsonType: 'string',
                      maxLength: 100
                    },
                lastName: encrypted
                  ? encryptedField('family name, encrypted')
                  : {
                      bsonType: 'string',
                      maxLength: 100
                    },
                birth: {
                  bsonType: 'object',
                  title: 'object',
                  required: [
                    'date'
                  ],
                  properties: {
                    date: encrypted
                      ? encryptedField('date of birth, encrypted — no range query and no sort can reach it')
                      : {
                          bsonType: 'date'
                        }
                  },
                  additionalProperties: false
                },
                contacts: {
                  bsonType: 'object',
                  title: 'object',
                  properties: {
                    mobile: encrypted
                      ? encryptedField('mobile number, encrypted')
                      : {
                          bsonType: 'string',
                          maxLength: 12
                        },
                    landline: encrypted
                      ? encryptedField('landline number, encrypted')
                      : {
                          bsonType: 'string',
                          maxLength: 12
                        },
                    email: encrypted
                      ? encryptedField('a second address to be reached on, encrypted — the credential is login.email')
                      : {
                          bsonType: 'string',
                          maxLength: 250,
                          description: 'a second address to be reached on — the credential is login.email'
                        }
                  },
                  additionalProperties: false
                }
              },
              additionalProperties: false
            },
            addresses: {
              bsonType: 'array',
              items: addressItem(encrypted),
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
            emailVerify: emailVerify(encrypted),
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

module.exports = { addressItem, DEFAULT_ADDRESS_POINTS_INTO_ADDRESSES, validatorUser };
