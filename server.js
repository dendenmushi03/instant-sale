require('dotenv').config();
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');

const express = require('express');
const mongoose = require('mongoose');
const multer = require('multer');
const sharp = require('sharp');
const { nanoid } = require('nanoid');
const mime = require('mime-types');
const Stripe = require('stripe');

const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const Item = require('./models/Item');
const DownloadToken = require('./models/DownloadToken');
const User = require('./models/User');

const app = express();

/* ====== ENV ====== */
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

const RAW_BASE_URL = process.env.BASE_URL;
if (isProd && !RAW_BASE_URL) {
  throw new Error('BASE_URL is required in production');
}

// 末尾スラ無しに正規化
let BASE_URL = (RAW_BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');
// 本番だけ http→https を強制
if (isProd) BASE_URL = BASE_URL.replace(/^http:\/\//, 'https://');

const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/instant_sale';
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY;
const CURRENCY = (process.env.CURRENCY || 'jpy').toLowerCase();
const CREATOR_SECRET = process.env.CREATOR_SECRET || 'changeme';
const DOWNLOAD_TOKEN_TTL_MIN = Number(process.env.DOWNLOAD_TOKEN_TTL_MIN || '120');
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_me';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const USE_STRIPE_CONNECT = process.env.USE_STRIPE_CONNECT === 'true';
const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || '0');

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
if (!STRIPE_SECRET_KEY) {
  console.warn('[WARN] STRIPE_SECRET_KEY が未設定です。決済は動きません。');
}

/* ====== Views ====== */
app.set('view engine', 'ejs');

// Render のリバースプロキシ配下での secure cookie 用
app.set('trust proxy', 1);

app.set('views', path.join(__dirname, 'views'));

/* ====== Core middlewares ====== */
app.use(session({
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: isProd,
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7,
  },
}));

app.use(passport.initialize());
app.use(passport.session());

// ★ Webhook は JSON パーサより前に raw を先適用
app.use('/webhooks/stripe', express.raw({ type: 'application/json' }));

app.use(express.urlencoded({ extended: true }));
app.use(express.json());
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

app.use(helmet());
app.use(compression());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
}));

// どちらのURLでも配信できるように二本立てにします
app.use(express.static(path.join(__dirname, 'public')));      // /logo.png でもOK
app.use('/public', express.static(path.join(__dirname, 'public'))); // /public/logo.png でもOK

app.use('/previews', express.static(path.join(__dirname, 'previews'))); // OGP用のみ公開

// EJS で user を使えるように
app.use((req, res, next) => {
  res.locals.me = req.user || null;
  next();
});

/* ====== Passport (Google) ====== */
passport.serializeUser((user, done) => done(null, user.id));
passport.deserializeUser(async (id, done) => {
  try {
    const u = await User.findById(id);
    done(null, u);
  } catch (e) {
    done(e);
  }
});

if (GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET) {
  passport.use(new GoogleStrategy({
    clientID: GOOGLE_CLIENT_ID,
    clientSecret: GOOGLE_CLIENT_SECRET,
    callbackURL: `${BASE_URL}/auth/google/callback`,
  }, async (accessToken, refreshToken, profile, done) => {
    try {
      const email = profile.emails && profile.emails[0]?.value;
      const avatar = profile.photos && profile.photos[0]?.value;
      let user = await User.findOne({ googleId: profile.id });
      if (!user) {
        user = await User.create({
          googleId: profile.id,
          email,
          name: profile.displayName || '',
          avatar: avatar || '',
        });
      } else {
        if (email && user.email !== email) user.email = email;
        if (avatar && user.avatar !== avatar) user.avatar = avatar;
        if (profile.displayName && user.name !== profile.displayName) user.name = profile.displayName;
        await user.save();
      }
      return done(null, user);
    } catch (e) {
      return done(e);
    }
  }));
}

// 認証必須ミドルウェア
const ensureAuthed = (req, res, next) => {
  if (req.user) return next();
  return res.redirect('/login');
};

