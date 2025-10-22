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
const crypto = require('crypto'); // ★ 追加：CSP nonce 生成用

const session = require('express-session');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const Item = require('./models/Item');
const DownloadToken = require('./models/DownloadToken');
const User = require('./models/User');

const PendingTransfer = require('./models/PendingTransfer');

const app = express();

// === PATH CONSTANTS ===
const ROOT_DIR    = __dirname;
const UPLOAD_DIR  = path.join(ROOT_DIR, 'uploads');
const PREVIEW_DIR = path.join(ROOT_DIR, 'previews');

/* ====== ENV ====== */
const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

// --- Asset version for cache-busting (prod: set ASSET_VER env) ---
const PKG_VER  = (() => { try { return require('./package.json').version || ''; } catch { return ''; } })();
const ASSET_VER = process.env.ASSET_VER || PKG_VER || 'v1';

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
// 最低価格（未設定なら JPY は 50）
const MIN_PRICE = Number(process.env.MIN_PRICE || (CURRENCY === 'jpy' ? 50 : 50));

// ─────────────────────────────────────────────
// 相対→絶対URL変換（正規化済み BASE_URL を使う版）
// ─────────────────────────────────────────────
const toAbs = (u) => {
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : `${BASE_URL}${u.startsWith('/') ? '' : '/'}${u}`;
};

const CREATOR_SECRET = process.env.CREATOR_SECRET || 'changeme';
const DOWNLOAD_TOKEN_TTL_MIN = Number(process.env.DOWNLOAD_TOKEN_TTL_MIN || '120');
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_me';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const USE_STRIPE_CONNECT = process.env.USE_STRIPE_CONNECT === 'true';
// プラットフォーム手数料の既定値を 20% に
const PLATFORM_FEE_PERCENT = Number(process.env.PLATFORM_FEE_PERCENT || '20');
// 業種(MCC) と 商品説明の既定値（必要なら .env で上書き）
const DEFAULT_MCC  = process.env.DEFAULT_MCC || '5399'; // Misc. General Merchandise
const DEFAULT_PRODUCT_DESC =
  process.env.DEFAULT_PRODUCT_DESC || 'デジタルコンテンツの即時販売（個人間）';


const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

// ====== S3 (S3/R2 互換) ======
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const S3_ENDPOINT = process.env.S3_ENDPOINT || undefined; // AWS の場合は undefined でOK
const S3_REGION   = process.env.S3_REGION   || 'auto';
const S3_BUCKET   = process.env.S3_BUCKET   || '';
const S3_PUBLIC_BASE = (process.env.S3_PUBLIC_BASE || '').replace(/\/+$/,''); // 末尾スラ削除

const s3 = (S3_BUCKET)
  ? new S3Client({
      region: S3_REGION,
      endpoint: S3_ENDPOINT,
      forcePathStyle: !!S3_ENDPOINT, // R2/MinIO向け
      credentials: {
        accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
      },
    })
  : null;
if (!S3_BUCKET) console.warn('[WARN] S3_BUCKET 未設定。オブジェクト保存は動きません。');

if (!STRIPE_SECRET_KEY) {
  console.warn('[WARN] STRIPE_SECRET_KEY が未設定です。決済は動きません。');
}

/* ====== Views ====== */
app.set('view engine', 'ejs');

// Render のリバースプロキシ配下での secure cookie 用
app.set('trust proxy', 1);

app.set('views', path.join(__dirname, 'views'));

// Core middlewares
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

// どのテンプレートからも使えるように
app.use((req, res, next) => {
  res.locals.assetVer = ASSET_VER;
  next();
});

// ★ 追加：各リクエスト毎に CSP 用の nonce を作ってビューへ渡す
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

// CSP: インラインJSは nonce 付きだけ許可。Stripeの必要オリジンも許可。
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "script-src": [
        "'self'",
        // ★ nonce を許可（各リクエストで異なる値）
        (req, res) => `'nonce-${res.locals.cspNonce}'`,
        "https://js.stripe.com"
      ],
      "img-src": ["'self'", "data:", "blob:", "https:", "http:"],
      "connect-src": ["'self'", "https://api.stripe.com", "https://r.stripe.com"],
      "frame-src": ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
      // スタイルは既にインラインを使っているので一旦許容（後で外部CSS化が理想）
      "style-src": ["'self'", "'unsafe-inline'"]
    }
  }
}));

app.use(compression());
app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 300,
}));

const CANON_HOST = new URL(BASE_URL).host;
app.use((req, res, next) => {
  if (!isProd) return next();

  // フォームやAPIを壊さない：安全なメソッドだけリダイレクト
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];

  if (host && host !== CANON_HOST) {
    return res.redirect(301, `${proto}://${CANON_HOST}${req.originalUrl}`);
  }
  next();
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// 本番は 1 年キャッシュ + immutable（URLに ?v=xxx を付けて破棄）
app.use('/public', express.static(path.join(__dirname, 'public'), {
  maxAge: isProd ? '365d' : 0,
  immutable: !!isProd,
  etag: true,
  lastModified: true
}));

// ★ 追加：/favicon.ico への直リンクをロゴで返す（簡易対応）
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logo.png'));
});

