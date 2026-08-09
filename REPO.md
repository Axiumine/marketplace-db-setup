# Repository mechanics

How this repo's prerequisites, test suites, gates and git plumbing behave, and why. Nothing here changes
what you write in a migration — it explains what happens when you run, commit or push one. [`CLAUDE.md`](./CLAUDE.md)
carries the rules; [`README.md`](./README.md) is the human-facing document.

## Prerequisites

1. `yarn install` (pulls `migrate-mongo`, `mongodb`, `dotenv`).
2. Populate `.env` from the committed `env` template. Required: `MONGO_DEV_UDBOWNER`, `MONGO_DEV_PWD`,
   `MONGO_DEV_AUTH_ADMIN`, `MONGO_DEV_DB`, `MONGO_DEV_CONN_STRING`. Optional: `SEED_DEMO`. To run the
   suites, also `MONGO_TEST_CONN_STRING`, `MONGO_TEST_UDBOWNER`, `MONGO_TEST_PWDDBOWNER`,
   `MONGO_TEST_AUTH_ADMIN`, `MONGO_TEST_DB`.
3. The DB user must already exist — create it with the snippets in `setup/mongodb.js`. That applies to the
   test user too: it needs `dbOwner` on the test DB, because the suite drops it.

## How migrate-mongo tracks state

- A `changelog` collection records each applied migration filename + timestamp. `up` applies every file
  not yet in `changelog`, in filename order; `down` reverts the most recent.
- Order is the filename timestamp prefix (`YYYYMMDDHHMMSS-…`), so `migrate:create` keeps it correct. There
  are no FK constraints in Mongo, so create-order between collections is cosmetic — except that the seed
  must come last, since it writes into all three collections it depends on.
- A `changelog_lock` collection serialises concurrent runs. **This only started working at migrate-mongo
  v12** — v11 accepted `lockCollectionName` and ignored it, so the key sat in the config doing nothing for
  the whole life of the repo. v12+ also requires `lockTtl` alongside it: leave it out and the TTL index is
  built with `expireAfterSeconds: null`, which Mongo rejects
  (`TTL index 'expireAfterSeconds' option must be numeric`) and every command fails. It is 90 seconds here
  — long enough for a full `up` (~0.5 s), short enough that a crashed run clears itself instead of wedging
  the database. `lockTtl: 0` turns locking back off.

## The migration replay

`test/migrations.test.mjs` runs the real migrations against a real MongoDB and asserts the resulting
state, under **vitest** (`vitest.config.mjs`), serially, with 30 s test and hook timeouts — the same shape
the nine services give their integration project, so one runner covers the whole platform. It used to run
on `node:test`; the assertions are unchanged (`node:assert/strict` is still what they call).

```sh
yarn test           # connection read from .env — no args needed
yarn test:seed      # same, with SEED_DEMO=true (also asserts the demo seed)
```

| Setting | Precedence (first non-empty wins) |
|---|---|
| URL | `TEST_MONGO_URL` (inline) → `MONGO_TEST_URL` (`.env`, one ready-made URL) → assembled from `MONGO_TEST_CONN_STRING` + `MONGO_TEST_UDBOWNER` + `MONGO_TEST_PWDDBOWNER` + `MONGO_TEST_AUTH_ADMIN` (**recommended** — the shape the `env` template has) → the dev URL from `MONGO_DEV_*` |
| DB | `TEST_MONGO_DB` → `MONGO_TEST_DB` (`.env`) → `marketplace_migration_test` |

The third row is the one that matters and the easy one to get wrong: the template stores the test
connection **split into pieces**, exactly like `MONGO_DEV_*`, not as a single URL. A fully populated
`MONGO_TEST_*` block therefore does nothing unless something assembles it — which is what `lib/mongoUrl.js`
is for. `MONGO_TEST_URL` is still honoured and still takes precedence, but nothing in the template produces
it.

The suite uses the **DB OWNER** pair, not the R/W pair: it calls `dropDatabase()` **before and after**, and
the migrations create collections, validators and indexes — none of which a read/write user may do.
`MONGO_TEST_UDBRW` / `MONGO_TEST_PWDDBRW` are in the template and deliberately unread; nothing here tests
the least-privilege user.