// ===== Legal pages (short URLs) =====
app.get('/terms', (req, res) => {
  res.render('legal/terms', {
    site: process.env.SITE_NAME || 'Instant Sale',
    governingLaw: process.env.GOVERNING_LAW || '日本法',
    court: process.env.COURT || '東京地方裁判所',
    contactEmail: process.env.CONTACT_EMAIL || 'support@example.com',
  });
});

app.get('/privacy', (req, res) => {
  res.render('legal/privacy', {
    site: process.env.SITE_NAME || 'Instant Sale',
    contactEmail: process.env.CONTACT_EMAIL || 'support@example.com',
    website: process.env.WEBSITE_URL || 'https://example.com',
  });
});

app.get('/tokushoho', (req, res) => {
  res.render('legal/tokushoho', {
    site: process.env.SITE_NAME || 'Instant Sale',
    sellerName: process.env.SELLER_NAME || '販売事業者名',
    responsibleName: process.env.RESPONSIBLE_NAME || '運営責任者名',
    address: process.env.SELLER_ADDRESS || '住所をここに記載',
    phone: process.env.SELLER_PHONE || '012-345-6789',
    email: process.env.CONTACT_EMAIL || 'support@example.com',
    website: process.env.WEBSITE_URL || 'https://example.com',
    businessHours: process.env.BUSINESS_HOURS || '平日 10:00-18:00',
  });
});

// Stripe Connect 接続状況を取得してビューに渡す共通ヘルパー
async function getConnectStatus(user) {
  if (!user) return { hasAccount: false, payoutsEnabled: false };

  // DBの最新ユーザーを取得（stripeAccountId/payoutsEnabled を使うので）
  const u = await User.findById(user._id);

  const hasAccount = !!u?.stripeAccountId;
  let payoutsEnabled = !!u?.payoutsEnabled;

  // Stripe 側の最新状態を同期（任意・推奨）
  if (hasAccount && stripe) {
    try {
      const acct = await stripe.accounts.retrieve(u.stripeAccountId);
      payoutsEnabled = !!acct.payouts_enabled;
      if (u.payoutsEnabled !== payoutsEnabled) {
        u.payoutsEnabled = payoutsEnabled;
        await u.save();
      }
    } catch (e) {
      // 取れなくても致命ではない
      console.warn('[Stripe] retrieve account failed:', e.message);
    }
  }

  return { hasAccount, payoutsEnabled };
}

/* ====== FS準備 ====== */
const ensureDir = async (dir) => {
  try { await fsp.mkdir(dir, { recursive: true }); } catch {}
};
ensureDir(path.join(__dirname, 'uploads'));
ensureDir(path.join(__dirname, 'previews'));

/* ====== Multer（画像のみ） ====== */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, 'uploads')),
  filename: (req, file, cb) => {
    const ext = mime.extension(file.mimetype) || 'bin';
    cb(null, `${Date.now()}-${nanoid(8)}.${ext}`);
  }
});
const fileFilter = (req, file, cb) => {
  if ((file.mimetype || '').startsWith('image/')) cb(null, true);
  else cb(new Error('画像ファイルのみアップロード可能です'));
};
const upload = multer({ storage, fileFilter, limits: { fileSize: 20 * 1024 * 1024 } });

/* ====== Mongo ====== */
mongoose.connect(MONGODB_URI).then(() => {
  console.log('[MongoDB] connected');
}).catch(err => {
  console.error('[MongoDB] connection error', err);
});

/* ====== Routes ====== */

// index（EJS に変更）
app.get('/', (req, res) => {
  res.render('home', { baseUrl: BASE_URL });
});

// auth pages
app.get('/login', (req, res) => {
  res.render('error', { message: '「Googleでログイン」をクリックしてください。<br><a href="/auth/google">Googleでログイン</a>' });
});

app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => res.redirect('/creator')
);

