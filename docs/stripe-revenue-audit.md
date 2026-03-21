# Stripe収益分配ロジック監査（Instant Sale）

## 監査対象
- Checkout作成: `POST /checkout/:slug`
- Webhook: `POST /webhooks/stripe`
- Connect連携: `/connect/onboard`, `/connect/return`
- 保留金再実行: `POST /admin/retry-pending`
- モデル: `User`, `PendingTransfer`

## 1) 決済〜収益反映までの全体フロー
1. 購入時にCheckout Sessionを作成し、販売者アカウントが `transfers=active && payouts_enabled=true` のときだけ destination charge（`payment_intent_data.transfer_data.destination`）を使う。
2. destinationが使えない場合、決済はプラットフォーム受領になり、Webhook `checkout.session.completed / async_payment_succeeded` で後続 `transfer` を試行する。
3. 後続transferで送金不能（Stripe未接続 or payouts無効 等）の場合は `PendingTransfer` に upsert で保留登録する。
4. 出品者がConnect設定を完了して `/connect/return` へ戻ったタイミング、または管理者の `/admin/retry-pending` で保留分を再送金する。

## 2) 4% + 30円 の収益分配ロジックの有無と実装箇所
- **有り**。設計は「プラットフォーム手数料を `Math.floor(price * 0.04) + 30`」として実装され、販売者受取は `price - platformFeeAmount`。
- destination charge時は `application_fee_amount = platformFeeAmount` を設定しているため、Stripe側でも同じ手数料式になる。
- Webhook後続transfer時も同じ共通ヘルパーから `sellerAmount` / `platformFeeAmount` / `grossAmount` を算出している。

## 3) 未設定ユーザーの売上保留ロジックの有無と実装箇所
- **有り**。Webhook内の `markPending()` で `PendingTransfer.updateOne(..., { upsert: true })` を実行。
- 保留条件:
  - `seller_no_stripe_account`
  - `payouts_disabled`
  - `non_positive_amount`
  - 例外時 `exception`
- 同一PaymentIntent重複登録は `paymentIntentId unique` で抑止。

## 4) 設定完了後に保留金を払う処理の有無
- **有り（2経路）**
  1. `/connect/return` で `payouts_enabled` が true の場合、該当sellerの `PendingTransfer` 全件を `stripe.transfers.create` 実行し、成功分を削除。
  2. `/admin/retry-pending` でも同様に全保留を走査して再送金。

## 5) 不足実装・危険箇所
1. **手数料式の変更時は共通ヘルパー更新が必須**
   - `utils/revenue.js` を単一の計算元として使う前提で、他箇所の直接計算を増やさないこと。
2. **PendingTransferの状態管理が実質未使用**
   - モデルに `status (queued/transferred/expired)` と `expiresAt` があるが、更新処理はなく、実際は「成功時に削除」方式。
3. **失効処理がない**
   - `expiresAt` はあるがTTL indexではないため自動削除されない。`expired` へ遷移させるバッチ/ジョブも見当たらない。
4. **payout可否判定が `payouts_enabled` のみ**
   - checkout時は `transfers=active && payouts_enabled` を見る一方、Webhook transfer再試行時は `payouts_enabled` のみ。判定基準が不統一。
5. **送金実行のトランザクション記録不足**
   - 成功時にPendingを削除するだけで、永続的な「送金済み台帳（transferId, executedAt）」が残らない。

## 6) テストで確認すべきケース
1. 出品者Connect完了かつ `transfers=active/payouts_enabled=true` で checkout 時に destination charge になる。
2. 出品者Stripe未接続で販売成立 → PendingTransferが `seller_no_stripe_account` で作成される。
3. Stripe接続済みだが payouts無効で販売成立 → PendingTransferが `payouts_disabled` で作成される。
4. `/connect/return` で payouts有効化後、保留分が送金され削除される。
5. `/admin/retry-pending` 実行で送金可能分だけ処理され、不可分はskipのまま残る。
6. 同一Webhook再送時に `ProcessedEvent` で二重処理されない。
7. 価格や手数料設定境界（最低価格100円、100円商品の sellerAmount=66、sellerAmount<=0）で期待通り保留になる。

## 7) 結論
- **現状コードは「概ね仕様を満たす経路」を持つ**（4%+30円計算、未設定時保留、設定後再送金）。
- ただし次の理由で「設計どおり完全担保」とは言い切れない。
  - PendingTransferの `status/expired` 設計が実運用コードに接続されていない。
  - 送金済みの監査証跡が弱い（削除方式）。

