// Optional demo/dev seed data.
// Runs ONLY when SEED_DEMO=true — otherwise up()/down() are no-ops, so this
// migration is safe to apply in every environment (it just does nothing in prod).
// Supersedes the manual snippets in setup/{admin,shopOwner}.js.
//
// ⚠️ This used to also insert a demo shop document, with the company embedded inside it — the shape
// that collection had in March. The shop and taxonomy collections were dropped outright on
// 2026-08-04 (see CLAUDE.md), and only the shop insert/delete came out with them.
//
// ⚠️ The demo identities below were rewritten in place on the user's explicit instruction, which is
// the one thing that overrides the immutability rule. Every database that has already run this file
// must be dropped and replayed — a database seeded before the rewrite holds the old documents and no
// migration will correct them.
const { ObjectId } = require('mongodb');

const ENABLED = process.env.SEED_DEMO === 'true';

// bcrypt of "1234567890"
const DEMO_PWD = '$2y$14$hzw7O9l5S65nWptPUnMtrOWgEq8CqNej7HZ5ggkaZ2Zspam99y0Ey';

const admin = {
  _id: new ObjectId('5c9a013fcf1448b9d885e018'),
  login: { email: 'info@thedoctorweb.com', password: DEMO_PWD },
  personalData: { firstName: 'John', lastName: 'Carter' },
};

const shopOwner = {
  _id: new ObjectId('5c9a013fcf1448b9d885e000'),
  login: { email: 'shopOwner@thedoctorweb.com', password: DEMO_PWD },
  personalData: {
    firstName: 'John',
    lastName: 'Carter',
    birth: { date: new Date('1970-11-24T00:00:00Z') },
    address: {
      street: '12 Market Street',
      postalCode: '02108',
      city: 'Boston',
      province: 'MA',
    },
    contacts: { mobile: '395458770', email: 'shopOwner@thedoctorweb.com' },
  },
  registeredAt: new Date('2026-01-24T15:17:00Z'),
};

module.exports = {
  async up(db) {
    if (!ENABLED) {
      console.log('[seed-demo] SEED_DEMO !== "true" — skipping demo seed.');
      return;
    }
    await db.collection('admin').insertOne(admin);
    await db.collection('shopOwner').insertOne(shopOwner);
  },

  async down(db) {
    if (!ENABLED) return;
    await db.collection('admin').deleteOne({ _id: admin._id });
    await db.collection('shopOwner').deleteOne({ _id: shopOwner._id });
  },
};