It **refuses to run when the test DB equals `MONGO_DEV_DB`**. That guard is the only thing between a typo
and a dropped dev database, since `MONGO_TEST_CONN_STRING` may point at the same cluster — here it does,
and only the DB name differs (`dbMarketplaceTest` vs `dbMarketplaceDev`).

⚠️ **The test database is named three times and all three must agree**: `MONGO_TEST_DB`,
`MONGO_TEST_AUTH_ADMIN`, and the database path of `MONGO_TEST_CONN_STRING`. This repo owns
`dbMarketplaceTest`; every other repo that runs integration tests owns a **different** database of its own
(`dbMarketplaceTestCommon`, `dbMarketplaceTestPublicRes`, …), because each suite drops its own. So copy the
four user/password values out of this `.env` and nothing else — the services' `vitest.mongo.mts` refuses to
build a URL when the three names disagree.

Because the authSource is the test database itself rather than `admin`, the two users have to exist in each
of those databases; `setup/mongodb.js` carries the loop that creates them. Dropping a database does not
remove them — MongoDB keeps every user document in `admin.system.users` whatever its authentication
database is.

**Five suites, 70 tests.** `yarn test` and `yarn test:seed` both report **70 passed**, nothing skipped, and
both exit 0. Nothing here stands down when `SEED_DEMO` is off: the seed-count test asserts zero instead of
one, and the test that drives the seeded `up` pops the seed migration and forces the flag on for the
length of one test, so the encryption path is exercised either way. ⚠️ Those numbers date from the last
change to `migrations/`; run `yarn test` to confirm them on a real database rather than trusting this file.
It is fast — about a second — so a long run means something is wrong, not that the suite is heavy.

### When it goes wrong

⚠️ **If the `MONGO_TEST_*` block is empty the suite does not skip — it fails, seventeen times, on a
permissions error.** `resolveUrl()` falls through to the dev URL while the DB name falls through to
`marketplace_migration_test`; the dev user has no rights outside its own database, so the first
`dropDatabase()` in `before` throws and takes every test with it:

```
MongoServerError: not authorized on marketplace_migration_test to execute command { dropDatabase: 1, … }
```

That is one failed hook, not seventeen problems — and it means *something* is always configured, so a skip
only ever happens if `migrate-mongo-config.js` itself throws.

A failing run also **does not exit**: the Mongo client keeps retrying, so node stays alive on the open
handle long after the reporter has printed. Combined with `sed`/`grep` block-buffering that looks like a
total hang — a piped `yarn test` once sat for over ten minutes with an empty output file while the tests
had already finished. A *passing* run exits on its own, so read a run that never returns as the auth
failure rather than as slowness. Redirect to a file instead of piping, either way.

### What it asserts

