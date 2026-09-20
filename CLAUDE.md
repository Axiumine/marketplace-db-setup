# marketplace-db-setup

MongoDB schema migrations for **Marketplace**. No application code — only migrations that create
collections, attach `$jsonSchema` validators, build indexes and optionally seed demo data. Managed by
[migrate-mongo](https://github.com/seppevs/migrate-mongo).

**Read parent first** — [`../../CLAUDE.md`](https://github.com/Axiumine/fullstack-marketplace-blueprint/blob/main/CLAUDE.md)
One of fifteen sub-repos.

| Need | File |
|---|---|
| scope, the six collections (diagram + field meanings), the demo seed, the three schema traps | [`README.md`](./README.md) |
| prerequisites, test suites, gates/hooks, migrate-mongo state, file layout, migration-authoring rules, the full collection-by-collection schema reference | [`REPO.md`](./REPO.md) |
| why a validator shape is the way it is | [`lib/schemas/README.md`](./lib/schemas/README.md) |
| GitNexus rules and this repo's registry name | [`AGENTS.md`](./AGENTS.md) |
| anything cross-repo | parent `CLAUDE.md` |

Six collections — `admin`, `shopOwner`, `company`, `user`, `itemCategory`, `item`.

⚠️ **No order, cart, delivery or payment collection, and no `shop` collection.** Commerce is permanently
out of scope (ADR-038, platform owner, 2026-08-27) — do not invent it. A shop **is** a `company`.

⚠️ **The catalogue is domain-neutral (ADR-008) — nothing here may presume what is sold.** A new product
type is an `itemCategory` **document**, never a migration or a new collection.

⚠️ **Every name is English** — collections, fields, `lib/schemas/` builders, migration filenames,
validator `description` strings, test identifiers, comments, the demo seed's data. One word of a second
language is a regression, not a style nit.

⚠️ **Migrations are immutable — never edit one that may already be applied.** A create migration declares
a collection once, in its final shape; correcting a shape means editing `lib/schemas/` and rebuilding
every database that has run these migrations, in the same piece of work. Authoring rules and the standard
migration shape: [`REPO.md`](./REPO.md).

⚠️ **NEVER run the mutation gate by hand, in any form** — not `yarn test:mutation`, not `npx stryker run`.
It is **hook-only**: `pre-push` calls it and nothing else does, not to check a change, not before a
commit, not to confirm a survivor is fixed. The threshold stays 100 regardless; reproduce a survivor by
hand-applying the mutant and running `yarn test`. Why an on-demand run is never the answer: [`REPO.md`](./REPO.md).
⚠️ Since ADR-055 the script has a second caller, `.github/workflows/gates.yml`, which runs it on
every pull request — two callers, both automated, and a hand is neither.

⚠️ **Never lower a coverage or mutation threshold, and never remove a gate.** 100% on all four coverage
metrics, mutation score 100. A commit that needs a threshold lowered needs a test instead.

⚠️ **Never read, echo or commit a secret-bearing file** (`.env`, `setup/mongodb.js`, `setup/redis.txt`).
`env` without the dot is a committed template and safe. `KEYGRIP_KEK` is the highest-value secret in this
repo's `.env` (ADR-034) — it unwraps the cookie-signing keys of all five signing services at once, so one
leak forges a session of any tier. Print its name, never its value.

⚠️ **`lib/keygrip.js` is a deliberate duplicate of `marketplace-common/src/encryption/wrapKeygripKeys.mts`**
— no test spans the two repos, and a drift in the format shows up as a fleet that stops booting. Its
header says what may not change alone. ⚠️ **Never wire `scripts/seedKeygrip.js` into a service's boot** —
it is an admin-run runbook, not application code.

- **Run `impact({target, repo})` before editing a symbol; run `detect_changes()` before committing.**
  `repo:` is mandatory, always a `marketplace*` registry name.

## Version control

**git**, branch `main`, remote `origin` → `https://github.com/Axiumine/marketplace-db-setup` (**public**).

- **Never commit on `main`.** Branch first: `git switch -c <type>/<slug>`. Merging is the user's call.
- **Push-on-request**, always.
- Merged → `git branch -d <slug>` (never `-D`) in the same breath as the merge.
- ⚠️ Nothing has been pushed to this public remote yet — before the first push, check that nothing beyond
  migrations, validators and the `env` template is staged. Detail: [`REPO.md`](./REPO.md).

## Gates

commit → secret guard, coverage, Qodana. push → trivy (dependency advisories), coverage, mutation,
Qodana. All blocking, and a docs-only commit skips the last two. ⚠️ A reachable MongoDB is therefore a
prerequisite for **committing**, not only for pushing. Mechanics, bypasses and the Qodana exclusions:
[`REPO.md`](./REPO.md).
