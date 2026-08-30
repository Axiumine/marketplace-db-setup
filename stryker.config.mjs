/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	testRunner: 'vitest',
	vitest: {
		configFile: 'vitest.mutation.config.mjs',
		/*
		 * ⚠️ Off, and it has to be. Stryker defaults to vitest's `--related` filter, which walks the
		 * static import graph to decide which test files touch a mutated file — and nothing here is
		 * reached by a static import. The migrations are loaded by migrate-mongo at runtime with
		 * `require()` against a path it assembles itself, and lib/schemas/* are required by those
		 * migrations rather than by any test. The graph is therefore empty, and the symptom is not a
		 * missed mutant but a dead run: "No tests were found", exit before the first mutant.
		 */
		related: false
	},
	coverageAnalysis: 'perTest',
	reporters: ['clear-text', 'progress', 'html'],
	/**
	 * ⚠️ 1, not the 28 every other repo on the platform uses, and it is not a tuning oversight.
	 *
	 * This suite runs against a REAL MongoDB and `before()` calls `dropDatabase()` before replaying
	 * every migration. The database name comes from MONGO_TEST_DB, one value for the whole repo, so
	 * two Stryker workers are two processes dropping and re-migrating the same database at the same
	 * time: the second wipes the first's collections mid-replay and both report failures that have
	 * nothing to do with the mutant under test. Overload of that kind does not read as a broken run,
	 * it reads as a *high* score — Stryker records a mutant whose test failed as killed.
	 *
	 * A per-worker database would fix it and cannot be built here: the URL authenticates against
	 * MONGO_TEST_AUTH_ADMIN, whose two users are provisioned with `dbOwner` scoped to that one
	 * database (setup/mongodb.js), so a worker pointed at `dbMarketplaceTest_2` authenticates fine
	 * and is then refused every write. Widening that grant is a change to the server, not to this
	 * file.
	 *
	 * The cost is bearable because the suite is: 60 tests in ~3s, and `perTest` analysis runs only
	 * the tests that cover each mutant.
	 */
	concurrency: 1,
	timeoutMS: 60000,
	// Mutation score is a push gate. `break` fails the run (exit 1) below this score, which is what
	// .githooks/pre-push keys off. Never lower it to make a run pass — add the missing assertion.
	thresholds: { high: 100, low: 95, break: 100 },
	/**
	 * Scan and coverage output, copied into the sandbox for no reason. Stryker's always-ignored list
	 * covers only `node_modules`, `.git`, `/reports`, `*.tsbuildinfo`, `/stryker.log` and
	 * `.stryker-tmp` — `ignorePatterns` itself defaults to empty, and `.qodana/` runs to tens of
	 * megabytes.
	 */
	ignorePatterns: ['.qodana', 'coverage'],
	mutate: [
		'lib/**/*.js',
		'migrations/**/*.js',
		'migrate-mongo-config.js',
		/*
		 * setup/mongodb.js is not JavaScript. It is the provisioning runbook — mongosh invocations
		 * and prose — that happens to carry a .js extension, so every "mutant" in it is a mutation
		 * of documentation no test can execute. ⚠️ It also contains real credentials in an unquoted
		 * `-password` flag; keeping it out of the sandbox keeps them out of one more place.
		 */
		'!setup/**',
		/*
		 * scripts/seedKeygrip.js is the admin entry point for ADR-034, and it is out of scope the
		 * same way an `index.mts` is in the services: everything it decides lives in lib/keygrip.js,
		 * which IS mutated and is unit-tested against a fake hash. What is left here is a Redis
		 * connection, one argv flag and four console lines — killing a mutant in any of them would
		 * take a test that connects to a real Redis to assert on wording.
		 *
		 * Neither positive pattern above reaches scripts/, so this is a statement of intent rather
		 * than a filter that removes anything today. It stops the next file added under scripts/
		 * from silently being outside the gate for a reason nobody wrote down.
		 */
		'!scripts/**'
	]
}
