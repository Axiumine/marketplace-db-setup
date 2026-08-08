# What this is

MongoDB schema-migration project for **Marketplace**, a multi-tenant marketplace platform — nothing
here may presume what is sold, and there is no longer a catalogue at all; the old collection names
were the only domain-specific thing about it, and they are gone (see below). It contains no
application code — only database migrations that create collections, attach `$jsonSchema`
validators, build indexes, and (optionally) seed demo data.

⚠️ **Scope: tenant skeleton, the customer identity, and the catalogue.** There is still no order or
cart collection, and no shop collection either. The six collections here today are `admin`,
`shopOwner`, `company`, `user`, `itemCategory` and `item`.

`user` (`20260804000000`) is the **end customer** — the person who will place orders. It exists
because role on this platform is which collection you authenticate against, so the customer tier needs
a collection of its own rather than a `role` field on `shopOwner`. Its account carries what a customer
needs to be reached and delivered to; nothing about ordering is in it yet, and cart/order/payment still
have no model anywhere.

⚠️ **`item` and `itemCategory` (`20260804020000`, `20260804030000`) are not a dropped catalogue
coming back.** The 13 product-type collections, the delivery-costs collection, the shop collection
and its per-shop taxonomy collection were dropped on 2026-08-04 and none of them returns under any
spelling — see *Collections & schema conventions* below and the parent workspace's `CLAUDE.md`. What
replaces them is **one** domain-neutral collection plus a taxonomy: the 13 differed in their
*category*, not in their shape, and encoding a category as a collection name is what made adding a
fourteenth a migration instead of a document. **A shop IS a `company`** — there is no `shop` collection
and there is not going to be one — so the chain is `shopOwner ──idShopOwner──> company ──idCompany──>
item`, and `20260804010000-alter-company-public` is what gave `company` the fields a storefront
renders. **Nothing here may presume what is sold.**

⚠️ **Every name in this repo is English** — collections, fields, builders, migration filenames,
validator `description` strings. See *Naming*.

