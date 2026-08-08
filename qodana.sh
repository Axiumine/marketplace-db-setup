#!/usr/bin/env bash
# Run the full Qodana Ultimate scan set for this repo, with QODANA_TOKEN
# auto-loaded from .env (the Qodana CLI reads process env, not the .env file).
# The token is exported into the process env and is never printed.
#
# Scans enabled (configured in qodana.yaml):
#   - code inspections + SAST / taint dataflow   (qodana.recommended profile)
#   - vulnerable-dependency check (SCA)           (Ultimate, automatic)
#   - third-party license audit                   (Ultimate Plus, raiseLicenseProblems)
#   - test coverage                               (vitest lcov -> --coverage-dir)
#
# The coverage line is new. This script used to say outright that it did NOT run a
# coverage pre-step, because qodana.yaml omitted testCoverageThresholds on the grounds
# that gating migration files would be theatre. That held while the only suite here was
# the end-to-end replay; it stopped holding when test/migrationGuards.test.mjs and
# test/mongoUrl.test.mjs landed and took the repo to 100% on every metric. It is gated
# like the other thirteen now.
#
# Extra args pass through to `qodana scan`, e.g. ./qodana.sh --baseline qodana.sarif.json
# Env:
#   SKIP_TESTS=1   reuse the existing coverage/lcov.info instead of re-running vitest
set -euo pipefail

cd "$(dirname "$0")"

if [[ ! -f .env ]]; then
	echo "qodana.sh: .env not found next to this script" >&2
	exit 1
fi

# Read QODANA_TOKEN only. Take everything after the first '=', strip one optional
# layer of surrounding single/double quotes. Never echo the value.
QODANA_TOKEN="$(grep -E '^[[:space:]]*QODANA_TOKEN[[:space:]]*=' .env | tail -n1 | cut -d= -f2- | sed -e 's/^[[:space:]]*//' -e 's/^"//' -e 's/"$//' -e "s/^'//" -e "s/'\$//")"
if [[ -z "${QODANA_TOKEN:-}" ]]; then
	echo "qodana.sh: QODANA_TOKEN missing or empty in .env" >&2
	exit 1
fi
export QODANA_TOKEN

# Regenerate coverage so the coverage scan reflects the current code.
# vitest writes lcov to coverage/lcov.info (reporter configured in vitest.config.mjs).
# `|| true`: a <100% threshold miss must not abort the scan here — Qodana enforces the
# 100% gate itself (qodana.yaml testCoverageThresholds) and reports the shortfall.
# vitest still writes coverage/lcov.info before it fails on the threshold.
#
# NOTE: the suite runs against a REAL MongoDB (MONGO_TEST_* from .env) and drops its own
# database. If the server is unreachable the run bails and lcov.info keeps the PREVIOUS
# run's numbers — Qodana would then scan stale coverage. Make sure Mongo is reachable
# before trusting the coverage verdict.
if [[ "${SKIP_TESTS:-0}" != "1" ]]; then
	yarn test:cov || true
elif [[ ! -f coverage/lcov.info ]]; then
	echo "qodana.sh: SKIP_TESTS=1 but coverage/lcov.info is missing — run once without SKIP_TESTS first" >&2
	exit 1
fi

# A scan killed mid-flight (Ctrl-C, a truncated pipe, a crashed terminal) leaves its
# container behind, and the CLI derives the container name from the project path — so every
# later run dies with "container name ... is already in use" and never scans anything.
# Remove only *stopped* qodana containers: a running one belongs to a concurrent scan.
stale="$(docker ps -aq --filter 'name=^qodana-cli-' --filter 'status=exited' --filter 'status=created' --filter 'status=dead' 2>/dev/null || true)"
if [[ -n "$stale" ]]; then
	echo "qodana.sh: removing $(wc -w <<< "$stale") stale qodana container(s) from an interrupted run"
	docker rm -f $stale >/dev/null || true
fi

# --run-promo true forces the promo (Ultimate) inspections on alongside the profile.
exec qodana scan --run-promo true --coverage-dir coverage "$@"
