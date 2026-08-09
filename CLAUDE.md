# marketplace-db-setup

MongoDB schema migrations for **Marketplace**. No application code — only migrations that create
collections, attach `$jsonSchema` validators, build indexes and optionally seed demo data. Managed by
[migrate-mongo](https://github.com/seppevs/migrate-mongo).

**Read parent first** — `/media/nvme/websites/fullstack-marketplace-blueprint/CLAUDE.md`
(<https://github.com/Axiumine/fullstack-marketplace-blueprint> if you are reading this on GitHub).
One of fifteen sub-repos.

| Need | File |
|---|---|
| scope, the six collections, the demo seed, the three schema traps | `README.md` |
| prerequisites, the five test suites, gates, hooks, migrate-mongo state | `REPO.md` |
| why a validator shape is the way it is | `lib/schemas/README.md` |
| anything cross-repo | parent `CLAUDE.md` |

**Seven migrations, six of which create a collection and one of which seeds demo data.** Each collection
is declared once, in its final shape — validator, `additionalProperties: false`, encryption and every
index in one call. There is no `collMod` here and no `<ts>-alter-<coll>.js`.

Six collections — `admin`, `shopOwner`, `company`, `user`, `itemCategory`, `item`:

```
shopOwner ──idShopOwner──> company ──idCompany──> item ──idCategory──> itemCategory
                                                                            ▲
                                                                    idParent ┘  (one level only)
admin, user — outside the chain
```

⚠️ **No order, cart, delivery or payment collection, and no `shop` collection.** A shop **is** a
`company`. There is no per-product-type collection and no per-shop taxonomy either, under any spelling.

⚠️ **Nothing here may presume what is sold.** The extension seam is the taxonomy: a new product type is
an `itemCategory` **document**, not a migration. A new *collection* needs a shape `item` genuinely cannot
hold — the 13 never cleared that bar, since they differed in their category and not in their shape.

⚠️ **Every name is English** — collections, fields, `lib/schemas/` builders and their flags, migration
filenames, the `description` strings inside validators, test identifiers, comments and the demo seed's
data. Adding one word of a second language is a regression, not a style nit.

## Layout

| Path | Purpose |
|---|---|
| `migrate-mongo-config.js` | Config. Builds an authenticated URL from `.env` (`MONGO_DEV_*`); `changelog` tracks applied migrations. |
| `migrations/*.js` | One migration per file, applied in filename (timestamp) order. `<ts>-create-<coll>.js` = collection + validator + indexes, in one `migrationCreation()` call. |
| `lib/schemas/*.js` | The validator shapes every migration is built from (`account`, `collection`, `encrypted`, `geo`, `admin`, `shopOwner`, `user`, `company`, `item`, `itemCategory`), each builder returning **one** shape and taking no arguments. Mostly `$jsonSchema`, not always — `user.js` and `company.js` both return an `$and` pair. **Read `lib/schemas/README.md` before touching it**: an edit here changes what an already-applied migration means. `encrypted.js` is the ADR-029 one — it turns a personal field's shape into `bsonType: 'binData'`, which is all a validator can say about a ciphertext. |
| `migrations/20260301000600-seed-demo.js` | Optional demo seed, **one** file — one `admin`, one `shopOwner`, one `company`. No-op unless `SEED_DEMO=true`. |
| `lib/encryption.js` | The CSFLE half (ADR-029): opens a `ClientEncryption` against the master key at `CSFLE_MASTER_KEY_PATH`, mints or reuses one data key per collection in `<db>.__keyVault`, and encrypts a document field by field so the seed can write into collections whose personal fields are `binData` from the moment they are created. |
| `lib/mongoUrl.js` | The `://user:pwd@` + `authSource` assembly, shared by the config (`MONGO_DEV_*`) and the tests (`MONGO_TEST_*`) so the two cannot drift. |
| `test/` | Five vitest suites — the migration replay plus four unit suites. Layout and traps: `REPO.md`. |
| `vitest.config.mjs` · `vitest.mutation.config.mjs` · `stryker.config.mjs` | Suite configs. Coverage gated at 100% on every metric; Stryker `thresholds.break: 100`, `concurrency: 1` (one real database). |
| `qodana.yaml` / `qodana.sh` | Scan config and runner. Critical 0 / high 0, coverage 100 total / 100 fresh, SCA and license checks. |
| `.githooks/pre-commit` · `pre-push` | Gates. What runs when, and why: `REPO.md`. |
| `env` | Committed template for `.env`. `.env` itself is gitignored — dev Mongo credentials. |
| `setup/mongodb.js` · `setup/redis.txt` | Manual one-off runbooks (DB users, dump/restore, Redis ACL). **Gitignored** — they hold real users, passwords and internal hostnames. A clone does not get them; ask whoever runs the cluster. |

## Running migrations

```sh
yarn migrate:status          # list applied / pending
yarn migrate:up              # apply all pending
yarn migrate:down            # revert the LAST applied migration (one step)
yarn migrate:create <name>   # scaffold a new timestamped migration file
```

Config auto-discovered as `migrate-mongo-config.js` in the repo root — run from there. It injects
`user:pwd@` into `MONGO_DEV_CONN_STRING`, appends `authSource=$MONGO_DEV_AUTH_ADMIN`, and sets
`databaseName` = `MONGO_DEV_DB`.

⚠️ **`migrate:status` compares filenames against `changelog` and nothing else.** A database whose
`changelog` names a file that is not on disk is not a database these migrations can move forward: every
file it does not recognise reads as PENDING, and `migrate:up` then dies on the first one with
`Collection already exists`. Drop it and replay — `yarn migrate:up` with `SEED_DEMO=true` for a dev
box. The one thing a replay does not reproduce is `login.firstLogin` / `login.lastLogin` on the demo
admin, which the app rewrites on the next login.

## Module system

Migrations and `migrate-mongo-config.js` are **CommonJS** and stay that way — the config declares
`moduleSystem: 'commonjs'` and migrate-mongo loads them through it.

`test/migrations.test.mjs` is **ESM**, and has to be: migrate-mongo is ESM-only from v12. Its CommonJS
wrapper is a `Proxy` whose every property access returns a *Promise*, so under `require` the whole API
reads as undefined and the first call dies with `TypeError: mm.config.set is not a function`.

## Authoring migrations — rules

- **Every migration here creates a collection.** Six creates and one seed, no `collMod`, no
  `<ts>-alter-<coll>.js`. A collection is declared once, in its final shape, so `migrations/` reads as
  the schema the database has rather than as the sum of a ladder — and a reader never has to replay six
  files in their head to learn what a field is today.
- **Migrations are immutable.** Never edit one that may already be applied anywhere — its `changelog`
  entry means it will not re-run. That is a rule about *applied* files: as long as every database that
  has run them can be dropped and replayed, correcting a shape means correcting the create and rebuilding
  in the same piece of work. The moment a database exists that cannot be rebuilt, the only legal change
  is a new migration, and the first one will need a `collMod` helper that does not exist yet.
- **The shapes live in `lib/schemas/`, not in the migration.** The usual rule says a migration must be
  self-contained, because an edit to a shared helper retroactively changes what an applied migration
  means. That argument depends on a database existing that cannot be rebuilt, and **none does here**: one
  `Dev` environment plus a throwaway test database, both replayable from these files. So the rule is
  replaced rather than broken — **a change under `lib/schemas/` is followed by a full rebuild of every
  database that has run these migrations, in the same piece of work.** Read `lib/schemas/README.md`.
- **A helper cannot live in `migrations/`.** migrate-mongo treats every `*.js` under `migrationsDir` as a
  migration, and `test/migrations.test.mjs` reads the directory the same way. Helpers go in `lib/`, in
  CommonJS like everything else.
- **Native driver API, not mongosh.** `up(db)` / `down(db)` receive the driver `Db`:
  `db.createCollection(name, { validator, validationLevel, validationAction })`,
  `db.collection(name).createIndex(key, options)`, `db.collection(name).drop()`. For BSON types,
  `require('mongodb')` → `ObjectId`, `Decimal128`, and `new Date(...)`; there is no `ISODate` /
  `NumberDecimal` global.
- Standard shape — a create is one call, and `migrationCreation` is the whole of it:

```js
// <ts>-create-example.js
const { migrationCreation } = require('../lib/schemas/collection');
const { validatorExample } = require('../lib/schemas/example');
const COLLECTION = 'example';
const indexes = [{ key: { field: 1 }, options: { name: 'field_unique', unique: true } }];
module.exports = migrationCreation(COLLECTION, validatorExample(), indexes);
```

## Collections & schema conventions

- Validators are `strict` + `additionalProperties: false` — app writes must match the shape exactly.
  Adding an app field means adding it to the builder and rebuilding.
- `__v` (int) allowed everywhere, for Mongoose `versionKey` compatibility.
- Recurring state fields: `deleted` (date or bool), `disabled` (bool), `waitApprov` (bool).
- Passwords: bcrypt, exactly 60 chars (`minLength`/`maxLength: 60`); hashes are `$2y$14$…`.

⚠️ **Know what the replay is buying you before you give it up.** The day a populated database can no
longer be dropped, adding a *required* field to it takes three steps rather than one — widen the
validator, backfill the documents, then narrow it — and `down` needs the same three mirrored. Neither
shortcut works: backfilling first runs the write under the old `additionalProperties: false` validator,
which has never heard of the field, and narrowing first is worse, because `collMod` does not re-validate
what is already stored, so every existing document stays valid where it sits and becomes unwritable on
its next update, surfacing weeks later on whoever edits an address.

### company — the registered company, and the shop

A collection of its own, not a sub-document of `shopOwner`, and that is the load-bearing choice here: one
shopOwner owns N companies (`idShopOwner`, **required**), which an embedded object cannot express — a
company running three shops would store its details three times and collide with itself on the second at
`vatNumber_unique`. Those two uniques, `vatNumber_unique` and `certifiedEmail_unique`, are **global**: one
VAT number is one company, whoever registered it. `idShopOwner_list` is the non-unique index for the one
list query.

`registryExtract` carries `maxLength: 1000` — it is a file path, not the file. `taxCode` is exactly 11
digits, a legal entity's tax code and not the 16-character personal form, optional and not unique.
`address` is a full street block including a **required** tuple-form `position`. `deleted` is an optional
**date**, the spelling `shopOwner` uses: `companyDel` stamps it instead of removing the document, and every
read path filters `{ $exists: false }`. A soft-deleted company keeps both unique entries, so its VAT number
stays occupied and it cannot be registered again — the same behaviour `shopOwner.login.email_unique` has,
and why neither index carries a `partialFilterExpression`.

Four fields make it the shop listing as well as the registered company: `publicName` (the trading name —
`legalName` is the registered one and wrong on a customer card), `slug` (the whole of `/shop/:slug`,
lowercase-and-hyphens by `pattern`, not merely capped), `description` (the page body and the text-search
target) and `published`. Only `published` is required; the other three cannot be, because no slug can be
derived from a legal name without inventing one.

⚠️ Its validator is an `$and` pair. The `$expr` half says **a published company has a slug and a
publicName** — `published: true` with neither is a shop with no URL and a card with no heading. It says
nothing about `deleted` on purpose: `companyDel` stamps the date and nothing else on both tiers, and the
read paths already filter `published: true` *and* `deleted: { $exists: false }`.

Indexes, and why each exists:

| Index | Serves |
|---|---|
| `slug_unique` | **partial** on `{ slug: { $type: 'string' } }` — a plain unique treats a missing field as one null key, so the second slugless company would duplicate the first. `$type: 'string'`, not `$exists: true`, which would readmit an explicit null. Global, and forced to be: two companies sharing a slug are two shops at one URL. |
| `address.position_2dsphere` | `companiesNearby` and the map — the only distance query on the platform |
| `published_list` (`{published, deleted}`) | the two equality predicates every public read carries |
| `published_publicName` | `/shops` — `published_list` answers the *filter* only |
| `published_city_publicName` | `/shops/:city` |
| `search_text` (`publicName` 10 / `description` 1, `english`) | the company half of `search` |

⚠️ **An index serves a sort only from the keys *after* the last equality predicate**, which is why the
last two exist: `companies` sorted by `publicName` handed every match to a blocking SORT stage. The
failure mode at the top end is an **error**, not slowness — a blocking sort is capped at 32 MB and
`allowDiskUse` is off by default on `find`, so past that the query returns
`QueryExceededMemoryLimitNoDiskUseAllowed`. A collection may carry **at most one** text index, so
`search_text` is the only one this collection will ever have. `published_list` is an exact prefix of
`published_publicName` and is installed anyway: it answers the filter-only reads without touching a
second key, and `company` is written a handful of times per shop, so the spare index costs almost nothing.
`item` is written far more often and carries no such spare.

### item — what a shop sells

Required: `idCompany`, `idCategory`, `name`, `description`, `slug`, `published`. Both references are
unenforced, as `company.idShopOwner` is; the resolvers check them.

`slug` is unique **per company**, not globally — the one place this collection's URL rules differ from the
other two. The route is `/shop/:slug/item/:itemSlug`, so the company segment already disambiguates, and a
global unique would force the second shop to sell a "blue-shirt-2" because of a catalogue it cannot see.
It is required, unlike `company.slug`: the collection is created empty, so nothing is stranded by
requiring it.

⚠️ **There is no `price`, deliberately.** Cart, order, delivery and payment have no model anywhere on this
platform, so a price would be a guess at a currency, a precision, a VAT treatment and a discount model at
once — and Decimal128, the type it wants, is a rejected write everywhere here. It arrives with the
ordering tier, in one migration, after those questions are answered. The suite asserts the absence.

Five indexes, each named for the read it serves: `idCompany_list` (the owner's catalogue),
`idCompany_slug_unique` (the per-company rule, doubling as the item-page lookup),
`idCompany_published_name` (the public shop page — not redundant with the first, which has `deleted` in
second position and would fetch and discard every draft), `idCategory_published_name` (the category
browse, the widest fan-out on the platform) and `search_text`.

⚠️ **Both listing indexes end in `name`, and that trailing key is load-bearing.** An index serves a sort
only from the keys *after* the last equality predicate, and both listings sort by `name`, so a three-key
`{ idCategory, published, deleted }` answers the *filter* and then hands every match to a blocking
in-memory SORT. Measured on 100 000 items in one category: 100 000 keys / 100 000 docs / 170 ms without
the trailing key, 24 keys / 24 docs / 3 ms with it, for the same 24 items. The three-key prefixes are
**not** installed alongside them — every plan that could use the short index can use the long one, and
`item` is the write-heavy collection of the three, which is the opposite call from `company.published_list`
and deliberately so. `funItemCategoryDelete` filters `{ idCategory, deleted }` with no sort and is served
by the `idCategory` prefix either way; `companyItems` uses `idCompany_list`, a different key order.

⚠️ **`search_text` is not compound.** MongoDB requires an equality predicate on every non-text prefix key,
so scoping it to `idCompany` would make platform-wide search unable to use it at all. Per-shop search is a
filter applied after it. No `2dsphere`: an item is at its shop, so "items near me" goes through
`company.address.position_2dsphere`, and a copied point would go stale on the first address change.

### itemCategory — the platform taxonomy

Two levels, admin-written. `name`, `slug`, `position` required; `idParent` optional —
absent means top-level, present means subcategory, and that is the whole level mechanism. `slug` is unique
across **both** levels, since `/category/:slug` and `/category/:slug/:subSlug` resolve through one flat URL
space; a plain unique rather than a partial one, because `slug` is required here and there are no null keys
to collide. `idParent_position` backs the two listing reads.

⚠️ `position` here is an **int sort ordinal**, not the GeoJSON point every other collection spells the same
way.

⚠️ **The depth cap is not in the validator and cannot be** — "my parent must itself be top-level" reads a
different document, which no collection validator can do. `itemCategoryAdd` / `itemCategoryUpdate` in the
Admin resource service are the only place it holds.

### user — the end customer

One of the two collections whose validator is not a bare `$jsonSchema` — `company` is the other. It is
`$and: [{ $jsonSchema }, { $expr }]`, because a collection validator is a query expression and
`$jsonSchema` is only one operator you may put in one. The `$expr` clause enforces that `defaultAddress`, a
top-level ObjectId, either is absent or names the `_id` of an element of this document's own `addresses`
array — a cross-field rule JSON Schema cannot state at all.

`defaultAddress` replaces the per-element `default: true` boolean the feature was first specified with. A
boolean can *represent* two defaults, so "only one" becomes a rule every write path upholds with a
clear-then-set two-step and every read path has to survive being handed a document that broke it; a pointer
cannot represent a second default, so setting one is a single atomic `$set` with no window. The cost,
stated so it is not a surprise: "is this the default?" is a comparison against a sibling field rather than
a local boolean read.

Four divergences from `shopOwner`, all argued at the head of `lib/schemas/user.js`: `personalData` is
**optional** (registration is an email and a password and nothing else), `addresses` is an **array** where
the shop owner has one, `defaultAddress` has no counterpart, and there is **no `waitApprov`** — a customer
self-serves, so the only gate between registering and logging in is the email confirmation.
`personalData.contacts` requires none of its members, unlike `shopOwner`'s: `login.email` is already the
credential, so demanding a contact email would ask for the same address twice.

No `2dsphere` over `addresses.position` — nothing queries customers by distance. Its only index is the
shared `login.email_unique`.

⚠️ **Anything that ever replaces this validator must restate *both* clauses.** A validator is set
wholesale, never merged, so handing MongoDB the `$jsonSchema` half alone silently drops the `$expr` rule —
and nothing fails at that moment. The first symptom is a dangling `defaultAddress` written weeks later.
`validatorUser()` returns the `$and` pair and nothing else for exactly that reason: there is no way to get
half of it.

### shopOwner

- `notes` (top level, optional, `maxLength: 2000`) is what an **operator** wrote *about* an account, which
  is why it is not inside `personalData` — that is what the shop owner declared about themselves. Nothing
  in the ShopOwner tier reads it: `marketplace-dev-authenticated-*` does not load this model at all, so the
  field cannot leak to the shop owner.
- `personalData.address.position` is the same GeoJSON point as `company.address.position`, in the same
  tuple form — but **optional**, with no `2dsphere` index. Deliberate: nothing queries shop owners by
  distance, and a coordinate cannot be derived from a street address without geocoding, so requiring it
  would put a geocoder in the path of registration. It fills in the first time an address is picked from
  the operator app's autocomplete.

### Geo

`position` is `{ type: "Point", coordinates: [<lng>, <lat>] }`, GeoJSON order, indexed `2dsphere` as
`address.position_2dsphere` where an index exists. Each axis has its own `items` schema — longitude ±180,
latitude ±90 — and both accept `['double', 'int', 'long']`.

⚠️ Three things about this are easy to get wrong, and each one is silent until it is expensive:

- **The order is `[lng, lat]`.** Writing `[lat, lng]` puts a company thousands of km from where it belongs
  the instant anything reads it as GeoJSON. No validator can catch it, because both orders are well-formed
  — the suite asserts it with a real `$near` query instead.
- **The type is double, never `decimal`.** `marketplace-common`'s `coordinates: { type: [Number] }` can
  never produce a Decimal128, so a validator that demanded one would answer 500 on every call.
- **`int` in the list** is not redundant: `bson` encodes an integer-valued JS Number as int32, so a point
  at longitude exactly 9 is stored `9`, and a `'double'`-only validator rejects it.

⚠️ **Decimal128 is a rejected write everywhere here, deliberately.** The resolvers use `.lean()`, so
mongoose getters never run and the raw driver value reaches GraphQL, where
`GraphQLFloat.serialize(Decimal128)` throws.

## Secrets

- `.env` holds the real dev credentials and is gitignored. A `pre-commit` guard blocks a staged secret.
- ⚠️ **`setup/redis.txt` is placeholdered; `setup/mongodb.js` is not.** `mongodb.js` carries **7 lines of
  literal credentials** — the `userAdminAnyDatabase` connection at the top and the `pwd` of every
  `createUser` below it — against 5 placeholder lines, all in the per-repo test-user block added later.
  The admin line is live: it provisioned `dbMarketplaceTest` and the nine per-repo test databases. The
  cluster is local and the owner has accepted that exposure, so nothing is being rotated — but this file
  is **not** safe to paste into an issue, a PR or a public repo. Both runbooks are gitignored for that
  reason; re-adding either undoes the exercise. Substitute from `.env` when running the placeholdered
  parts by hand.
- Only a `Dev` environment is wired up (`MONGO_DEV_*`). There is no staging or prod config yet.

## Version control

**git**, branch `main`, remote `origin` → `https://github.com/Axiumine/marketplace-db-setup` (**public**).

⚠️ **The remote is public and nothing has been pushed to it yet.** The history is a single commit by
design: the two runbooks under `setup/` used to be tracked and carried live credentials, so they were
untracked and the twenty commits holding earlier copies were collapsed into one. There is no second
revision to leak from. Before the first push, read what a public reader would get: every migration, every
validator and the `env` template are fine, and nothing else should be assumed to be.

- **Never commit on `main`.** Branch first: `git switch -c <type>/<slug>`. Merging is the user's call.
- **Push-on-request**, always.
- Merged → delete the branch: `git branch -d <slug>`, in the same breath as the merge. `-d` only, `-D`
  never — `-d` refuses a branch whose commits are not already reachable, so the safe case is quiet and the
  unsafe one stops you.

## Gates

commit → secret guard, coverage, Qodana. push → coverage, mutation, Qodana. All blocking, and a docs-only
commit skips the last two. ⚠️ **A reachable MongoDB is therefore a prerequisite for committing**, not only
for pushing. **Never lower a threshold and never remove a gate** — a migration whose branch is uncovered
gets a test, and `test/migrationCalls.test.mjs` is the file to copy: it drives a migration against a fake
db with no server anywhere, which is how the branches a real replay cannot reach get covered. Mechanics,
bypasses and the Qodana exclusions: `REPO.md`.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **marketplace-db-setup**. Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> Index stale? Run `node .gitnexus/run.cjs analyze` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? `npx gitnexus analyze` (npm 11 crash → `npm i -g gitnexus`; #1939).

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows. For regression review, compare against the default branch: `detect_changes({scope: "compare", base_ref: "main"})`.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `query({search_query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `context({name: "symbolName"})`.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method without first running `impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit changes without running `detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/marketplace-db-setup/context` | Codebase overview, check index freshness |
| `gitnexus://repo/marketplace-db-setup/clusters` | All functional areas |
| `gitnexus://repo/marketplace-db-setup/processes` | All execution flows |
| `gitnexus://repo/marketplace-db-setup/process/{name}` | Step-by-step execution trace |

## Cross-Repo Groups

This repository is listed under GitNexus **group(s): marketplace-platform** (see `~/.gitnexus/groups/`). For cross-repo analysis, use MCP tools `impact`, `query`, and `context` with `repo` set to `@<groupName>` or `@<groupName>/<memberPath>` (paths match keys in that group’s `group.yaml`). Use `group_list` / `group_sync` for membership and sync. From the project root: `node .gitnexus/run.cjs group list`, `node .gitnexus/run.cjs group sync <name>`, `node .gitnexus/run.cjs group impact <name> --target <symbol> --repo <group-path>` (the `.gitnexus/run.cjs` path is repo-root-relative).

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
