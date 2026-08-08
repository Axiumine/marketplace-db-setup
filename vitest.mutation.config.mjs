import { defineConfig } from 'vitest/config'

// The config Stryker runs the suite under. It is the normal one minus the coverage block, for two
// reasons: Stryker drives its own per-test coverage instrumentation and would fight a v8 provider
// configured underneath it, and the `thresholds: { 100: true }` gate would fail the dry run the
// moment a mutant made a line unreachable — turning "this mutant survived" into "the whole run is
// red", which is not the question being asked.
//
// ⚠️ Everything else is deliberately identical to vitest.config.mjs, `fileParallelism: false` above
// all. See stryker.config.mjs for why the concurrency there is 1: all three suites share one real
// MongoDB database and the migration suite drops it in before(), so any parallelism at either
// layer has one worker wiping another's collections mid-replay.
export default defineConfig({
	test: {
		include: ['test/**/*.test.mjs'],
		fileParallelism: false,
		testTimeout: 30000,
		hookTimeout: 30000
	}
})
