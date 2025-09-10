// models/Item.js
const mongoose = require('mongoose');

const ItemSchema = new mongoose.Schema(
  {
    slug: { type: String, unique: true, index: true },
    title: { type: String, required: true },
    price: { type: Number, required: true }, // jpyは最小単位=1円
    currency: { type: String, default: 'jpy' },
    filePath: { type: String, required: true },
    previewPath: { type: String, required: true },
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
