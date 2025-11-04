// models/PendingTransfer.js
const mongoose = require('mongoose');

const DAYS_180_MS = 1000 * 60 * 60 * 24 * 180;

const PendingTransferSchema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  item:   { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
  amount: { type: Number, required: true },                // 送金額（例：価格の80%）
  currency: { type: String, required: true },              // 'jpy' など
  paymentIntentId: { type: String, required: true, unique: true }, // 同一決済の重複送金防止
  transferGroup: { type: String, default: '' },
  reason: { type: String, default: '' },                   // スキップ理由のメモ

  // ★追加：有効期限（デフォルト＝作成から180日）
  expiresAt: { type: Date, required: true, default: () => new Date(Date.now() + DAYS_180_MS), index: true },

  // ★追加：状態管理（queued=保留, transferred=送金済, expired=失効）
  status: { type: String, enum: ['queued', 'transferred', 'expired'], default: 'queued', index: true },

  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('PendingTransfer', PendingTransferSchema);
