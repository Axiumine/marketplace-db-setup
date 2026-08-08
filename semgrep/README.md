# Semgrep — marketplace-db-setup

Static analysis (SAST) for this repo. Runs via the pinned Docker image, with
**all rules vendored locally** — no network fetch at scan time, fully
reproducible.

## Run

```bash
yarn semgrep        # human-readable report
yarn semgrep:ci     # nonzero exit on findings + SARIF (semgrep.sarif)
```

Both wrap `docker run … semgrep/semgrep:1.172.0 …` — nothing to install locally.
Output is written as your own UID (`-u`), so no root-owned files.

## Layout

| Path | What |
|---|---|
| `custom.yml` | Marketplace-specific rules (secret-in-logs guard — see below, only one applies here) |
| `vendor/typescript.yml` | Vendored registry pack `p/typescript` (74 rules) |
| `vendor/secrets.yml` | Vendored registry pack `p/secrets` (52 rules) |
| `vendor/refresh.sh` | Re-download the vendored packs (manual snapshot update) |

The yarn scripts pass `--config semgrep/`, which loads every rule file in this
directory (custom + vendored) in one shot.

`custom.yml` carries only `marketplace-no-log-reset-secret` of the platform's three
custom rules. This repo's own validators define `resetPwd.resetHash` /
`resetDateReq` (see `migrations/20260301000000-create-admin.js` and
`migrations/20260301000100-create-shopOwner.js`), so a future migration or
seed script that debug-prints one of those documents is a real risk worth
guarding against. `marketplace-no-log-introspection-code` and
`marketplace-no-log-auth-token` are **not** carried here: this repo has no
introspection-code header and no access/refresh-token handling of any kind —
it is migrations, not a running service on the auth boundary. See the header
comment in `custom.yml` for the full grep-and-decide record.

## Provenance / reproducibility

- Vendored from `https://semgrep.dev/c/p/<pack>` on **2026-08-01**.
- Semgrep engine pinned to **`semgrep/semgrep:1.172.0`**.
- The committed YAML is a frozen snapshot — the registry can change server-side,
  so scans use these files, not the live registry. To update deliberately:
  `./vendor/refresh.sh`, then review `git diff` and commit.
- `p/javascript` and `p/nodejs` are **not** vendored: the former has the same
  rule-id set as `p/typescript`, the latter is a strict subset of it. Vendoring
  them would only add duplicates.

## `.mts` limitation — does NOT apply here, and why the scripts still differ from the services'

The platform-wide caveat (see any backend service's `semgrep/README.md`) is that
**Semgrep 1.172.0 does not recognize the `.mts` / `.cts` extension**, so a
`.mts` file is treated as generic and every TypeScript/JavaScript rule is
silently skipped unless the scripts work around it. That limitation is about
the extension, not the platform, and it is real for the nine backend services
because they are written entirely in `.mts`.

**This repo is different: it is plain JavaScript (`.js` / `.mjs`), not
TypeScript, and has no `.mts` files anywhere.** `.js` and `.mjs` are extensions
semgrep already maps natively to the `javascript` language — no bypass needed
for language detection to work.

Verified empirically, the same way the services' README verifies the opposite
result: running the exact same file list with and without
`--scan-unknown-extensions` produced **the same 105 rules run, on the same 25
files, with the same 1 finding**, both times. So for this repo the flag is not
doing anything.

It is kept in `semgrep`/`semgrep:ci` anyway, for two reasons:
1. **Idempotent here** — proven by the comparison above, it changes nothing
   for `.js`/`.mjs`, so keeping it costs nothing.
2. **Cheap insurance** — if a stray `.mts`/`.cts`/`.ts` file is ever added to
   this repo (there is a slot for them in the `find` list below, unused today),
   it would still be analyzed under the vendored TypeScript rules instead of
   silently skipped.

### Why the `find` list is different from the services'

The nine backend services keep everything under `src/`. This repo's sources
are spread across four roots instead — `migrations/`, `lib/`, `setup/`,
`test/` — plus one root-level config file, so the scripts enumerate all of
them explicitly:

```
find migrations lib setup test -type f \( -name '*.mts' -o -name '*.cts' -o -name '*.ts' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.js' \)
```

plus `migrate-mongo-config.js` appended by hand, since it lives at the repo
root and the `find` roots above don't reach it.

### Coverage consequences — read before trusting a clean run

- **Scope is the explicit file list, not `.semgrepignore`.** Because files are
  passed explicitly (not via a directory walk), `.semgrepignore` does **not**
  filter them. Scoping is done entirely by the `find` roots and
  `migrate-mongo-config.js` above. A new source file under one of those four
  directories is covered automatically; a source file **outside all four**, or
  with an extension not in the `find` list, is **not scanned**. `.env`,
  `node_modules/`, and generated artifacts are correctly out of scope — none
  match the `find` expression.
- **`setup/mongodb.js` and `setup/redis.txt` are manual runbooks, not app
  code** — see CLAUDE.md. `mongodb.js` is still a `.js` file and gets scanned
  like any other; `redis.txt` is not, since `.txt` is not in the extension
  list.
- If a future migration needs TypeScript (it shouldn't — see CLAUDE.md,
  *Module system*: migrations are CommonJS and stay that way), the vendored
  `p/typescript` pack is already present and the `--scan-unknown-extensions`
  bypass would then start doing real work here too.
