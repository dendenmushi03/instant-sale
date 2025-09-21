// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    googleId: { type: String, index: true },
    email:    { type: String, index: true },
    name:     { type: String, default: '' },
    avatar:   { type: String, default: '' },

    // Stripe Connect
    stripeAccountId: { type: String, default: '' },
    payoutsEnabled:  { type: Boolean, default: false },

    // ▼ 特商法（売主）情報を保存するフィールド
    legal: {
      // 追加：販売者の種別（'business' | 'individual'）
      sellerType:   { type: String, enum: ['business', 'individual'], default: 'individual' },

      name:         { type: String, default: '' }, // 事業者名/氏名（必須）
      responsible:  { type: String, default: '' }, // 運営責任者（事業者のみ任意）
      address:      { type: String, default: '' }, // 住所（必須）
      phone:        { type: String, default: '' }, // 電話（任意）
      email:        { type: String, default: '' }, // 連絡先メール（必須）
      website:      { type: String, default: '' }, // 任意
      invoiceRegNo: { type: String, default: '' }, // 任意（インボイス）
      published:    { type: Boolean, default: false }, // 購入ページに表示OK
      updatedAt:    { type: Date },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
