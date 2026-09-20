# Repository mechanics

How this repo's prerequisites, test suites, gates and git plumbing behave, and why — plus the file
layout, the migration-authoring rules and the full collection-by-collection schema reference (moved here
so `CLAUDE.md` stays short). [`CLAUDE.md`](./CLAUDE.md) carries the rules; [`README.md`](./README.md) is
the human-facing document.

## Prerequisites

1. `yarn install` (pulls `migrate-mongo`, `mongodb`, `dotenv`, and — for the keygrip seed alone — `redis`).
2. Populate `.env` from the committed `env` template. Required: `MONGO_DEV_UDBOWNER`, `MONGO_DEV_PWD`,
   `MONGO_DEV_AUTH_ADMIN`, `MONGO_DEV_DB`, `MONGO_DEV_CONN_STRING`. Optional: `SEED_DEMO`. To run the
   suites, also `MONGO_TEST_CONN_STRING`, `MONGO_TEST_UDBOWNER`, `MONGO_TEST_PWDDBOWNER`,
   `MONGO_TEST_AUTH_ADMIN`, `MONGO_TEST_DB`. `yarn seed:keygrip` needs none of those and a different set
   instead — the `REDIS_*` block, `REDIS_KEY`, and `KEYGRIP_KEK`; the suite that covers it stubs all of
   them, so a `.env` with no Redis at all still runs the tests.
3. The DB user must already exist — create it with the snippets in `setup/mongodb.js`. That applies to the
   test user too: it needs `dbOwner` on the test DB, because the suite drops it.

