// Unit tests for lib/keygrip.js — the seed side of ADR-034.
//
// Nothing here connects to Redis. `seedKeygripRecord` takes its store as a parameter for exactly this
// reason, so the decisions worth testing — refuse an existing record, bump the version when forced,
// adopt the old environment pair rather than log the platform out — are driven against a fake hash and
// asserted on what would have been written.
//
// ⚠️ **The unwrap is done here with plain `node:crypto`, not with this file's own helper**, and that is
// the point of the round-trip tests. What has to hold is that a reader who knows only the format —
// `iv(12) ‖ tag(16) ‖ ciphertext`, version as AAD — can open what this wrote, because the readers are
// five services in another repo that share no code with it (BCON-03). A test that decrypted with a
// `unwrapKeygripKeys` from the same file would pass just as happily on a format both halves got wrong.
import { createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

import { test } from 'vitest';

// ⚠️ `require`, not `import`, for the reason spelled out in mongoUrl.test.mjs: scripts/seedKeygrip.js
// pulls this file in through node's own loader, and two coverage reports for one path with mismatched
// byte offsets lose ranges instead of merging.
const { buildSeedKeys, keygripFingerprint, keygripHoldersKey, keygripKey, readKek, seedKeygripRecord, wrapKeygripKeys } = createRequire(
  import.meta.url
)('../lib/keygrip.js');

const KEK = randomBytes(32);
const ENV = { REDIS_KEY: 'marketplaceDev:', KEYGRIP_KEK: KEK.toString('base64') };
const NOW = new Date('2026-08-12T09:14:22.581Z');

/** A hash that answers `hGetAll` and records `hSet`, which is the whole of what the store contract is. */
function fakeStore(initial = {}) {
  const calls = [];

  return {
    calls,
    hGetAll: async () => initial,
    hSet: async (key, value) => void calls.push({ key, value })
  };
}

/** The reader's half of the format, written out against `node:crypto` and nothing else. */
function unwrap(wrapped, version, kek = KEK) {
  const blob = Buffer.from(wrapped, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', kek, blob.subarray(0, 12), { authTagLength: 16 });

  decipher.setAAD(Buffer.from(String(version)));
  decipher.setAuthTag(blob.subarray(12, 28));

  return JSON.parse(Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]).toString());
}

test('the key names carry the shared prefix and nothing else', () => {
  assert.equal(keygripKey(ENV), 'marketplaceDev:keygrip');
  assert.equal(keygripHoldersKey(ENV), 'marketplaceDev:keygrip:holders');
});

// The fingerprint is compared across repos by eye and by the admin screen, so what is asserted is the
// exact string, computed here the long way round.
test('the fingerprint is 12 hex characters of sha256 over the ids, not the material', () => {
  const keys = [
    { id: 'k2', material: 'AAAA', createdAt: '2026-08-12T09:14:22.581Z' },
    { id: 'k1', material: 'BBBB', createdAt: '2026-05-01T08:00:00.000Z' }
  ];

  assert.equal(keygripFingerprint(keys), createHash('sha256').update('k2:k1').digest('hex').slice(0, 12));
  // Same ids, different material: the material must not be reachable from this string at all.
  assert.equal(keygripFingerprint(keys), keygripFingerprint(keys.map((key) => ({ ...key, material: 'CCCC' }))));
});

test('a wrapped array round-trips through a reader that knows only the format', () => {
  const keys = [{ id: 'k1', material: randomBytes(64).toString('base64'), createdAt: NOW.toISOString() }];

  assert.deepEqual(unwrap(wrapKeygripKeys(keys, 7, KEK), 7), keys);
});

// ⚠️ The AAD, which is the reason the version is not simply a field. A blob wrapped under version 7 must
// not open under 8, or a captured older `wrapped` could be pasted back over a rotated record.
test('a blob does not open under a version other than the one it was wrapped under', () => {
  const wrapped = wrapKeygripKeys([{ id: 'k1', material: 'AAAA', createdAt: NOW.toISOString() }], 7, KEK);

  assert.throws(() => unwrap(wrapped, 8));
});

test('a fresh IV per wrap: the same keys under the same version never produce the same blob', () => {
  const keys = [{ id: 'k1', material: 'AAAA', createdAt: NOW.toISOString() }];

  assert.notEqual(wrapKeygripKeys(keys, 1, KEK), wrapKeygripKeys(keys, 1, KEK));
});

test('readKek refuses anything that does not decode to 32 bytes', () => {
  assert.deepEqual(readKek(ENV), KEK);
  assert.throws(() => readKek({}), /decodes to 0/);
  assert.throws(() => readKek({ KEYGRIP_KEK: randomBytes(16).toString('base64') }), /decodes to 16/);
});

// ⚠️ The migration path. A machine already running the pre-ADR-034 pair keeps signing with KEYGRIP_KEY_1
// — at index 0, because that is the key the old `new Keygrip([_1, _2])` signed with — so no live session
// is invalidated by the move.
test('an existing KEYGRIP_KEY_1/_2 pair is adopted in order, KEYGRIP_KEY_1 first', () => {
  const { keys, adopted } = buildSeedKeys({ ...ENV, KEYGRIP_KEY_1: 'one', KEYGRIP_KEY_2: 'two' }, NOW);

  assert.equal(adopted, true);
  assert.deepEqual(keys, [
    { id: 'k1', material: 'one', createdAt: '2026-08-12T09:14:22.581Z' },
    { id: 'k2', material: 'two', createdAt: '2026-08-12T09:14:22.581Z' }
  ]);
});