Migrations are managed by **[migrate-mongo](https://github.com/seppevs/migrate-mongo)**,
the de-facto Node.js migration tool. It replaced a hand-rolled runner that tracked a
per-collection revision in a `revApp` collection (`Utility.js` + `migrationDev.sh`) —
that system is gone; do not reintroduce it.

VCS is **git**; the history is shallow and nothing predates it. Commits follow Conventional Commits
(`feat:`, `fix:`).

## Layout

| Path | Purpose |
|---|---|
| `migrate-mongo-config.js` | Config. Builds an authenticated URL from `.env` (`MONGO_DEV_*`); `changelog` collection tracks applied migrations. |
| `migrations/*.js` | One migration per file, applied in filename (timestamp) order. `<ts>-create-<coll>.js` = collection + validator + indexes. |
| `lib/schemas/*.js` | The validator shapes every migration is built from (`account.js`, `collection.js`, `geo.js`, `shopOwner.js`, `user.js`, `company.js`, `item.js`, `itemCategory.js`), each builder carrying **every** state its collection has had. Mostly `$jsonSchema`, but not always — `user.js` always returns an `$and` pair and `company.js` returns one once `publicFields` is on. **Read `lib/schemas/README.md` before touching it** — an edit here changes what an already-applied migration means. |
| `migrations/*-seed-demo*.js` | Optional demo/dev seed, in **two** files. No-op unless `SEED_DEMO=true`. |
| `test/migrations.test.mjs` | Vitest integration suite. Runs migrations against a throwaway MongoDB (`MONGO_TEST_*`). |
| `test/migrationGuards.test.mjs` | Unit suite for what a working server never produces: the `IndexNotFound` re-throws and the `SEED_DEMO=true` halves of the two seed migrations, driven with a fake `db`. |
| `test/migrationCalls.test.mjs` | Every migration's `up` and `down` driven against a **recording** fake `db`, with the ordered call log frozen as a snapshot — what the replay cannot see: intermediate states, `updateMany` filters, call ordering. Runs each migration in both `SEED_DEMO` states. |
| `test/mongoUrl.test.mjs` | Unit suite for every branch of the URL assembly in `lib/mongoUrl.js`. |
| `test/migrateMongoConfig.test.mjs` | Unit suite for `migrate-mongo-config.js`, loaded under stubbed fake `MONGO_DEV_*`. |
| `vitest.config.mjs` | The suites' only config: serial, 30 s timeouts, **coverage gated at 100% on every metric** (rationale in its header, including why there is no pool setting). |
| `vitest.mutation.config.mjs` | What Stryker runs the suites under — same shape, without the coverage gate (Stryker reruns per mutant, and a threshold there fails every run). |
| `stryker.config.mjs` | Mutation config. `concurrency: 1` (one real database), `vitest.related: false`, `thresholds.break: 100`. |
| `.githooks/pre-commit` | Secret guard, then `yarn test:cov`, then Qodana. Both gates are skipped when nothing staged can move a verdict, so a docs-only commit pays nothing. |
| `.githooks/pre-push` | Three blocking gates: `yarn test:cov` (the migration replay at 100% coverage), `yarn test:mutation` (Stryker at 100), then Qodana. Not lint — that omission alone is argued in the hook's own header. |
| `qodana.yaml` / `qodana.sh` | The scan config and its runner. Gated on severity (critical 0 / high 0), on coverage (100 total / 100 fresh), plus the SCA and license checks. |
| `lib/mongoUrl.js` | The `://user:pwd@` + `authSource` assembly, shared by the config (`MONGO_DEV_*`) and the test (`MONGO_TEST_*`) so the two cannot drift. |
| `.env` | Dev Mongo credentials + connection string. Gitignored. |
| `env` | Template for `.env`. |
| `setup/mongodb.js` | Manual one-off runbook: create DB users, dump/restore, empty DB. Prerequisite, not run by migrate-mongo. **Gitignored** — it holds real users, passwords and internal hostnames. A clone does not get it; ask whoever runs the cluster. |
| `setup/redis.txt` | Redis ACL snippet. **Gitignored**, alongside `setup/mongodb.js`. |

## Prerequisites

1. `yarn install` (pulls `migrate-mongo`, `mongodb`, `dotenv`).
2. Populate `.env` (copy from `env`). Required: `MONGO_DEV_UDBOWNER`, `MONGO_DEV_PWD`,
   `MONGO_DEV_AUTH_ADMIN`, `MONGO_DEV_DB`, `MONGO_DEV_CONN_STRING`. Optional `SEED_DEMO`.
   To run the test suite, also fill `MONGO_TEST_CONN_STRING`, `MONGO_TEST_UDBOWNER`,
   `MONGO_TEST_PWDDBOWNER`, `MONGO_TEST_AUTH_ADMIN` and `MONGO_TEST_DB` — see *Testing*.
3. The DB user must already exist — create it with the snippets in `setup/mongodb.js`. That
   applies to the test user too: it needs `dbOwner` on the test DB, because the suite drops it.

## Running migrations

```sh
yarn migrate:status          # list applied / pending
yarn migrate:up              # apply all pending
yarn migrate:down            # revert the LAST applied migration (one step)
yarn migrate:create <name>   # scaffold a new timestamped migration file
```

Config is auto-discovered as `migrate-mongo-config.js` in the repo root — run from
there. `migrate-mongo-config.js` injects `user:pwd@` into `MONGO_DEV_CONN_STRING` and
appends `authSource=$MONGO_DEV_AUTH_ADMIN`; `databaseName` = `MONGO_DEV_DB`.

⚠️ **`dbMarketplaceDev` only became migrate-mongo-managed on 2026-08-01.** Until then it was still the
database the retired hand-rolled runner had built: it had no `changelog` at all, so `migrate:status`
reported all 22 files PENDING and `migrate:up` would have died on the first one with `Collection
already exists`. It also carried four collections no migration creates — `revApp` (19 revision documents,
the old runner's state), `user`, `loginsubdocs`, `resetpwdsubdocs`. It was dropped and rebuilt from
the 22 migrations with `SEED_DEMO=true`; the only thing not reproduced was `login.firstLogin` /
`login.lastLogin` on the demo admin, which the app rewrites on the next login. Treat `migrate:status`
against dev as trustworthy from that point on, and not before it.

## Testing

`test/migrations.test.mjs` runs the real migrations against a MongoDB and asserts the
resulting state. It runs under **vitest** (`vitest.config.mjs`), serially, with 30 s test and
hook timeouts — the same shape the nine services give their integration project, so one runner
covers the whole platform. It used to run on the built-in `node:test` runner; the assertions are
unchanged (`node:assert/strict` is still what they call).

```sh
yarn test           # connection read from .env — no args needed
yarn test:seed      # same, with SEED_DEMO=true (also asserts the demo seed)
```

The connection is resolved from `.env`, so you don't pass it on the command line:

| Setting | Precedence (first non-empty wins) |
|---|---|
| URL | `TEST_MONGO_URL` (inline) → `MONGO_TEST_URL` (`.env`, one ready-made URL) → assembled from `MONGO_TEST_CONN_STRING` + `MONGO_TEST_UDBOWNER` + `MONGO_TEST_PWDDBOWNER` + `MONGO_TEST_AUTH_ADMIN` (**recommended** — this is the shape the `env` template has) → the dev URL from `MONGO_DEV_*` |
| DB | `TEST_MONGO_DB` → `MONGO_TEST_DB` (`.env`) → `marketplace_migration_test` |

The third row is the one that matters, and it is easy to get wrong: the `env` template stores
the test connection **split into pieces**, exactly like `MONGO_DEV_*`, not as a single URL. A
fully populated `MONGO_TEST_*` block therefore does nothing at all unless something assembles
it — which is what `lib/mongoUrl.js` is for. `MONGO_TEST_URL` (singular, ready-made) is still
honoured and still takes precedence, but nothing in the template produces it.

The suite uses the **DB OWNER** pair, not the R/W pair: it calls `dropDatabase()` **before and
after**, and the migrations create collections, validators and indexes — none of which a
read/write user may do. `MONGO_TEST_UDBRW` / `MONGO_TEST_PWDDBRW` are in the template but are
deliberately unread here; nothing in this repo tests the least-privilege user.

It **refuses to run when the test DB equals `MONGO_DEV_DB`**. That guard is the only thing
standing between a typo and a dropped dev database, since `MONGO_TEST_CONN_STRING` may well
point at the same cluster — here it does, and only the DB name differs
(`dbMarketplaceTest` vs `dbMarketplaceDev`).

⚠️ **The test database is named three times and all three must agree**: `MONGO_TEST_DB`,
`MONGO_TEST_AUTH_ADMIN`, and the database path of `MONGO_TEST_CONN_STRING`. This repo owns
`dbMarketplaceTest`; every other repo that runs integration tests owns a **different** database of
its own (`dbMarketplaceTestCommon`, `dbMarketplaceTestPublicRes`, …), because each suite drops its own.
So copy the four user/password values out of this `.env` and nothing else — the services'
`vitest.mongo.mts` refuses to build a URL when the three names disagree.

Because the authSource is the test database itself rather than `admin`, the two users have to
exist in each of those databases. `setup/mongodb.js` carries the loop that creates them.
Dropping a database does not remove them: MongoDB keeps every user document in
`admin.system.users` whatever its authentication database is.

There are **five suites, 86 tests**, against `dbMarketplaceTest` with the `MONGO_TEST_*` block
filled in. `yarn test` reports **84 passed | 2 skipped** and `yarn test:seed` **86 passed**; both
should exit 0. The two are the seed-content tests, which `test.skipIf(!SEEDED)` stands down when
there is nothing seeded to look at — the counts they would have read are asserted as zero by the
seed-count test either way, so skipping them costs no coverage. ⚠️ These counts reflect the suite as
edited when the catalogue landed (`alter-company-public`, `itemCategory`, `item`), which is itself
after the `user` addition and after the sweep that dropped the shop collection, its per-shop
taxonomy collection and the 14 product-type collections, and renamed everything to English (see
*Collections & schema conventions* and *Naming*) — run `yarn test` to confirm them on a real database
rather than trusting the number in
this file after the next change here. It is fast because it is a handful of tests against a local
replica set, so a long run means something is wrong, not that the suite is heavy.

### The four other suites, and the 100% gates

`test/migrations.test.mjs` was the only suite here for the whole life of the repo, and both this file
and `vitest.config.mjs` argued that coverage should not be gated: a statement gate over migration
files would mostly measure whether every migration was added to the suite's `MIGRATION_FILES` list.
That was a fair reading while a real MongoDB was the only thing driving the code, because **a working
server only ever produces the happy answer**. It stopped being fair the moment the unit suites
landed:

- `test/migrationGuards.test.mjs` drives the five guarded `dropIndex` calls with a fake `db` that
  fails the drop — once with `IndexNotFound`, which the guard must swallow, and once with
  `Unauthorized`, which it must re-throw. Swallowing the second is the bug worth catching: it turns a
  migration that did nothing into a migration that reports success. It also runs both seed migrations
  with `SEED_DEMO=true` and asserts that each `down` deletes exactly the `_id`s its `up` wrote, that
  the company points at the seeded shop owner, and that the demo position is `[-73.98566, 40.74844]` —
  longitude first, New York and not Kazakhstan.
- `test/mongoUrl.test.mjs` covers every branch of `lib/mongoUrl.js`: credentials after the scheme,
  only the first `://` replaced, percent-encoding, `&authSource=` when a query already exists, no
  query parameter at all for `undefined` / `''` / `null`, and a missing piece reported under the
  caller's own variable name.
- `test/migrateMongoConfig.test.mjs` loads `migrate-mongo-config.js` under stubbed **fake**
  `MONGO_DEV_*` values and asserts the whole exported object with one `deepEqual` — a misspelled key
  there is not an error, it is a migrate-mongo default silently taking over. It had no test of any
  kind and the coverage gate did not notice: v8 only reports files that were **loaded**, so a file no
  suite requires is absent from the report rather than shown at 0%, and `thresholds: { 100: true }`
  passed over it. The mutation run is what surfaced it, as 18 "no coverage" mutants. ⚠️ The stubbing
  happens **before** the load and that is a secrecy requirement, not a convenience — dotenv does not
  override a variable already present in the environment, which is what keeps the real `.env`
  credentials out of the assertions and out of any failure diff.
- `test/migrationCalls.test.mjs` is the backstop: every migration's `up` and `down` against a
  recording fake `db`, with the ordered driver-call log frozen as a snapshot. See its header — the
  short version is that final state cannot see an intermediate one, and `alter-company-public` is
  widen → backfill → narrow, where skipping the widen leaves the end state identical.

The repo now sits at **100% statements / branches / functions / lines** and at a **100 mutation
score**. Coverage is gated in `vitest.config.mjs` (`thresholds: { 100: true }`), in `qodana.yaml`
(`testCoverageThresholds`) and in both git hooks; mutation is gated in `stryker.config.mjs`
(`thresholds.break: 100`) and in `.githooks/pre-push`. **Never lower either to accommodate a new
migration — drive its uncovered branch instead**, and copy `migrationGuards.test.mjs` to do it.

⚠️ **The two measure different things and the gap here was enormous.** Coverage asks whether a line
ran; mutation asks whether a test would have *failed* had it been wrong. This repo sat at 100%
coverage and scored **52.92%** the first time Stryker ran — 383 survivors out of 856. They were not
exotic: `maxLength: 150` → `151`, `unique: true` → `false`, `'2dsphere'` → `''`, a `bsonType` list
→ `[]`. Every one of those is a validator or an index that would have shipped wrong, and the reason
none broke a test is that the assertions were **partial** — `assert.ok(names.includes(idx))` reads a
name and nothing else, and `jsonSchemaOf(v).title` reads one property of a validator with a hundred.
The three things that closed it, in order of how much they killed:

1. **Freezing the whole shape.** `migrations.test.mjs` grew two tests that snapshot each collection's
   entire `validator` and entire index list, read back from the real database.
2. **Freezing the whole call log**, in `migrationCalls.test.mjs`.
3. **Deleting code no test could reach.** `migrationCreation`'s `indexes = []` default,
   `address`'s `positionRequired = false` default and the whole of `COORDINATE_DECIMAL` were
   unreachable — see `lib/schemas/README.md`. An equivalent mutant is killed by changing the code,
   never by lowering the threshold and never with `// Stryker disable`.

⚠️ **A top-level `const` is evaluated once per process, and that is why `test/migrationCalls.test.mjs`
evicts the whole of `lib/` from the CommonJS cache before each load.** `lib/schemas/*` is mostly
module-level constants (`COORDINATE_TUPLE`, `EMAIL_VERIFY`, `PUBLIC_FIELDS`, `NOTE`), and Stryker
switches a mutant on per **test** — so a builder loaded before the switch hands every test the
unmutated object no matter how thoroughly it is asserted. That alone was 54 survivors, and only the
shapes built inside a function body (`position()`, `address()`) were ever caught. Re-requiring the
directory inside the test is what puts the const under the mutant. Keep the eviction if you touch
that file; the modules are pure data, so nothing else observes the reload.

⚠️ **Load a CommonJS file the same way every other caller in the process loads it.** Both unit suites
use `createRequire(import.meta.url)`, not `import`, and so does `migrations.test.mjs` for
`buildMongoUrl`. migrate-mongo requires a migration through node's own loader; an `import()` of the
same path goes through vite, and v8 then holds **two scripts for one path with different byte
offsets**. Merging coverage reports whose ranges do not line up does not union them, it drops them.
The symptom is a total that moves between runs: measured at 91.75% for the replay alone, 85.56% and
87.62% on two runs with `import()`-based unit suites, and — from the one `import` left in
`migrations.test.mjs` — 99.48% on roughly one run in six, with `lib/mongoUrl.js` reporting both
function bodies uncovered while a suite exhaustively tested them. Neither
`poolOptions: { forks: { singleFork: true } }` (removed in vitest 4, silently ignored) nor
`isolate: false` (deterministic at the *wrong* number) fixes it; loading the file the same way
everywhere does, and eight consecutive runs confirm it.

⚠️ **If the `MONGO_TEST_*` block is empty, the suite does not skip — it fails, seventeen times,
on a permissions error.** `resolveUrl()` falls through to the dev URL, while the DB name falls
through to `marketplace_migration_test`. The dev user has no rights outside its own database, so the
first `dropDatabase()` in `before` throws and takes every test with it:

```
MongoServerError: not authorized on marketplace_migration_test to execute command { dropDatabase: 1, … }
```

Those are one failed hook, not seventeen problems. This is worth knowing because it contradicts the
"skips when nothing is configured" line above: the dev-URL fallback means *something* is always
configured, so the skip only happens if `migrate-mongo-config.js` itself throws.

A failing run also **does not exit** — the Mongo client keeps retrying, so node stays alive on
the open handle long after the reporter has printed. Combined with `sed`/`grep` block-buffering,
that looks like a total hang: a piped `yarn test` sat for over ten minutes with an empty output
file while the tests had already finished. A *passing* run exits on its own, so if a run does not
return, read it as the auth failure rather than as slowness. Redirect to a file instead of
piping, either way.

Assertions: every migration applies and is logged in `changelog`; `up` is idempotent;
all 6 collections exist with strict validators; every expected index is
present by name; validators reject bad docs / accept good ones (incl. the `city`
`maxLength` fix and `company`'s per-axis coordinate bounds); a `$near` query resolves the seeded
company to midtown Manhattan rather than to its transposed reading; demo-seed counts match `SEED_DEMO`; `down`
reverts everything (collections dropped, `changelog` emptied).

The four `shopOwner` table indexes (`20260801000100`) additionally get their **key documents**
asserted with `deepEqual`, not merely their names: key order carries the ESR ordering, and the
trailing direction has to be uniform across every sort component (`deleted`/`disabled` excluded —
those are matched, not sorted) or a single index stops serving both ASC and DESC. Their `down` is
asserted to converge from a partially applied state, since `dropIndex` throws `IndexNotFound`.

`20260802000100`'s single-field `registeredAt_series` index is asserted by name in the same
`EXPECTED_INDEXES` table. It is a plain index with no `down`-specific behaviour of its own, so it gets
no dedicated test.

Both `collMod` alters get the same pair of assertions — that the rest of the validator survived the
wholesale replace, and that their own `down` restores the previous shape. ⚠️ `mm.down` reverts the
**most recent** migration, so any newer migration — an alter or not — changes what the older
down-tests pop, and this is the single most common way adding a migration breaks this suite. Four
tests carry a pop count, and **every one of them has to be extended for every migration added** (the
newest one always pops `1`, and every older one gains a pop):

|Test|Pops|`up` re-applies|
|---|---|---|
|`emailVerify down strips the field…`|12|the same|
|`the table indexes drop on down…`|11, then 11 more after the re-`up`|11|
|`the shopOwner alter down strips both fields…`|9|9|
|`the demo seed down removes exactly what it wrote…`|7|7|

Each pop is spelled out as its own `await mm.down(db, client)` with the migration filename in a
trailing comment, so a shifted ladder reads as a diff rather than as a changed integer. The
`ABOVE_POSITION` const and its `downToBeforePosition()` helper are **gone** — they existed to pop past
the alter migration for the shop collection's position field, and that migration went with the shop
collection on 2026-08-04.

`20260804050000-index-item-listing-sort` is the newest migration, so it is what every down-test above
pops first. The head has moved four times in two days — `20260803142526-seed-demo-company`, then
`20260804000000-create-user`, then `20260804030000-create-item`, now this — and the seed test is the
one that shows what each shift costs: it used to be the head and popped once, and it pops seven now.
Every one of the four counts above went up by one when `user` landed, by three more when the catalogue
did, and by two more when the public-read indexes did.

⚠️ **Two validators are not a bare `$jsonSchema`** — `user`'s always, and `company`'s since
`20260804010000` — they are `$and: [{ $jsonSchema }, { $expr }]`, so `options.validator.$jsonSchema`
is `undefined` on both. The suite carries `jsonSchemaOf()` for the unwrap; use it rather than reaching
for `.$jsonSchema` when adding an assertion, including one that only ever looks at `company`. See
`lib/schemas/README.md` for why the second clause exists.

⚠️ **The seed being newest also means a re-`up` re-seeds.** Read that as the general rule — an "and
now it is empty" assertion downstream of a seed has to name by `_id` what it expects to be missing
rather than asserting a count of zero.

`20260802000300-alter-shopOwner-position-note`'s own tests cover both fields it adds: that `position`
landed inside `personalData.address` in tuple form and is **not** in that object's `required` array,
that `notes` is a top-level string capped at 2000 and not required, that the restated
`emailVerify`/`resetPwd` rules survived the wholesale `collMod`, and that `down` `$unset`s both from
stored documents — not merely from the validator, since the restored shape is
`additionalProperties: false` and a document still carrying either would fail its next write.

The company fixture helper is `validCompany()`. Its `vatNumber`/`certifiedEmail` come from the shared
`uid()` counter because both carry a global unique index and a literal collides on the second insert
of a run — and it carries `published: false`, which is not decoration: `20260804010000` put that field
in `required`, so a fixture without it stopped being a valid company and every `accepts('company', …)`
in the file would have started failing for a reason unrelated to what it was testing.

`validItemCategory(over)` and `validItem(over)` are the catalogue fixtures, both taking an override
object because most of their tests differ from the minimum by one field. `validItem` mints its two
references rather than resolving them — nothing checks them — so a test only has to pass the same
ObjectId twice when it asserts on a per-company or per-category read.

The symptom when the pop counts are not extended is not a clear failure at the count — it is a
**cascade**: the suite runs serially against one database, so a test that stops one migration short
leaves the following tests reading a validator shape they never asked for, and the run reports a dozen
unrelated assertion failures (`Missing expected rejection`, and a `down reverts every migration` that
dies partway through). Read a burst like that as a shifted pop count, not as a dozen problems.

## How migrate-mongo tracks state

- A `changelog` collection records each applied migration filename + timestamp. `up`
  applies every file not yet in `changelog`, in filename order; `down` reverts the most
  recent. This replaces the old `revApp` revision integers.
- Migration order is the filename timestamp prefix (`YYYYMMDDHHMMSS-…`), so
  `migrate:create` (which timestamps for you) keeps ordering correct. There are no
  FK constraints in Mongo, so create-order between collections is cosmetic.
- A `changelog_lock` collection serialises concurrent runs. **This only started working at
  migrate-mongo v12** — v11 accepted `lockCollectionName` and ignored it, so the key sat in
  the config doing nothing for the whole life of the repo. v12+ also requires `lockTtl`
  alongside it: leave it out and the TTL index is built with `expireAfterSeconds: null`,
  which Mongo rejects (`TTL index 'expireAfterSeconds' option must be numeric`) and every
  command fails. It is set to 90 seconds here — long enough for a full `up` (~0.5 s), short
  enough that a crashed run clears itself instead of wedging the database. `lockTtl: 0`
  would turn locking back off.

## Module system

The migrations and `migrate-mongo-config.js` are **CommonJS** and stay that way — the
config declares `moduleSystem: 'commonjs'` and migrate-mongo loads them through it.

`test/migrations.test.mjs` is **ESM**, and has to be: migrate-mongo is ESM-only from v12.
It does ship a CommonJS wrapper, but that wrapper is a `Proxy` whose every property access
returns a *Promise*, so under `require` the entire API reads as undefined and the first call
dies with `TypeError: mm.config.set is not a function`. Importing it is the only way to get
the real object. That is why the file is `.mjs`, and why `vitest.config.mjs` includes
`test/**/*.test.mjs`.

## Authoring migrations — rules

- **Migrations are immutable.** Never edit a migration that may already be applied in
  any environment — its `changelog` entry means it won't re-run. To change a schema,
  add a NEW migration (e.g. a `<ts>-alter-<coll>.js` with `collMod`).
- **The shapes live in `lib/schemas/`, not in the migration.** This reverses the rule this repo
  carried until 2026-08-03, which said each file must inline its own `validator` + `indexes` and
  that duplication was intentional. It was not sustainable: 13 identical product validators, 5
  restatements of the shop collection, 3 of `shopOwner` — about 3 500 of 5 100 lines were copies,
  and Qodana's four `DuplicatedCode` findings could not be cleared by any edit inside `migrations/`.
  The old rule's justification (an edit to a shared helper retroactively changes an applied
  migration) depends on a database existing that cannot be rebuilt, and **none does here** — one
  `Dev` environment plus a throwaway test database, both replayable from these files. So the rule
  is replaced rather than broken: **a change under `lib/schemas/` is followed by a full rebuild of
  every database that has run these migrations, in the same piece of work.** The moment an
  unrebuildable database exists, that directory freezes and the old rule comes back.
  `lib/schemas/README.md` is the long form; read it before editing anything there.
- **`migrations/` itself keeps the immutability rule intact.** Adding a parameter to a builder so a
  *new* migration can express a *new* shape is normal work. Changing what an existing call site
  produces is the same forbidden edit, one file further away.
- **A helper cannot live in `migrations/`.** migrate-mongo treats every `*.js` under `migrationsDir`
  as a migration, and `test/migrations.test.mjs` reads the directory the same way. `lib/` is where
  they go, and they are CommonJS like everything else here.
- **Native driver API, not mongosh.** `up(db)`/`down(db)` receive the MongoDB driver
  `Db`. Use `db.createCollection(name, { validator, validationLevel, validationAction })`,
  `db.collection(name).createIndex(key, options)`, `db.collection(name).drop()`. For
  BSON types in seed/data migrations, `require('mongodb')` → `ObjectId`, `Decimal128`,
  and `new Date(...)` (there is no `ISODate`/`NumberDecimal` global).
- Standard shape — a create is one call, and an alter is a `collMod` per direction:

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

Collections: `admin`, `shopOwner`, `company`, `user`, `itemCategory`, `item`. Six, and the names are
English — see *Naming* below.

⚠️ **This used to list sixteen more.** A delivery-costs collection and 13 product-type collections
were the customer-ordering side of the platform, never built out past the catalog shape; the shop
collection and its per-shop taxonomy collection went next. Every one of them was dropped outright —
`create-*` migrations deleted, the alters that touched them deleted, the product-type schema builder
and the shop schema builder deleted, both seed migrations stripped of every insert into them. What
survived that cut was the tenant skeleton — an operator, a shop owner, and the company that shop owner
registered — plus `user`, added afterwards.

⚠️ **`item` and `itemCategory` are the replacement, and they are not those collections renamed.** The
13 differed from one another in their *category*, not in their shape, so the replacement is **one**
domain-neutral collection plus a taxonomy: a fourteenth product type is now a document, not a migration.
`itemCategory` is not a renamed version of the old per-shop taxonomy either: it is platform-wide,
written only by an admin, two levels deep via `idParent`, and has no owner column at all. Nothing
here may presume what is sold, and do not add a per-type collection back.

**The extension seam is now the taxonomy, not the collection list.** Adding a product type means
inserting an `itemCategory` document. A new *collection* is only warranted by a shape `item` genuinely
cannot hold, and that is the bar to clear before writing a migration — the 13 did not clear it.

- Validators are `strict` + `additionalProperties: false` — app writes must match the
  shape exactly. Adding an app field means adding a migration that updates the validator.
- `__v` (int) allowed everywhere for Mongoose `versionKey` compatibility.
- Recurring state fields: `deleted` (date or bool), `disabled` (bool), `waitApprov` (bool).
- **`company` is its own collection since `20260803000000`.** It used to be an embedded object on
  the shop collection holding
  `legalName`/`vatNumber`/`contactPerson`/`administrator`/`uniqueCode`/`certifiedEmail`/`registryExtract`,
  with two GLOBALLY unique indexes on `company.vatNumber` and `company.certifiedEmail` — which meant a
  company running three shops stored its details three times and was then refused at the second shop
  as a duplicate. The extraction makes the real cardinality expressible: one shopOwner owns N
  companies (`company.idShopOwner`, **required**). The two unique indexes moved to `vatNumber_unique`
  / `certifiedEmail_unique` on `company`, **unchanged in scope** — one VAT number is one company,
  whoever registered it — plus a non-unique `idShopOwner_list` for the only list query. Three fields
  differ from the sub-document: `registryExtract` gained `maxLength: 1000` (it is a file path, not the
  file), `taxCode` is new (exactly 11 — the tax code of a legal entity, not the 16-character
  personal form — and optional, and not unique), and `address` is a full street-address block
  including a **required** tuple-form `position`. `deleted` is there too — an optional **date**, the
  same spelling `shopOwner` uses: `companyDel` stamps it instead of removing the document, and every read
  path filters `{ $exists: false }`. It keeps its `vatNumber_unique` / `certifiedEmail_unique` entries
  while deleted, so a soft-deleted company's VAT number stays occupied and the company cannot be
  registered again — the same behaviour `shopOwner.login.email_unique` has, and the reason neither
  index carries a `partialFilterExpression`.
- **`company` became the shop listing in `20260804010000-alter-company-public`, and there is no `shop`
  collection.** A company IS the shop, so everything a storefront renders hangs off this collection:
  `publicName` (the trading name — `legalName` is the registered one and wrong on a customer card),
  `slug` (the whole of `/shop/:slug`, lowercase-and-hyphens by `pattern`, not merely capped),
  `description` (the page body and the text-search target) and `published`. Only `published` is
  required; the other three cannot be, because `collMod` does not re-validate stored documents but does
  govern their next write, and no slug can be derived from a legal name without inventing one.

  Its validator is the second `$and` pair in this repo. The `$expr` half says **a published company
  has a slug and a publicName** — `published: true` with neither is a shop with no URL and a card with
  no heading, and both are cheap to make unwritable. It says nothing about `deleted` on purpose:
  `companyDel` stamps the date and nothing else on both tiers, and the read paths already filter
  `published: true` *and* `deleted: { $exists: false }`.

  Three indexes came with it. `slug_unique` is **partial** on `{ slug: { $type: 'string' } }` —
  a plain unique treats a missing field as one null key, so the second slugless company (and every
  company predates the migration) would be a duplicate of the first; `$type: 'string'` rather than
  `$exists: true`, which would admit an explicit null and put the null keys back. It is global, and
  forced to be: two companies sharing a slug are two shops at one URL. `address.position_2dsphere` is
  what `companiesNearby` and the map run on — the create migration deferred it on the grounds that
  nothing queried companies by distance, and something does now. `published_list`
  (`{ published: 1, deleted: 1 }`) is the two equality predicates every public read carries.

  **Three more came later, in `20260804040000-index-company-public-read`, and they are what stops the
  public shop list from sorting in memory.** `published_list` answers the *filter* and nothing else, so
  `companies` — `{ published: true, deleted: {$exists: false} }` sorted by `publicName` — handed every
  match to a blocking SORT stage; an index serves a sort only from the keys **after** the last equality
  predicate. `published_publicName` (`{ published: 1, deleted: 1, publicName: 1 }`) and
  `published_city_publicName` (`{ published: 1, deleted: 1, 'address.city': 1, publicName: 1 }`) append
  it, one per listing route (`/shops` and `/shops/:city`). ⚠️ The failure mode at the top end is an
  **error**, not slowness: a blocking sort is capped at 32 MB and `allowDiskUse` is off by default on
  `find`, so past that the query returns `QueryExceededMemoryLimitNoDiskUseAllowed`. `search_text`
  (weights `publicName` 10 / `description` 1, `default_language: 'english'`) is the company half of
  `search`; a collection may carry **at most one** text index, so it is the only one this collection
  will ever have. `published_list` was deliberately **left installed** even though it is now an exact
  prefix of `published_publicName`: `company` is written a handful of times per shop, so the spare index
  costs almost nothing, and dropping it is a separate audit. `item` made the opposite call — see below.

  ⚠️ **Adding a required field to a populated collection takes three steps, not two**, and this
  migration is the worked example in both directions. Backfill-first fails immediately: the write runs
  under the OLD `additionalProperties: false` validator, which has never heard of `published`.
  Narrow-first fails later and worse: `collMod` does not re-validate stored documents, so every
  existing company stays valid where it sits and becomes unwritable on its next update, surfacing
  weeks later on whoever edits an address. So `up` is **widen → backfill → narrow**, via the builder's
  `publishedRequired: false` flag. `down` needs the same three steps mirrored, for the exactly
  symmetric reason: its `$unset` runs under the validator that *requires* the field.
- **`itemCategory` (`20260804020000`) is the platform taxonomy, two levels, admin-written.**
  `name`, `slug` and `position` required; `idParent` optional — absent means top-level, present means
  subcategory, and that is the whole level mechanism. `slug` is unique across **both** levels, since
  `/category/:slug` and `/category/:slug/:subSlug` resolve through one flat URL space; the index is a
  plain unique rather than a partial one because `slug` is required here and there are no null keys to
  collide. `idParent_position` backs the two listing reads.

  ⚠️ `position` here is an **int sort ordinal**, not the GeoJSON point every other collection spells
  the same way. And ⚠️ **the depth cap is not in the validator and cannot be**: "my parent must itself
  be top-level" reads a different document, which no collection validator can do. `itemCategoryAdd` /
  `itemCategoryUpdate` in the Admin resource service enforce it.
- **`item` (`20260804030000`) is what a shop sells** — the bottom of
  `shopOwner ──idShopOwner──> company ──idCompany──> item`. Required: `idCompany`, `idCategory`,
  `name`, `description`, `slug`, `published`. Both references are unenforced, as
  `company.idShopOwner` is; the resolvers check them.

  `slug` is unique **per company**, not globally — the one place this collection's URL rules differ
  from the other two. The route is `/shop/:slug/item/:itemSlug`, so the company segment already
  disambiguates, and a global unique would force the second shop to sell a "blue-shirt-2" because of a
  catalogue it cannot see. It is required, unlike `company.slug`: the collection is created empty, so
  nothing is stranded by requiring it.

  ⚠️ **There is no `price`, deliberately.** Cart, order, delivery and payment have no model anywhere
  on this platform, so a price would be a guess at a currency, a precision, a VAT treatment and a
  discount model at once — and Decimal128, the type it wants, is a rejected write everywhere here
  because it cannot survive `.lean()` into GraphQL. It goes in with the ordering tier, in one
  migration, after those questions are answered. The suite asserts the absence.

  Five indexes, each named for the read it serves: `idCompany_list` (the owner's catalogue),
  `idCompany_slug_unique` (the per-company rule, doubling as the item-page lookup),
  `idCompany_published_name` (the public shop page — not redundant with the first, which has `deleted`
  in second position and would fetch and discard every draft), `idCategory_published_name` (the
  category browse, the widest fan-out on the platform) and `search_text`.

  ⚠️ **The two `_name` indexes were three-key `idCompany_published` / `idCategory_published` as
  `20260804030000` created them, and `20260804050000-index-item-listing-sort` replaced them.** Same
  reason as `company` above — both listings sort by `name`, which was in neither, so both did a blocking
  in-memory SORT. Measured on 100 000 items in one category: 100 000 keys / 100 000 docs / 170 ms
  before, 24 keys / 24 docs / 3 ms after, for the same 24 items. Here the superseded pair was **dropped**
  rather than left installed as `published_list` was: they are exact prefixes of their replacements, so
  every plan that could use the short one can use the long one, and `item` is the write-heavy collection
  of the three — a shop owner edits a catalogue, not a registration. `funItemCategoryDelete` on the
  Admin tier filters `{ idCategory, deleted }` with no sort and is served by the `idCategory` prefix
  either way; `companyItems` on both authenticated tiers uses `idCompany_list`, a different key order,
  untouched. ⚠️ `search_text` is **not compound**: MongoDB requires an
  equality predicate on every non-text prefix key, so scoping it to `idCompany` would make the
  platform-wide search unable to use it at all. Per-shop search is a filter applied after it.
  `weights: { name: 10, description: 1 }` stops a term buried in a paragraph scoring like the one the
  customer typed, and `default_language: 'english'` decides stemming and stopwords. No `2dsphere`: an
  item is at its shop, so "items near me" goes through `company.address.position_2dsphere`, and a
  copied point would go stale on the first address change.
- **`user` is the end customer, created by `20260804000000`, and it was the first collection whose
  validator is not a bare `$jsonSchema`** — `company` is the second, since the alter above. It is
  `$and: [{ $jsonSchema }, { $expr }]` — a collection
  validator is a query expression and `$jsonSchema` is only one operator you may put in it. The second
  clause enforces that `defaultAddress`, a top-level ObjectId, either is absent or names the `_id` of
  an element of this document's own `addresses` array. That is a cross-field rule and JSON Schema
  cannot state one at all.

  `defaultAddress` replaces the per-element `default: true` boolean the feature was first specified
  with. The boolean can *represent* two defaults, so "only one" becomes a rule every write path has to
  uphold with a clear-then-set two-step and every read path has to survive being handed a document
  that broke; the pointer cannot represent a second default, so setting one is a single atomic `$set`
  with no window in it. The cost, stated so it is not a surprise: "is this the default?" is a
  comparison against a sibling field rather than a local boolean read.

  Four divergences from `shopOwner`, all argued at the head of `lib/schemas/user.js`: `personalData`
  is **optional** (registration is an email and a password and nothing else), `addresses` is an
  **array** where the shop owner has one, `defaultAddress` has no counterpart, and there is **no
  `waitApprov`** — a customer self-serves, so the only gate between registering and logging in is the
  email confirmation. Its `personalData.contacts` requires none of its members, unlike
  `shopOwner`'s: `login.email` is already the credential, so demanding a contact email would be
  asking for the same address twice.

  No `2dsphere` over `addresses.position`, deliberately: nothing queries customers by distance. Its
  only index is the shared `login.email_unique`.

  ⚠️ A `collMod` on this collection must restate **both** clauses. `collMod` replaces a validator
  wholesale; passing the `$jsonSchema` half alone silently drops the `$expr` rule, and nothing fails
  until a dangling pointer is written.
- `shopOwner.notes` (top level, optional, `maxLength: 2000`) is what an **operator** wrote *about*
  an account, which is why it is not inside `personalData` — `personalData` is what the shop owner
  declared about themselves. Nothing in the ShopOwner tier ever reads it:
  `marketplace-dev-authenticated-*` does not load this model at all, so the field cannot leak to the
  shop owner. Added by `20260802000300-alter-shopOwner-position-note.js`.
- `shopOwner.personalData.address.position` (same migration) is the same GeoJSON point as
  `company.address.position`, in the same tuple form — but **optional**, and there is no `2dsphere`
  index on it. That asymmetry is deliberate: `collMod` does not re-validate stored documents, so a
  required point would leave every shop owner written before the migration unwritable, and there is
  nothing to backfill it *from* — a coordinate cannot be derived from a stored street address without
  geocoding every one. It fills in the first time an address is picked from the operator app's
  autocomplete; until then the account simply has no map.
- Passwords: bcrypt, exactly 60 chars (`minLength/maxLength: 60`); hashes are `$2y$14$…`.
- Geo `position`: `{ type: "Point", coordinates: [<lng>, <lat>] }`, GeoJSON order, indexed
  `2dsphere` as `address.position_2dsphere` where an index exists. Each axis has its own `items`
  schema — longitude ±180, latitude ±90 — and both accept `['double', 'int', 'long']`.

  ⚠️ Three things about this are easy to get wrong, and all three were wrong in the original mongosh
  scripts. **The order** was `[lat, lng]`, which put the demo company 5 000 km from Almè the instant
  anything read it as GeoJSON; no validator can catch this, because both orders are well-formed, so it
  is asserted by an actual `$near` query in the suite. **The type** was `decimal`, which
  marketplace-common's `coordinates: { type: [Number] }` can never produce, and the resolver answered
  500 on every call because of it. **`int` in the list** is not redundant: `bson` encodes an
  integer-valued JS Number as int32, so a point at longitude exactly 9 is stored `9`, and a
  `'double'`-only validator rejects it.

  Decimal128 is a *rejected* write, deliberately. The resolvers use `.lean()`, so mongoose getters
  never run and the raw driver value reaches GraphQL, where `GraphQLFloat.serialize(Decimal128)`
  throws.

## Naming

⚠️ **Everything here is English.** Collections, fields, `lib/schemas/` builders and their flags, the
`description` strings inside the validators, migration filenames, test identifiers, comments and the
demo seed's data — there is no second language anywhere in this repo, and adding one is a regression
rather than a style nit.

## Demo seed

Two files, both **gated on `SEED_DEMO=true`** and a no-op otherwise, so both are safe to apply in
every environment. Both use fixed `_id` literals, so each `down` deletes exactly what its `up` wrote.

|File|Inserts|
|---|---|
|`20260301001800-seed-demo.js`|one `admin`, one `shopOwner`|
|`20260803142526-seed-demo-company.js`|one `company`|

The two are not independent. `20260803142526` points its `company.idShopOwner` at the March seed's
shopOwner and does **not** insert one if it is missing — the shared flag plus the file order means
either both ran or neither did. It dangles only if someone replays with the flag off and then turns it
on, which no supported flow does.

⚠️ **Both files used to write more.** The March seed also inserted a shop document with the company
embedded inside it; the August seed inserted a shop and two taxonomy documents. Those collections are
gone, and every insert into them went with them. The second file still exists rather than being folded
into the first because migrations are immutable in *ordering* even when their content was rewritten:
`company` does not exist until `20260803000000`, so its seed cannot run in March.

The demo company is **Northwind Trading Ltd**, carried over field for field from the embedded object the March
seed wrote, so a database seeded before the extraction and one seeded after it describe the same
company. Two fields are new because `company` has them and the sub-document did not: `taxCode` and
`address`, the registered seat.

## Fixes applied during the migrate-mongo port

These deviate intentionally from the original mongosh scripts (fidelity of everything
else was diff-verified field-by-field):

- `address.city`: `maximum: 100` → `maxLength: 100`. `maximum` is a no-op on strings, so the original
  enforced no length limit; the port enforces 100.
- Array item schemas gained `bsonType: "object"` where the original omitted it. App writes always
  insert objects there, so no valid data is rejected.
- The GeoJSON coordinate order and the coordinate type — see *Collections & schema conventions*.
  Preserving the original order was defensible only while nothing interpreted the pair; the moment a
  geo index exists, `[lat, lng]` is not a quirk but a shop in the wrong country.

## Domain glossary

`shopOwner` = the business owner who runs shops on the platform · `admin` = the platform operator · `company` = the registered company a shopOwner owns,
**and the shop itself** · `user` = the end customer, the person who places orders ·
`item` = one thing a company sells · `itemCategory` = the platform-wide taxonomy items are filed
under, two levels · `personalData` = personal/registry data · `registeredAt` = sign-up instant ·
`defaultAddress` = the `user`'s chosen delivery address, stored as a pointer into `addresses` rather
than as a flag on it · `publicName` = the trading name, what `legalName` is not · `slug` = the URL
segment, on `company`, `item` and `itemCategory` · `published` = the owner has put it live; every
public read filters on it.

The old shop collection, its old per-shop taxonomy collection, the old delivery-costs collection and
the 13 old product-type collections were all dropped on 2026-08-04. None of their names names anything
in this repo any more, under any spelling — and in particular the old per-shop taxonomy is **not**
`itemCategory` under an English name, nor is the old shop collection `company`.

Entity graph: `shopOwner` → owns → `company` (`idShopOwner`) → sells → `item` (`idCompany`) → filed
under → `itemCategory` (`idCategory`, which may itself point at a parent through `idParent`). `admin`
and `user` stand outside it — an operator owns nothing, and a customer owns nothing yet, because the
collections they would own (cart, order) do not exist. References are plain ObjectIds and nothing
enforces them — nothing stops a company pointing at a shopOwner that was never created, which is why
`companyDel` checks in application code before stamping `deleted`.

The one exception is **inside** a `user`: `defaultAddress` → `addresses[]._id` *is* enforced, by the
`$expr` half of that collection's validator. It is intra-document, which is the only kind of reference
MongoDB can check, and it is checked because a dangling default is silently wrong rather than loudly
broken. `company`'s `$expr` is the same trick for a different job — it constrains three fields of one
document against each other, not a reference.


## Version control

**git**, branch `main`, remote `origin` → `https://github.com/Axiumine/marketplace-db-setup` (**public**).
Never commit on `main` — branch first (`git switch -c <type>/<slug>`), and merging is the user's
decision alone.

⚠️ **The remote is public and nothing has been pushed to it yet.** The history is a single commit by
design: the two runbooks under `setup/` used to be tracked and carried live credentials, so they were
untracked and the twenty commits that held earlier copies were collapsed into one. There is no second
revision to leak from, and re-adding either file would undo the whole exercise — they are gitignored
for that reason. Before the first push, read what a public reader would get: every migration, every
validator and the `env` template are fine, and nothing else should be assumed to be.

**Delete the local branch as soon as it is merged**: `git branch -d <slug>`, in the same breath as
the merge, not at the top of the next task. Use `-d` and never `-D` — `-d` refuses a branch whose
commits are not already reachable from where you stand, so the safe case succeeds quietly and the
unsafe one stops you before the work is unreachable. Merges land locally here and are pushed as
`main`, so no forge-side "delete branch on merge" ever fires; a merged branch stays until someone
removes it, and `git branch` is the only place in-flight work is visible. If the branch was pushed
too, `git push origin --delete <slug>`, and only if that push was asked for in the first place.

`git push` runs `.githooks/pre-push`, **three** blocking gates: `yarn test:cov`, the migration replay
against a real MongoDB gated at 100% on every metric; `yarn test:mutation`, Stryker gated at 100;
then Qodana (`./qodana.sh`, gated by `qodana.yaml`). Not lint — that is the one omission left, and
the hook's own header argues it.

⚠️ **The mutation gate is new, and both this file and that header used to argue it could not exist.**
The claim was that mutating a migration means mutating an immutable, already-applied file, so a
survivor there has no legal fix. That confuses the subject of the edit: a surviving mutant in a
migration says the **test suite** does not notice that migration being wrong, and the fix is an
assertion in `test/`, which nothing forbids. See *The four other suites* for what the first run
measured and what closed it.

`git commit` runs `.githooks/pre-commit`: the secret guard, then that same coverage gate, then that
same Qodana scan, and the last two only when a staged path can move their verdict — sources, the
dependency manifests, the scan and test configs, the hooks. A docs-only commit skips both. ⚠️ That
makes a **reachable MongoDB a prerequisite for committing**, not just for pushing; `git commit
--no-verify` is the escape hatch and the push still gates. Both hooks scan on purpose, and the
pre-push one is not redundant:
**`git merge --no-ff` never fires `pre-commit`** — git runs that hook for `git commit` only — so the
merge commit, the one revision that actually reaches origin, is the single commit no pre-commit scan
ever sees. The second reason is Qodana Cloud, which files every report under the branch it ran on;
pre-commit only ever stands on the feature branch, so a repo gated there alone never produces a
`main`-tagged report for the baseline to compare against.

Both scans pass `SKIP_TESTS=1`, exactly as the other thirteen sub-repos do — this file used to say
the opposite, on the grounds that `qodana.yaml` omitted `testCoverageThresholds` and there was
therefore nothing to reuse. There is now: the flag tells `qodana.sh` to read the `coverage/lcov.info`
the preceding gate just wrote instead of regenerating it. Reuse is not only about the replay it
saves — `qodana.sh` regenerates coverage as `yarn test:cov || true`, which swallows the exit code, so
taking the report from the blocking gate is what keeps a threshold failure loud.

⚠️ **The Qodana gate only passes because `setup/mongodb.js` is excluded from four inspections.** The
first scan this repo ever had came back with 51 problems, 15 of them High, and **45 of the 51 in that
one file** — `CommaExpressionJS` ×8, `UnnecessaryLabelJS` ×6, `ThisExpressionReferencesGlobalObjectJS`
×1, `BadExpressionStatementJS` ×30. All false positives of a single kind: the file is a mongosh runbook
and not JavaScript at all. `use dbMarketplaceDev` is a shell command; a JS parser reads it as the label
`use:` plus the bare expression `dbMarketplaceDev` and reports both halves. `setup/redis.txt` is the same
kind of file and avoids all of it only by being named `.txt`.

Those four `exclude` entries in `qodana.yaml` are scoped to that path and nothing wider — in particular
**not** the whole file and **not** `setup/`, because `HardcodedPasswords` has to keep firing there: those
7 credential lines below are exactly what an inspection should catch. With the exclusions the scan exited
0 at 6 problems, all Moderate `DuplicatedCode` — four in migrations, two in the migration test.

Those 6 are gone now, and all six by the same route: the duplication was removed, not silenced. The two
in `test/migrations.test.mjs` were factored out first (`ABOVE_POSITION` / `downToBeforePosition()` and
`assertGeoJsonTuple`, see *Testing*). The four in `migrations/` were briefly excluded instead — a fifth
`exclude` entry, `DuplicatedCode` scoped to `migrations`, the only one here that silenced a true
positive — on the grounds that a migration is self-contained by rule and the finding therefore
unfixable. The rule was lifted (see *Authoring migrations*), the shapes moved to `lib/schemas/`, and the
entry was deleted. **Do not add it back**: `DuplicatedCode` fires over `migrations/` like everywhere
else, and a new finding there means a shape that belongs in `lib/schemas/`.

The refactor was proven equivalent before the docs were touched, not asserted: the full `up` ladder plus
every `down` rung — 31 states — was snapshotted (each collection's `listCollections` options and its
`indexes()`, minus `v`) before and after, and the two are identical **including JSON key order**. The
only difference between the two captures is the order `listCollections` enumerates collections in, which
is server-side and not schema. `yarn test` and `yarn test:seed` both passed — 44 tests at the time, 2
of them skipped in the unseeded run. (That count predates the catalogue deletion and everything since;
the current one is under *Testing*.)

`20260803000000-create-company`'s validator was extracted to `lib/schemas/company.js` later, when the
catalogue work needed a second state of that collection, and it was held to the same standard: the
builder's zero-argument output was diffed against the inlined literal it replaced and is identical
**including key order**. That is the bar for any future extraction here — a shape that "looks the
same" is not evidence, because `$jsonSchema` key order is preserved by `collMod` and shows up in every
snapshot comparison downstream.

The `setup/mongodb.js` half of that is a symptom fix. The cause is the extension, and the next JS
inspection added to the profile will need a sixth entry. Renaming to `setup/mongodb.txt` removes the
class outright — the migrations exclusion is unaffected by it — and is the better fix once
the references in this file, in the parent workspace's `CLAUDE.md` and in the `-name '*.js'` glob of
`package.json`'s semgrep script can move with it.

Ahead of the migration gate the hook selects node, reading `engines.node` from `package.json` and
switching via nvm. That gate shells out to yarn and yarn's `engines` check is a hard exit 1, so without
it a push from a shell on the machine default node dies *before* the gate, under the gate's own banner.
Every repo's `pre-push` carries the same block, and `pre-commit` here carries it too now — it used to
skip it, correctly, while `qodana.sh` was the only thing it ran (the linter runs in a container and
calls neither node nor yarn). The coverage gate added ahead of that scan does call yarn, so the block
came with it.

Bypasses, in order of bluntness: `SKIP_QODANA=1` (scan only — the coverage and mutation gates still
run) ·
`git commit --no-verify` / `git push --no-verify` (the whole hook).

## Cautions

- `.env` holds the real dev credentials and is gitignored. Never commit a secret — a
  `pre-commit` guard blocks it.
- ⚠️ **`setup/redis.txt` is placeholdered; `setup/mongodb.js` is not.** This was previously
  documented the other way round, as if both files had been reduced to `<MONGO_DEV_PWD>` /
  `<MONGO_DEV_UDBOWNER>` / `<REDIS_PASSWORD>` placeholders. `redis.txt` has, in its one
  credential line. `mongodb.js` has **7 lines carrying literal credentials** — the
  `userAdminAnyDatabase` connection at the top and the `pwd` of every `createUser` below it —
  against 5 placeholder lines, all of them in the per-repo test-user block added later. The
  admin line at the top is live: it is what provisioned `dbMarketplaceTest` and the nine per-repo
  test databases below it — nine because the two user-tier services were added on 2026-08-05 and
  their suites authenticate against databases that do not exist until that loop is re-run.

  The cluster is local, and the owner has accepted that exposure, so nothing here is being
  rotated. Recording it because the old wording asserted the opposite, and someone trusting it
  would treat this file as safe to paste into an issue, a PR, or a public repo. It is not.
  Substitute from `.env` when running the placeholdered parts by hand.
- Only a `Dev` environment is wired up (`MONGO_DEV_*`). There is no staging/prod config yet.

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