app.post('/logout', (req, res) => {
  req.logout(() => res.redirect('/'));
});

// ====== Stripe Connect: クリエイターの接続アカウント作成 & オンボーディング ======
app.get('/connect/onboard', ensureAuthed, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).render('error', { message: 'Stripeが未設定です（STRIPE_SECRET_KEY）。' });
    }

// DBから最新ユーザーを取得（stripeAccountId保存のため）
let user = await User.findById(req.user._id);
let acctId = user.stripeAccountId;

// 現在のAPIキー（テスト/本番）でそのacctが有効かチェック。
// 失敗したら新規作成して置き換える（モード切替の古いIDを自動修復）。
const ensureConnectedAccount = async () => {
  if (acctId) {
    try {
      await stripe.accounts.retrieve(acctId); // 取得できればOK
      return acctId;
    } catch (err) {
      console.warn('[Stripe] stale stripeAccountId; recreating. reason:', err?.raw?.message || err.message);
      acctId = null;
    }
  }
  const account = await stripe.accounts.create({
    type: 'express',
    country: 'JP',
    email: user.email,
    capabilities: {
      transfers: { requested: true },
      card_payments: { requested: true },
    },
  });
  user.stripeAccountId = account.id;
  await user.save();
  return account.id;
};

const connectedAccountId = await ensureConnectedAccount();

// オンボーディングリンクを発行
const accountLink = await stripe.accountLinks.create({
  account: connectedAccountId,
  refresh_url: `${BASE_URL}/connect/refresh`,
  return_url:  `${BASE_URL}/connect/return`,
  type: 'account_onboarding',
});

return res.redirect(accountLink.url);

} catch (e) {
  // Stripeのエラー本文を画面にも出す（暫定）
  const detail = e?.raw?.message || e?.message || 'unknown error';
  console.error('[Stripe onboard] failed:', detail, e);
  return res.status(500).render('error', { message: `オンボーディングリンクの発行に失敗しました：${detail}` });
}

  });

// オンボーディング完了後の戻り先（接続状態の同期）
app.get('/connect/return', ensureAuthed, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user?.stripeAccountId) {
      return res.status(400).render('error', { message: '接続アカウントが見つかりません。' });
    }
    const acct = await stripe.accounts.retrieve(user.stripeAccountId);
    // payouts_enabled をDBにも反映（任意）
    user.payoutsEnabled = !!acct.payouts_enabled;
    await user.save();

    return res.render('error', { message: '接続設定を受け付けました。<br><a href="/creator">アップロードへ戻る</a>' });
  } catch (e) {
    console.error(e);
    return res.status(500).render('error', { message: '接続状態の確認に失敗しました。' });
  }
});

// オンボーディングの中断→再開用
app.get('/connect/refresh', ensureAuthed, (req, res) => {
  return res.render('error', { message: 'オンボーディングを再開してください。<br><a href="/connect/onboard">もう一度始める</a>' });
});

// クリエイター：特商法（売主）情報の設定画面
app.get('/creator/legal', ensureAuthed, async (req, res) => {
  const me = await User.findById(req.user._id).lean();
  const legal = me?.legal || {};
  res.render('creator-legal', { baseUrl: BASE_URL, me, legal });
});

app.post('/creator/legal', ensureAuthed, async (req, res) => {
  const {
    sellerType, // ← 追加: 'business' or 'individual'
    name, responsible, address, phone, email, website, invoiceRegNo, publish
  } = req.body;

  const type = (sellerType === 'business') ? 'business' : 'individual';

  // 種別に応じたサニタイズ（個人なら責任者/インボイスは空で保存）
  const safeResponsible = (type === 'business') ? (responsible || '').trim() : '';
  const safeInvoice     = (type === 'business') ? (invoiceRegNo || '').trim() : '';

  const u = await User.findById(req.user._id);
  u.legal = {
    sellerType: type,                        // ★ 追加
    name: (name||'').trim(),
    responsible: safeResponsible,
    address: (address||'').trim(),
    phone: (phone||'').trim(),
    email: (email||'').trim(),
    website: (website||'').trim(),
    invoiceRegNo: safeInvoice,
    published: publish === 'on',
    updatedAt: new Date()
  };
  await u.save();

  return res.render('error', { message: '事業者情報を保存しました。<br><a href="/creator">アップロードへ戻る</a>' });
});

