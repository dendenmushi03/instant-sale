// models/Item.js
const mongoose = require('mongoose');

const ItemSchema = new mongoose.Schema(
  {
    slug: { type: String, unique: true, index: true },
    title: { type: String, required: true },
    price: { type: Number, required: true }, // jpyは最小単位=1円
    currency: { type: String, default: 'jpy' },

    // 原本（レガシー互換 or S3キー不在時のフォールバック）
    filePath: { type: String, required: true },

    // プレビュー表示用（S3公開URL または 相対パス）
    previewPath: { type: String, required: true },

    // S3/R2 に保存した原本のキー（ダウンロード時の署名URL発行に必須）
    s3Key: { type: String, default: '' },

    mimeType: { type: String, required: true },
    creatorName: { type: String },

    // ここを必須→任意に（ログイン利用時は空でOK）
    createdBySecret: { type: String, default: '' },

    // ログインユーザーの参照を保持
    ownerUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

licensePreset: {
  type: String,
  enum: ['personal', 'standard', 'commercial-lite', 'exclusive'],
  default: 'standard'
},
    
// クレジット表記はプラットフォーム方針として常に不要
requireCredit: {
  type: Boolean,
  default: false,
  set: () => false,   // ← どんな値が来ても false に矯正
  select: false       // ← 通常の find では返さない（任意）
},
    licenseNotes:  { type: String, default: '' },
    aiGenerated:   { type: Boolean, default: false },
    aiModelName:   { type: String, default: '' }
    // ▲ 追加ここまで
  },
  { timestamps: true }
);

module.exports = mongoose.model('Item', ItemSchema);
