// Optional demo/dev seed, part two: the company.
//
// Gated on `SEED_DEMO=true` exactly like `20260301001800-seed-demo.js`, so it is a no-op in any
// environment that has not asked for it.
//
// **Why a second seed file exists.** The first one inserts an `admin` and a `shopOwner` only.
// `20260803000000-create-company` lifted companies into a collection of their own, and nothing
// before this file writes a document into it, so a database replayed from scratch would come out with
// the two accounts and no company at all.
//
// ⚠️ It used to insert a shop document and two taxonomy documents as well. Both collections were
// dropped platform-wide on 2026-08-04 — see CLAUDE.md — so those inserts went with them.
//
// **The `_id`s are fixed literals**, like the March seed's, so `down` deletes exactly what `up`
// wrote. They continue the same block:
//   5c9a013fcf1448b9d885e018  admin        (20260301001800)
//   5c9a013fcf1448b9d885e000  shopOwner    (20260301001800)
//   5c9a013fcf1448b9d885a000  company      here
//
// `idShopOwner` points at the March seed's shop owner. This migration does **not** insert one
// if it is missing: the two files are gated on the same flag and ordered, so either both ran or
// neither did. It dangles only if someone replays with the flag off and then turns it on, which no
// supported flow does.
//
// **The company is Northwind Trading Ltd**, carried over from the object the March seed used to embed
// in its shop — same legal name, VAT number, contact person, administrator, unique code, certified
// email and registry extract, so a database seeded before the extraction and one seeded after it
// describe the same company. Two fields are new because `company` has them and the sub-document did
// not: `taxCode`, the 11-digit tax code of a legal entity, and `address`, the registered seat.
//
// ⚠️ Those literals were rewritten in place on the user's explicit instruction, which is the one
// thing that overrides the immutability rule. Every database that has already run this file must be
// dropped and replayed — a database seeded before the rewrite holds the old document and no migration
// will correct it.
//
// Coordinates are GeoJSON order, **longitude first**. No validator catches a transposition because
// both orders are well-formed: [-73.98, 40.74] is in New York, [40.74, -73.98] is in the Southern
// Ocean off Antarctica.
const { ObjectId } = require('mongodb');

const ENABLED = process.env.SEED_DEMO === 'true';

const ID_SHOP_OWNER = new ObjectId('5c9a013fcf1448b9d885e000');
const ID_COMPANY = new ObjectId('5c9a013fcf1448b9d885a000');

const company = {
  _id: ID_COMPANY,
  idShopOwner: ID_SHOP_OWNER,
  legalName: 'Northwind Trading Ltd',
  vatNumber: '02554785963',
  taxCode: '02554785963',
  contactPerson: 'John Carter',
  administrator: 'John Carter',
  uniqueCode: '548XS3W',
  certifiedEmail: 'certified@northwind.example',
  // The registered seat, in New York.
  address: {
    street: '350 Fifth Avenue',
    postalCode: '10118',
    city: 'New York',
    province: 'NY',
    position: {
      type: 'Point',
      coordinates: [-73.98566, 40.74844]
    }
  },
  registryExtract: 'registryExtract.pdf'
};

module.exports = {
  async up(db) {
    if (!ENABLED) {
      console.log('[seed-demo-company] SEED_DEMO !== "true" — skipping demo seed.');
      return;
    }
    await db.collection('company').insertOne(company);
  },

  async down(db) {
    if (!ENABLED) {
      return;
    }
    await db.collection('company').deleteOne({ _id: ID_COMPANY });
  }
};