test('KEYGRIP_KEY_1 alone is adopted on its own; KEYGRIP_KEY_2 alone is not adopted at all', () => {
  const one = buildSeedKeys({ ...ENV, KEYGRIP_KEY_1: 'one' }, NOW);
  const two = buildSeedKeys({ ...ENV, KEYGRIP_KEY_2: 'two' }, NOW);

  assert.equal(one.adopted, true);
  assert.equal(one.keys.length, 1);
  // The second key was never the signer, so a machine holding only it is misconfigured rather than
  // migratable — it gets a fresh key, and the material it holds is not carried anywhere.
  assert.equal(two.adopted, false);
  assert.equal(two.keys.length, 1);
  assert.notEqual(two.keys[0].material, 'two');
});

test('with no pair in the environment a single 64-byte key is minted', () => {
  const { keys, adopted } = buildSeedKeys(ENV, NOW);

  assert.equal(adopted, false);
  assert.deepEqual(Object.keys(keys[0]), ['id', 'material', 'createdAt']);
  assert.equal(keys[0].id, 'k1');
  assert.equal(keys[0].createdAt, '2026-08-12T09:14:22.581Z');
  assert.equal(Buffer.from(keys[0].material, 'base64').length, 64);
  // Minted, not fixed: two runs must not produce the same key.
  assert.notEqual(keys[0].material, buildSeedKeys(ENV, NOW).keys[0].material);
});

test('a virgin Redis is seeded at version 1 and the record is readable', async () => {
  const store = fakeStore();

  const result = await seedKeygripRecord(store, { env: ENV, force: false, now: NOW });

  assert.deepEqual(result, { written: true, version: 1, fp: result.fp, adopted: false });
  assert.equal(store.calls.length, 1);
  assert.equal(store.calls[0].key, 'marketplaceDev:keygrip');
  assert.equal(store.calls[0].value.version, '1');

  const keys = unwrap(store.calls[0].value.wrapped, 1);
  assert.equal(keys.length, 1);
  assert.equal(store.calls[0].value.fp, keygripFingerprint(keys));
});

// ⚠️ The refusal. Overwriting a live record re-keys the fleet: every session cookie signed under the old
// array stops verifying, and services already running keep the old keys until they restart.
test('an existing record is left alone and reported back, not overwritten', async () => {
  const store = fakeStore({ version: '4', wrapped: 'not-touched', fp: 'abcdef012345' });

  const result = await seedKeygripRecord(store, { env: ENV, force: false, now: NOW });

  assert.deepEqual(result, { written: false, version: 4, fp: 'abcdef012345', adopted: false });
  assert.equal(store.calls.length, 0);
});

// A half-written record — a `wrapped` with no `version`, or the reverse — is not a record. Treating it
// as one would refuse the seed and leave the fleet unable to boot with no way out but redis-cli.
test('a partial record does not count as a record', async () => {
  for (const partial of [{ version: '4' }, { wrapped: 'x' }, {}]) {
    const store = fakeStore(partial);

    const result = await seedKeygripRecord(store, { env: ENV, force: false, now: NOW });

    assert.equal(result.written, true);
    assert.equal(result.version, 1);
  }
});

// ⚠️ The version is the AAD, so a forced rewrite may never reuse the number it replaced: two valid blobs
// under one version would let the older be written back over the newer undetected.
test('a forced write bumps the version rather than reusing it', async () => {
  const store = fakeStore({ version: '4', wrapped: 'old', fp: 'abcdef012345' });

  const result = await seedKeygripRecord(store, { env: ENV, force: true, now: NOW });

  assert.equal(result.written, true);
  assert.equal(result.version, 5);
  assert.equal(store.calls[0].value.version, '5');
  assert.deepEqual(unwrap(store.calls[0].value.wrapped, 5).length, 1);
});

test('the pair is adopted through the seed itself, and reported as adopted', async () => {
  const store = fakeStore();

  const result = await seedKeygripRecord(store, { env: { ...ENV, KEYGRIP_KEY_1: 'one', KEYGRIP_KEY_2: 'two' }, force: false, now: NOW });

  assert.equal(result.adopted, true);
  assert.deepEqual(
    unwrap(store.calls[0].value.wrapped, 1).map((key) => key.material),
    ['one', 'two']
  );
});

// The KEK is read only once the write is going to happen, so an admin who runs the seed twice on a
// machine that already has a record is told about the record rather than about a missing variable.
test('a bad KEK stops a write but not the report on an existing record', async () => {
  await assert.rejects(seedKeygripRecord(fakeStore(), { env: { REDIS_KEY: 'marketplaceDev:' }, force: false, now: NOW }), /decodes to 0/);

  const store = fakeStore({ version: '4', wrapped: 'old', fp: 'abcdef012345' });
  const result = await seedKeygripRecord(store, { env: { REDIS_KEY: 'marketplaceDev:' }, force: false, now: NOW });

  assert.equal(result.written, false);
});
