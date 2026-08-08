# marketplace-db-setup

MongoDB schema migrations for **Marketplace**. No application code — only migrations that create
collections, attach `$jsonSchema` validators, build indexes and optionally seed demo data. Managed by
[migrate-mongo](https://github.com/seppevs/migrate-mongo); the hand-rolled `revApp` runner it replaced is
gone and must not come back.

**Read parent first** — `/media/nvme/websites/fullstack-marketplace-blueprint/CLAUDE.md`. One of fourteen
sub-repos.

| Need | File |
|---|---|
| history, demo seed, glossary, the mongosh-port fixes | `README.md` |
| prerequisites, the five test suites, gates, hooks, migrate-mongo state | `REPO.md` |
| why a validator shape is the way it is | `lib/schemas/README.md` |
| anything cross-repo | parent `CLAUDE.md` |

Six collections — `admin`, `shopOwner`, `company`, `user`, `itemCategory`, `item`:

```
shopOwner ──idShopOwner──> company ──idCompany──> item ──idCategory──> itemCategory
                                                                            ▲
                                                                    idParent ┘  (one level only)
admin, user — outside the chain
```

⚠️ **No order, cart, delivery or payment collection, and no `shop` collection.** A shop **is** a
`company`. The 13 product-type collections, the delivery-costs collection, the shop collection and its
per-shop taxonomy were all dropped on 2026-08-04, and none returns under any spelling.

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
| `migrations/*.js` | One migration per file, applied in filename (timestamp) order. `<ts>-create-<coll>.js` = collection + validator + indexes. |
| `lib/schemas/*.js` | The validator shapes every migration is built from (`account`, `collection`, `encrypted`, `geo`, `admin`, `shopOwner`, `user`, `company`, `item`, `itemCategory`), each builder carrying **every** state its collection has had. Mostly `$jsonSchema`, not always — `user.js` always returns an `$and` pair, `company.js` returns one once `publicFields` is on. **Read `lib/schemas/README.md` before touching it**: an edit here changes what an already-applied migration means. `encrypted.js` is the ADR-029 one — it turns a personal field's shape into `bsonType: 'binData'`, which is all a validator can say about a ciphertext. |
| `migrations/*-seed-demo*.js` | Optional demo seed, **two** files. No-op unless `SEED_DEMO=true`. |
| `lib/encryption.js` | The CSFLE half (ADR-029): opens a `ClientEncryption` against the master key at `CSFLE_MASTER_KEY_PATH`, mints or reuses one data key per collection in `<db>.__keyVault`, and encrypts stored documents in place so an `alter-*-encrypted` migration can convert a populated collection. |
| `lib/mongoUrl.js` | The `://user:pwd@` + `authSource` assembly, shared by the config (`MONGO_DEV_*`) and the tests (`MONGO_TEST_*`) so the two cannot drift. |
| `test/` | Six vitest suites — the migration replay plus five unit suites. Layout and traps: `REPO.md`. |
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

⚠️ **`migrate:status` against dev is trustworthy only from 2026-08-01 on.** Before that the database was
still the retired runner's: no `changelog` at all, so every file read as PENDING and `migrate:up` would
have died on the first one with `Collection already exists`. It was dropped and rebuilt from the
migrations with `SEED_DEMO=true`. The one thing not reproduced is `login.firstLogin` / `login.lastLogin`
on the demo admin, which the app rewrites on the next login.

## Module system

Migrations and `migrate-mongo-config.js` are **CommonJS** and stay that way — the config declares
`moduleSystem: 'commonjs'` and migrate-mongo loads them through it.

`test/migrations.test.mjs` is **ESM**, and has to be: migrate-mongo is ESM-only from v12. Its CommonJS
wrapper is a `Proxy` whose every property access returns a *Promise*, so under `require` the whole API
reads as undefined and the first call dies with `TypeError: mm.config.set is not a function`.

## Authoring migrations — rules

- **Migrations are immutable.** Never edit one that may already be applied anywhere — its `changelog`
  entry means it will not re-run. Change a schema by adding a NEW migration (`<ts>-alter-<coll>.js` with
  `collMod`).
- **The shapes live in `lib/schemas/`, not in the migration.** This reverses the rule this repo carried
  until 2026-08-03. That rule (inline every `validator` + `indexes`, duplication intentional) was not
  sustainable — 13 identical product validators, 5 restatements of the shop collection, 3 of `shopOwner`,
  about 3 500 of 5 100 lines copies, and four Qodana `DuplicatedCode` findings that no edit inside
  `migrations/` could clear. Its justification depends on a database existing that cannot be rebuilt, and
  **none does here**: one `Dev` environment plus a throwaway test database, both replayable from these
  files. So the rule is replaced, not broken — **a change under `lib/schemas/` is followed by a full
  rebuild of every database that has run these migrations, in the same piece of work.** The moment an
  unrebuildable database exists, that directory freezes and the old rule returns.
- **`migrations/` itself keeps immutability intact.** Adding a parameter to a builder so a *new* migration
  can express a *new* shape is normal work. Changing what an existing call site produces is the same
  forbidden edit, one file further away.
- **A helper cannot live in `migrations/`.** migrate-mongo treats every `*.js` under `migrationsDir` as a
  migration, and `test/migrations.test.mjs` reads the directory the same way. Helpers go in `lib/`, in
  CommonJS like everything else.
- **Native driver API, not mongosh.** `up(db)` / `down(db)` receive the driver `Db`:
  `db.createCollection(name, { validator, validationLevel, validationAction })`,
  `db.collection(name).createIndex(key, options)`, `db.collection(name).drop()`. For BSON types,
  `require('mongodb')` → `ObjectId`, `Decimal128`, and `new Date(...)`; there is no `ISODate` /
  `NumberDecimal` global.
- Standard shape — a create is one call, an alter is a `collMod` per direction:

```js
// <ts>-create-example.js
const { migrationCreation } = require('../lib/schemas/collection');
const COLLECTION = 'example';
const validator = { $jsonSchema: { /* … or a builder from lib/schemas/ */ } };
const indexes = [{ key: { field: 1 }, options: { name: 'field_unique', unique: true } }];
module.exports = migrationCreation(COLLECTION, validator, indexes);

// <ts>-alter-example.js
const { setValidator } = require('../lib/schemas/collection');
module.exports = {
  async up(db) { await setValidator(db, COLLECTION, validatorExample({ newField: true })); },
  async down(db) {
    // Data first, validator second — `collMod` does not re-validate what is already stored, and
    // the reverted shape is `additionalProperties: false`.
    await db.collection(COLLECTION).updateMany({ newField: { $exists: true } }, { $unset: { newField: '' } });
    await setValidator(db, COLLECTION, validatorExample({}));
  }
};
```

## Collections & schema conventions

- Validators are `strict` + `additionalProperties: false` — app writes must match the shape exactly.
  Adding an app field means adding a migration that updates the validator.
- `__v` (int) allowed everywhere, for Mongoose `versionKey` compatibility.
- Recurring state fields: `deleted` (date or bool), `disabled` (bool), `waitApprov` (bool).
- Passwords: bcrypt, exactly 60 chars (`minLength`/`maxLength: 60`); hashes are `$2y$14$…`.

⚠️ **Adding a required field to a populated collection takes three steps, not two: widen → backfill →
narrow.** Backfill-first fails immediately, because the write runs under the OLD
`additionalProperties: false` validator that has never heard of the field. Narrow-first fails later and
worse: `collMod` does not re-validate stored documents, so every existing document stays valid where it
sits and becomes unwritable on its next update, surfacing weeks later on whoever edits an address.
`down` needs the same three steps mirrored, for the exactly symmetric reason — its `$unset` runs under
the validator that *requires* the field. `20260804010000-alter-company-public` is the worked example in
both directions, via the builder's `publishedRequired: false` flag.

### company — the registered company, and the shop

Its own collection since `20260803000000`. It used to be an embedded object on the shop collection, with
two globally unique indexes on `company.vatNumber` and `company.certifiedEmail` — so a company running
three shops stored its details three times and was refused at the second as a duplicate. The extraction
makes the real cardinality expressible: one shopOwner owns N companies (`idShopOwner`, **required**). The
two unique indexes moved to `vatNumber_unique` / `certifiedEmail_unique` on `company`, **unchanged in
scope** — one VAT number is one company, whoever registered it — plus a non-unique `idShopOwner_list` for
the one list query.

Three fields differ from the old sub-document: `registryExtract` gained `maxLength: 1000` (it is a file
path, not the file), `taxCode` is new (exactly 11 — a legal entity's tax code, not the 16-character
personal form — optional, not unique), and `address` is a full street block including a **required**
tuple-form `position`. `deleted` is an optional **date**, the spelling `shopOwner` uses: `companyDel`
stamps it instead of removing the document, and every read path filters `{ $exists: false }`. A
soft-deleted company keeps both unique entries, so its VAT number stays occupied and it cannot be
registered again — the same behaviour `shopOwner.login.email_unique` has, and why neither index carries a
`partialFilterExpression`.

`20260804010000-alter-company-public` made it the shop listing: `publicName` (the trading name —
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
| `address.position_2dsphere` | `companiesNearby` and the map. The create migration deferred it; something queries by distance now. |
| `published_list` (`{published, deleted}`) | the two equality predicates every public read carries |
| `published_publicName` | `/shops` — `published_list` answers the *filter* only |
| `published_city_publicName` | `/shops/:city` |
| `search_text` (`publicName` 10 / `description` 1, `english`) | the company half of `search` |

⚠️ **An index serves a sort only from the keys *after* the last equality predicate**, which is why the
last two exist: `companies` sorted by `publicName` handed every match to a blocking SORT stage. The
failure mode at the top end is an **error**, not slowness — a blocking sort is capped at 32 MB and
`allowDiskUse` is off by default on `find`, so past that the query returns
`QueryExceededMemoryLimitNoDiskUseAllowed`. A collection may carry **at most one** text index, so
`search_text` is the only one this collection will ever have. `published_list` was deliberately **left
installed** even though it is now an exact prefix of `published_publicName`: `company` is written a
handful of times per shop, so the spare index costs almost nothing. `item` made the opposite call.

### item — what a shop sells

Created by `20260804030000`. Required: `idCompany`, `idCategory`, `name`, `description`, `slug`,
`published`. Both references are unenforced, as `company.idShopOwner` is; the resolvers check them.

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

⚠️ **The two `_name` indexes were three-key `idCompany_published` / `idCategory_published` until
`20260804050000-index-item-listing-sort` replaced them** — both listings sort by `name`, which was in
neither. Measured on 100 000 items in one category: 100 000 keys / 100 000 docs / 170 ms before, 24 keys /
24 docs / 3 ms after, for the same 24 items. Here the superseded pair was **dropped** rather than left
installed: they are exact prefixes of their replacements, and `item` is the write-heavy collection of the
three. `funItemCategoryDelete` filters `{ idCategory, deleted }` with no sort and is served by the
`idCategory` prefix either way; `companyItems` uses `idCompany_list`, a different key order, untouched.

⚠️ **`search_text` is not compound.** MongoDB requires an equality predicate on every non-text prefix key,
so scoping it to `idCompany` would make platform-wide search unable to use it at all. Per-shop search is a
filter applied after it. No `2dsphere`: an item is at its shop, so "items near me" goes through
`company.address.position_2dsphere`, and a copied point would go stale on the first address change.

### itemCategory — the platform taxonomy

`20260804020000`. Two levels, admin-written. `name`, `slug`, `position` required; `idParent` optional —
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

`20260804000000`, and the first collection whose validator is not a bare `$jsonSchema`: it is
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

⚠️ **A `collMod` on this collection must restate *both* clauses.** `collMod` replaces a validator
wholesale; passing the `$jsonSchema` half alone silently drops the `$expr` rule, and nothing fails until a
dangling pointer is written.

### shopOwner

- `notes` (top level, optional, `maxLength: 2000`) is what an **operator** wrote *about* an account, which
  is why it is not inside `personalData` — that is what the shop owner declared about themselves. Nothing
  in the ShopOwner tier reads it: `marketplace-dev-authenticated-*` does not load this model at all, so the
  field cannot leak to the shop owner. Added by `20260802000300-alter-shopOwner-position-note.js`.
- `personalData.address.position` (same migration) is the same GeoJSON point as `company.address.position`,
  in the same tuple form — but **optional**, with no `2dsphere` index. Deliberate: a required point would
  leave every shop owner written before the migration unwritable, and there is nothing to backfill it
  *from* — a coordinate cannot be derived from a stored street address without geocoding every one. It
  fills in the first time an address is picked from the operator app's autocomplete.

### Geo

`position` is `{ type: "Point", coordinates: [<lng>, <lat>] }`, GeoJSON order, indexed `2dsphere` as
`address.position_2dsphere` where an index exists. Each axis has its own `items` schema — longitude ±180,
latitude ±90 — and both accept `['double', 'int', 'long']`.

⚠️ Three things about this are easy to get wrong, and all three were wrong in the original mongosh scripts:

- **The order** was `[lat, lng]`, which puts the demo company thousands of km from where it belongs the
  instant anything reads it as GeoJSON. No validator can catch it, because both orders are well-formed —
  the suite asserts it with a real `$near` query instead.
- **The type** was `decimal`, which `marketplace-common`'s `coordinates: { type: [Number] }` can never
  produce; the resolver answered 500 on every call because of it.
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
gets a test, and `test/migrationGuards.test.mjs` is the file to copy. Mechanics, bypasses and the Qodana
exclusions: `REPO.md`.

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