Every migration applies and is logged in `changelog`; `up` is idempotent; all 6 collections exist with
strict validators; every expected index is present by name; validators reject bad documents and accept good
ones (including the `city` `maxLength` rule and `company`'s per-axis coordinate bounds); a `$near` query
resolves the seeded company to midtown Manhattan rather than to its transposed reading; demo-seed counts
match `SEED_DEMO`; `down` reverts everything (collections dropped, `changelog` emptied).

⚠️ **There is exactly one `mm.down` ladder in the file and it is the last test.** Every migration here
creates a collection, so there is no intermediate state to walk to: the migrations are applied once at the
top and every assertion reads the one state they produce. A test that needs to pop a migration to see what
it is testing is a sign an alter has crept back in. The one exception is the seeded-`up` test, which pops
the seed alone — the newest migration, so it always pops exactly `1` — drives it by hand with `SEED_DEMO`
forced on, and re-applies it.

The four `shopOwner` table indexes additionally get their **key documents** asserted with `deepEqual`, not
merely their names: key order carries the ESR ordering, and the trailing direction has to be uniform across
every sort component (`deleted`/`disabled` excluded — those are matched, not sorted) or one index stops
serving both ASC and DESC. `company`'s three listing indexes and `item`'s four get the same treatment, for
the same reason.

⚠️ **Two validators are not a bare `$jsonSchema`** — `user`'s and `company`'s — so
`options.validator.$jsonSchema` is `undefined` on both. The suite carries `jsonSchemaOf()` for the unwrap;
use it rather than reaching for `.$jsonSchema`, including in an assertion that only ever looks at `company`.

The **encryption census** is one test and the place to add a field: `CIPHERTEXT` lists every path this
platform treats as personal data, per collection, and `CLEARTEXT` lists the ones a reader would expect
there and which deliberately are not — the three `shopOwner` sort keys above all. A new personal field
belongs in a validator and in that list, in the same change.

The **seeded-`up`** test is the only one in the repo that runs a real `ClientEncryption` against a real
96-byte key: it asserts that the seven planned paths present on the demo shop owner are subtype 6, that the
four absent ones were **not** invented, that the three sort keys and the company's point were left alone,
that the vault holds one data key per seeded collection under its own alt name, and that the account is
still findable by its deterministically encrypted `login.email`. The master key is minted into a temp
directory by `beforeAll`, which **overwrites** `CSFLE_MASTER_KEY_PATH` and `CSFLE_KEY_VAULT_NAMESPACE`
rather than defaulting them — honouring a real `.env` pair would point a suite that calls `dropDatabase()`
at the platform's own key vault.

Fixtures: `cipher()` mints BSON `binData` subtype 6 with bytes that are not a real CSFLE blob and do not
need to be — every rule it exercises is server-side, and the server never looks inside subtype 6. Making it
real would make every fixture async, and every call site with it, for a property no assertion reads.
`validCompany()` draws its `vatNumber`/`certifiedEmail` from the shared `uid()` counter, because both carry
a global unique index and a literal collides on the second insert of a run. It carries `published: false`,
which is not decoration — that field is in `required`, so a fixture without it stops being a valid company
and every `accepts('company', …)` in the file starts failing for a reason unrelated to what it tests.
`validItemCategory(over)`, `validItem(over)` and `validUser(over)` take an override object because most of
their tests differ from the minimum by one field; `validItem` mints its two references rather than
resolving them, since nothing checks them.

## The four unit suites, and the 100% gates

The replay was the only suite here for most of the repo's life, and both this project and
`vitest.config.mjs` argued coverage should not be gated: a statement gate over migration files would mostly
measure whether every migration was in the suite's `MIGRATION_FILES` list. That was fair while a real
MongoDB was the only thing driving the code, because **a working server only ever produces the happy
answer**. It stopped being fair the moment the unit suites landed.

| Suite | Drives |
|---|---|
| `test/mongoUrl.test.mjs` | every branch of `lib/mongoUrl.js`: credentials after the scheme, only the first `://` replaced, percent-encoding, `&authSource=` when a query already exists, no query parameter at all for `undefined` / `''` / `null`, and a missing piece reported under the caller's own variable name. |
| `test/migrateMongoConfig.test.mjs` | `migrate-mongo-config.js` under stubbed **fake** `MONGO_DEV_*`, asserting the whole exported object with one `deepEqual` — a misspelled key there is not an error, it is a migrate-mongo default silently taking over. |
| `test/migrationCalls.test.mjs` | the backstop: every migration's `up` and `down` against a recording fake `db`, with the ordered driver-call log frozen as a snapshot. It is also the only suite that drives the seed with `SEED_DEMO` **off**, where both directions are no-ops and a real database can therefore prove nothing. |
| `test/encryption.test.mjs` | the four guards in `lib/encryption.js` that a correct environment never trips: `CSFLE_KEY_VAULT_NAMESPACE` unset, set to `''`, `CSFLE_MASTER_KEY_PATH` unset, and a master key that is not exactly 96 bytes. `migrations.test.mjs` drives the conversion itself against a real MongoDB; only these drive the file *refusing to run*. Each passes `null` as the client, which is the proof that all four fire before the connection is touched — one moving below the `ClientEncryption` construction turns the asserted message into a `TypeError`. |

`migrateMongoConfig` had no test of any kind and the coverage gate did not notice: v8 only reports files
that were **loaded**, so a file no suite requires is absent from the report rather than shown at 0%, and
`thresholds: { 100: true }` passed over it. The mutation run surfaced it, as 18 "no coverage" mutants.
⚠️ Its stubbing happens **before** the load, and that is a secrecy requirement rather than a convenience —
dotenv does not override a variable already present in the environment, which is what keeps the real `.env`
credentials out of the assertions and out of any failure diff.

The repo sits at **100% statements / branches / functions / lines** and a **100 mutation score**. Coverage
is gated in `vitest.config.mjs` (`thresholds: { 100: true }`), in `qodana.yaml` (`testCoverageThresholds`)
and in both hooks; mutation is gated in `stryker.config.mjs` (`thresholds.break: 100`) and in
`.githooks/pre-push`.

⚠️ **The two measure different things and the gap here was enormous.** Coverage asks whether a line ran;
mutation asks whether a test would have *failed* had it been wrong. This repo sat at 100% coverage and
scored **52.92%** the first time Stryker ran — 383 survivors out of 856. They were not exotic:
`maxLength: 150` → `151`, `unique: true` → `false`, `'2dsphere'` → `''`, a `bsonType` list → `[]`. Every one
is a validator or an index that would have shipped wrong, and none broke a test because the assertions were
**partial** — `assert.ok(names.includes(idx))` reads a name and nothing else, and `jsonSchemaOf(v).title`
reads one property of a validator with a hundred. Three things closed it, in order of how much they killed:

1. **Freezing the whole shape** — two tests in `migrations.test.mjs` snapshot each collection's entire
   `validator` and entire index list, read back from the real database.
2. **Freezing the whole call log**, in `migrationCalls.test.mjs`.
3. **Deleting code no test could reach** — `migrationCreation`'s `indexes = []` default, `address`'s
   `positionRequired = false` default and the whole of `COORDINATE_DECIMAL`. An equivalent mutant is killed
   by changing the code, never by lowering the threshold and never with `// Stryker disable`.

⚠️ **A top-level `const` is evaluated once per process, which is why `test/migrationCalls.test.mjs` evicts
the whole of `lib/` from the CommonJS cache before each load.** `lib/schemas/*` is mostly module-level
constants (`COORDINATE_TUPLE`, `EMAIL_VERIFY`, `LOGIN`), and Stryker switches a mutant on per **test** — so
a builder loaded before the switch hands every test the unmutated object no matter how thoroughly it is
asserted. That alone was 54 survivors, and only the shapes built inside a function body (`address()`) were
ever caught. Keep the eviction if you touch that file; the modules are pure data, so nothing else observes
the reload.

⚠️ **The seed migration is the same trap in a file that is not in `lib/`, and it cost 45 survivors.** Its
two demo documents, its bcrypt hash and its three encryption plans are all top-level, migrate-mongo loads
the file in `beforeAll`, and Stryker then credits every literal in it to whichever test happened to trigger
that first load — never to the test that actually asserts the seeded documents. `test/migrations.test.mjs`
therefore `delete`s the file from `require.cache` before requiring it, in the one test that drives the
seeded `up` by hand. The rule generalises: **a test that means to cover module-level code has to be the
thing that loads the module.**

⚠️ **Load a CommonJS file the same way every other caller in the process loads it.** All four unit suites use
`createRequire(import.meta.url)`, not `import`, and so does `migrations.test.mjs` for `buildMongoUrl`.
migrate-mongo requires a migration through node's own loader; an `import()` of the same path goes through
vite, and v8 then holds **two scripts for one path with different byte offsets**. Merging coverage reports
whose ranges do not line up does not union them, it drops them. The symptom is a total that moves between
runs: 91.75% for the replay alone, 85.56% and 87.62% on two runs with `import()`-based unit suites, and —
from the one `import` left in `migrations.test.mjs` — 99.48% on roughly one run in six, with
`lib/mongoUrl.js` reporting both function bodies uncovered while a suite exhaustively tested them. Neither
`poolOptions: { forks: { singleFork: true } }` (removed in vitest 4, silently ignored) nor `isolate: false`
(deterministic at the *wrong* number) fixes it; loading the file the same way everywhere does, and eight
consecutive runs confirm it.

## The hooks

`.githooks/pre-push` is three blocking gates: `yarn test:cov` (the replay at 100% on every metric),
`yarn test:mutation` (Stryker at 100), then Qodana (`./qodana.sh`). Not lint — that is the one omission
left, and the hook's own header argues it.

`.githooks/pre-commit` is the secret guard, then that same coverage gate, then that same scan, and the last
two only when a staged path can move their verdict — sources, the dependency manifests, the scan and test
configs, the hooks. A docs-only commit skips both. ⚠️ That makes a **reachable MongoDB a prerequisite for
committing**, not only for pushing.

⚠️ **The mutation gate is new, and both this project and that header used to argue it could not exist.**
The claim was that mutating a migration means mutating an immutable, already-applied file, so a survivor
there has no legal fix. That confuses the subject of the edit: a surviving mutant in a migration says the
**test suite** does not notice that migration being wrong, and the fix is an assertion in `test/`, which
nothing forbids.

Both scans pass `SKIP_TESTS=1`, exactly as the other thirteen sub-repos do — the flag tells `qodana.sh` to
read the `coverage/lcov.info` the preceding gate just wrote instead of regenerating it. Reuse is not only
about the replay it saves: `qodana.sh` regenerates coverage as `yarn test:cov || true`, which swallows the
exit code, so taking the report from the blocking gate is what keeps a threshold failure loud.

Ahead of the migration gate each hook selects node, reading `engines.node` from `package.json` and switching
via nvm. That gate shells out to yarn and yarn's `engines` check is a hard exit 1, so without it a push from
a shell on the machine default node dies *before* the gate, under the gate's own banner. Every repo's
`pre-push` carries the same block; `pre-commit` here carries it too now — it used to skip it, correctly,
while `qodana.sh` was the only thing it ran (the linter runs in a container and calls neither node nor
yarn).

Bypasses, in order of bluntness: `SKIP_QODANA=1` (scan only — coverage and mutation still run) ·
`git commit --no-verify` / `git push --no-verify` (the whole hook).

### Why Qodana runs in both hooks

**`git merge --no-ff` never fires `pre-commit`** — git runs that hook for `git commit` only — so the merge
commit, the one revision that actually reaches origin, is the single commit no pre-commit scan ever sees.
The second reason is Qodana Cloud, which files every report under the branch it ran on; pre-commit only ever
stands on the feature branch, so a repo gated there alone never produces a `main`-tagged report for the
baseline to compare against.

### The `setup/mongodb.js` exclusions

⚠️ **The Qodana gate only passes because `setup/mongodb.js` is excluded from four inspections.** The first
scan this repo ever had came back with 51 problems, 15 of them High, and **45 of the 51 in that one file** —
`CommaExpressionJS` ×8, `UnnecessaryLabelJS` ×6, `ThisExpressionReferencesGlobalObjectJS` ×1,
`BadExpressionStatementJS` ×30. All false positives of a single kind: the file is a mongosh runbook and not
JavaScript at all. `use dbMarketplaceDev` is a shell command; a JS parser reads it as the label `use:` plus
the bare expression `dbMarketplaceDev` and reports both halves. `setup/redis.txt` is the same kind of file
and avoids all of it only by being named `.txt`.

Those four `exclude` entries are scoped to that path and nothing wider — in particular **not** the whole
file and **not** `setup/`, because `HardcodedPasswords` has to keep firing there: those credential lines are
exactly what an inspection should catch.

With the exclusions the scan exited 0 at 6 Moderate `DuplicatedCode` problems — four in migrations, two in
the migration test. All six are gone now, and all six by removing the duplication rather than silencing it.
The two in `test/migrations.test.mjs` were factored out first. The four in `migrations/` were briefly
excluded instead — a fifth entry, `DuplicatedCode` scoped to `migrations`, the only one here that silenced
a true positive — on the grounds that a migration is self-contained by rule and the finding therefore
unfixable. The rule was lifted, the shapes moved to `lib/schemas/`, and the entry was deleted. **Do not add
it back**: a new `DuplicatedCode` finding over `migrations/` means a shape that belongs in `lib/schemas/`.

`setup/mongodb.js` is a symptom fix; the cause is the extension, and the next JS inspection added to the
profile will need a sixth entry. Renaming to `setup/mongodb.txt` removes the class outright and is the
better fix once the references in this file, in the parent workspace's [`CLAUDE.md`](./CLAUDE.md) and in the `-name '*.js'`
glob of `package.json`'s semgrep script can move with it.

### The bar for extracting a shape

Every `$jsonSchema` here is built by a `lib/schemas/` builder rather than written into the migration, and
the bar for adding another one is that the builder's output be **identical to the literal it replaces,
including JSON key order**. Key order is not cosmetic: MongoDB stores a validator as the document it was
handed, `listCollections` reads it back in that order, and both frozen-shape tests in
`test/migrations.test.mjs` compare it as text. A shape that "looks the same" is not evidence — diff it.

The rule that licenses the directory at all is in [`lib/schemas/README.md`](./lib/schemas/README.md): a change under it is followed by
a full rebuild of every database that has run these migrations, in the same piece of work. What makes the
extraction safe here is that a create migration produces its collection in one call, so there is exactly one
state per collection to compare, in one direction.
