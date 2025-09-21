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
      name:         { type: String, default: '' }, // 氏名/名称（必須）
      responsible:  { type: String, default: '' }, // 代表者/運営責任者（任意）
      address:      { type: String, default: '' }, // 住所（必須）
      phone:        { type: String, default: '' }, // 電話（任意・公開したくない人向けに空でも可）
      email:        { type: String, default: '' }, // 連絡先メール（必須）
      website:      { type: String, default: '' }, // 任意
      invoiceRegNo: { type: String, default: '' }, // 任意（インボイス登録番号）
      published:    { type: Boolean, default: false }, // 掲載OKフラグ
      updatedAt:    { type: Date },                   // 最終更新
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