app.get('/creator', ensureAuthed, async (req, res) => {
  const connect = await getConnectStatus(req.user);

  // C2C化：事業者（business）のときだけ販売者情報を必須にする
  const me = await User.findById(req.user._id).lean();
  const L = me?.legal || {};
  const isBiz = L.sellerType === 'business';
  const legalReady = isBiz ? !!(L.published && L.name && L.address && L.email) : true;

  res.render('upload', { baseUrl: BASE_URL, connect, legal: L, legalReady, isBiz });
});

// upload
app.post('/upload', ensureAuthed, upload.single('image'), async (req, res) => {
  try {
    const { title, price, currency, creatorName, creatorSecret, ownerEmail, attestOwner } = req.body;

    // 旧シークレット（無ログイン運用に戻す場合のバックドア）
    if (!req.user && creatorSecret !== CREATOR_SECRET) {
      if (req.file) await fsp.unlink(req.file.path).catch(() => {});
      return res.status(401).render('error', { message: '認証に失敗しました（ログインまたはシークレットが必要）。' });
    }

    if (!req.file) return res.status(400).render('error', { message: '画像が選択されていません。' });

    if (!attestOwner) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).render('error', { message: '権利者であることのチェックが未入力です。' });
    }

    const priceNum = Number(price);
    if (!title || !priceNum || priceNum < 1) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).render('error', { message: 'タイトルと価格（1以上）は必須です。' });
    }

    const slug = nanoid(10);
    const mimeType = req.file.mimetype;

    // OGPプレビュー（1200x630）
    const previewName = `${slug}-preview.jpg`;
    const previewFull = path.join(__dirname, 'previews', previewName);

const previewBase = await sharp(req.file.path)
  .rotate()
  .resize(1200, 630, { fit: 'cover' }) // ← OGPは見栄え重視で従来通り
  .jpeg({ quality: 85 })
  .toBuffer();

const svg = Buffer.from(`
  <svg width="1200" height="630">
    <style>
      .wmark { fill: rgba(255,255,255,0.25); font-size: 110px; font-weight: 700; }
    </style>
    <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" class="wmark">SAMPLE</text>
  </svg>
`);

await sharp(previewBase)
  .composite([{ input: svg, gravity: 'center' }])
  .toFile(previewFull);

// ★ Stripe用（縦長が切れない “contain” 版）を追加生成
const stripeName = `${slug}-stripe.jpg`;
const stripeFull = path.join(__dirname, 'previews', stripeName);

await sharp(req.file.path)
  .rotate()
  .resize(1200, 630, {
    fit: 'contain',                               // 余白を付けて全体を表示
    background: { r: 10, g: 16, b: 24, alpha: 1 } // ダーク系余白
  })
  .composite([{ input: svg, gravity: 'center' }]) // 透かしは同じでOK（不要なら外しても可）
  .jpeg({ quality: 85 })
  .toFile(stripeFull);

    const item = await Item.create({
  slug,
  title,
  price: priceNum,
  currency: (currency || CURRENCY).toLowerCase(),
  filePath: req.file.path,
  previewPath: `/previews/${previewName}`,
  mimeType,
  creatorName: creatorName || '',

  // ログイン時はユーザー参照を保存
  ownerUser: req.user?._id || null,

  // 旧シークレット運用の名残。未入力なら空文字で通す
  createdBySecret: creatorSecret || '',

  ownerEmail: (req.user?.email || ownerEmail || ''),
  attestOwner: !!attestOwner,
  uploaderIp: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '',
});

    const saleUrl = `${BASE_URL}/s/${item.slug}`;
    return res.render('upload', { baseUrl: BASE_URL, createdUrl: saleUrl });
  } catch (e) {
    console.error(e);
    return res.status(500).render('error', { message: 'アップロードに失敗しました。' });
  }
});

