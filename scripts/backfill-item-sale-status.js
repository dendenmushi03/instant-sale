#!/usr/bin/env node

const mongoose = require('mongoose');
const Item = require('../models/Item');

const EXCLUDED_REASON_PATTERNS = [
  /under[_\s-]?review/i,
  /blocked/i,
  /reject(ed)?/i,
  /manual:(rejected|policy_blocked)/i,
  /review/i
];

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  const dryRun = !flags.has('--apply');
  const limitArg = argv.find((arg) => arg.startsWith('--limit='));
  const limit = Math.max(1, Number(limitArg ? limitArg.split('=')[1] : 0) || 5000);
  return { dryRun, limit };
}

function shouldExcludeByReason(reason) {
  const normalized = typeof reason === 'string' ? reason.trim() : '';
  if (!normalized) return false;
  return EXCLUDED_REASON_PATTERNS.some((pattern) => pattern.test(normalized));
}

function buildBaseFilter() {
  return {
    saleStatus: { $exists: false },
    isDeleted: { $ne: true }
  };
}

async function run() {
  const options = parseArgs(process.argv);
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/instant_sale';
  await mongoose.connect(mongoUri);

  const baseFilter = buildBaseFilter();
  const summary = {
    dryRun: options.dryRun,
    limit: options.limit,
    baseFilter,
    stats: {
      missingSaleStatus: 0,
      candidatesBeforeReasonCheck: 0,
      eligibleCount: 0,
      excludedByReasonCount: 0
    },
    matchedIds: [],
    excludedIds: [],
    modifiedCount: 0
  };

  try {
    summary.stats.missingSaleStatus = await Item.countDocuments({ saleStatus: { $exists: false } });
    summary.stats.candidatesBeforeReasonCheck = await Item.countDocuments(baseFilter);

    const candidates = await Item.find(baseFilter)
      .select('_id saleStatusReason createdAt')
      .sort({ _id: 1 })
      .limit(options.limit)
      .lean();

    const eligible = [];
    const excluded = [];

    for (const item of candidates) {
      if (shouldExcludeByReason(item.saleStatusReason)) {
        excluded.push(String(item._id));
        continue;
      }
      eligible.push(String(item._id));
    }

    summary.stats.eligibleCount = eligible.length;
    summary.stats.excludedByReasonCount = excluded.length;
    summary.matchedIds = eligible;
    summary.excludedIds = excluded;

    if (!options.dryRun && summary.matchedIds.length > 0) {
      const result = await Item.updateMany(
        { _id: { $in: summary.matchedIds } },
        [
          {
            $set: {
              saleStatus: Item.SALE_STATUSES.PUBLISHED,
              saleStatusUpdatedAt: { $ifNull: ['$createdAt', '$$NOW'] }
            }
          }
        ]
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
