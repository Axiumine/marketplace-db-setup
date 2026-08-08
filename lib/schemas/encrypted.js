// What an encrypted field looks like to a collection validator.
//
// MongoDB Community has neither automatic CSFLE nor Queryable Encryption, so the platform encrypts
// explicitly: the service replaces the value with a BinData subtype 6 blob before it leaves the
// process (ADR-029). The server therefore stores a binary and knows nothing else about it — no
// length, no pattern, no format, no ordering.
//
// ⚠️ **Every field-level rule a plaintext declaration carried is gone, and cannot be kept.** A
// `maxLength` on a ciphertext bounds the blob, not the address inside it; a `pattern` matches bytes
// no human wrote. `personalData.address.postalCode` loses its exactly-5 rule and
// `personalData.address.province` its exactly-2 the moment either is encrypted. Those bounds now hold
// in one place only — the GraphQL input validation in the services — and that is the price of the
// encryption, stated here so nobody looks for a database rule that is no longer there.
//
// ⚠️ **Which fields are encrypted is written down in TWO repos and nothing checks that they agree.**
// Here, and in `marketplace-common/src/encryption/encryptedFields.mts`. A field declared `binData`
// here but missing there is written in the clear and refused by this validator on the next write; a
// field declared there but still `string` here is written encrypted and refused for the mirror
// reason. Both failures are loud, which is the one good thing about them — but they are only loud at
// write time. Change both lists in the same piece of work.
//
// ⚠️ Read `lib/schemas/README.md` before changing anything here.

/**
 * One encrypted field.
 *
 * `description` has no default and is not optional, for the same reason `positionRequired` has none
 * in `geo.js`: a defaulted argument no call site passes is a branch no test can reach. It also earns
 * its place — a `binData` node says nothing at all about what it holds, so once the type is gone the
 * description is the entire documentation of the field rather than decoration on top of it.
 */
function encryptedField(description) {
  return {
    bsonType: 'binData',
    description
  };
}

module.exports = { encryptedField };