// sale
app.get('/s/:slug', async (req, res) => {
  const { slug } = req.params;
  const item = await Item.findOne({ slug });
  if (!item) return res.status(404).render('error', { message: '販売ページが見つかりません。' });

  // ビュー用 OGP
  const og = {
    title: `${item.title} | 即ダウンロード`,
    desc: `高解像度をすぐ購入（${item.price.toLocaleString()} ${item.currency.toUpperCase()}）`,
    image: `${BASE_URL}${item.previewPath}`,
    url: `${BASE_URL}/s/${item.slug}`
  };

  // 「閲覧者がこの商品のオーナーかつ未接続/未有効なら注意表示」のためのフラグ
  let connect = null;
  if (req.user && item.ownerUser && String(item.ownerUser) === String(req.user._id)) {
    connect = await getConnectStatus(req.user);
  }

let seller = null;
if (item.ownerUser) {
  seller = await User.findById(item.ownerUser).lean();
}

let sellerLegal = null;
if (item.ownerUser) {
  const seller = await User.findById(item.ownerUser).lean();
  if (seller?.legal?.published && seller.legal.sellerType === 'business') {
    sellerLegal = seller.legal; // 事業者のみ表示
  }
}

return res.render('sale', { item, baseUrl: BASE_URL, og, connect, sellerLegal });

});

// checkout（接続アカウントが未有効ならプラットフォーム受領にフォールバック）
app.post('/checkout/:slug', async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).render('error', { message: '決済設定が未完了です（STRIPE_SECRET_KEY）。' });
    }

    const { slug } = req.params;
    const item = await Item.findOne({ slug });
    if (!item) return res.status(404).render('error', { message: '商品が見つかりません。' });

    // 手数料
    const platformFee = Math.max(0, Math.floor(item.price * (PLATFORM_FEE_PERCENT / 100)));

    // 販売者（オーナー）
    let seller = null;
    if (USE_STRIPE_CONNECT && item.ownerUser) {
      seller = await User.findById(item.ownerUser);
    }
    const destinationAccountId = seller?.stripeAccountId || null;

    // 販売者が destination charge を使えるか（charges_enabled）
    let canChargeOnSeller = false;

// ★ 特商法の必須入力チェック（C2C化：事業者のみ）
if (seller) {
  const L = seller.legal || {};
  const isBiz = L.sellerType === 'business';
  if (isBiz) {
    const hasBizLegal = !!L.published && !!L.name && !!L.address && !!L.email;
    if (!hasBizLegal) {
      return res.status(400).render('error', {
        message: '（事業者向け）販売者情報の必須項目が未設定です。<br><a href="/creator/legal">販売者情報の設定</a> を先に完了してください。'
      });
    }
  }
}

    if (destinationAccountId) {
      try {
        const acct = await stripe.accounts.retrieve(destinationAccountId);
        canChargeOnSeller = !!acct?.charges_enabled;
      } catch (err) {
        console.warn('[checkout] retrieve account failed:', err?.raw?.message || err.message);
      }
    }

    // 決済手段：destination charge のときは card のみに（未対応のPMを避ける）
    const paymentMethodTypes = ['card'];

    const successUrl = `${BASE_URL}/success?session_id={CHECKOUT_SESSION_ID}&slug=${item.slug}`;
    const cancelUrl  = `${BASE_URL}/s/${item.slug}`;

    // 後続の transfer と突合するためのグループ & メタデータ
    const transferGroup = `item_${item._id}`;
    const commonMetadata = {
      itemId: String(item._id),
      slug: item.slug,
      sellerId: seller?._id ? String(seller._id) : ''
    };

    // 縦長でも切れない Stripe 用サムネが存在すればそれを優先、無ければ従来プレビューを使用
