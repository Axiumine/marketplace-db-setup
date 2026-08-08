# `lib/schemas` — the shared validator shapes

Every `$jsonSchema` in `migrations/` is built from this directory. Before it existed, each migration
inlined its own copy: 13 identical product validators, 5 restatements of the shop collection, 3 of
`shopOwner`, 2 of a drink collection. About 3 500 of the repo's 5 100 migration lines were copies of another
migration, and Qodana reported four `DuplicatedCode` findings that no edit inside `migrations/` could
have cleared.

⚠️ **The product-type side of this is gone, and so is the old shop-collection side.** The 13 product
builders and the delivery-costs builder were dropped along with the customer-ordering scope they
existed to serve, and the old shop builder and its per-shop taxonomy builder followed (see the parent
workspace's CLAUDE.md and this repo's own). Those builders are deleted with the migrations that called
them, so nothing under `migrations/` requires any of them any more.

⚠️ **`item.js` and `itemCategory.js` are not those files coming back.** The catalogue was rebuilt on a
different axis: the old product builder existed because 13 collections restated one base shape and
differed only in their *category*, so the replacement is one `item` collection plus a taxonomy, and a
fourteenth product type is an `itemCategory` document rather than a builder branch. `itemCategory.js` is
likewise not the old per-shop taxonomy builder — that shape carried the shop it belonged to, and this
one has no owner column at all. **Nothing here may presume what is sold**, and do not reintroduce a
per-type builder: the duplication this directory exists to remove is exactly what a second one would
restore.

⚠️ **Every name in this directory is English.** The builders, their flags, the exported constants and
the `description` strings inside the validators are English, and so are the collection names.
Older prose below still describes the old shop and taxonomy collections in historical terms — those
collections are not coming back under any spelling.

## Why this is allowed here, when it usually is not

The standing rule in migration tooling — and the rule this repo carried until now — is that a
migration must be self-contained, because a later edit to a shared helper retroactively changes the
meaning of a migration that has already run and can never run again. Two databases that both report
the same `changelog` then hold different schemas, and nothing detects it.

That argument depends on a database existing that cannot be rebuilt. **On this platform none does.**
There is one environment, `Dev`, plus the throwaway `MONGO_TEST_*` database each suite drops on every
run. There is no staging and no production; `migrate-mongo-config.js` has no configuration for one.
The owner can drop and replay both databases from these files at will, and does.

So the rule is replaced rather than broken:

> **A change under `lib/schemas/` is followed by a full rebuild of every database that has run these
> migrations** — `yarn migrate:down` to empty, `yarn migrate:up` to replay — in the same piece of
> work, not later. The moment a database exists that cannot be rebuilt, this directory freezes and
> the old rule comes back.

`migrations/` itself keeps the original rule intact: **never edit an applied migration's behaviour**.
Adding a parameter to a builder here so a *new* migration can express a *new* shape is normal work.
Changing what an existing call site produces is not — it is the same forbidden edit, one file further
away.

## Layout

|File|Holds|
|---|---|
|`collection.js`|`migrationCreation()` — the `createCollection` + `createIndex` / `drop` pair every `<ts>-create-<coll>.js` is. `setValidator()` — the `collMod` every `<ts>-alter-<coll>.js` is.|
|`geo.js`|The GeoJSON point (`COORDINATE_TUPLE`, `position()`) and the street-address block (`address()`), shared by the three collections that store an address. `COORDINATE_DECIMAL`, the pre-`20260801000000` node, was **deleted** — see below.|
|`account.js`|`LOGIN`, `RESET_PWD`, `EMAIL_VERIFY`, `DELETED`, `DISABLED`, `INDEXES_LOGIN_EMAIL` — what `admin`, `shopOwner` and `user` have in common, which is everything about being a thing you log in as. `EMAIL_VERIFY` moved here from `shopOwner.js` when `user` gained the same slot; the shape did not change, so every restatement in `shopOwner.js` still produces what it always produced.|
|`shopOwner.js`|`validatorShopOwner()`, in each of its three historical shapes.|
|`user.js`|`validatorUser()`, `addressItem()`, `DEFAULT_ADDRESS_POINTS_INTO_ADDRESSES`. One shape so far. Returns an `$and` pair, always — see below.|
|`company.js`|`validatorCompany()`, `PUBLIC_FIELDS`, `PUBLISHED_IMPLIES_LINKABLE`. Two shapes: the bare legal record `20260803000000` created, and the shop listing `20260804010000` installed on top of it. Returns an `$and` pair **only** in the second, which is the one thing here that is conditional rather than fixed.|
|`itemCategory.js`|`validatorItemCategory()`. One shape. The two-level taxonomy — and ⚠️ its depth cap is **not** in it, because "my parent must itself be top-level" reads a different document and no validator can.|
|`item.js`|`validatorItem()`. One shape, deliberately domain-neutral and deliberately without a `price`.|

## A validator is not always a `$jsonSchema`

