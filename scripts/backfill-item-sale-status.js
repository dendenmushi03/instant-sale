#!/usr/bin/env node

const mongoose = require('mongoose');
const Item = require('../models/Item');

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  const dryRun = !flags.has('--apply');
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  const limit = Math.max(1, Number(limitArg ? limitArg.split('=')[1] : 0) || 5000);
  return { dryRun, limit };
}

async function run() {
  const options = parseArgs(process.argv);
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/instant_sale';
  await mongoose.connect(mongoUri);

  const filter = { saleStatus: { $exists: false } };
  const summary = {
    dryRun: options.dryRun,
    filter,
    missingSaleStatus: 0,
    limit: options.limit,
    matchedIds: [],
    modifiedCount: 0
  };

  try {
    summary.missingSaleStatus = await Item.countDocuments(filter);
    const targets = await Item.find(filter).select('_id').limit(options.limit).lean();
    summary.matchedIds = targets.map((row) => String(row._id));

    if (!options.dryRun && summary.matchedIds.length > 0) {
      const result = await Item.updateMany(
        { _id: { $in: summary.matchedIds } },
        { $set: { saleStatus: Item.SALE_STATUSES.PUBLISHED } }
      );
      summary.modifiedCount = Number(result.modifiedCount || 0);
    }
  } finally {
    await mongoose.disconnect();
  }

  console.log(JSON.stringify(summary, null, 2));
}

run().catch((error) => {
  console.error('[backfill-item-sale-status] failed:', error.message);
  process.exit(1);
});
