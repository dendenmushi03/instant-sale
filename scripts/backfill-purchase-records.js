#!/usr/bin/env node

const mongoose = require('mongoose');
const Stripe = require('stripe');

const Item = require('../models/Item');
const PendingTransfer = require('../models/PendingTransfer');
const PurchaseRecord = mongoose.models.PurchaseRecord || mongoose.model('PurchaseRecord', new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  item: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true, index: true },
  sessionId: { type: String, required: true, unique: true, index: true },
  paymentIntentId: { type: String, default: '', index: true },
  amount: { type: Number, required: true, min: 0 },
  purchasedAt: { type: Date, required: true, default: Date.now, index: true },
}, { timestamps: true }));

function parseArgs(argv) {
  const flags = new Set(argv.slice(2));
  const getValue = (name) => {
    const prefix = `${name}=`;
    const hit = argv.find((arg) => arg.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : '';
  };

  const dryRun = !flags.has('--apply');
  const limit = Math.max(1, Number(getValue('--limit') || 0) || 5000);
  const createdGte = Number(getValue('--created-gte') || 0) || null;
  const createdLte = Number(getValue('--created-lte') || 0) || null;

  return { dryRun, limit, createdGte, createdLte };
}

function pickString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

async function listPaidCheckoutSessions(stripe, options) {
  const out = [];
  let startingAfter = null;

  while (out.length < options.limit) {
    const page = await stripe.checkout.sessions.list({
      limit: Math.min(100, options.limit - out.length),
      ...(startingAfter ? { starting_after: startingAfter } : {}),
      expand: ['data.payment_intent'],
      ...(options.createdGte || options.createdLte
        ? { created: { ...(options.createdGte ? { gte: options.createdGte } : {}), ...(options.createdLte ? { lte: options.createdLte } : {}) } }
        : {})
    });

    const paid = page.data.filter((session) => session.status === 'complete' && session.payment_status === 'paid');
    out.push(...paid);

    if (!page.has_more || !page.data.length) break;
    startingAfter = page.data[page.data.length - 1].id;
  }

  return out;
}

async function resolveSellerAndItem(session) {
  const sessionMeta = session.metadata || {};
  const pi = typeof session.payment_intent === 'object' && session.payment_intent
    ? session.payment_intent
    : null;
  const piMeta = pi?.metadata || {};
  const paymentIntentId = pickString(session.payment_intent?.id, session.payment_intent);

  const itemIdFromMeta = pickString(sessionMeta.itemId, piMeta.itemId);
  const sellerIdFromMeta = pickString(sessionMeta.sellerId, piMeta.sellerId);
  const slug = pickString(sessionMeta.slug, piMeta.slug);

  let item = null;
  let sellerId = sellerIdFromMeta;

  if (itemIdFromMeta && mongoose.Types.ObjectId.isValid(itemIdFromMeta)) {
    item = await Item.findById(itemIdFromMeta).select('_id ownerUser price').lean();
  }
  if (!item && slug) {
    item = await Item.findOne({ slug }).select('_id ownerUser price').lean();
  }
  if (!item && paymentIntentId) {
    const pending = await PendingTransfer.findOne({ paymentIntentId }).select('item seller').lean();
    if (pending?.item && mongoose.Types.ObjectId.isValid(String(pending.item))) {
      item = await Item.findById(pending.item).select('_id ownerUser price').lean();
    }
    if (!sellerId && pending?.seller) sellerId = String(pending.seller);
  }

  if (!item?._id) return { reason: 'item_not_resolved', paymentIntentId };

  const seller = pickString(sellerId, item.ownerUser ? String(item.ownerUser) : '');
  if (!seller || !mongoose.Types.ObjectId.isValid(seller)) {
    return { reason: 'seller_not_resolved', paymentIntentId };
  }

  return {
    itemId: String(item._id),
    sellerId: seller,
    amount: Number.isFinite(session.amount_total) ? Number(session.amount_total) : Number(item.price || 0),
    paymentIntentId,
  };
}

async function run() {
  const options = parseArgs(process.argv);
  const mongoUri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/instant_sale';
  const stripeKey = process.env.STRIPE_SECRET_KEY;

  if (!stripeKey) {
    throw new Error('STRIPE_SECRET_KEY is required');
  }

  const stripe = new Stripe(stripeKey);
  await mongoose.connect(mongoUri);

  const summary = {
    dryRun: options.dryRun,
    scannedSessions: 0,
    alreadyRecorded: 0,
    creatable: 0,
    created: 0,
    unresolved: 0,
    unresolvedByReason: {}
  };

  try {
    const sessions = await listPaidCheckoutSessions(stripe, options);
    summary.scannedSessions = sessions.length;

    for (const session of sessions) {
      const sessionId = session.id;
      const existing = await PurchaseRecord.findOne({ sessionId }).select('_id').lean();
      if (existing) {
        summary.alreadyRecorded += 1;
        continue;
      }

      const resolved = await resolveSellerAndItem(session);
      if (!resolved.itemId || !resolved.sellerId) {
        summary.unresolved += 1;
        summary.unresolvedByReason[resolved.reason] = (summary.unresolvedByReason[resolved.reason] || 0) + 1;
        continue;
      }

      summary.creatable += 1;
      if (options.dryRun) continue;

      await PurchaseRecord.updateOne(
        { sessionId },
        {
          $setOnInsert: {
            seller: resolved.sellerId,
            item: resolved.itemId,
            sessionId,
            paymentIntentId: resolved.paymentIntentId || '',
            amount: resolved.amount,
            purchasedAt: Number(session.created) ? new Date(Number(session.created) * 1000) : new Date()
          }
        },
        { upsert: true }
      );
      summary.created += 1;
    }
  } finally {
    await mongoose.disconnect();
  }

  console.log(JSON.stringify(summary, null, 2));
}

run().catch((error) => {
  console.error('[backfill-purchase-records] failed:', error.message);
  process.exit(1);
});
