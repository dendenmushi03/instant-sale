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
    ownerUser: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);

module.exports = mongoose.model('Item', ItemSchema);
