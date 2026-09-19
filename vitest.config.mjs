import { defineConfig } from 'vitest/config'

// Five suites, and only one of them is an integration suite.
//
// test/migrations.test.mjs replays the REAL migrations against a REAL MongoDB (see CLAUDE.md,
// *Testing*) — that is the main event here and it is what proves a schema, not a mock of one.
// The other four exist because a real server only ever produces the happy answer: the argument
// checks in lib/schemas/, the four CSFLE guards in lib/encryption.js, the `SEED_DEMO`-off half of
// the seed and every branch of the URL assembly are unreachable from a replay that works.
//
// fileParallelism: false — mirrors the services' integration project. The migration suite mutates
// one shared database end to end (drops it, replays every migration, reverts every migration), so
// a second file running concurrently would race the same collections.
//
// ⚠️ There is NO pool setting here, and the coverage flake that looked like one was not one.
// Several suites load the same CommonJS files (migrate-mongo requires a migration, migrationCalls
// requires it again to record its driver calls; migrate-mongo-config and mongoUrl.test both pull in
// lib/mongoUrl.js), and `yarn test:cov` alternated between 100% and 99.48% — lib/mongoUrl.js at
// 90.9% statements / 50% branches, lines 13-28 (both function bodies) uncovered, about one run in
// six. The real cause is one line in test/migrations.test.mjs: it took `buildMongoUrl` through an
// ESM `import`, which vite transforms, while migrate-mongo-config requires the same file natively.
// v8 then holds two scripts for one path with different byte offsets, and merging reports whose
// ranges do not line up drops them instead of unioning them. That import is a `createRequire` now
// and eight consecutive runs report 100% on all four metrics. **Load a CJS file the same way every
// caller in the process loads it** — that is the rule, and no pool option substitutes for it.
//
// Two things were tried first and both are recorded so they are not tried again.
// `poolOptions: { forks: { singleFork: true } }` is vitest 3 spelling: vitest 4 REMOVED
// poolOptions, prints one deprecation line and ignores the block, so it did nothing at all while
// the runs happened to come out at 100%. Its v4 equivalent, top-level `isolate: false`, made the
// number deterministic at the WRONG value — 99.48% on five runs out of five, because one process
// then reports the file twice and the second report wins rather than merging.
//
// testTimeout / hookTimeout: 30000 — same figure the services use for their real-MongoDB
// integration project. The before()/after() hooks here do dropDatabase() + the full migration
// replay, which is network I/O against a real server, not a mock.
//
// ⚠️ Coverage is gated at 100%, and this reverses what this header used to argue. The old text
// said a statement gate on migration files "would be theatre — it would mostly measure whether
// every migration was added to MIGRATION_FILES". That was true of a repo whose only suite was the
// replay, and it stopped being true the moment the two unit suites landed: the 16 statements the
// replay could never reach are exactly the error paths and the seeded branches, which are the ones
// worth a test. Every other repo on the platform gates at 100 — never lower this to accommodate a
// new migration; drive its uncovered branch instead.
export default defineConfig({
	test: {
		include: ['test/**/*.test.mjs'],
		fileParallelism: false,
		testTimeout: 30000,
		hookTimeout: 30000,
		// `vitest.testNames.mjs` caps how long a test's name may be — the mutation gate selects tests by
		// name, and past a size it cannot; see the file.
		setupFiles: ['./vitest.testNames.mjs'],
		coverage: {
			provider: 'v8',
			/*
			 * ⚠️ `include` is what makes the gate below mean anything, and it is not optional.
			 * With no `include` key, the v8 provider reports only the files a test actually
			 * `import`-ed: a source file no suite ever loads is ABSENT from the report rather
			 * than listed at 0%, and `thresholds` reads 100% over a set that quietly excludes
			 * it (RISK_REGISTER R07). This repo was the one package on the platform still in
			 * that state — 26 files in the report against 27 on disk, the missing one being
			 * scripts/seedKeygrip.js. The globs below name every shipped source file, so a new
			 * one is force-listed at 0% and takes the run red until it has a test.
			 *
			 * ⚠️ `coverage.all` does NOT do this. It was removed in vitest 4 and is read by
			 * nothing; a non-null `include` is the whole mechanism. Do not replace one with the
			 * other.
			 *
			 * setup/ is deliberately unnamed: it is gitignored, untracked, and setup/mongodb.js
			 * is a mongosh runbook carrying real credentials rather than JavaScript — the same
			 * call stryker.config.mjs makes with `!setup/**`, for the same two reasons.
			 */
			include: ['migrate-mongo-config.js', 'lib/**/*.js', 'migrations/**/*.js', 'scripts/**/*.js'],
			/*
			 * scripts/seedKeygrip.js is the admin entry point for ADR-034, out of scope the same
			 * way an `index.mts` is in the services: everything it decides lives in lib/keygrip.js,
			 * which IS covered and IS mutated. What is left is a Redis connection, one argv flag
			 * and four console lines, and covering them takes a test that connects to a real Redis
			 * to assert on wording. stryker.config.mjs excludes it for exactly this reason.
			 *
			 * Named file by file rather than as `scripts/**`: the blanket form would exempt the
			 * next file added under scripts/ as silently as the missing `include` exempted this
			 * one, which is the failure this whole block exists to stop.
			 */
			exclude: ['scripts/seedKeygrip.js'],
			reporter: ['text', 'text-summary', 'html', 'lcov'],
			thresholds: { 100: true }
		}
	}
})