const stripeImgRel = `/previews/${item.slug}-stripe.jpg`;
const stripeImgAbs = path.join(__dirname, stripeImgRel);
let productImageUrl = `${BASE_URL}${item.previewPath}`;
try {
  await fsp.access(stripeImgAbs);
  productImageUrl = `${BASE_URL}${stripeImgRel}`;
} catch (_) {
  // ない場合はそのまま previewPath を使う
}

    /** @type {import('stripe').Stripe.Checkout.SessionCreateParams} */
    const params = {
      mode: 'payment',
      payment_method_types: paymentMethodTypes,
      line_items: [{
        price_data: {
          currency: item.currency,
          unit_amount: item.price,            // 最小通貨単位
          tax_behavior: 'inclusive',
          product_data: {
            name: item.title,
            images: [productImageUrl],
          },
        },
        quantity: 1,
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: commonMetadata,
      billing_address_collection: 'required',
      automatic_tax: { enabled: true },
      customer_creation: 'always',  // ← セッション完了時にCustomerを自動作成
      // どちらのルートでも PI に transfer_group & metadata を付与しておく
      payment_intent_data: {
        transfer_group: transferGroup,
        metadata: commonMetadata
      }
    };

    if (canChargeOnSeller) {
      // ✅ 直接接続アカウントで決済（destination charge）
      params.payment_intent_data = {
        ...params.payment_intent_data,
        application_fee_amount: platformFee,
        transfer_data: { destination: destinationAccountId },
        on_behalf_of: destinationAccountId
      };
    }
    // それ以外（charges_enabled=false）はプラットフォーム受領 → Webhook で transfer 実施

const session = await stripe.checkout.sessions.create(params);
console.log('[checkout] session created:', session.id, '→', session.url);

// 303 リダイレクトを素直に採用しない環境向けフォールバック（JS + meta refresh）
const to = session.url;
return res
  .status(200)
  .set('Content-Type', 'text/html; charset=utf-8')
  .send(`<!doctype html>
<html lang="ja">
<head>
  <meta charset="utf-8">
  <title>Stripeへ遷移します…</title>
  <meta http-equiv="refresh" content="0;url=${to}">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>body{font:16px/1.6 system-ui,-apple-system,Segoe UI,Roboto;padding:24px}a{color:#06f}</style>
</head>
<body>
  <p>Stripe の決済ページへ遷移します…<br>
  自動で切り替わらない場合は <a href="${to}" target="_top" rel="noopener">こちらをタップ</a> してください。</p>
  <script>
    try { window.top.location.replace(${JSON.stringify(to)}); }
    catch(_) { location.href = ${JSON.stringify(to)}; }
  </script>
</body>
</html>`);

} catch (e) {
  const detail = e?.raw?.message || e.message || 'unknown';
  console.error('[checkout] error:', detail, e);
  return res.status(500).render('error', { message: `決済セッションの作成に失敗しました：${detail}` });
}

  });

