const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  googleId: { type: String, index: true, unique: true },
  email: { type: String, index: true },
  name: { type: String, default: '' },
  avatar: { type: String, default: '' },
    stripeAccountId: { type: String, default: '' },   // Stripe ConnectのアカウントID
  payoutsEnabled: { type: Boolean, default: false } // 出金が有効かどうか
}, { timestamps: true });

module.exports = mongoose.model('User', userSchema);