app.use('/previews', express.static(PREVIEW_DIR)); // OGP/プレビューを公開

// Stripe/X(Twitter) など外部からの画像取得を明示許可（任意・上の Helmet だけでも可）
app.use(['/previews', '/uploads'], (req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// EJS で user を使えるように
app.use((req, res, next) => {
  res.locals.me = req.user || null;
  next();
});

// 各ページの canonical/robots を出せるように共通値を用意
app.use((req, res, next) => {
  // 既に BASE_URL は末尾スラ無し・https 化済み
  res.locals.canonical = `${BASE_URL}${req.path}`;
  res.locals.robots = 'index,follow'; // 法令・ポリシーは index でOK
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
  // 相対パスにして、実際のホスト/プロトコルはリクエストから判定
  callbackURL: '/auth/google/callback',
  // 逆プロキシ配下でも https として扱う
  proxy: true,
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

const ensureAuthed = (req, res, next) => {
  if (req.user) return next();
  // ★ AJAX から来た場合は JSON 返却にする（フロントがアラート表示→/login遷移）
  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.status(401).json({ ok: false, message: 'login_required' });
  }
  return res.redirect('/login');
};

app.get('/terms', (req, res) => {
  res.locals.canonical = `${BASE_URL}/terms`;
  res.render('legal/terms', {
    site: process.env.SITE_NAME || 'Instant Sale',
    governingLaw: process.env.GOVERNING_LAW || '日本法',
    court: process.env.COURT || '東京地方裁判所',
    contactEmail: process.env.CONTACT_EMAIL || 'Instant-Sale.sup@outlook.jp',
  });
});

app.get('/privacy', (req, res) => {
  res.locals.canonical = `${BASE_URL}/privacy`;
  res.render('legal/privacy', {
    site: process.env.SITE_NAME || 'Instant Sale',
    contactEmail: process.env.CONTACT_EMAIL || 'Instant-Sale.sup@outlook.jp',
    website: process.env.WEBSITE_URL || (process.env.BASE_URL || ''),
  });
});

app.get('/tokushoho', (req, res) => {
  res.locals.canonical = `${BASE_URL}/tokushoho`;
  const fallbackName =
    '個人で運営しているため、氏名（又は屋号＋代表者名）はご請求いただいた場合に遅滞なく開示します。';
  const fallbackAddress =
    '個人で運営しているため、住所はご請求いただいた場合に遅滞なく開示します。';
  const fallbackPhone =
    '電話番号はご請求があれば遅滞なく開示いたします（通常のお問い合わせはメールでお願いします）。';

  res.render('legal/tokushoho', {
    site: process.env.SITE_NAME || 'Instant Sale',
    sellerName: process.env.SELLER_NAME || fallbackName,
    responsibleName: process.env.RESPONSIBLE_NAME || '—',
    address: process.env.SELLER_ADDRESS || fallbackAddress,
    phone: process.env.SELLER_PHONE || fallbackPhone,
    email: process.env.CONTACT_EMAIL || 'Instant-Sale.sup@outlook.jp',
    website: process.env.WEBSITE_URL || (process.env.BASE_URL || ''),
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

ensureDir(UPLOAD_DIR);
ensureDir(PREVIEW_DIR);

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
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

// robots.txt
app.get('/robots.txt', (req, res) => {
  res.type('text/plain').send(
`User-agent: *
Allow: /
Sitemap: ${BASE_URL}/sitemap.xml`
  );
});

// sitemap.xml（最小構成）
app.get('/sitemap.xml', (req, res) => {
  res.type('application/xml').send(
`<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${BASE_URL}/</loc></url>
  <url><loc>${BASE_URL}/privacy</loc></url>
  <url><loc>${BASE_URL}/terms</loc></url>
  <url><loc>${BASE_URL}/tokushoho</loc></url>
</urlset>`
  );
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

/**
 * transfers-only（card_paymentsなし）での軽いオンボーディングを強制。
 * 既存アカウントが card_payments を要求していたり、website URL が currently_due に含まれている場合は作り直す。
 */
const ensureConnectedAccount = async () => {
  if (acctId) {
    try {
      const acct = await stripe.accounts.retrieve(acctId);

// 両方の capability が既に（active/pending/inactive のいずれかで）存在すれば再利用
const hasTransfers =
  !!acct?.capabilities?.transfers &&
  ['active','pending','inactive'].includes(acct.capabilities.transfers);
const hasCardPayments =
  !!acct?.capabilities?.card_payments &&
  ['active','pending','inactive'].includes(acct.capabilities.card_payments);

// 既存アカウントを使うが、URL / MCC / 商品説明が未設定なら事前に入れておく
if (hasTransfers && hasCardPayments) {
  try {
    const needUrl  = !acct?.business_profile?.url;
    const needMcc  = !acct?.business_profile?.mcc;
    const needDesc = !acct?.business_profile?.product_description;

    if (needUrl || needMcc || needDesc) {
      await stripe.accounts.update(acctId, {
        business_profile: {
          ...(needUrl  ? { url: `${BASE_URL}` } : {}),
          ...(needMcc  ? { mcc: DEFAULT_MCC } : {}),
          ...(needDesc ? { product_description: DEFAULT_PRODUCT_DESC } : {}),
        }
      });
    }
  } catch (e) {
    console.warn('[Stripe] preset business_profile failed:', e?.raw?.message || e.message);
  }
  return acctId;
}

// capability が足りない場合だけ作り直す
console.warn('[Stripe] recreate account with transfers + card_payments');
acctId = null;

    } catch (err) {
      console.warn('[Stripe] retrieve failed; recreate. reason:', err?.raw?.message || err.message);
      acctId = null;
    }
  }

const account = await stripe.accounts.create({
  type: 'express',
  country: 'JP',
  email: user.email,
  business_type: 'individual',
  capabilities: { 
    transfers: { requested: true },
    card_payments: { requested: true }
  },
  business_profile: {
    mcc: DEFAULT_MCC,
    product_description: DEFAULT_PRODUCT_DESC,
    url: `${BASE_URL}`,
  },
  settings: { payouts: { schedule: { interval: 'manual' } } }
});

  user.stripeAccountId = account.id;
  await user.save();
  return account.id;
};
    
const connectedAccountId = await ensureConnectedAccount();

const accountLink = await stripe.accountLinks.create({
  account: connectedAccountId,
  refresh_url: `${BASE_URL}/connect/refresh`,
  return_url:  `${BASE_URL}/connect/return`,
  type: 'account_onboarding',
  // card_payments を含む通常の Express Onboarding に従う
  // （指定を外す or 'currently_due' を明示）
  collect: 'currently_due'
});

return res.redirect(accountLink.url);

} catch (e) {
  // Stripeのエラー本文を画面にも出す（暫定）
  const detail = e?.raw?.message || e?.message || 'unknown error';
  console.error('[Stripe onboard] failed:', detail, e);
  return res.status(500).render('error', { message: `オンボーディングリンクの発行に失敗しました：${detail}` });
}

  });

app.get('/connect/return', ensureAuthed, async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user?.stripeAccountId) {
      return res.status(400).render('error', { message: '接続アカウントが見つかりません。' });
    }
    const acct = await stripe.accounts.retrieve(user.stripeAccountId);
    const payoutsEnabled = !!acct.payouts_enabled;

    user.payoutsEnabled = payoutsEnabled;
    await user.save();

    // ★ 自動送金：payouts が有効になったら、そのユーザーの保留分を一括実行
    if (payoutsEnabled) {
      const pendings = await PendingTransfer.find({ seller: user._id }).lean();
      for (const p of pendings) {
        try {
          await stripe.transfers.create({
            amount: p.amount,
            currency: p.currency,
            destination: user.stripeAccountId,
            transfer_group: p.transferGroup || undefined
          });
          await PendingTransfer.deleteOne({ _id: p._id });
          console.log('[pending-transfer] sent', { seller: String(user._id), amount: p.amount, pi: p.paymentIntentId });
        } catch (te) {
          console.error('[pending-transfer] send failed', te?.raw?.message || te.message, { pendingId: p._id });
          // 失敗した分は保留のまま（次回また試せる）
        }
      }
    }

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

// ── Admin: 未送金の PendingTransfer を再実行（管理者専用） ──
// 使い方: 環境変数 ADMIN_TOKEN を設定して、
// POST /admin/retry-pending へ Authorization: Bearer <ADMIN_TOKEN> で呼ぶ。
app.post('/admin/retry-pending', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    if (!stripe) return res.status(500).json({ ok: false, error: 'stripe_not_configured' });

    const pendings = await PendingTransfer.find({}).lean();
    const results = [];
    for (const p of pendings) {
      try {
        const seller = await User.findById(p.seller);
        if (!seller?.stripeAccountId) { results.push({ id: p._id, status: 'skip_no_account' }); continue; }

        // payouts_enabled 確認
        let enabled = true;
        try {
          const acc = await stripe.accounts.retrieve(seller.stripeAccountId);
          enabled = !!acc?.payouts_enabled;
        } catch (e) { enabled = false; }

        if (!enabled) { results.push({ id: p._id, status: 'skip_payouts_disabled' }); continue; }

        await stripe.transfers.create({
          amount: p.amount,
          currency: p.currency,
          destination: seller.stripeAccountId,
          transfer_group: p.transferGroup || undefined
        });

        await PendingTransfer.deleteOne({ _id: p._id });
        results.push({ id: p._id, status: 'transferred', amount: p.amount });
      } catch (e) {
        results.push({ id: p._id, status: 'error', error: e?.raw?.message || e.message });
      }
    }
    return res.json({ ok: true, count: results.length, results });
  } catch (e) {
    console.error('[admin/retry-pending] error', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// （任意）接続アカウントIDを手動リセットして、軽いフローで作り直したい時に使う
app.post('/connect/reset', ensureAuthed, async (req, res) => {
  const u = await User.findById(req.user._id);
  u.stripeAccountId = undefined;
  u.payoutsEnabled = false;
  await u.save();
  return res.redirect('/connect/onboard');
});

// クリエイター：特商法（売主）情報の設定画面
app.get('/creator/legal', ensureAuthed, async (req, res) => {
  const me = await User.findById(req.user._id).lean();
  const legal = me?.legal || {};
  res.render('creator-legal', { baseUrl: BASE_URL, me, legal });
});

app.post('/creator/legal', ensureAuthed, async (req, res) => {
  return res.status(405).render('error', {
    message: 'このページからの登録は不要です（本サービスは個人ユーザー専用です）。<br><a href="/creator">アップロードへ戻る</a>'
  });
});

app.get('/creator', ensureAuthed, async (req, res) => {
  const connect = await getConnectStatus(req.user);

  // 個人専用運用：常に個人扱い（＝特商法入力は不要）
  const me = await User.findById(req.user._id).lean();
  const L = me?.legal || {};
  const isBiz = false;
  const legalReady = true;

  res.render('upload', { baseUrl: BASE_URL, connect, legal: L, legalReady, isBiz });
});

// upload
app.post('/upload', ensureAuthed, upload.single('image'), async (req, res) => {
  try {

const {
  title, price, creatorName, creatorSecret, ownerEmail, attestOwner,
  licensePreset, requireCredit, licenseNotes, aiGenerated, aiModelName
} = req.body;

const currency = CURRENCY; // ← フォーム値は無視して固定

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
if (!title || !priceNum || priceNum < MIN_PRICE) {
  await fsp.unlink(req.file.path).catch(() => {});
  return res.status(400).render('error', { message: `タイトルと価格（${MIN_PRICE}以上）は必須です。` });
}

// 追加：ライセンス入力の正規化
const licensePresetSafe = (['standard','editorial','commercial-lite','exclusive'].includes(licensePreset))
  ? licensePreset : 'standard';
const requireCreditBool = !!requireCredit;
const aiGeneratedBool   = !!aiGenerated;
const licenseNotesSafe  = (licenseNotes || '').trim().slice(0, 1000);
const aiModelNameSafe   = (aiModelName || '').trim().slice(0, 200);

    const slug = nanoid(10);
    const mimeType = req.file.mimetype;

// OGPプレビュー（1200x630）
const previewName = `${slug}-preview.jpg`;
const previewFull = path.join(PREVIEW_DIR, previewName);

const previewBase = await sharp(req.file.path)
  .rotate()
  .resize(1200, 630, { fit: 'cover' })
  .jpeg({ quality: 85 })
  .toBuffer();

const svg = Buffer.from(`
  <svg width="1200" height="630">
    <style>
      .wmark { fill: rgba(255,255,255,0.35); font-size: 110px; font-weight: 700; }
    </style>
    <text x="50%" y="50%" dominant-baseline="middle" text-anchor="middle" class="wmark">SAMPLE</text>
  </svg>
`);

await sharp(previewBase)
  .composite([{ input: svg, gravity: 'center' }])
  .toFile(previewFull);

// ★ Stripe用（縦長が切れない “contain” 版）
const stripeName = `${slug}-stripe.jpg`;
const stripeFull  = path.join(PREVIEW_DIR, stripeName);

await sharp(req.file.path)
  .rotate()
  .resize(1200, 630, {
    fit: 'contain',
    background: { r: 10, g: 16, b: 24, alpha: 1 }
  })
  .composite([{ input: svg, gravity: 'center' }])
  .jpeg({ quality: 85 })
  .toFile(stripeFull);

// ★ 等倍プレビュー（透かし入り・最大4096pxに内接）
const fullName = `${slug}-full.jpg`;
const fullPath    = path.join(PREVIEW_DIR, fullName);

// まず「回転＋内接リサイズ」をバッファに作る
const fullBase = await sharp(req.file.path)
  .rotate()
  .resize(4096, 4096, { fit: 'inside' })
  .toBuffer();

// 出来上がった fullBase の実寸を取得（←これが確実）
const fullMeta = await sharp(fullBase).metadata();
const fw = Math.max(1, fullMeta.width  || 1200);
const fh = Math.max(1, fullMeta.height || 1200);

// 実寸にピッタリの SVG を生成（短辺の約14%をフォントサイズ）
const wmSize = Math.round(Math.min(fw, fh) * 0.14);
const svgFull = Buffer.from(`
  <svg width="${fw}" height="${fh}" xmlns="http://www.w3.org/2000/svg">

    <style>.wm{ fill: rgba(255,255,255,.38); font-size: ${wmSize}px; font-weight: 700; }</style>
    <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
      class="wm" transform="rotate(-18 ${fw/2} ${fh/2})">SAMPLE</text>
  </svg>
`);

await sharp(fullBase)
  .composite([{ input: svgFull }])  // ← fullBase と同寸の SVG なので安全
  .jpeg({ quality: 90 })
  .toFile(fullPath);

// ====== ここから S3 へアップロード ======
if (!s3) {

  const item = await Item.create({
  slug,
  title,
  price: priceNum,
  currency: (CURRENCY).toLowerCase(),
  filePath: req.file.path,
  previewPath: `/previews/${previewName}`,
  mimeType,
  creatorName: creatorName || '',
  ownerUser: req.user?._id || null,
  createdBySecret: creatorSecret || '',
  ownerEmail: (req.user?.email || ownerEmail || ''),
  attestOwner: !!attestOwner,
  uploaderIp: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '',

  // 追加：ライセンス情報
  licensePreset: licensePresetSafe,
  requireCredit: requireCreditBool,
  licenseNotes:  licenseNotesSafe,
  aiGenerated:   aiGeneratedBool,
  aiModelName:   aiModelNameSafe,
});

  const saleUrl = `${BASE_URL}/s/${item.slug}`;
  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.json({ ok: true, createdUrl: saleUrl });
  }
  return res.render('upload', { baseUrl: BASE_URL, createdUrl: saleUrl });

}

// 拡張子（例: .jpg）を推定
const extFromMime = mime.extension(mimeType) ? ('.' + mime.extension(mimeType)) : path.extname(req.file.originalname) || '';

// S3キーの決定（原本と各プレビュー）
const s3KeyOriginal = `originals/${slug}${extFromMime}`;
const s3KeyPreview  = `previews/${slug}-preview.jpg`;
const s3KeyStripe   = `previews/${slug}-stripe.jpg`;
const s3KeyFull     = `previews/${slug}-full.jpg`;

// 原本をS3へアップロード
await s3.send(new PutObjectCommand({
  Bucket: S3_BUCKET,
  Key: s3KeyOriginal,
  Body: fs.createReadStream(req.file.path),
  ContentType: mimeType || 'application/octet-stream'
}));

// 生成済みプレビュー3種をS3へアップロード
await s3.send(new PutObjectCommand({
  Bucket: S3_BUCKET,
  Key: s3KeyPreview,
  Body: fs.createReadStream(previewFull),
  ContentType: 'image/jpeg'
}));
await s3.send(new PutObjectCommand({
  Bucket: S3_BUCKET,
  Key: s3KeyStripe,
  Body: fs.createReadStream(stripeFull),
  ContentType: 'image/jpeg'
}));
await s3.send(new PutObjectCommand({
  Bucket: S3_BUCKET,
  Key: s3KeyFull,
  Body: fs.createReadStream(fullPath),
  ContentType: 'image/jpeg'
}));

// ローカルの一時ファイルを削除
await fsp.unlink(req.file.path).catch(()=>{});

// プレビュー3種は、S3_PUBLIC_BASE がある＝「公開URLで配信できる」時だけ削除。
// 無い場合は /previews 配信に使うので残す（これが無いと 404 → 画像が「？」になる）
if (S3_PUBLIC_BASE) {
  await fsp.unlink(previewFull).catch(()=>{});
  await fsp.unlink(stripeFull).catch(()=>{});
  await fsp.unlink(fullPath).catch(()=>{});
}

// プレビューのURL（パブリック配信前提）
const previewUrl = S3_PUBLIC_BASE
  ? `${S3_PUBLIC_BASE}/${s3KeyPreview}`
  : `/previews/${previewName}`; // フォールバック（S3_PUBLIC_BASE 未設定）

// 本文表示に使う “full” 版（あるいはプレビューURL）
const fullUrl = S3_PUBLIC_BASE
  ? `${S3_PUBLIC_BASE}/${s3KeyFull}`
  : previewUrl;

// DB には「原本の S3 キー」＋「プレビューはURL」を保存

const item = await Item.create({
  slug,
  title,
  price: priceNum,
  currency: (CURRENCY).toLowerCase(),
  filePath: req.file.path,
  previewPath: `/previews/${previewName}`,
  mimeType,
  creatorName: creatorName || '',
  ownerUser: req.user?._id || null,
  createdBySecret: creatorSecret || '',
  ownerEmail: (req.user?.email || ownerEmail || ''),
  attestOwner: !!attestOwner,
  uploaderIp: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '',

  // 追加：ライセンス情報
  licensePreset: licensePresetSafe,
  requireCredit: requireCreditBool,
  licenseNotes:  licenseNotesSafe,
  aiGenerated:   aiGeneratedBool,
  aiModelName:   aiModelNameSafe,
});

const saleUrl = `${BASE_URL}/s/${item.slug}`;
if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
  return res.json({ ok: true, createdUrl: saleUrl });
}
return res.render('upload', { baseUrl: BASE_URL, createdUrl: saleUrl });

} catch (e) {
  console.error(e);
  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.status(500).json({ ok: false, message: e?.message || 'アップロードに失敗しました。' });
  }
  return res.status(500).render('error', { message: 'アップロードに失敗しました。' });
}

});

// /s/:slug
app.get('/s/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    const item = await Item.findOne({ slug }).lean();
    if (!item) {
      return res.status(404).render('error', { message: '販売ページが見つかりません。' });
    }

const isAbs = typeof item.previewPath === 'string' && /^https?:\/\//i.test(item.previewPath);

const og = {
  title: `${item.title} | 即ダウンロード`,
  desc: `高解像度をすぐ購入（${Number(item.price).toLocaleString('ja-JP')} 円）`,
image: isAbs ? item.previewPath : `${BASE_URL}${item.previewPath}`,
  url: `${BASE_URL}/s/${item.slug}`
};

    // ログイン者がオーナーなら接続状態
    let connect = null;
    if (req.user && item.ownerUser && String(item.ownerUser) === String(req.user._id)) {
      connect = await getConnectStatus(req.user);
    }

    // 販売者情報の取得は「例外を潰して」null安全に
    let seller = null;
    let sellerLegal = null;
    if (item.ownerUser) {
      try {
        seller = await User.findById(item.ownerUser).lean();
        if (seller?.legal?.published) sellerLegal = seller.legal;
      } catch (_) {
        seller = null;
        sellerLegal = null;
      }
    }

// ▼ 特商法リンクのフォールバック先を決める（販売者ページが公開されていなければ /tokushoho）
let tokushohoUrl = '/tokushoho';
if (seller && sellerLegal) {
    tokushohoUrl = `/legal/seller/${seller._id}`;
}

const fullRelNoSlash   = `previews/${item.slug}-full.jpg`;
const stripeRelNoSlash = `previews/${item.slug}-stripe.jpg`;
const fullAbs   = path.join(__dirname, fullRelNoSlash);
const stripeAbs = path.join(__dirname, stripeRelNoSlash);

// 既定は DB の previewPath（S3_PUBLIC_BASE ありの場合は絶対URL、無ければ /previews/...）
let displayImagePath = item.previewPath;

// ローカルが残っている構成（S3_PUBLIC_BASE なし）では、存在する方を優先
try {
  await fsp.access(fullAbs);
  displayImagePath = `/${fullRelNoSlash}`;
} catch {
  try {
    await fsp.access(stripeAbs);
    displayImagePath = `/${stripeRelNoSlash}`;
  } catch {
    // 何もしない：どちらも無ければ DB の previewPath を使う
  }
}
    
    // EJS でのプロパティ参照で落ちないよう、空オブジェクト/ null を渡す
    return res.render('sale', {
      item,
      baseUrl: BASE_URL,
      og,
      connect,
      seller: seller || {},            // ← undefined ではなく {}
      sellerLegal: sellerLegal || null,
      displayImagePath,
      tokushohoUrl
    });

  } catch (e) {
    console.error('[sale] route error:', e);
    return res.status(500).render('error', { message: '販売ページの表示に失敗しました。' });
  }
});

// 等倍プレビュー（透かし付き、元画像サイズのまま）
app.get('/view/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const item = await Item.findOne({ slug }).lean();
    if (!item) return res.status(404).send('Not found');

    // 元画像が無い場合はフルプレビューにフォールバック
    const srcPath = path.resolve(item.filePath || '');
    const fallbackFull = path.join(__dirname, 'previews', `${slug}-full.jpg`);

    let usePath = srcPath;
    if (!fs.existsSync(usePath)) {
      if (fs.existsSync(fallbackFull)) {
        res.setHeader('Content-Type', 'image/jpeg');
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        return fs.createReadStream(fallbackFull).pipe(res);
      }
      return res.status(404).send('source image missing');
    }

    // 回転補正した後のサイズを取得
    const base = sharp(usePath).rotate();
    const meta = await base.metadata();
    const w = Math.max(1, meta.width  || 1200);
    const h = Math.max(1, meta.height || 1200);

    // 画像サイズに合わせたSVG（フォントサイズは辺の短い方の約14%）
    const fontSize = Math.round(Math.min(w, h) * 0.14);
    const svg = Buffer.from(`
      <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <style>.wm{ fill: rgba(255,255,255,.38); font-size: ${fontSize}px; font-weight: 700; }</style>
        <text x="50%" y="50%" text-anchor="middle" dominant-baseline="middle"
              class="wm" transform="rotate(-18 ${w/2} ${h/2})">SAMPLE</text>
      </svg>
    `);

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    await base
      .composite([{ input: svg, gravity: 'center' }])  // ← 同サイズなのでエラーにならない
      .jpeg({ quality: 90 })
      .pipe(res);

  } catch (e) {
    console.error('[view-full]', e);
    res.status(500).send('viewer error');
  }
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

// 手数料（20%など）
const platformFee = Math.max(0, Math.floor(item.price * (PLATFORM_FEE_PERCENT / 100)));

// 販売者（オーナー）
let seller = null;
if (USE_STRIPE_CONNECT && item.ownerUser) {
  seller = await User.findById(item.ownerUser);
}

// destination を安全に使えるかを確認（transfers=active かつ payouts_enabled）
let destinationAccountId = null;
if (USE_STRIPE_CONNECT && seller?.stripeAccountId) {
  try {
    const acc = await stripe.accounts.retrieve(seller.stripeAccountId);
    const transfersCap = acc?.capabilities?.transfers;
    const canUseDestination =
      transfersCap === 'active' && !!acc?.payouts_enabled;
    if (canUseDestination) destinationAccountId = seller.stripeAccountId;
  } catch (e) {
    console.warn('[checkout] could not retrieve account; fallback to platform charge:', e?.raw?.message || e.message);
  }
}

// 個人専用運用：事業者（business）は利用不可
if (seller?.legal?.sellerType === 'business') {
  return res.status(403).render('error', {
    message: '本サービスは個人ユーザー専用です。事業者（法人・屋号）としてのご利用はできません。'
  });
}

// 決済手段
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

// 画像URL（絶対URLへ）
let productImageUrl = toAbs(item.previewPath);

// S3_PUBLIC_BASE が無い構成（＝ローカル /previews 配信）なら、Stripe用に生成した 1200x630 を優先
// これが無い/読めない場合は DB の previewPath を絶対URL化したものを使う
try {
  if (!S3_PUBLIC_BASE) {
    const stripeImgAbs = path.join(PREVIEW_DIR, `${item.slug}-stripe.jpg`);
    await fsp.access(stripeImgAbs);
    productImageUrl = toAbs(`/previews/${item.slug}-stripe.jpg`);
  }
} catch (_) {
  // 何もしない（productImageUrl は既に previewPath の絶対URLになっている）
}

const automaticTax = { enabled: true, liability: { type: 'self' } };
const paymentIntentData = {
  transfer_group: transferGroup,
  metadata: commonMetadata,
};

// destination を使える時のみ、アプリ手数料・transfer・税務責任の移譲を行う
if (USE_STRIPE_CONNECT && destinationAccountId) {
  paymentIntentData.application_fee_amount = platformFee;
  paymentIntentData.transfer_data = { destination: destinationAccountId };
  paymentIntentData.on_behalf_of = destinationAccountId;

  // Automatic Tax を販売者責任に切替（destination 利用時のみ）
  automaticTax.liability = { type: 'account', account: destinationAccountId };
}

const params = {
  mode: 'payment',
  payment_method_types: paymentMethodTypes,
  line_items: [{
    price_data: {
      currency: item.currency,
      unit_amount: item.price,
      tax_behavior: 'inclusive',
      product_data: {
        name: item.title,
        images: productImageUrl ? [productImageUrl] : [],
      },
    },
    quantity: 1,
  }],
  success_url: successUrl,
  cancel_url: cancelUrl,
  metadata: commonMetadata,
  billing_address_collection: 'required',
  automatic_tax: automaticTax,
  customer_creation: 'always',
  payment_intent_data: paymentIntentData
};

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

app.get('/debug/session', async (req, res) => {
  try {
    // ★ 管理者トークンで保護
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
      return res.status(403).send('forbidden');
    }

    if (!stripe) return res.status(500).send('stripe_not_configured');
    const sid = String(req.query.sid || '');
    if (!sid) return res.status(400).send('sid required');

    const s = await stripe.checkout.sessions.retrieve(sid, { expand: ['payment_intent.charges.data.balance_transaction'] });
    const pi = s.payment_intent
      ? await stripe.paymentIntents.retrieve(s.payment_intent, { expand: ['charges.data.transfer_data'] })
      : null;

    const summary = {
      session: { id: s.id, status: s.payment_status, amount_total: s.amount_total, currency: s.currency },
      payment_intent: pi ? {
        id: pi.id,
        amount: pi.amount,
        application_fee_amount: pi.application_fee_amount,
        transfer_group: pi.transfer_group,
        has_transfer_data: !!pi.transfer_data,
        destination: pi.transfer_data?.destination || null
      } : null
    };

    res.type('json').send(JSON.stringify(summary, null, 2));
  } catch (e) {
    res.status(500).send(e?.raw?.message || e.message);
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
      //     送れない時は PendingTransfer に保留登録
      // --------------------
      try {
        const piId = session.payment_intent;
        if (piId) {
          const pi = await stripe.paymentIntents.retrieve(piId);
          const needTransfer = !pi.transfer_data; // destination でない = 要 transfer

          if (needTransfer && itemId) {
            const item = await Item.findById(itemId);
            if (!item?.ownerUser) {
              console.warn('[transfer] item/seller not found', { itemId });
            } else {
              const seller = await User.findById(item.ownerUser);

              // 金額計算
              const feePercent = Number(process.env.PLATFORM_FEE_PERCENT || 0);
              const fee = Math.floor(item.price * (feePercent / 100));
              const sellerAmount = item.price - fee;
              const transferGroup = pi.transfer_group || `item_${item._id}`;

              // 送金すべきだが、前提が揃わない場合は保留登録
              const markPending = async (reason) => {
                try {
                  await PendingTransfer.updateOne(
                    { paymentIntentId: pi.id },
                    {
                      seller: item.ownerUser,
                      item: item._id,
                      amount: sellerAmount,
                      currency: item.currency,
                      paymentIntentId: pi.id,
                      transferGroup,
                      reason
                    },
                    { upsert: true }
                  );
                  console.warn('[transfer] pending queued:', { pi: pi.id, sellerAmount, reason });
                } catch (qe) {
                  console.error('[transfer] queue error:', qe?.message || qe);
                }
              };

              if (!seller || !seller.stripeAccountId) {
                await markPending('seller_no_stripe_account');
              } else if (sellerAmount <= 0) {
                await markPending('non_positive_amount');
              } else {
                // 送金可否（payouts_enabled）
                let canTransfer = true;
                try {
                  const acc = await stripe.accounts.retrieve(seller.stripeAccountId);
                  canTransfer = !!acc?.payouts_enabled;
                } catch (accErr) {
                  console.warn('[transfer] retrieve account failed', accErr?.raw?.message || accErr.message);
                }

                if (canTransfer) {
                  await stripe.transfers.create({
                    amount: sellerAmount,
                    currency: item.currency,
                    destination: seller.stripeAccountId,
                    transfer_group: transferGroup,
                  });
                  console.log('[transfer] success', {
                    pi: pi.id,
                    dest: seller.stripeAccountId,
                    amount: sellerAmount
                  });

                  // 念のため保留があれば削除（再入場対策）
                  await PendingTransfer.deleteOne({ paymentIntentId: pi.id }).catch(()=>{});
                } else {
                  await markPending('payouts_disabled');
                }
              }
            }
          }
        }
      } catch (tErr) {
        console.error('[transfer] error', tErr?.raw?.message || tErr.message, tErr?.raw || tErr);
        // 例外時も保留に入れておく（idempotent）
        try {
          const piId = (tErr?.payment_intent && tErr.payment_intent.id) || null;
          if (piId && itemId) {
            const item = await Item.findById(itemId);
            if (item) {
              const feePercent = Number(process.env.PLATFORM_FEE_PERCENT || 0);
              const fee = Math.floor(item.price * (feePercent / 100));
              const sellerAmount = item.price - fee;
              await PendingTransfer.updateOne(
                { paymentIntentId: piId },
                {
                  seller: item.ownerUser,
                  item: item._id,
                  amount: sellerAmount,
                  currency: item.currency,
                  paymentIntentId: piId,
                  transferGroup: `item_${item._id}`,
                  reason: 'exception'
                },
                { upsert: true }
              );
              console.warn('[transfer] pending queued by exception:', { pi: piId, sellerAmount });
            }
          }
        } catch (_) {}
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

// S3 から署名付きURLを発行してリダイレクト
if (!s3 || !item.s3Key) {
  // フォールバック：まだS3化していないレガシーアイテム向け（存在しない可能性あり）
  const abs = path.resolve(item.filePath || '');
  if (!fs.existsSync(abs)) return res.status(404).render('error', { message: 'ファイルが存在しません。' });
  res.setHeader('Content-Type', item.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.title)}${path.extname(abs) || ''}`);
  return fs.createReadStream(abs).pipe(res);
}

// 署名の有効期限（例：60秒）。必要なら環境変数で調整
const signedTtlSec = Number(process.env.S3_SIGNED_TTL_SEC || '60');

// ★ ビューページに <img> で埋め込むため、Content-Disposition は付けない（= inline）
const cmd = new GetObjectCommand({
  Bucket: S3_BUCKET,
  Key: item.s3Key
});
const signedUrl = await getSignedUrl(s3, cmd, { expiresIn: signedTtlSec });

// ★ 直接リダイレクトさせず、注意文付きのビューページを表示
return res.render('download-view', {
  imageUrl: signedUrl,
  item,
  expiresAt: doc.expiresAt,
  ttlMin: DOWNLOAD_TOKEN_TTL_MIN
});

// 補助: S3キーから拡張子取得
function extnameFromKey(key) {
  const m = /\.[a-z0-9]+$/i.exec(key);
  return m ? m[0] : '';
}

  } catch (e) {
    console.error(e);
    return res.status(500).render('error', { message: 'ダウンロード処理に失敗しました。' });
  }
});

// 404
app.use((req, res) => res.status(404).render('error', { message: 'ページが見つかりません。' }));

// === Legal pages (legacy path → 301 redirect) ===
app.get('/legal/tokushoho', (req, res) => res.redirect(301, '/tokushoho'));
app.get('/legal/terms',     (req, res) => res.redirect(301, '/terms'));
app.get('/legal/privacy',   (req, res) => res.redirect(301, '/privacy'));

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

// 画像ライセンスポリシー（AI対応）
app.get('/image-license', (req, res) => {
  res.locals.canonical = `${BASE_URL}/image-license`;
  res.render('legal/image-license');
});

// ★ ここからグローバルエラーハンドラ（ファイル容量/形式NGやその他の例外を拾う）
app.use((err, req, res, next) => {
  const isAjax = req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest';

  // Multerの代表的エラー（容量/形式）
  if (err && (err.name === 'MulterError' || /画像ファイルのみ|File too large/i.test(err.message || ''))) {
    if (isAjax) {
      return res.status(400).json({ ok: false, message: err.message || 'ファイルアップロードに失敗しました。' });
    }
    return res.status(400).render('error', { message: err.message || 'ファイルアップロードに失敗しました。' });
  }

  // それ以外
  console.error('[ERROR]', err);
  if (isAjax) {
    return res.status(500).json({ ok: false, message: 'サーバーエラーが発生しました。' });
  }
  return res.status(500).render('error', { message: 'サーバーエラーが発生しました。' });
});

// start
app.listen(PORT, () => {
  console.log(`Server running: ${BASE_URL}`);
});