// ====== Stripe Webhook（決済確定→ダウンロード発行＋必要なら送金）======
// 注意: このルートは raw が必要（署名検証のため）
app.post('/webhooks/stripe', async (req, res) => {
  try {
    if (!stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
      return res.status(500).send('Webhook not configured');
    }
    const sig = req.headers['stripe-signature'];
    let event;
    try {
      event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
      console.error('[webhook] signature verify failed:', err.message);
      return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // 決済完了（カード等）＋ 非同期ウォレット成功（PayPay等）
    if (
      event.type === 'checkout.session.completed' ||
      event.type === 'checkout.session.async_payment_succeeded'
    ) {
      const session = event.data.object; // Stripe.Checkout.Session
      const sessionId = session.id;
      const paid = session.payment_status === 'paid';
      const itemId = session.metadata?.itemId;

      // --------------------
      // 1) ダウンロードトークンの発行（既存ロジック）
      // --------------------
      if (paid && itemId) {
        const existing = await DownloadToken.findOne({ sessionId });
        if (!existing) {
          const item = await Item.findById(itemId);
          if (item) {
            const token = nanoid(32);
            const ttlMin = Number(process.env.DOWNLOAD_TOKEN_TTL_MIN || '120');
            const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000);
            await DownloadToken.create({
              token,
              item: item._id,
              expiresAt,
              sessionId,
            });
          }
        }
      }

      // --------------------
      // 2) destination でなかった場合、販売者へ transfer を実施
      // --------------------
      try {
        // Checkout Session → PaymentIntent を取得
        const piId = session.payment_intent;
        if (piId) {
          const pi = await stripe.paymentIntents.retrieve(piId);

          // transfer_data が無ければ「プラットフォーム受領」= 要 transfer
          const needTransfer = !pi.transfer_data;

          if (needTransfer && itemId) {
            const item = await Item.findById(itemId);
            if (!item?.ownerUser) {
              console.warn('[transfer] item/seller not found', { itemId });
            } else {
              const seller = await User.findById(item.ownerUser);
              if (seller?.stripeAccountId) {
                // 手数料と送金額
                const feePercent = Number(process.env.PLATFORM_FEE_PERCENT || 0);
                const fee = Math.floor(item.price * (feePercent / 100));
                const sellerAmount = item.price - fee;

                // 送金可否（payouts_enabled）を軽くチェック（厳密に capabilities でもOK）
                let canTransfer = true;
                try {
                  const acc = await stripe.accounts.retrieve(seller.stripeAccountId);
                  canTransfer = !!acc?.payouts_enabled;
                } catch (accErr) {
                  console.warn('[transfer] retrieve account failed', accErr?.raw?.message || accErr.message);
                }

                if (sellerAmount > 0 && canTransfer) {
                  await stripe.transfers.create({
                    amount: sellerAmount,
                    currency: item.currency,
                    destination: seller.stripeAccountId,
                    transfer_group: pi.transfer_group || `item_${item._id}`, // 念のため
                  });
                  console.log('[transfer] success', {
                    pi: pi.id,
                    dest: seller.stripeAccountId,
                    amount: sellerAmount
                  });
                } else {
                  console.warn('[transfer] skipped (amount<=0 or cannot transfer)', {
                    sellerAmount, canTransfer, sellerId: seller._id
                  });
                }
              } else {
                console.warn('[transfer] seller has no stripeAccountId', { sellerId: seller?._id });
              }
            }
          }
        }
      } catch (tErr) {
        console.error('[transfer] error', tErr?.raw?.message || tErr.message, tErr?.raw || tErr);
        // TODO: ここで保留キューに退避し、後で再送金する運用にしてもOK
      }
    } else if (event.type === 'checkout.session.async_payment_failed') {
      const session = event.data.object; // Stripe.Checkout.Session
      console.warn('[webhook] async payment failed:', session.id);
    }

    res.json({ received: true });
  } catch (e) {
    console.error('[webhook] handler error', e);
    res.status(500).send('handler error');
  }
});

// success（Webhook で発行済みトークンを優先。無ければフォールバック発行）
app.get('/success', async (req, res) => {
  try {
    const { session_id, slug } = req.query;
    if (!stripe) return res.status(500).render('error', { message: '決済設定が未完了です（STRIPE_SECRET_KEY）。' });

    const item = await Item.findOne({ slug });
    if (!item) return res.status(404).render('error', { message: '商品が見つかりません。' });

    const session = await stripe.checkout.sessions.retrieve(String(session_id));
    const paid = session && session.payment_status === 'paid' && session.metadata?.itemId === String(item._id);
    if (!paid) return res.status(403).render('error', { message: 'お支払いの確認ができませんでした。' });

    // 既に Webhook が発行したトークンがあればそれを使う
    let doc = await DownloadToken.findOne({ sessionId: session.id });
    if (!doc) {
      // フォールバック：まだ無ければここで発行
      const token = nanoid(32);
      const expiresAt = new Date(Date.now() + DOWNLOAD_TOKEN_TTL_MIN * 60 * 1000);
      doc = await DownloadToken.create({
        token,
        item: item._id,
        expiresAt,
        sessionId: session.id,
      });
    }

    const downloadUrl = `${BASE_URL}/download/${doc.token}`;
    return res.render('success', { item, downloadUrl, expiresAt: doc.expiresAt, ttlMin: DOWNLOAD_TOKEN_TTL_MIN });
  } catch (e) {
    console.error(e);
    return res.status(500).render('error', { message: '決済結果の処理に失敗しました。' });
  }
});

