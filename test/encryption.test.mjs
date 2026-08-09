// Unit tests for the four guards in `lib/encryption.js` that a working migration never trips.
//
// `test/migrations.test.mjs` drives the whole of that file against a real MongoDB and a real master
// key — the demo seed encrypting field by field before it writes, and the deterministic lookup the
// encryption exists to make possible. What it cannot drive is the file refusing to run: every one of these branches is entered
// only when the environment is wrong, and an environment that is wrong produces no migration at all
// rather than a bad one.
//
// They are worth a test rather than a threshold exemption because each is the *only* thing standing
// between a misconfiguration and permanent data loss. A missing `CSFLE_KEY_VAULT_NAMESPACE` or a
// truncated master key must stop the migration before the first `encrypt` call: a conversion run
// under the wrong key writes blobs no other key can open, and `down` cannot undo it because `down`
// needs that same key to decrypt.
//
// ⚠️ Every test here passes `null` as the client, deliberately. All four guards run *before*
// `openEncryption` touches the connection, and a `null` client is the cheapest possible proof of
// that ordering: if one ever moves below the `ClientEncryption` construction, these stop failing
// with the message they assert and start failing with a `TypeError`.
import { afterEach, test } from 'vitest';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

// `require`, not `import()`, for the reason spelled out at length in test/migrations.test.mjs:
// the migration suite loads this same CommonJS file through node's own loader, and pulling in a
// vite-transformed second copy hands v8 two scripts for one path whose coverage ranges do not merge.
const require = createRequire(import.meta.url);
const { openEncryption, ENV_MASTER_KEY_PATH, ENV_KEY_VAULT_NAMESPACE, MASTER_KEY_LENGTH } = require('../lib/encryption.js');

// The migration suite sets both variables for the whole process and its `beforeAll` may already have
// run. Snapshot and restore rather than delete, so the order the files happen to run in cannot
// matter.
const saved = { [ENV_MASTER_KEY_PATH]: process.env[ENV_MASTER_KEY_PATH], [ENV_KEY_VAULT_NAMESPACE]: process.env[ENV_KEY_VAULT_NAMESPACE] };
const dirs = [];

afterEach(() => {
  for (const [name, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

/** A throwaway directory holding a master key file of whatever length the test wants. */
function keyFile(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'marketplace-csfle-guard-'));
  dirs.push(dir);
  const file = path.join(dir, 'master.key');
  fs.writeFileSync(file, crypto.randomBytes(bytes), { mode: 0o600 });
  return file;
}

test('an unset key vault namespace stops the migration before it connects', async () => {
  delete process.env[ENV_KEY_VAULT_NAMESPACE];
  process.env[ENV_MASTER_KEY_PATH] = keyFile(MASTER_KEY_LENGTH);

  await assert.rejects(openEncryption(null, 'admin'), (err) => {
    assert.match(err.message, /^CSFLE_KEY_VAULT_NAMESPACE is not set/, 'the message names the variable to set');
    return true;
  });
});

// The empty string is the case that matters in practice and the one a plain `undefined` check misses:
// `env` ships `CSFLE_MASTER_KEY_PATH=` with nothing after it, so a `.env` copied from the template
// and not filled in defines the variable — as `''`. Treating that as set would carry the failure all
// the way down to `readFileSync('')`.
test('a key vault namespace set to the empty string counts as unset', async () => {
  process.env[ENV_KEY_VAULT_NAMESPACE] = '';
  process.env[ENV_MASTER_KEY_PATH] = keyFile(MASTER_KEY_LENGTH);

  await assert.rejects(openEncryption(null, 'admin'), (err) => {
    assert.match(err.message, /^CSFLE_KEY_VAULT_NAMESPACE is not set/, 'the empty value is refused, not read');
    return true;
  });
});

test('an unset master key path stops the migration too', async () => {
  process.env[ENV_KEY_VAULT_NAMESPACE] = 'encryption.__keyVault';
  delete process.env[ENV_MASTER_KEY_PATH];

  await assert.rejects(openEncryption(null, 'admin'), (err) => {
    assert.match(err.message, /^CSFLE_MASTER_KEY_PATH is not set/, 'the other variable is guarded by the same check');
    return true;
  });
});

// 96 bytes, not 32 — the `local` KMS provider splits the key into a 32-byte encryption key, a 32-byte
// MAC key and 32 bytes of reserve. A 32-byte file is the mistake this guard exists for, because it is
// what `openssl rand 32` and every "generate an AES-256 key" instruction produce.
test('a master key of the wrong length is refused, with both lengths in the message', async () => {
  process.env[ENV_KEY_VAULT_NAMESPACE] = 'encryption.__keyVault';
  process.env[ENV_MASTER_KEY_PATH] = keyFile(32);

  await assert.rejects(openEncryption(null, 'admin'), (err) => {
    assert.equal(err.message, `The CSFLE master key must be exactly ${MASTER_KEY_LENGTH} bytes, got 32`,
      'the message says what was expected and what was found');
    return true;
  });
});

test('a master key of exactly the right length gets past the guards', async () => {
  process.env[ENV_KEY_VAULT_NAMESPACE] = 'encryption.__keyVault';
  process.env[ENV_MASTER_KEY_PATH] = keyFile(MASTER_KEY_LENGTH);

  // It gets no further than the guards here: the next thing `openEncryption` does is create the
  // unique index on the vault, and the client is `null`. That TypeError is the assertion — it is
  // proof the length check passed, and it is what pins the check to `!==` rather than `===`, which
  // would otherwise let a 96-byte key through the door marked "wrong length" unnoticed.
  await assert.rejects(openEncryption(null, 'admin'), (err) => {
    assert.equal(err.constructor.name, 'TypeError', 'it failed on the null client, not on the key');
    return true;
  });
});
