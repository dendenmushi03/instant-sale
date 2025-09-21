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

// ▼▼▼ ここから追加：販売者用の特商法プロフィール ▼▼▼
UserSchema.add({
  legal: {
    name: { type: String, default: '' },          // 販売事業者名（氏名/屋号/法人名）
    responsible: { type: String, default: '' },   // 運営責任者
    address: { type: String, default: '' },       // 住所（丁目番地・建物名まで）
    phone: { type: String, default: '' },         // 電話番号
    email: { type: String, default: '' },         // 問い合わせメール
    website: { type: String, default: '' },       // 任意：販売者サイト
    deliveryTime: { type: String, default: '決済確認後、即時（ダウンロードリンク提供）' },
    paymentMethod: { type: String, default: 'クレジットカード（Stripe）' },
    paymentTiming: { type: String, default: '購入時（前払い）' },
    returns: { type: String, default: 'デジタル商品のため、ダウンロード後の返品・キャンセルは原則不可。誤課金・ファイル不具合時はお問い合わせください。' },
    extraFees: { type: String, default: 'なし（通信費はお客様負担）' },   // 追加手数料があれば明記
    invoiceRegNo: { type: String, default: '' },  // 任意：適格請求書発行事業者登録番号
  }
});
// ▲▲▲ 追加ここまで ▲▲▲