// download
app.get('/download/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const doc = await DownloadToken.findOne({ token });
    if (!doc) return res.status(404).render('error', { message: 'ダウンロードリンクが無効です。' });
    if (doc.usedOnce) return res.status(410).render('error', { message: 'このリンクはすでに使用されています。' });
    if (doc.expiresAt.getTime() < Date.now()) return res.status(410).render('error', { message: 'ダウンロードリンクの有効期限が切れました。' });

    const item = await Item.findById(doc.item);
    if (!item) return res.status(404).render('error', { message: 'ファイルが見つかりません。' });

    const abs = path.resolve(item.filePath);
    if (!fs.existsSync(abs)) return res.status(404).render('error', { message: 'ファイルが存在しません。' });

    res.setHeader('Content-Type', item.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.title)}${path.extname(abs) || ''}`);
    const stream = fs.createReadStream(abs);
    return stream.pipe(res);
  } catch (e) {
    console.error(e);
    return res.status(500).render('error', { message: 'ダウンロード処理に失敗しました。' });
  }
});

// 404
app.use((req, res) => res.status(404).render('error', { message: 'ページが見つかりません。' }));

// === Legal pages ===
app.get('/legal/tokushoho', (req, res) => {
  res.render('legal/tokushoho', {
    site: process.env.SITE_NAME || 'Instant Sale',
    sellerName: process.env.LEGAL_SELLER_NAME || '',
    responsibleName: process.env.LEGAL_RESPONSIBLE_NAME || '',
    address: process.env.LEGAL_ADDRESS || '',
    phone: process.env.LEGAL_PHONE || '',
    email: process.env.LEGAL_EMAIL || '',
    website: process.env.LEGAL_WEBSITE || process.env.BASE_URL || '',
    businessHours: process.env.LEGAL_BUSINESS_HOURS || '',
  });
});

app.get('/legal/terms', (req, res) => {
  res.render('legal/terms', {
    site: process.env.SITE_NAME || 'Instant Sale',
    contactEmail: process.env.LEGAL_EMAIL || '',
    governingLaw: '日本法',
    court: '東京地方裁判所'
  });
});

app.get('/legal/privacy', (req, res) => {
  res.render('legal/privacy', {
    site: process.env.SITE_NAME || 'Instant Sale',
    contactEmail: process.env.LEGAL_EMAIL || '',
    website: process.env.LEGAL_WEBSITE || process.env.BASE_URL || '',
  });
});

// ▼▼▼ ここから追加：販売者ごとの特商法表示ページ ▼▼▼
app.get('/legal/seller/:userId', async (req, res) => {
  try {
    const u = await User.findById(req.params.userId).lean();
    if (!u || !u.legal || !u.legal.name) {
      return res
        .status(404)
        .render('error', { message: '販売者の特商法情報が未設定です。' });
    }
    res.render('legal/tokushoho_seller', {
      site: process.env.SITE_NAME || 'Instant Sale',
      legal: u.legal
    });
  } catch (e) {
    console.error(e);
    res.status(500).render('error', { message: '表示に失敗しました。' });
  }
});
// ▲▲▲ 追加ここまで ▲▲▲

// start
app.listen(PORT, () => {
  console.log(`Server running: ${BASE_URL}`);
});