`validatorUser()` returns `$and: [ { $jsonSchema: … }, { $expr: … } ]`, and so does `validatorCompany()`
once `publicFields` is on. That is not a stylistic difference: a MongoDB collection validator is a
**query expression**, and `$jsonSchema` is only one operator you may use inside it. Anything a query
can say, a validator can enforce.

`user` needs that because of `defaultAddress`, a top-level ObjectId naming one element of the
document's own `addresses` array. "This field must equal the `_id` of a sibling array element" is a
cross-field rule, and JSON Schema has no way to express one — it validates each subtree against a
shape, never against another subtree's value. `$expr` does, so the two clauses ride together and the
pointer cannot dangle.

`company` needs it for a different kind of cross-field rule and the same reason: `published: true`
must imply a `slug` and a `publicName`, or the storefront has a shop with no URL and a card with no
heading. JSON Schema cannot make one property's *value* change another's requiredness.

The two are worth comparing, because they show the range: one constrains a reference, the other
constrains a combination. Neither is expressible in the `$jsonSchema` half at any cost, and both are a
handful of characters in the `$expr` one.

Consequences to know before adding another one:

- **`migrationCreation()` and `setValidator()` needed no change.** Both hand the validator to
  `createCollection` / `collMod` opaquely and never look inside it. A future `$and` builder works the
  same way.
- **A `collMod` on such a collection must restate BOTH clauses.** `collMod` replaces the validator
  wholesale, as it always has; passing only the `$jsonSchema` half silently drops the `$expr` rule and
  nothing fails until a dangling pointer is written.
- **Reading the schema half out of `listCollections` needs an unwrap.** `test/migrations.test.mjs`
  carries `jsonSchemaOf()` for exactly this; `options.validator.$jsonSchema` is `undefined` on both
  `user` and `company`. The `company` case is how it gets missed: that collection's assertions were
  written against a bare `$jsonSchema` and kept working for a day, so the destructure had to be
  found and replaced when the alter landed rather than being caught by a rule.
- **`$expr` runs on every write to the collection**, not only on the fields it names. Keep it cheap —
  the `user` one is a `$map` over an array that is at most a handful of elements, and the `company`
  one is two `$type` checks behind a short-circuiting `$or`.
- **It runs on updates too, not only inserts.** That is the point — it is a constraint rather than a
  create-time check — but it means an update that moves a document *through* an invalid state is
  refused. `companyUpdate` cannot set `published: true` and the slug in two calls, and deleting a
  `user`'s default address has to `$unset` the pointer in the same update.

## How the builders carry history

A builder is not "the current schema". It is **every** shape the collection has ever had, selected by
flag. `validatorShopOwner()` with no arguments is what `20260301000100` created in March;
`validatorShopOwner({ emailVerify: true, position: true, note: true })` is what the collection looks
like today. Both have to keep working, because the later shape's `down` is the earlier one.

`company.js` carries a third kind of flag, and it is worth understanding before copying the pattern:
`publishedRequired` selects a shape **no database ever rests in**. Adding a required field to a
populated collection takes three steps — widen so the field is legal but not demanded, backfill,
narrow so it is demanded — because backfilling first is a write under the old
`additionalProperties: false` validator and narrowing first leaves every stored document valid where it
sits and unwritable on its next update. The middle shape exists for the length of one migration, in
both directions (`down` unwinds through it too, since its `$unset` runs under the validator that
requires the field). It is a flag rather than a state of its own for that reason — and it defaults to
`publicFields`, so a caller that does not know about the three-step gets the resting shape.

That is what makes a *deletion* here dangerous in a way an *addition* is not. Dropping a flag branch
because nothing current uses it breaks the `down` of the migration that introduced it, and nothing
will notice until someone tries to walk the ladder back.

⚠️ **"Nothing current uses it" and "no migration on disk references it" are different statements, and
only the second licenses a deletion.** `COORDINATE_DECIMAL` was the worked example: it was the
pre-`20260801000000` coordinate node, kept under the rule above so
the migration that created the old shop collection could restate it and the `down` of
`20260801000000` could restore it. Both of those migrations were deleted on 2026-08-04 with the old
shop collection, which left the const exported, imported by nothing, and unreachable from every rung
of the ladder that still exists. `grep -r <name> migrations/` is the check, and it is the whole check: a hit means the shape is
load-bearing however old it looks, and no hits at all means the history it belonged to went first.

The reason this got noticed rather than sitting there: a dead literal is a **permanent mutation
survivor**. No test can distinguish `maximum: 180` from `maximum: -180` in a const nothing reads, so
`yarn test:mutation` reports it every run and it can only ever be cleared by deleting the code. That
makes the mutation gate the thing that finds orphaned history here, which is worth knowing before
reaching for a Stryker `disable` comment to quiet one.

`test/migrations.test.mjs` walks that whole ladder — full `up`, then one `down` at a time to the
bottom — so it is the check that a change here did not break a shape further up the history. Run
`yarn test` before committing anything in this directory, and treat a failure as "the builder no
longer reproduces a past shape" rather than as a broken test.
