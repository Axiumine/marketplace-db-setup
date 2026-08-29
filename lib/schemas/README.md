# `lib/schemas` — the shared validator shapes

Every `$jsonSchema` in `migrations/` is built from this directory, and every builder here returns
**one** shape: the shape its collection was created with and still has. There are no flags, no
historical variants and no `down` that has to reproduce an earlier version, because every migration in
this repository *creates* a collection and none alters one.

⚠️ **Every name in this directory is English** — the builders, their arguments, the exported constants,
and the `description` strings inside the validators, along with the collection and field names
themselves. The same name has to spell identically in a migration, a `$jsonSchema`, a Mongoose model, a
resolver, a GraphQL field and three frontends, and nothing maps between those layers.

⚠️ **Nothing here may presume what is sold** (ADR-008). `item.js` is one domain-neutral collection and
`itemCategory.js` is the taxonomy that gives it meaning; a new product type is an `itemCategory`
*document*. Do not add a per-type builder — one validator per product type, each restating the same base
shape and differing only in its category, is exactly the duplication this directory exists to prevent.

## Why sharing a shape is allowed here, when it usually is not

The standing rule in migration tooling is that a migration must be self-contained, because a later edit
to a shared helper retroactively changes the meaning of a migration that has already run and can never
run again. Two databases that both report the same `changelog` then hold different schemas, and nothing
detects it.

That argument depends on a database existing that cannot be rebuilt. **On this platform none does.**
There is one environment, `Dev`, plus the throwaway `MONGO_TEST_*` database each suite drops on every
run. There is no staging and no production; `migrate-mongo-config.js` has no configuration for one. The
owner can drop and replay both databases from these files at will, and does.

So the rule is replaced rather than broken:

> **A change under `lib/schemas/` is followed by a full rebuild of every database that has run these
> migrations** — `yarn migrate:down` to empty, `yarn migrate:up` to replay — in the same piece of work,
> not later. The moment a database exists that cannot be rebuilt, this directory freezes and the old
> rule comes back.

Adding a field to a builder is therefore not an edit to history, it is a change to the schema, and it is
followed by a rebuild in the same commit. What it is **not** is a way to change a live database in
place: `createCollection` does not run twice, so a `lib/schemas/` edit reaches a database only through a
replay.

## Layout

|File|Holds|
|---|---|
|`collection.js`|`migrationCreation(collection, validator, indexes)` — the whole of every `<ts>-create-<coll>.js`: `createCollection` with the validator and `LEVEL`, then one `createIndex` per entry, and a `down` that drops the collection. The only export.|
|`encrypted.js`|`encryptedField(description)` → `{ bsonType: 'binData', description }`. All a validator can say about a ciphertext, and the ADR-029 seam: a field routed through this loses every `maxLength`, `minLength` and `pattern` it would otherwise carry, because the server cannot measure a blob.|
|`geo.js`|`address({ maxLength, positionRequired, encrypted })` — the street-address block, shared by `company`, `shopOwner` and `user`. The GeoJSON node it builds from stays module-internal on purpose: every collection with a point carries the *same* point, and a swapped axis order is the one mistake a reader cannot see in a stored document.|
|`account.js`|`LOGIN`, `RESET_PWD`, `EMAIL_VERIFY`, `DELETED`, `DISABLED`, `INDEXES_LOGIN_EMAIL` — what `admin`, `shopOwner` and `user` have in common, which is everything about being a thing you log in as. Role on this platform is *which collection you authenticate against* (ADR-002), so the three genuinely share one credential shape.|
|`admin.js`|`validatorAdmin()`. The platform admin. No `registeredAt`, no `emailVerify`, no `waitApprov` — an admin account is created by another admin, not by a sign-up flow.|
|`shopOwner.js`|`validatorShopOwner()`. ⚠️ The one collection with personal fields deliberately left in the clear — see below.|
|`user.js`|`validatorUser()`, `ADDRESS_ITEM`, `DEFAULT_ADDRESS_POINTS_INTO_ADDRESSES`. Returns an `$and` pair, always.|
|`company.js`|`validatorCompany()`, `PUBLISHED_IMPLIES_LINKABLE`. Returns an `$and` pair, always. The legal record and the storefront in one collection, because a shop **is** a company.|
|`itemCategory.js`|`validatorItemCategory()`. The two-level taxonomy — and ⚠️ its depth cap is **not** in it, because "my parent must itself be top-level" reads a different document and no validator can.|
|`item.js`|`validatorItem()`. Domain-neutral, and deliberately without a `price` — permanently, ADR-038.|

## A validator is not always a `$jsonSchema`

`validatorUser()` and `validatorCompany()` both return `$and: [ { $jsonSchema: … }, { $expr: … } ]`.
That is not a stylistic difference: a MongoDB collection validator is a **query expression**, and
`$jsonSchema` is only one admin you may use inside it. Anything a query can say, a validator can
enforce.

`user` needs that because of `defaultAddress`, a top-level ObjectId naming one element of the document's
own `addresses` array. "This field must equal the `_id` of a sibling array element" is a cross-field
rule, and JSON Schema has no way to express one — it validates each subtree against a shape, never
against another subtree's value. `$expr` does, so the two clauses ride together and the pointer cannot
dangle.

`company` needs it for a different kind of cross-field rule and the same reason: `published: true` must
imply a `slug` and a `publicName`, or the storefront has a shop with no URL and a card with no heading.
JSON Schema cannot make one property's *value* change another's requiredness.

