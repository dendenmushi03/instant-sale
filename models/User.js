// models/User.js
const mongoose = require('mongoose');

const userSchema = new mongoose.Schema(
  {
    googleId: { type: String, index: true },
    email:    { type: String, index: true },
    name:     { type: String, default: '' },
    avatar:   { type: String, default: '' },
    isAdmin:  { type: Boolean, default: false, index: true },

    // Stripe Connect
    stripeAccountId: { type: String, default: '' },
    payoutsEnabled:  { type: Boolean, default: false },

    // ▼ 特商法（売主）情報を保存するフィールド
    // 旧互換の売主情報。新規の販売者情報必須導線では参照しない。
    legal: {
      sellerType:   { type: String, enum: ['business', 'individual'], default: 'individual' },
      name:         { type: String, default: '' },
      responsible:  { type: String, default: '' },
      address:      { type: String, default: '' },
      phone:        { type: String, default: '' },
      email:        { type: String, default: '' },
      website:      { type: String, default: '' },
      invoiceRegNo: { type: String, default: '' },
      published:    { type: Boolean, default: false },
      updatedAt:    { type: Date },
    },

    // 新規の販売者情報登録フローにおける正規ソース。
    sellerProfile: {
      businessType:       { type: String, enum: ['sole_proprietor', 'corporation'], default: undefined },
      creatorDisplayName: { type: String, default: '' },
      legalName:          { type: String, default: '' },
      representativeName: { type: String, default: '' },
      postalCode:         { type: String, default: '' },
      address:            { type: String, default: '' },
      phoneNumber:        { type: String, default: '' },
      isCompleted:        { type: Boolean, default: false, index: true },
      updatedAt:          { type: Date, default: null },
    },

    // 管理画面トップの「新着あり」判定に使う最終確認時刻
    adminSeen: {
      sellersLastSeenAt: { type: Date, default: null },
      reviewsLastSeenAt: { type: Date, default: null },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('User', userSchema);
