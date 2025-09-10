const mongoose = require('mongoose');

const DownloadTokenSchema = new mongoose.Schema({
  token: { type: String, index: true, unique: true },
  item: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
  expiresAt: { type: Date, required: true },
  usedOnce: { type: Boolean, default: false },
  // 追加: Stripe セッションIDで冪等化（Webhook と /success の二重発行防止）
  sessionId: { type: String, index: true, unique: true, sparse: true },
}, { timestamps: true });

module.exports = mongoose.model('DownloadToken', DownloadTokenSchema);

// TTLインデックス（期限が来たら自動削除）
DownloadTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
