const mongoose = require('mongoose');

const PurchaseRecordSchema = new mongoose.Schema({
  seller: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  item: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true, index: true },
  sessionId: { type: String, required: true, unique: true, index: true },
  paymentIntentId: { type: String, default: '', index: true },
  amount: { type: Number, required: true, min: 0 },
  purchasedAt: { type: Date, required: true, default: Date.now, index: true },
}, { timestamps: true });

module.exports = mongoose.model('PurchaseRecord', PurchaseRecordSchema);
