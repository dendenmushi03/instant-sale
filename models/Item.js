// models/Item.js
const mongoose = require('mongoose');

const ItemSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, trim: true },
    price: { type: Number, required: true, min: 1 }, // jpy最小単位=1円
    currency: { type: String, default: 'jpy', lowercase: true, trim: true },

    // S3を使わないときだけ必須（ローカル原本）
    filePath: {
      type: String,
      required: function () { return !this.s3Key; },
      default: ''
    },

    // S3/R2 に保存した原本のキー（ダウンロード時の署名URL発行に必須）
    s3Key: { type: String, default: '' },

    // プレビュー表示用（S3公開URL または 相対パス）
    previewPath: { type: String, required: true },

    mimeType: { type: String, required: true },

    creatorName: { type: String, default: '' },
    createdBySecret: { type: String, default: '' }, // 非ログイン運用のバックドア互換

    // 所有者（ログインユーザー）
    ownerUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    ownerEmail: { type: String, default: '' },

    // 証明と監査用
    attestOwner: { type: Boolean, default: false },
    uploaderIp: { type: String, default: '' },

    // ── ライセンス情報 ──
    licensePreset: {
      type: String,
      enum: ['standard', 'editorial', 'commercial-lite', 'exclusive'],
      default: 'standard'
    },
    // クレジット表記はプラットフォーム方針として常に不要
    requireCredit: {
      type: Boolean,
      default: false,
      set: () => false,   // どんな値が来ても false に矯正
      select: false       // 通常の find では返さない（任意）
    },
    licenseNotes: { type: String, default: '' },
    aiGenerated: { type: Boolean, default: false },
    aiModelName: { type: String, default: '' }
  },
  { timestamps: true }
);

// どちらも空なら保存させない安全弁（S3運用/ローカル運用の整合）
ItemSchema.pre('validate', function (next) {
  if (!this.filePath && !this.s3Key) {
    return next(new Error('Either filePath or s3Key is required'));
  }
  next();
});

module.exports = mongoose.model('Item', ItemSchema);