⚠️ **Several of those keys are not in this repo's `.env` at all — they answer from the workspace layer.**
[`ADR-053`](../../docs/devprotocol/phase3/adr/ADR-053-the-shared-half-of-the-environment-is-one-file.md)
moved every value identical across the sixteen repos into `.env.shared` at the workspace root, exported by
one root `.envrc` that [direnv](https://direnv.net) loads. The list above says what the code **reads**,
never where the value lives, and `../../scripts/env-diff.sh` is what reports the difference — a key the
layer supplies prints `SHARED`, one nothing supplies prints `MISSING`. Two consequences land here:

- ⚠️ **A shell without the direnv hook loads none of it, and says nothing.** `dotenv` then finds this
  repo's `.env` alone — the half that did *not* move — and the suite dies naming one absent key,
  `Missing MONGO_TEST_UDBOWNER in .env`, on a machine where that value is provisioned and correct. It
  reads as an unprovisioned box and is not one. This is every non-interactive shell: a script run as
  `sh -c`, a CI step, an editor's task runner, an assistant's tool shell — never an ordinary terminal,
  which is why it does not reproduce when you go looking by hand. Run the command through the layer
  instead — **`direnv exec . yarn test:cov`** — which walks up to the workspace-root `.envrc` (this repo
  has none of its own) and evaluates it for that one command, needing no hook at all. `direnv allow`,
  once per machine, is what makes the hooked form work.
- ⚠️ **The git hooks inherit the shell that ran `git commit`.** `pre-commit`'s second gate is
  `yarn test:cov`, and `pre-push` runs that plus Stryker (see *The hooks* below), so from a non-hooked
  shell they fail on the environment rather than on the diff while the message blames the suite.
  `direnv exec . git commit …` and `direnv exec . git push` are the fix. A docs-only commit skips that
  gate altogether, so the problem stays hidden until the next commit that touches a source file.

⚠️ **Never answer either of those by copying a shared key back into this repo's `.env`.** The layer wins —
`dotenv` does not overwrite an exported variable — so the copy is dead text wherever the hook is loaded and
a second source of truth everywhere else. That is `RISK_REGISTER` **R04** being manufactured by hand.

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

**Six suites, 86 tests.** `yarn test` and `yarn test:seed` both report **86 passed**, nothing skipped, and
both exit 0. Nothing here stands down when `SEED_DEMO` is off: the seed-count test asserts zero instead of
one, and the test that drives the seeded `up` pops the seed migration and forces the flag on for the
length of one test, so the encryption path is exercised either way. ⚠️ Those numbers date from the last
change to `migrations/`; run `yarn test` to confirm them on a real database rather than trusting this file.
It is fast — about a second — so a long run means something is wrong, not that the suite is heavy.

⚠️ **`yarn test:unit` is that same suite minus the replay** — five files, 50 tests, no MongoDB anywhere
in it — and it exists for one caller: `.github/workflows/gates.yml`, which has no replica set to replay
against. It carries no coverage gate, because the statements only the replay reaches would fail one: on a
runner the replay skips itself, the suite still reports green, and the report lands twenty statements and
six functions short. The threshold itself is untouched, and `pre-push` still measures it here, where the
database is.

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

## The five unit suites, and the 100% gates

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
| `test/keygrip.test.mjs` | `lib/keygrip.js`, the ADR-034 seed helper — and the only suite here that touches neither MongoDB nor migrations. It drives the mint / adopt / leave-alone decision against a fake hash store, and it **unwraps with plain `node:crypto` rather than with the module's own helper**: the readers are five services in another repo, so a test that used the writer to check the writer would pass through any change of format. Fingerprints are asserted to move with the key **ids** and not with the material, and the version is asserted to be the AAD — swapping it must make the unwrap throw. |
| `test/encryption.test.mjs` | the four guards in `lib/encryption.js` that a correct environment never trips: `CSFLE_KEY_VAULT_NAMESPACE` unset, set to `''`, `CSFLE_MASTER_KEY_PATH` unset, and a master key that is not exactly 96 bytes. `migrations.test.mjs` drives the conversion itself against a real MongoDB; only these drive the file *refusing to run*. Each passes `null` as the client, which is the proof that all four fire before the connection is touched — one moving below the `ClientEncryption` construction turns the asserted message into a `TypeError`. |

`migrateMongoConfig` had no test of any kind and the coverage gate did not notice: v8 only reports files
that were **loaded**, so a file no suite requires is absent from the report rather than shown at 0%, and
`thresholds: { 100: true }` passed over it. The mutation run surfaced it, as 18 "no coverage" mutants.
⚠️ Its stubbing happens **before** the load, and that is a secrecy requirement rather than a convenience —
dotenv does not override a variable already present in the environment, which is what keeps the real `.env`
credentials out of the assertions and out of any failure diff.

⚠️ **That is `RISK_REGISTER` R07, and until 2026-09-06 mutation catching it was luck.** `vitest.config.mjs`
now sets `coverage.include` over every source directory, which is the only thing that makes v8 force an
unimported file into the report at 0%, and `scripts/coverage-audit.mjs` runs after vitest inside `yarn
test:cov` to prove the report really does hold every git-tracked file that `include` gates. Whatever is
missing has to be named in `coverage-exempt.txt` with the reason it can never be there; this repo names
exactly one, `scripts/seedKeygrip.js`, for the reason `stryker.config.mjs` already gave. Exact paths only —
a `scripts/**` glob would exempt the next file added there as silently as the missing `include` exempted
this one.

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

⚠️ **Load a CommonJS file the same way every other caller in the process loads it.** All five unit suites use
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

`.githooks/pre-push` is five blocking gates: trivy (dependency advisories over `yarn.lock`, HIGH and
CRITICAL, production tree only), `yarn test:cov` (the replay at 100% on every metric),
`yarn test:mutation` (Stryker at 100), then Qodana (`./qodana.sh`). Not lint — that is the one omission
left, and the hook's own header argues it.

⚠️ **The trivy gate is new, and it is there because Qodana's dependency check does not report.** What
Qodana runs is `VulnerableLibrariesLocal`, an offline heuristic that queries no advisory feed and answers
zero on every repo on this platform; the class that does query one is bundled with the image and is in no
profile — which is why the SCA line has left this repo's gate descriptions. Trivy reads `yarn.lock`
natively, suppresses devDependencies and blocks on HIGH or CRITICAL. It is first because it is by far the
cheapest gate here and needs neither node nor a reachable MongoDB. Bypass for a Docker or network outage,
never for a finding: `SKIP_TRIVY=1 git push`.

`.githooks/pre-commit` is the secret guard, then that same coverage gate, then that same scan, and the last
two only when a staged path can move their verdict — sources, the dependency manifests, the scan and test
configs, the hooks. A docs-only commit skips both. ⚠️ That makes a **reachable MongoDB a prerequisite for
committing**, not only for pushing.

⚠️ **The mutation gate is new, and both this project and that header used to argue it could not exist.**
The claim was that mutating a migration means mutating an immutable, already-applied file, so a survivor
there has no legal fix. That confuses the subject of the edit: a surviving mutant in a migration says the
**test suite** does not notice that migration being wrong, and the fix is an assertion in `test/`, which
nothing forbids.

### Why `yarn test:mutation` is hook-only

This does not weaken anything: the threshold stays 100, `pre-push` still blocks, and no survivor is ever
answered by lowering a number. What changes is **who starts the run**. A full pass costs tens of minutes
and holds the whole machine at 28 workers while it lasts, so an on-demand run is time taken from the
person waiting for the work.

Go through the package script if a run is ever authorised — never `npx stryker run`, which skips whatever
the script sets up around it.

A survivor is answered by writing the test it names and letting the next push run the gate. If a mutant
has to be reproduced first, apply it by hand in the source and run `yarn test` — that is seconds, it
names the tests that should have failed, and it costs nobody the machine.

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

## Layout

| Path | Purpose |
|---|---|
| `migrate-mongo-config.js` | Config. Builds an authenticated URL from `.env` (`MONGO_DEV_*`); `changelog` tracks applied migrations. |
| `migrations/*.js` | One migration per file, applied in filename (timestamp) order. `<ts>-create-<coll>.js` = collection + validator + indexes, in one `migrationCreation()` call. |
| `lib/schemas/*.js` | The validator shapes every migration is built from (`account`, `collection`, `encrypted`, `geo`, `admin`, `shopOwner`, `user`, `company`, `item`, `itemCategory`), each builder returning **one** shape and taking no arguments. Mostly `$jsonSchema`, not always — `user.js` and `company.js` both return an `$and` pair. **Read `lib/schemas/README.md` before touching it**: an edit here changes what an already-applied migration means. `encrypted.js` is the ADR-029 one — it turns a personal field's shape into `bsonType: 'binData'`, which is all a validator can say about a ciphertext. |
| `migrations/20260301000600-seed-demo.js` | Optional demo seed, **one** file — one `admin`, one `shopOwner`, one `company`. No-op unless `SEED_DEMO=true`. |
| `lib/encryption.js` | The CSFLE half (ADR-029): opens a `ClientEncryption` against the master key at `CSFLE_MASTER_KEY_PATH`, mints or reuses one data key per collection in `<db>.__keyVault`, and encrypts a document field by field so the seed can write into collections whose personal fields are `binData` from the moment they are created. |
| `lib/mongoUrl.js` | The `://user:pwd@` + `authSource` assembly, shared by the config (`MONGO_DEV_*`) and the tests (`MONGO_TEST_*`) so the two cannot drift. |
| `lib/keygrip.js` | The ADR-034 one, and the only file here that has nothing to do with MongoDB: it mints or adopts the cookie-signing key array and seals it under `KEYGRIP_KEK`. ⚠️ **A deliberate duplicate of `marketplace-common/src/encryption/wrapKeygripKeys.mts`** — five services in another repo unwrap what it writes, no test spans the two, and a drift in the format shows up as a fleet that stops booting. Its header says what may not change alone. |
| `scripts/seedKeygrip.js` | `yarn seed:keygrip` — the admin entry point for the above: connection, the `--force` flag, and what is printed (version and fingerprint, never a key). ⚠️ **Never wire it into a service's boot.** |
| `test/` | Six vitest suites — the migration replay plus five unit suites. Layout and traps: above, in this file. |
| `vitest.config.mjs` · `vitest.mutation.config.mjs` · `stryker.config.mjs` | Suite configs. Coverage gated at 100% on every metric; Stryker `thresholds.break: 100`, `concurrency: 1` (one real database). |
| `qodana.yaml` / `qodana.sh` | Scan config and runner. Critical 0 / high 0, coverage 100 total / 100 fresh, license check. Its vulnerable-dependency inspection is an offline heuristic that reports nothing — advisories are the trivy gate's job. |
| `.githooks/pre-commit` · `pre-push` | Gates. What runs when, and why: above, in this file. |
| `env` | Committed template for `.env`. `.env` itself is gitignored — dev Mongo credentials. |
| `setup/mongodb.js` · `setup/redis.txt` | Manual one-off runbooks (DB users, dump/restore, Redis ACL). **Gitignored** — they hold real users, passwords and internal hostnames. A clone does not get them. |

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

## Seeding the cookie-signing keys

```sh
yarn seed:keygrip            # once per machine, BEFORE any service starts
yarn seed:keygrip --force    # mint a new key set, invalidating every live session
```

Writes one Redis hash, `<REDIS_KEY>keygrip`, holding the Keygrip key array sealed with AES-256-GCM under
`KEYGRIP_KEK` (ADR-034). The five cookie-signing services — the four `*-authorization` ones and
`marketplace-dev-authenticated-logout` — read it at boot and **exit 1** if it is missing
(`KEYGRIP_RECORD_MISSING`) or if their KEK cannot open it (`KEYGRIP_KEK_MISMATCH`).

⚠️ **It is idempotent without `--force` and destructive with it.** A second plain run leaves an existing
record untouched and reports it; `--force` replaces the keys, so every cookie signed under the old set
stops verifying and every user signs in again. Upgrading a machine that still has `KEYGRIP_KEY_1` /
`KEYGRIP_KEY_2` in this repo's `.env` is the one case where the plain run adopts rather than mints —
delete both from the `.env` afterwards, they are read once and never again.

## Module system

Migrations and `migrate-mongo-config.js` are **CommonJS** and stay that way — the config declares
`moduleSystem: 'commonjs'` and migrate-mongo loads them through it.

`test/migrations.test.mjs` is **ESM**, and has to be: migrate-mongo is ESM-only from v12. Its CommonJS
wrapper is a `Proxy` whose every property access returns a *Promise*, so under `require` the whole API
reads as undefined and the first call dies with `TypeError: mm.config.set is not a function`.

## Authoring migrations — rules

- **A migration creates a collection unless it cannot.** Six creates, one seed, five alters. A collection
  is declared once, in its final shape, so `migrations/` reads as the schema the database has rather than
  as the sum of a ladder — and a reader never has to replay six files in their head to learn what a field
  is today. An alter is what is left when the create has already been applied, and there are three kinds:
  it adds something the create never had (`20260825000000` and `20260829000200`, an index each;
  `20260829000000`, four paths and a
  `dependencies` clause), it hands an existing database a shape the create now carries and it does not
  (`20260826000000`, `maxItems` on `user.addresses`), or it **removes** something the create built
  (`20260829000100`, `deleted_ttl`). In the second case **the create migration stays the statement of
  record** — the alter is a catch-up, it is a no-op on a fresh replay, and it must be written to be one.
  ⚠️ **The third kind cannot be a no-op and must not be written as one.** A fresh replay creates
  `deleted_ttl` and drops it seconds later, which is the honest record: the index existed and was
  retired. Editing it out of `INDEXES_USER` instead would rewrite what an applied migration built, and
  would buy a `dropIndex` guarded against a state no replay can produce — a branch no test can reach.
  What such an alter owes the reader is an END-STATE assertion in `test/migrations.test.mjs`, so the
  shared shape is no longer the statement of what a database has.
- **Migrations are immutable.** Never edit one that may already be applied anywhere — its `changelog`
  entry means it will not re-run. That is a rule about *applied* files: as long as every database that
  has run them can be dropped and replayed, correcting a shape means correcting the create and rebuilding
  in the same piece of work. The moment a database exists that cannot be rebuilt, the only legal change
  is a new migration. `20260826000000` is the pattern to copy for a validator change: `lib/schemas/`
  edited so a replay is right, plus a `collMod` restating the **whole** validator so an applied database
  catches up. ⚠️ `collMod` does not re-validate what is already stored — a document that violates the new
  rule stays where it is and becomes unwritable on its next update, so check the collection for
  violations before running one, not after.
- **The shapes live in `lib/schemas/`, not in the migration.** The usual rule says a migration must be
  self-contained, because an edit to a shared helper retroactively changes what an applied migration
  means. That argument depends on a database existing that cannot be rebuilt, and **none does here**: one
  `Dev` environment plus a throwaway test database, both replayable from these files. So the rule is
  replaced rather than broken — **a change under `lib/schemas/` is followed by a full rebuild of every
  database that has run these migrations, in the same piece of work.** Read [`lib/schemas/README.md`](./lib/schemas/README.md).
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

## Schema reference — collections, fields and indexes

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

⚠️ **There is no `price`, deliberately and permanently.** Cart, order, delivery and payment are permanently
out of scope on this platform — ADR-038, the platform owner's decision of 2026-08-27 — so a price would be a
guess at a currency, a precision, a VAT treatment and a discount model at once, with nothing that will ever
resolve it — and Decimal128, the type it wants, is a rejected write everywhere here. **No migration adds
this field**: there is no ordering tier to add it with, and a display-only price was offered and refused on
the same day. The suite asserts the absence.

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

Three divergences from `shopOwner`, all argued at the head of `lib/schemas/user.js`: `addresses` is an
**array** where the shop owner has one, `defaultAddress` has no counterpart, and there is **no
`waitApprov`** — a customer self-serves, so the only gate between registering and logging in is the email
confirmation. A shop owner who self-serves through `shopOwnerRegister` gets both gates; one an Admin
created gets neither.

⚠️ **`personalData` was a fourth divergence until 2026-08-12** and is not one now: it left `shopOwner`'s
required list when `shopOwnerRegister` was built, so both collections take an email and a password at
sign-up and collect the rest later. `shopOwnerAdd` still demands the whole block — an admin filling a
form in has the details in front of them — which is a rule of that mutation, not of the collection.

`personalData.contacts` requires none of its members, unlike `shopOwner`'s: `login.email` is already the
credential, so demanding a contact email would ask for the same address twice.

`addresses` is capped at **six** elements (`maxItems`, added by `20260826000000`). It is the one length
rule left on this collection that the server can measure: every member of an address is `binData` since
ADR-029 and no `$jsonSchema` can measure a ciphertext, but the number of elements is countable whatever
they hold. Without it the only ceiling was BSON's 16 MB, which is tens of thousands of addresses on one
document that every read of that account loads whole. ⚠️ **Six is spelled in three repositories and
cannot be shared** — here, `funUserAddressAdd` in `marketplace-dev-user-authenticated-resource`, and
`AddressList.tsx` in `marketplace-user`. This one is the rule; the other two exist so the customer gets
a sentence instead of a failed write.

No `2dsphere` over `addresses.position` — nothing queries customers by distance. Three indexes: the shared
`login.email_unique`, `tbl_active_registeredAt` from `20260825000000` and `registeredAt_series` from
`20260829000200`.

⚠️ **The last two are not one index doing two jobs, and the second cannot be folded into the first.**
`tbl_active_registeredAt` leads with `deleted` and `disabled` because the admin's customers table filters
on both; the customers chart the platform owner asked for on 2026-08-29 bounds **neither**, since it
counts every customer who ever registered so that its points sum to the Total tile beside it. An index
orders a later key only within each group of its leading ones, so a date range over that compound index is
a full scan of it — hence `{ registeredAt: 1 }` on its own, byte-identical to the `shopOwner` index of the
same name. It is not unique (two people may register in the same millisecond) and not partial (a closed
account is still someone who registered).

⚠️ **There is no TTL index on this platform and `deleted` is not a destruction clock.** `deleted_ttl` was
one — `{ deleted: 1 }`, `expireAfterSeconds` 2592000 — and it was what made `userDel` an erasure rather than
a flag. The platform owner reversed the outcome on 2026-08-29 (ADR-041): a closed account keeps its document
**for ever** as the record that a person held one, and thirty days on a sweep overwrites the personal fields
inside it with placeholders. A TTL index removes whole documents and has no other mode, and `collMod` can
retune `expireAfterSeconds` but cannot strip TTL-ness off a live index, so it was dropped —
`20260829000100`, unconditionally. ⚠️ `INDEXES_USER` in `lib/schemas/user.js` **still lists it**, because
`20260301000300` did create it and an applied migration is immutable; read
`test/migrations.test.mjs`'s end-state assertion, not the array, for what a database has. ⚠️ **Do not bring
one back.** It destroys the rows the scrub exists to keep and takes each closed account's `login.email` with
them — the address a re-registration inside the thirty days is meant to find, rename and step over
(ADR-042) — and it reports neither.

⚠️ **A suspended `user` or `shopOwner` must carry a reason, and MongoDB is what demands it.**
`20260829000000` adds four paths to both collections — `deletedBy`, `disabledBy`, `disabledReason`
(encrypted, `ALGORITHM_RANDOM`) and `scrubbedAt` — plus `dependencies: { disabled: ['disabledReason'] }`.
`dependencies` demands presence and reads nothing, which is the only form the rule can take over a
ciphertext; the 1000-character cap lives in the two Admin-tier mutations' GraphQL input validation and
nowhere else. ⚠️ `deletedBy` **absent** means the holder closed their own account and **present** means an
admin did — absence is the record, not a gap, so nothing may backfill it. ⚠️ `admin` gets none of the
four: nobody has decided who suspends an admin. ⚠️ `collMod` never re-validates stored documents, so the
migration **counts suspended documents with no reason and refuses to run** if it finds any rather than
inventing a sentence no admin wrote — lift and re-apply those suspensions through the Admin tier first.

⚠️ **Anything that ever replaces this validator must restate *both* clauses.** A validator is set
wholesale, never merged, so handing MongoDB the `$jsonSchema` half alone silently drops the `$expr` rule —
and nothing fails at that moment. The first symptom is a dangling `defaultAddress` written weeks later.
`validatorUser()` returns the `$and` pair and nothing else for exactly that reason: there is no way to get
half of it.

### shopOwner

- `notes` (top level, optional, **encrypted**) is what an **admin** wrote *about* an account, which is
  why it is not inside `personalData` — that is what the shop owner declared about themselves. Nothing in
  the ShopOwner tier reads it: `marketplace-dev-authenticated-*` does not load this model at all, so the
  field cannot leak to the shop owner. ⚠️ It carries **no** `maxLength`, and cannot: it is `binData` here,
  so a bound would measure the blob. The cap holds in the Admin tier's GraphQL input validation alone.
- `disabledReason` (top level, optional, **encrypted**) is the second field of that kind and `user` now has
  one too — an admin's words about a named person, which the person never reads. Same missing
  `maxLength` for the same reason, and the same rule: `dependencies` can demand it is *there* beside a
  `disabled`, and nothing anywhere can demand what it says.
- `personalData.address.position` is the same GeoJSON point as `company.address.position`, in the same
  tuple form — but **optional**, with no `2dsphere` index. Deliberate: nothing queries shop owners by
  distance, and a coordinate cannot be derived from a street address without geocoding, so requiring it
  would put a geocoder in the path of registration. It fills in the first time an address is picked from
  the admin app's autocomplete.

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
- ⚠️ **`KEYGRIP_KEK` is the highest-value value in this repo's `.env`** (ADR-034). It is not a database
  credential — it unwraps the cookie-signing keys of all five signing services at once, so one leak forges
  a session of any tier. The `pre-commit` guard matches it on its exact shape (base64 of 32 bytes: 43
  characters and one `=`), which no template placeholder has. Print its name, never its value.
- Only a `Dev` environment is wired up (`MONGO_DEV_*`). There is no staging or prod config yet.

## Version control — before the first push

**git**, branch `main`, remote `origin` → `https://github.com/Axiumine/marketplace-db-setup` (**public**).
The history is a single commit by design, so there is no second revision to leak from. Before the first
push, read what a public reader would get: every migration, every validator and the `env` template are
fine, and nothing else should be assumed to be.
