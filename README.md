# marketplace-db-setup

The MongoDB schema for **Marketplace**, a multi-tenant marketplace platform, expressed as migrations.

Customers order from many independent shops; each shop is run by its owner; the platform vendor operates
the whole thing. This repository holds none of that logic. It contains no application code at all — only
migrations that create collections, attach `$jsonSchema` validators, build indexes, and optionally seed a
demo dataset. Everything that reads or writes those collections lives in the nine backend services and
the three frontends beside this repo.

Migrations run under [migrate-mongo](https://github.com/seppevs/migrate-mongo). They replaced a
hand-rolled runner that tracked a per-collection revision integer in a `revApp` collection; that system
is gone.

- **Rules for changing anything here** — `CLAUDE.md`
- **Prerequisites, test suites, gates, hook mechanics** — `REPO.md`
- **Why a particular validator shape exists** — `lib/schemas/README.md`

## The six collections

```
shopOwner ──idShopOwner──> company ──idCompany──> item ──idCategory──> itemCategory
                                                                            ▲
                                                                    idParent ┘  (one level only)
admin, user — outside the chain
```

`shopOwner` is the business owner who runs shops on the platform · `admin` is the platform operator ·
`company` is the registered company a shopOwner owns, **and the shop itself** · `user` is the end customer,
the person who places orders · `item` is one thing a company sells · `itemCategory` is the platform-wide
taxonomy items are filed under, two levels deep.

Recurring field names: `personalData` is personal/registry data · `registeredAt` is the sign-up instant ·
`defaultAddress` is the `user`'s chosen delivery address, stored as a pointer into `addresses` rather than
as a flag on it · `publicName` is the trading name, which is what `legalName` is not · `slug` is the URL
segment, on `company`, `item` and `itemCategory` · `published` means the owner has put it live, and every
public read filters on it.

References are plain ObjectIds and nothing enforces them — nothing stops a company pointing at a shopOwner
that was never created, which is why `companyDel` checks in application code before stamping `deleted`.
The one exception is **inside** a `user`: `defaultAddress` → `addresses[]._id` *is* enforced, by the `$expr`
half of that collection's validator. It is intra-document, which is the only kind of reference MongoDB can
check, and it is checked because a dangling default is silently wrong rather than loudly broken.
`company`'s `$expr` is the same trick for a different job — it constrains three fields of one document
against each other, not a reference.

## Scope

The tenant skeleton, the customer identity, and the catalogue. There is no order collection, no cart
collection, and no shop collection.

**A shop is a `company`.** There is no separate shop entity and there is not going to be one; everything a
storefront renders about a shop hangs off `company`, which is what `publicName`, `slug`, `description` and
`published` are doing on a collection whose other fields describe a legal entity to a registrar.

On 2026-08-04 sixteen collections were dropped outright: 13 product-type collections, a delivery-costs
collection, the shop collection and its per-shop taxonomy collection. Their `create-*` migrations were
deleted, the alters that touched them were deleted, their schema builders were deleted, and both seed
migrations were stripped of every insert into them. What survived was the tenant skeleton — an operator, a
shop owner, and the company that shop owner registered — plus `user`, added just before.

`item` and `itemCategory` are the replacement, and they are **not those collections renamed**. The 13
product types differed from one another in their *category*, not in their shape, so encoding the category
as a collection name is what made adding a fourteenth a migration instead of a document. The replacement is
one domain-neutral collection plus a taxonomy. `itemCategory` is not the old per-shop taxonomy under an
English name either: it is platform-wide, written only by an operator, two levels deep, and has no owner
column at all.

Nothing here presumes what is sold, and that is a design constraint rather than an accident of the current
data.

## Naming

Every name in this repository is English — collections, fields, builders, migration filenames, the
`description` strings inside validators, test identifiers, comments and the demo seed's data. The same name
has to spell identically in a migration, a `$jsonSchema`, a Mongoose model, a resolver, a GraphQL field and
three frontends, and nothing maps between those layers. `default_language: 'english'` on the two text
indexes and the `en-GB` locale the frontends format with are market choices rather than names.

## Demo seed

Two files, both **gated on `SEED_DEMO=true`** and a no-op otherwise, so both are safe to apply in every
environment. Both use fixed `_id` literals, so each `down` deletes exactly what its `up` wrote.

| File | Inserts |
|---|---|
| `20260301001800-seed-demo.js` | one `admin`, one `shopOwner` |
| `20260803142526-seed-demo-company.js` | one `company` |

The two are not independent. `20260803142526` points its `company.idShopOwner` at the March seed's
shopOwner and does **not** insert one if it is missing — the shared flag plus the file order means either
both ran or neither did. It dangles only if someone replays with the flag off and then turns it on, which
no supported flow does.

Both files used to write more: the March seed also inserted a shop document with the company embedded
inside it, and the August seed inserted a shop and two taxonomy documents. Those collections are gone and
every insert into them went with them. The second file still exists rather than being folded into the first
because migrations are immutable in *ordering* even when their content was rewritten — `company` does not
exist until `20260803000000`, so its seed cannot run in March.

The demo company is **Northwind Trading Ltd**, carried over field for field from the embedded object the
March seed wrote, so a database seeded before the extraction and one seeded after it describe the same
company. Two fields are new, because `company` has them and the sub-document did not: `taxCode` and
`address`, the registered seat.

## Fixes applied during the migrate-mongo port

These deviate intentionally from the original mongosh scripts; fidelity of everything else was
diff-verified field by field.

- `address.city`: `maximum: 100` → `maxLength: 100`. `maximum` is a no-op on strings, so the original
  enforced no length limit at all; the port enforces 100.
- Array item schemas gained `bsonType: "object"` where the original omitted it. App writes always insert
  objects there, so no valid data is rejected.
- The GeoJSON coordinate order and the coordinate type. The original stored `[lat, lng]` and typed the
  values `decimal`. Preserving the original order was defensible only while nothing interpreted the pair;
  the moment a geo index exists, `[lat, lng]` is not a quirk but a shop in the wrong hemisphere. The
  `decimal` type is worse than cosmetic: the models declare `coordinates: { type: [Number] }`, which can
  never produce it, and the resolver answered 500 on every call.

## History

The dev database `dbMarketplaceDev` only became migrate-mongo-managed on 2026-08-01. Until then it was
still what the retired hand-rolled runner had built: no `changelog` at all, four collections no migration
creates (`revApp` with 19 revision documents, plus `user`, `loginsubdocs` and `resetpwdsubdocs`), and a
`migrate:status` that reported every file as pending. It was dropped and rebuilt from the migrations with
`SEED_DEMO=true`. The only thing not reproduced was `login.firstLogin` / `login.lastLogin` on the demo
admin, which the application rewrites on the next login.

Only a `Dev` environment is wired up. There is no staging or production configuration yet.

## Licence and publication

GPL-3.0-or-later — the full text is in [LICENSE](./LICENSE), and `package.json` declares the same SPDX id.
The remote is `https://github.com/Axiumine/marketplace-db-setup` and it is public. The history is a single
commit by design: two operational runbooks under `setup/` used to be tracked and carried live credentials,
so they were untracked and the commits holding earlier copies were collapsed into one. Those files are
gitignored and a clone does not get them — ask whoever runs the cluster.
