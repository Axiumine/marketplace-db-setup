// Turns the two natural persons inside a company record into ciphertext — the third of four
// (ADR-029).
//
// Same shape and the same ordering argument as `20260808000000-alter-admin-encrypted`.
//
// ⚠️ **Two fields out of sixteen, and the fourteen it leaves alone are the whole point.** A company
// is a legal entity: `legalName`, `vatNumber`, `taxCode` — the 11-character company form, not the
// 16-character personal one — `uniqueCode`, `certifiedEmail` and `registryExtract` identify that
// entity and are a matter of public record, not personal data. `publicName`, `slug`, `description`
// and the whole of `address` are what the storefront hands to anonymous visitors, and they are read
// by `search_text`, `published_city_publicName` and `address.position_2dsphere`. Encrypting any of
// them would be encrypting data the platform publishes anyway, and paying for it with the map, the
// city listing and the search.
//
// `contactPerson` and `administrator` are different in kind: they are the names of two people. The
// company they belong to is public; they are not.
//
// ⚠️ **`collMod` here must restate BOTH clauses**, and `validatorCompany({ publicFields: true })`
// does. The validator has been an `$and` pair since `20260804010000` — the `$jsonSchema` half plus
// the `$expr` rule that a published company has a slug and a public name. `collMod` replaces a
// validator wholesale, so passing the schema half alone would silently drop the publish rule, and
// nothing would fail until an unlinkable company was put live.

const { setValidator } = require('../lib/schemas/collection');
const { validatorCompany } = require('../lib/schemas/company');
const { ALGORITHM_RANDOM, encryptStored, decryptStored } = require('../lib/encryption');

const COLLECTION = 'company';

/** The state `20260804010000` left behind — the flags this migration adds `encrypted` on top of. */
const CURRENT = { publicFields: true };

/**
 * ⚠️ A copy of `ENCRYPTED_FIELDS_COMPANY` in
 * `marketplace-common/src/encryption/encryptedFields.mts`, and nothing checks that the two agree.
 *
 * Both random. Nothing on this platform looks a company up by the name of its contact person, and
 * deterministic ciphertext would leak which companies share one for no return.
 *
 * ⚠️ A function rather than a constant — see `20260808000000-alter-admin-encrypted.js`.
 */
const plan = () => ({
  collection: COLLECTION,
  keyAltName: 'company',
  fields: [
    ['contactPerson', ALGORITHM_RANDOM],
    ['administrator', ALGORITHM_RANDOM]
  ]
});

module.exports = {
  async up(db, client) {
    await setValidator(db, COLLECTION, validatorCompany({ ...CURRENT, encrypted: true }));
    await encryptStored(db, client, plan());
  },

  async down(db, client) {
    await setValidator(db, COLLECTION, validatorCompany(CURRENT));
    await decryptStored(db, client, plan());
  }
};
