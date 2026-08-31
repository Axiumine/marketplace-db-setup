// The cookie-signing key set, minted here and read by five services out of Redis (ADR-034).
//
// ⚠️ **This file is a deliberate duplicate of `marketplace-common/src/encryption/wrapKeygripKeys.mts`
// and `src/others/keygripFingerprint.mts`, byte for byte in what it produces.** It cannot import them:
// that package is ESM with TypeScript path aliases and is consumed by the nine services, while this repo
// is CommonJS and is run with plain `node` before any service exists. Duplicating twenty lines of
// `node:crypto` is the smaller price — the alternative is a build step in the one repo whose job is to
// be runnable against a virgin machine.
//
// ⚠️ **The format is the contract, and the readers are five processes that will refuse to boot if it
// drifts.** Any change here — the IV length, the tag length, the concatenation order, the AAD, the JSON
// shape, the fingerprint separator or its slice — has to land in `marketplace-common` in the same piece
// of work. There is no test that spans the two repos (BCON-03), so nothing will catch a drift except a
// fleet that stops starting.
//
// ⚠️ **Nothing here is ever wired into a service's boot** (ADR-034, *Signals a violation*). Minting a
// signing key is an admin act: a service that could mint its own would silently re-key the fleet every
// time it started against an empty Redis, which is precisely the split-brain this ADR removes.

const { createCipheriv, createHash, randomBytes } = require('node:crypto');

/**
 * Bytes of key material per signing key. An SHA-512 HMAC key is 64 bytes: shorter weakens the MAC, and
 * longer than 128 is hashed down before use, so the extra length would be discarded.
 */
const KEY_BYTES = 64;

/** Bytes a decoded `KEYGRIP_KEK` must be — AES-256 takes a 256-bit key and nothing else. */
const KEK_BYTES = 32;

/** GCM standard IV: at 12 bytes the counter block is used directly, any other length is hashed first. */
const IV_BYTES = 12;

/**
 * The Redis hash this writes, and the holders hash it deliberately does NOT write.
 *
 * Both are built from `REDIS_KEY` exactly as `marketplace-common/src/others/sessionKeys.mts` builds them
 * — same prefix, same suffixes. The holders name is here only so the script can tell an admin where
 * to look; a seed run must never write a row into it, because a holder is a service that has adopted the
 * keys and this script is not one.
 */
const keygripKey = (env) => `${env.REDIS_KEY}keygrip`;
const keygripHoldersKey = (env) => `${env.REDIS_KEY}keygrip:holders`;

/**
 * The public name of a key set: `sha256(ids joined by ':')`, first 12 hex characters.
 *
 * Over the key *ids*, never the material — this string is written to Redis in the clear, printed to a
 * terminal and read off an admin screen. See `keygripFingerprint.mts` for the full argument.
 */
function keygripFingerprint(keys) {
  return createHash('sha256')
    .update(keys.map((key) => key.id).join(':'))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Wraps the ordered key array into the single opaque string the record holds.
 *
 * Layout: `iv(12) ‖ tag(16) ‖ ciphertext`, base64. One field rather than three, because a hash with
 * separate `iv`/`tag`/`ciphertext` fields can be half-written, and a new ciphertext read against an old
 * tag is a boot failure on a service that was running a second ago.
 *
 * ⚠️ **The version is the AAD.** It binds the blob to the version number in the same hash, so a captured
 * older `wrapped` cannot be pasted back under a higher version to roll the fleet onto a retired key.
 */
function wrapKeygripKeys(keys, version, kek) {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', kek, iv);

  cipher.setAAD(Buffer.from(String(version)));

  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(keys)), cipher.final()]);

  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

/**
 * The KEK, decoded and length-checked.
 *
 * Refused rather than padded or hashed: a 32-byte key derived from whatever the admin happened to
 * type would still wrap and unwrap perfectly here, and would differ from what the five services derive
 * only if they ever derived it differently. One shape, checked in both places, and the error says what
 * it decoded to so a truncated copy/paste is obvious.
 */
