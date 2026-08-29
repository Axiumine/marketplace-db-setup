# marketplace-db-setup

The MongoDB schema for **Marketplace**, a multi-tenant marketplace platform, expressed as migrations.

Customers order from many independent shops; each shop is run by its owner; the platform vendor operates
the whole thing. This repository holds none of that logic. It contains no application code at all — only
migrations that create collections, attach `$jsonSchema` validators, build indexes, and optionally seed a
demo dataset. Everything that reads or writes those collections lives in the nine backend services and
the three frontends beside this repo.

Migrations run under [migrate-mongo](https://github.com/seppevs/migrate-mongo).

**Twelve migrations: six create a collection, one seeds demo data, and five alter an already-created one.**
Each collection is still declared once, in its final shape — validator, `additionalProperties: false`,
encryption and every index in the same call — so a reader of `migrations/` sees the shape the database
actually has rather than the sum of a ladder.

The five alters do not weaken that. Two add an index to `user` — `20260825000000` for the operator's
customers table, `20260829000200` for the customers-over-time chart. `20260826000000` runs the
repository's first `collMod`, capping `user.addresses` at six, and installs a shape `20260301000300`
already carries: a database built from empty is capped before it runs, and the file exists only to move a
database built before the cap onto it. `20260829000000` is the second `collMod` and the only migration
that touches two collections, putting the four account-lifecycle paths on `user` and `shopOwner` at once.
`20260829000100` drops `deleted_ttl`, which is the one kind of alter that cannot be a no-op on a replay —
the index is created and retired seconds later, because that is what actually happened. There is still no
widen → backfill → narrow ladder anywhere here, which is the thing worth not having.

- **Rules for changing anything here** — [`CLAUDE.md`](./CLAUDE.md)
- **Prerequisites, test suites, gates, hook mechanics** — [`REPO.md`](./REPO.md)
- **Why a particular validator shape exists** — [`lib/schemas/README.md`](./lib/schemas/README.md)

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
public read filters on it · `image`, on `item`, is a **file name and nothing else** — the bytes live at
`STATIC_FOLDER/item/<idCompany>/<image>`, and the two path segments are already on the document, so the
field stores neither a path nor a URL. Its pattern is anchored at both ends for that reason: the value is
interpolated straight into a URL by whoever renders it, and an unanchored one is a traversal. Optional —
an item may have no picture, and that absence is what a card reads before choosing a placeholder.

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

**The catalogue is one collection plus a taxonomy, and it is domain-neutral by design** (ADR-008). A
product type is an `itemCategory` *document*, never a collection: types differ from one another in their
*category*, not in their shape, so encoding a category as a collection name is what would make adding the
next one a migration instead of a document. A new collection needs a shape `item` genuinely cannot hold.
`itemCategory` is platform-wide rather than per shop — two shops selling the same kind of thing have to
land in the same category or the customer-facing filter means nothing — which is why writes are Admin-only
and there is no owner column on it.

Nothing here presumes what is sold, and that is a design constraint rather than an accident of the current
data.

## Naming

Every name in this repository is English — collections, fields, builders, migration filenames, the
`description` strings inside validators, test identifiers, comments and the demo seed's data. The same name
has to spell identically in a migration, a `$jsonSchema`, a Mongoose model, a resolver, a GraphQL field and
three frontends, and nothing maps between those layers. `default_language: 'english'` on the two text
indexes and the `en-GB` locale the frontends format with are market choices rather than names.

## Demo seed

One file, `20260301000600-seed-demo.js`, **gated on `SEED_DEMO=true`** and a no-op otherwise, so it is safe
to apply in every environment. It writes one `admin`, one `shopOwner` and one `company` — the tenant
skeleton: an operator, a shop owner, and the company that shop owner registered. Fixed `_id` literals, so
`down` deletes exactly what `up` wrote, in the reverse order.

The three inserts are one file rather than three because they are one fact: the company points its
`idShopOwner` at the seeded shop owner, and nothing enforces that reference. Splitting them across
migrations would make a dangling pointer representable the moment somebody replayed with the flag off and
then turned it on.

⚠️ **The seed is the only migration that needs the CSFLE master key.** Every personal field on these three
collections is `bsonType: 'binData'` in the validator that created them, so a plaintext `insertOne` is a
rejected write: the seed encrypts field by field first, through `lib/encryption.js`, and refuses to start
if `CSFLE_KEY_VAULT_NAMESPACE` or `CSFLE_MASTER_KEY_PATH` is unset. `down` needs neither — deleting by
`_id` does not read a value.

The demo company is **Northwind Trading Ltd**, seeded `published: false`: it carries no `slug` and no
`publicName`, and the validator's `$expr` half refuses to let a company go live without them.

## Three things about this schema that look like mistakes

- **`address.city` is bounded with `maxLength`, never `maximum`.** `maximum` is a no-op on a string, so a
  validator that uses it enforces no length limit at all while reading exactly as if it does.
- **Every array item schema states `bsonType: 'object'`.** Omitting it leaves the element unconstrained,
  and `additionalProperties: false` inside it then constrains nothing.
- **The GeoJSON pair is `[lng, lat]` and typed `['double', 'int', 'long']`.** Both orders are well-formed,
  so no validator can catch a transposed point — it simply puts the shop in the wrong hemisphere, and the
  suite asserts the axis order with a real `$near` query instead. `decimal` is worse than cosmetic: the
  models declare `coordinates: { type: [Number] }`, which can never produce one, and after a `.lean()`
  read `GraphQLFloat.serialize(Decimal128)` throws. `int` in the list is not redundant — `bson` encodes an
  integer-valued JS Number as int32, so a point at longitude exactly 9 is stored `9`.

## Environments

Only a `Dev` environment is wired up (`MONGO_DEV_*`), plus a throwaway test database. There is no staging
or production configuration yet.

⚠️ **Both are replayable from these files, and that is what licenses `lib/schemas/`.** A change to a
builder there changes what an already-applied migration means, which is safe only for as long as every
database that has run these migrations can be dropped and rebuilt in the same piece of work. The moment an
unrebuildable database exists, that directory freezes.

## Licence and publication

GPL-3.0-or-later — the full text is in [LICENSE](./LICENSE), and `package.json` declares the same SPDX id.
The remote is `https://github.com/Axiumine/marketplace-db-setup` and it is public. The history is a single
commit by design: two operational runbooks under `setup/` used to be tracked and carried live credentials,
so they were untracked and the commits holding earlier copies were collapsed into one. Those files are
gitignored and a clone does not get them — ask whoever runs the cluster.
