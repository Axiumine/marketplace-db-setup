#!/usr/bin/env node
// `yarn seed:keygrip` — mints the fleet's cookie-signing key set into Redis (ADR-034).
//
// ⚠️ **Run this once, before any service starts, on a machine whose Redis has no keygrip record.** The
// five services that sign or read the session cookie refuse to boot without it, deliberately: the record
// is the single source of truth this ADR replaced five `.env` copies with. It is listed in SETUP.md
// ahead of the services for that reason.
//
// ⚠️ **It must never be wired into a service's boot** (ADR-034, *Signals a violation*). A service that
// minted its own keys against an empty Redis would silently re-key the fleet on every restart — the exact
// split-brain the design removes — and would put key minting behind a network port.
//
// Everything this decides lives in lib/keygrip.js, unit-tested against a fake hash. What is here is the
// part that cannot be: the connection, the flag, and what an operator reads afterwards.

const dotenv = require('dotenv');
const { createClient, createCluster } = require('redis');

const { keygripHoldersKey, keygripKey, seedKeygripRecord } = require('../lib/keygrip');

dotenv.config();

/**
 * The same client shape the services build (`@axiumine/koa-utils/dataSources/Redis`), down to the
 * `REDIS_IS_CLUSTER` switch: a record written against one node of a cluster and read through the cluster
 * client would be looked for on whichever node the key hashes to, and the seed would appear to have done
 * nothing.
 */
function buildClient(env) {
  if (env.REDIS_IS_CLUSTER === '1')
    return createCluster({
      rootNodes: [
        { url: `redis://${env.REDIS_DB1_HOST}:${env.REDIS_DB1_PORT}` },
        { url: `redis://${env.REDIS_DB2_HOST}:${env.REDIS_DB2_PORT}` },
        { url: `redis://${env.REDIS_DB3_HOST}:${env.REDIS_DB3_PORT}` }
      ],
      defaults: { username: env.REDIS_USERNAME, password: env.REDIS_PASSWORD }
    });

  return createClient({ url: env.REDIS_URL });
}

async function main() {
  const env = process.env;
  // `--force` is spelled out at the call site rather than parsed into a config: it is the one flag, and
  // what it does is overwrite a key set the fleet may be using.
  const force = process.argv.includes('--force');

  if (!env.REDIS_KEY) throw new Error('REDIS_KEY is not set. It is the prefix every key on this platform shares — see docs/architecture.md.');

  const client = buildClient(env);

  try {
    await client.connect();

    const result = await seedKeygripRecord(client, { env, force, now: new Date() });

    if (!result.written) {
      console.info(`A keygrip record already exists at "${keygripKey(env)}": version ${result.version} (${result.fp}).`);
      console.info('Nothing was written. Rotating a live key set is `keygripRotate` in the operator panel, not this script.');
      console.info('Re-run with --force ONLY to replace it wholesale — every session cookie signed under the old keys stops verifying.');

      return;
    }

    // The fingerprint, because it is the string an operator compares against the holders table, and
    // never a key: this output lands in terminals, scrollback and screenshots.
    console.info(`Wrote keygrip record version ${result.version} (${result.fp}) to "${keygripKey(env)}".`);
    console.info(
      result.adopted
        ? 'Adopted the existing KEYGRIP_KEY_1/KEYGRIP_KEY_2 pair, KEYGRIP_KEY_1 first — sessions signed with it stay valid.'
        : 'Minted a fresh signing key. Any session cookie issued before now stops verifying.'
    );
    console.info(`Start the services, then check they agree: HGETALL "${keygripHoldersKey(env)}" — one row per service, all carrying ${result.fp}.`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
