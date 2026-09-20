import base from './stryker.config.mjs'

/*
 * The mutation gate as a GitHub runner can run it: the whole configuration, minus the part of it
 * that cannot exist without a MongoDB replica set.
 *
 * ⚠️ This is NOT a relaxation of the gate. `.githooks/pre-push` still runs `yarn test:mutation` —
 * the real config, every pattern, score 100 or no push — against the replica set the workstation
 * has (marketplace-docker-DBs). What a runner cannot do is replay the migrations:
 * test/migrations.test.mjs skips itself when there is no database, so every mutant whose only
 * killer lives in that file comes back survived. The first pull-request run said so in the most
 * confusing form available — 85.68 against a break threshold of 100, with 60 survivors nobody
 * introduced.
 *
 * What is dropped, and why each is unkillable without a database:
 *   - migrations/**\/*.js — replayed by migrate-mongo against a real database or not at all. 56 of
 *     those 60 survivors were in 20260301000600-seed-demo.js alone.
 *   - lib/encryption.js — the whole file, not a line range. Its unit test reaches part of it and
 *     the rest only through the field-level encryption the replay sets up; the first run killed 21
 *     mutants there and still reported 3 survived and 34 uncovered. A line-range union would keep
 *     those 21 in scope, and would also be a set of line numbers that quietly stops meaning what it
 *     says the next time the file changes length — the trap src/index.mts carries in the nine
 *     services. Stability is worth more here than 21 mutants the stricter gate already covers.
 *
 * What remains is 582 mutants — lib/schemas/**, lib/keygrip.js, lib/mongoUrl.js and
 * migrate-mongo-config.js — and the first run killed every one of them with no database present.
 *
 * The test set is deliberately NOT narrowed to match. migrations.test.mjs skipping itself is what
 * makes it harmless here, and a second vitest config would be one more file to keep in step for no
 * gain.
 */
const DATABASE_ONLY = 'migrations/**/*.js'
const hermetic = base.mutate.filter((pattern) => pattern !== DATABASE_ONLY)

// Loud, because the alternative is silent. If that pattern is ever renamed in stryker.config.mjs,
// this file would go on mutating the migrations on a runner that cannot kill them, and the gate
// would fail for a reason that reads like a missing test.
if (hermetic.length !== base.mutate.length - 1) {
	const where = 'stryker.ci.config.mjs'
	throw new Error(`${where}: '${DATABASE_ONLY}' is no longer one of stryker.config.mjs's mutate patterns`)
}

/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
export default {
	// Everything else — thresholds, `related: false`, concurrency 1, timeoutMS, ignorePatterns —
	// comes from the real config, and must keep coming from there.
	...base,
	mutate: [...hermetic, '!lib/encryption.js']
}
