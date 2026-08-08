// Initial schema migration for the `company` collection.
//
// The company data that used to live inside the old shop collection's `company` field as an embedded
// object, lifted out into a collection of its own and given an owner. The now-deleted alter migration
// that followed this one is what turned the embedded object into a reference to a document here; the
// two were one logical change split across two files only because one creates a collection and the
// other alters an existing one, which is this repo's naming convention.
//
// **Why lift it out at all.** A company is a legal entity and a point of sale is a shop: a company with
// three shops had its registered legal name, VAT number, certified email and registryExtract stored three
// times, and the two
// unique indexes on `company.vatNumber` / `company.certifiedEmail` then made that impossible — the second shop of the
// same company was rejected as a duplicate. Extracting it makes the real cardinality expressible:
// one shopOwner owns N companies, one company has N shops.
//
// `idShopOwner` is required. A company with no owner is unreachable — every read path lists by
// owner — and there is no flow anywhere that creates one before the shopOwner exists.
//
// Field shapes are the now-deleted migration that created the old shop collection's `company`
// sub-document verbatim, bounds included — with one deliberate exception: `registryExtract` was
// unbounded there and is capped at 1000 here.
// It holds the uploaded file's path, not the document, and every other string on the collection carries
// a cap; leaving one field able to absorb an arbitrarily long value is what the strict validator exists
// to prevent. Nothing stored today comes close, so the tighter bound rejects no value the platform has
// actually seen — but it does bound what a future writer can put there.
//
// `taxCode` is new here — the embedded sub-document never had one. Fixed at exactly 11 characters, the
// tax code of a legal entity, which for a company is the 11-digit form and not the 16-character
// personal one. Optional, and it has to be: no stored company carries the field, and `collMod` does not
// re-validate what is already stored, so requiring it would leave every company unwritable. It is also NOT
// unique — a company's tax code usually equals its VAT number, which `vatNumber_unique` already
// covers, and the two are distinct only for the entities where a shared index would be wrong anyway.
//
// `address` is new too, and is the old shop collection's `address` restated field for field: the
// company's legal seat, which is not the address of any of its shops. Required, with `position`
// required inside it, exactly as on the old shop collection — the collection is created empty, so
// there is no stored document for the requirement to strand, and every writer has to produce coordinates
// the same way the shop form already
// does. No `2dsphere` index is built over it: nothing queries companies by distance, and the point is
// stored in proper GeoJSON order from the first insert, so adding one later is a one-line migration
// rather than the four-step repair 20260801000000 had to be.
//
// The two unique indexes come across unchanged in scope — GLOBALLY unique, not per shopOwner, which
// is what they were on the old shop collection. One VAT number is one company, whoever registered it.
//
// `deleted` is an optional DATE, not a bool — the same spelling `shopOwner` and the old shop
// collection use,
// and it means the same thing: absent while the company is live, set to the instant of deletion afterwards.
// A bool would answer "is it gone" and nothing else; the date also answers "since when", which is the
// question an operator asks first. Every read path filters on `{ $exists: false }` rather than on a
// value, so the two spellings cost the same to query and only one of them carries the timestamp.
//
// It is optional and absent from `required` because that is what makes the field free: a stored company
// that predates it stays valid, and `collMod` does not re-validate anything already written.
//
// The two unique indexes stay GLOBALLY unique with no `partialFilterExpression`, which has a consequence
// worth stating out loud: a soft-deleted company keeps its VAT number and its certified email occupied,
// so the same
// company cannot be registered again while the deleted document is there. That is the behaviour
// `shopOwner.login.email_unique` already has for a soft-deleted owner, and matching it is the point —
// a partial index would let two companies carry one VAT number, which is the state the extraction exists to
// make impossible.

const { migrationCreation } = require('../lib/schemas/collection');
const { validatorCompany } = require('../lib/schemas/company');

const COLLECTION = 'company';

// The shape this file used to inline, unchanged. It moved to `lib/schemas/company.js` when
// `20260804010000-alter-company-public` needed a second state to restate against — the builder's
// no-argument call reproduces this migration's original validator key for key, which is the
// condition `lib/schemas/README.md` puts on moving a shape out of a migration.
const validator = validatorCompany();

const indexes = [
  {
    key: {
      vatNumber: 1
    },
    options: {
      name: 'vatNumber_unique',
      unique: true
    }
  },
  {
    key: {
      certifiedEmail: 1
    },
    options: {
      name: 'certifiedEmail_unique',
      unique: true
    }
  },
  // Not unique: one shopOwner may own several companies — that is the whole point of the
  // extraction. This backs `shopOwnerCompanies`, the only list query on the collection.
  {
    key: {
      idShopOwner: 1
    },
    options: {
      name: 'idShopOwner_list'
    }
  }
];

module.exports = migrationCreation(COLLECTION, validator, indexes);