function readKek(env) {
  const kek = Buffer.from(env.KEYGRIP_KEK ?? '', 'base64');

  if (kek.length !== KEK_BYTES)
    throw new Error(`KEYGRIP_KEK must be base64 of ${KEK_BYTES} bytes, this one decodes to ${kek.length}. Mint one with: openssl rand -base64 32`);

  return kek;
}

/**
 * The key array a seed run starts the fleet with — adopted from the old environment pair when it is
 * there, freshly minted when it is not.
 *
 * ⚠️ **Adoption is the whole reason this is not simply "mint one key".** A machine already running the
 * pre-ADR-034 arrangement has live cookies signed with `KEYGRIP_KEY_1`; seeding a fresh key set would
 * make every one of them unverifiable and log out every session on the platform at once. Carrying the
 * pair in keeps them valid until they age out on their own.
 *
 * ⚠️ **`KEYGRIP_KEY_1` becomes index 0** — the old code built `new Keygrip([KEYGRIP_KEY_1,
 * KEYGRIP_KEY_2], 'sha512')`, so `_1` is the key that has been signing. Reversing them here would keep
 * every cookie verifiable and still change which key signs, which is a rotation nobody asked for.
 *
 * `KEYGRIP_KEY_2` alone is not adopted: it was never the signer, and a machine that has one but not the
 * other is misconfigured in a way this script must not paper over.
 */
function buildSeedKeys(env, now) {
  const createdAt = now.toISOString();

  if (env.KEYGRIP_KEY_1) {
    const adopted = [{ id: 'k1', material: env.KEYGRIP_KEY_1, createdAt }];

    if (env.KEYGRIP_KEY_2) adopted.push({ id: 'k2', material: env.KEYGRIP_KEY_2, createdAt });

    return { keys: adopted, adopted: true };
  }

  return { keys: [{ id: 'k1', material: randomBytes(KEY_BYTES).toString('base64'), createdAt }], adopted: false };
}

/**
 * Writes the record, or refuses.
 *
 * ⚠️ **An existing record is never overwritten without `--force`.** Overwriting is a fleet-wide re-key:
 * every session cookie signed under the old array stops verifying, and every service that has already
 * booted keeps its old keys until it is restarted or a rotation is published — so the fleet is split
 * exactly the way ADR-034 exists to prevent. A rotation is `keygripRotate`, which prepends and
 * publishes; this script is for a machine that has no record at all.
 *
 * ⚠️ **A forced write bumps the version rather than reusing it.** The version is the GCM AAD, so leaving
 * it where it is would produce two different blobs that are both valid under the same number, and the
 * older one could be written back over the newer with nothing detecting it. It also gives the running
 * fleet's five-minute version poll something to notice.
 *
 * The store is a parameter, not a client this file creates: this function is the whole of the decision
 * and is unit-tested against a fake hash, while `scripts/seedKeygrip.js` owns the connection.
 */
async function seedKeygripRecord(store, options) {
  const env = options.env;
  const existing = await store.hGetAll(keygripKey(env));
  const hasRecord = Boolean(existing && existing.wrapped && existing.version);

  if (hasRecord && !options.force)
    return {
      written: false,
      version: Number(existing.version),
      fp: existing.fp,
      adopted: false
    };

  const kek = readKek(env);
  const version = hasRecord ? Number(existing.version) + 1 : 1;
  const { keys, adopted } = buildSeedKeys(env, options.now);
  const fp = keygripFingerprint(keys);

  await store.hSet(keygripKey(env), {
    version: String(version),
    wrapped: wrapKeygripKeys(keys, version, kek),
    fp
  });

  return { written: true, version, fp, adopted };
}

module.exports = {
  IV_BYTES,
  KEK_BYTES,
  KEY_BYTES,
  buildSeedKeys,
  keygripFingerprint,
  keygripHoldersKey,
  keygripKey,
  readKek,
  seedKeygripRecord,
  wrapKeygripKeys
};
