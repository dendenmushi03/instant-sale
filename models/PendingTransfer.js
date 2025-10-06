// models/PendingTransfer.js
const mongoose = require('mongoose');

const PendingTransferSchema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  item: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
  amount: { type: Number, required: true },           // 送金額（例：価格の80%）
  currency: { type: String, required: true },         // 'jpy' など
  paymentIntentId: { type: String, required: true, unique: true }, // 同一決済の重複送金防止
  transferGroup: { type: String, default: '' },
  reason: { type: String, default: '' },              // スキップ理由のメモ
  createdAt: { type: Date, default: Date.now }
}, { versionKey: false });

module.exports = mongoose.model('PendingTransfer', PendingTransferSchema);