The two are worth comparing, because they show the range: one constrains a reference, the other
constrains a combination. Neither is expressible in the `$jsonSchema` half at any cost, and both are a
handful of characters in the `$expr` one.

Consequences to know before adding another one:

- **`migrationCreation()` needed no change.** It hands the validator to `createCollection` opaquely and
  never looks inside it. A future `$and` builder works the same way.
- **⚠️ Anything that replaces a validator must restate BOTH clauses.** `collMod` replaces a validator
  wholesale; passing only the `$jsonSchema` half silently drops the `$expr` rule, and nothing fails
  until a dangling pointer is written. `migrations/20260826000000-user-cap-addresses.js` is the one
  `collMod` in this repository and it calls `validatorUser()`, which returns the whole `$and` pair and
  offers no way to obtain half of it — copy that, never a hand-assembled `$jsonSchema`.
- **Reading the schema half out of `listCollections` needs an unwrap.** `test/migrations.test.mjs`
  carries `jsonSchemaOf()` for exactly this; `options.validator.$jsonSchema` is `undefined` on both
  `user` and `company`, so a destructure reads as `undefined` and every assertion under it passes
  vacuously.
- **`$expr` runs on every write to the collection**, not only on the fields it names. Keep it cheap —
  the `user` one is a `$map` over an array that is at most a handful of elements, and the `company` one
  is two `$type` checks behind a short-circuiting `$or`.
- **It runs on updates too, not only inserts.** That is the point — it is a constraint rather than a
  create-time check — but it means an update that moves a document *through* an invalid state is
  refused. `companyUpdate` cannot set `published: true` and the slug in two calls, and deleting a
  `user`'s default address has to `$unset` the pointer in the same update.

## Encryption is a property of whose data it is, not of what the field is

`encryptedField()` is applied field by field rather than collection by collection, and the three
collections that store a street address hand `address()` three different `encrypted` lists. The rule is
not "an address is personal data":

- **`company.address` is not encrypted at all.** It is the registered seat of a legal entity, published
  on the shop page, sorted on by `published_city_publicName` and queried by distance through
  `address.position_2dsphere`. Encrypting it would be encrypting data the platform hands out for free,
  and paying for it with the map, the city listing and the search.
- **`user.addresses[]` is encrypted whole**, `city` included, because nothing sorts, searches or
  paginates customers. Its `_id` and the top-level `defaultAddress` stay clear, and *have to*: the
  `$expr` clause compares them, and random ciphertext differs on every encryption, so encrypting either
  side would refuse every write to the collection.
- **`shopOwner` is the compromise, and the one deliberate hole.** `personalData.firstName`,
  `personalData.lastName` and `personalData.address.city` stay in the clear because
  `tbl_active_lastName_firstName`, `tbl_active_firstName` and `tbl_active_city` sort on them and the
  admin table prefix-searches them with `/^term/i`. **Neither CSFLE algorithm survives that** —
  random supports no comparison at all, deterministic supports equality and nothing else — so
  encrypting them would not make the admin table slower, it would make it *wrong*, silently.
  ADR-029 records the trade and what would have to change to close it.

⚠️ **`login.email` is the one deterministically encrypted field, on all three login collections.** A
unique index over random ciphertext constrains nothing, since every insert of one address produces
different bytes, and no login could find its own account. `emailVerify.newEmailTmp` is deterministic for
the same reason: koa-utils looks an account up by it.

⚠️ **A field-level rule cannot survive encryption.** `maxLength`, `minLength`, `pattern` and the
per-axis coordinate bounds all describe a value the server can read. Wherever a field is ciphertext, its
bound holds in the GraphQL input validation instead — which is why `address()` refuses to attach a
`maxLength` to an encrypted street, and why passing one anyway would be a rule written down and enforced
nowhere.

## Two traps in this directory

⚠️ **A value passed to a builder and then discarded is a permanent mutation survivor.** `address()`
builds the clear shape of every member and then throws away the ones named in `encrypted`, so a
`maxLength` handed in by a caller that encrypts its street reaches no validator at all. No test can
distinguish `maxLength: 250` from `maxLength: 251` in a shape nothing reads, so `yarn test:mutation`
reports it every run and it can only ever be cleared by deleting the argument. That makes the mutation
gate the thing that finds dead literals here, which is worth knowing before reaching for a Stryker
`disable` comment to quiet one.

⚠️ **A default on an argument every call site passes is a branch nothing can reach.** `positionRequired`
has no default for that reason, and `indexes` in `collection.js` has none either. `encrypted` keeps its
`[]` because `company` genuinely passes nothing. The second reason for `positionRequired` is worse than
untestability: silently false on `company` would make a shop's coordinate optional.

⚠️ **Top-level consts here are evaluated once per process**, so a test that loads a module twice gets the
first evaluation both times and every mutant inside those consts survives. `test/migrationCalls.test.mjs`
carries `evictLib()`, which deletes every `lib/` key from `require.cache` before each load, for exactly
this — without it the directory scored 88% with 54 survivors.

`test/migrations.test.mjs` applies every migration against a real MongoDB and asserts the whole of every
validator and every index, snapshots included. Run `yarn test` before committing anything in this
directory, and read the snapshot diff rather than regenerating it — a snapshot updated because the test
went red launders a schema regression into a committed expectation.
