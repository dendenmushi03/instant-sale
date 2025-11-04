require('dotenv').config();
const path = require('path');

const cookieParser = require('cookie-parser');
const i18next = require('i18next');
const i18nextMiddleware = require('i18next-http-middleware');
const i18nextFsBackend = require('i18next-fs-backend');

const fs = require('fs');
const fsp = require('fs/promises');

const csurf = require('csurf'); // ★ 追加

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

const FileType = require('file-type'); // ★ 追加：実体MIME検査（CJSはfromFileを使う）

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

const ProcessedEvent = mongoose.models.ProcessedEvent || mongoose.model('ProcessedEvent', new mongoose.Schema({
  eventId: { type: String, unique: true, index: true },
  at: { type: Date, default: Date.now },
  expiresAt: { type: Date, default: () => new Date(Date.now() + 30*24*60*60*1000), index: { expires: '0s' } }
}));

// ─────────────────────────────────────────────
// 相対→絶対URL変換（正規化済み BASE_URL を使う版）
// ─────────────────────────────────────────────
const toAbs = (u) => {
  if (!u) return '';
  return /^https?:\/\//i.test(u) ? u : `${BASE_URL}${u.startsWith('/') ? '' : '/'}${u}`;
};

// 現在言語の取得（cookie → i18n → Accept-Language の順で決定）
function getLng(req) {
  return req.cookies?.i18next || req.i18n?.language || req.language || 'ja';
}

// 言語→数値ロケールの簡易マップ
function toNumberLocale(lng) {
  return (lng === 'en') ? 'en-US' : 'ja-JP';
}

// 出品時に選ばれた licensePreset を販売ページ表示用に整形
function licenseViewOf(item) {
  const key = item.licensePreset || 'standard';
  const map = {
    'editorial': {
      key, label: '商用不可',
      desc: '個人利用のみ可。用途例：SNSアイコン、個人ブログ、壁紙など'
    },
    'standard': {
      key, label: '商用可',
      desc: '用途例：SNS投稿、企業SNS、HP素材など'
    },
    'commercial-lite': {
      key, label: '一部商用可',
      desc: '用途例：同人誌・グッズ等の小規模販売（大量生産・ロゴ利用は不可）'
    },
    'exclusive': {
      key, label: '完全商用可',
      desc: '用途例：広告素材、パッケージ販売'
    }
  };
  return map[key] || map['standard'];
}

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

// http の公開URLは本番(https)で混在コンテンツになるため “非公開扱い” にする
const S3_PUBLIC_IS_HTTPS = /^https:\/\//i.test(S3_PUBLIC_BASE);

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

// ★ CSRF（webhook などは除外）
const csrfProtection = csurf({ cookie: false });
app.use((req, res, next) => {
  // Stripe Webhook は署名検証で守るため CSRF 適用外
  if (req.path.startsWith('/webhooks/stripe')) return next();
  return csrfProtection(req, res, next);
});

// EJS から <%= csrfToken %> を使えるように
app.use((req, res, next) => {
  try {
    res.locals.csrfToken = req.csrfToken ? req.csrfToken() : '';
  } catch (_) {
    res.locals.csrfToken = '';
  }
  next();
});

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

// ▼ i18n: 言語検出は Cookie 優先、辞書は /locales/{{lng}}/{{ns}}.json
app.use(cookieParser());

i18next
  .use(i18nextFsBackend)
  .use(i18nextMiddleware.LanguageDetector)
  .init({
    fallbackLng: 'ja',
    supportedLngs: ['ja','en'],
    preload: ['ja','en'],
    ns: ['common'],
    defaultNS: 'common',
    // ↓ 明示しておくと安心（デフォルトも '.' だが衝突を避けるため）
    keySeparator: '.',     // ドットで階層解釈
    nsSeparator: ':',      // 名前空間セパレータ（将来の多NS運用向け）
    backend: {
      loadPath: path.join(__dirname, 'locales/{{lng}}/{{ns}}.json'),
    },
    detection: {
      order: ['querystring','cookie','header'],
      lookupQuerystring: 'lng',
      lookupCookie: 'i18next',
      caches: ['cookie'],
      cookieSameSite: 'lax'
    },
    interpolation: { escapeValue: false },
  });

app.use(
  i18nextMiddleware.handle(i18next, {
    ignoreRoutes: ['/public/'],
    removeLngFromUrl: false
  })
);

// ★ 初回訪問時：ブラウザ言語を自動検出し、i18next クッキーを1年固定
app.use((req, res, next) => {
  if (!req.cookies.i18next) {
    const lang = req.acceptsLanguages('en', 'ja') || 'ja';
    res.cookie('i18next', lang, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: 'lax'
    });
    // i18next の言語にも反映
    req.i18n.changeLanguage(lang);
  }
  next();
});

// ★ EJS で使う共通変数（翻訳関数・現在言語・切替リンク）
app.use((req, res, next) => {
  const lng = req.language || req.i18n?.language || 'ja';
  res.locals.t   = req.t;
  res.locals.lng = lng;

  // 今のURL（クエリ・ハッシュ含む）を安全に付与
  const now = req.originalUrl || '/';
  const ret = encodeURIComponent(now);

  res.locals.langMenu = [
    { code: 'ja', label: '日本語', url: `/lang?lng=ja&return=${ret}`, active: lng === 'ja' },
    { code: 'en', label: 'English', url: `/lang?lng=en&return=${ret}`, active: lng === 'en' }
  ];
  next();
});

const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');

// Express の署名隠し
app.disable('x-powered-by');

app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  // HSTS（本番のみ強制）
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "script-src": [
        "'self'",
        (req, res) => `'nonce-${res.locals.cspNonce}'`,
        "https://js.stripe.com"
      ],
      "img-src": ["'self'", "data:", "blob:", "https:", "http:"],
      "connect-src": ["'self'", "https://api.stripe.com", "https://r.stripe.com"],
      "frame-src": ["'self'", "https://js.stripe.com", "https://hooks.stripe.com"],
      "style-src": ["'self'", "'unsafe-inline'"],
      // クリックジャッキング対策
      "frame-ancestors": ["'none'"],
      // plugin/object は使わない
      "object-src": ["'none'"]
    }
  },
  referrerPolicy: { policy: "no-referrer" },
  // 権限ポリシー（使わないものは拒否）
  permissionsPolicy: {
    features: {
      geolocation: ["()"], microphone: ["()"], camera: ["()"]
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

// ✅ /public だけを配信（キャッシュ付き）
app.use('/public', express.static(path.join(__dirname, 'public'), {
  maxAge: isProd ? '365d' : 0,
  immutable: !!isProd,
  etag: true,
  lastModified: true
}));

// ❌ /uploads は公開しない（原本は download ルートのみで配布）

// ★ 追加：/favicon.ico への直リンクをロゴで返す（簡易対応）
app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'logo.png'));
});

app.use('/previews', express.static(PREVIEW_DIR)); // OGP/プレビューを公開

app.use(['/previews'], (req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
});

// EJS で user を使えるように
app.use((req, res, next) => {
  res.locals.me = req.user || null;
  next();
});

// ★ いま表示中のパス（クエリ含む）を全テンプレートへ
app.use((req, res, next) => {
  res.locals.currentPath = req.originalUrl || '/';
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

// ★ リダイレクト先を厳格にバリデーション
function safeReturnUrl(input) {
  try {
    const s = String(input || '');
    if (!s.startsWith('/')) return '/';             // 絶対URL/相対パス拒否
    if (/^\/\/|https?:/i.test(s)) return '/';       // プロトコル相対/外部URL拒否
    if (/[<>"'\\]/.test(s)) return '/';             // 危険文字拒否
    return s;
  } catch { return '/'; }
}

app.get('/lang', (req, res) => {
  const nextLng = String(req.query.lng || '').toLowerCase();
  if (['ja','en'].includes(nextLng)) {
    res.cookie('i18next', nextLng, {
      httpOnly: false,
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60 * 1000
    });
    req.i18n.changeLanguage(nextLng);
  }

  const back = safeReturnUrl(req.query.return);
  if (back !== '/') return res.redirect(303, back);

  // Referer 保険（同一オリジンだけ）
  try {
    const ref = req.get('Referer');
    if (ref) {
      const u = new URL(ref);
      if (u.host === (req.headers['x-forwarded-host'] || req.headers.host)) {
        return res.redirect(303, u.pathname + (u.search || '') + (u.hash || ''));
      }
    }
  } catch (_) {}

  return res.redirect(303, '/');
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
  <url><loc>${BASE_URL}/image-license</loc></url>
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

// ★ 出品者用：Stripe Express ダッシュボード（売上/入金）へ遷移
app.get('/connect/portal', ensureAuthed, async (req, res) => {
  try {
    if (!stripe) {
      return res.status(500).render('error', { message: 'Stripeが未設定です（STRIPE_SECRET_KEY）。' });
    }

    // DBから最新ユーザーを取得（stripeAccountIdを確実に参照）
    const me = await User.findById(req.user._id);
    const accountId = me?.stripeAccountId;

    // まだ接続アカウントがない場合 → まずオンボーディングへ
    if (!accountId) {
      return res.redirect('/connect/onboard');
    }

    // 一時ログインリンクを発行（数十秒〜1分有効）
    const link = await stripe.accounts.createLoginLink(accountId, {
      redirect_url: `${BASE_URL}/creator`  // 閲覧後の戻り先
    });

    return res.redirect(link.url);
  } catch (err) {
    console.error('[connect/portal] failed:', err?.raw?.message || err.message);
    return res.status(500).render('error', {
      message: '売上ダッシュボードに遷移できませんでした。時間をおいて再度お試しください。'
    });
  }
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

res.render('upload', {
  baseUrl: BASE_URL,
  connect,
  legal: L,
  legalReady,
  isBiz,
  minPrice: MIN_PRICE,                    // ← 追加
  platformFeePct: PLATFORM_FEE_PERCENT   // ← 追加
});

});

// upload
app.post('/upload', ensureAuthed, upload.single('image'), async (req, res) => {
  try {

const {
  title, price, creatorName, creatorSecret, ownerEmail, attestOwner,
  licensePreset,            licenseNotes, aiGenerated, aiModelName
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

// ★ 実体MIME検査（画像以外は拒否）
const ft = await FileType.fromFile(req.file.path).catch(() => null);
const realMime = ft?.mime || '';
if (!/^image\/(png|jpe?g|webp|gif)$/i.test(realMime)) {
  await fsp.unlink(req.file.path).catch(() => {});
  return res.status(400).render('error', { message: '未対応のファイル形式です。PNG/JPEG/WEBP/GIF のみ対応。' });
}

    // ★ 原本も再エンコードして EXIF/メタデータを除去（配布時の位置情報漏洩を防ぐ）
    //    ここでは JPEG に統一（色変化を抑えたい場合は PNG 保存でも可）
    try {
      const cleaned = await sharp(req.file.path)
        .rotate()
        .jpeg({ quality: 95 }) // withMetadata() を付けない = EXIF除去
        .toBuffer();
      await fsp.writeFile(req.file.path, cleaned);
    } catch (re) {
      await fsp.unlink(req.file.path).catch(() => {});
      return res.status(400).render('error', { message: '画像の処理に失敗しました。別の画像でお試しください。' });
    }

    const priceNum = Number(price);
    
if (!title || !priceNum || priceNum < MIN_PRICE) {
  await fsp.unlink(req.file.path).catch(() => {});
  return res.status(400).render('error', { message: `タイトルと価格（${MIN_PRICE}以上）は必須です。` });
}

const licensePresetSafe = (['standard','editorial','commercial-lite','exclusive'].includes(licensePreset))
  ? licensePreset : 'standard';
const requireCreditBool = false; // ← プラットフォーム方針：常に不要
const aiGeneratedBool   = !!aiGenerated;
const licenseNotesSafe  = (licenseNotes || '').trim().slice(0, 1000);
const aiModelNameSafe   = (aiModelName || '').trim().slice(0, 200);

    const slug = nanoid(10);
    // ★ 配布原本は JPEG 化したので MIME も固定
    const mimeType = 'image/jpeg';

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
  requireCredit: false, 
  licenseNotes:  licenseNotesSafe,
  aiGenerated:   aiGeneratedBool,
  aiModelName:   aiModelNameSafe,
});

const saleUrl = `${BASE_URL}/s/${item.slug}`;
if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
  return res.json({ ok: true, createdUrl: saleUrl });
}

// ← ここから追加：成功後に再描画する upload 画面にも必要情報を渡す
const connectNow  = await getConnectStatus(req.user);
const meAfter     = await User.findById(req.user._id).lean();
const LAfter      = meAfter?.legal || {};
const isBizAfter  = false;     // 本サービスは個人専用運用
const legalReadyA = true;

return res.render('upload', {
  baseUrl: BASE_URL,
  connect: connectNow,
  legal: LAfter,
  legalReady: legalReadyA,
  isBiz: isBizAfter,
  createdUrl: saleUrl,
  minPrice: MIN_PRICE,                   // ← 追加
  platformFeePct: PLATFORM_FEE_PERCENT  // ← 追加
});

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

// https の公開URLで配信できる場合のみローカルを削除。
// http 公開URLは混在コンテンツで弾かれるためローカルを残す。
if (S3_PUBLIC_IS_HTTPS) {
  await fsp.unlink(previewFull).catch(()=>{});
  await fsp.unlink(stripeFull).catch(()=>{});
  await fsp.unlink(fullPath).catch(()=>{});
}

const previewUrl = S3_PUBLIC_IS_HTTPS
  ? `${S3_PUBLIC_BASE}/${s3KeyPreview}`
  : `/previews/${previewName}`; // http公開URLや未設定時はローカルを使う

const fullUrl = S3_PUBLIC_IS_HTTPS
  ? `${S3_PUBLIC_BASE}/${s3KeyFull}`
  : previewUrl;

// DB には S3 の「原本キー」と「公開URL（プレビュー）」を保存
const item = await Item.create({
  slug,
  title,
  price: priceNum,
  currency: (CURRENCY).toLowerCase(),

  // 原本キーはダウンロード時の署名URL発行に必要
  s3Key: s3KeyOriginal,

  // 画像表示・OGP用には S3 の公開URLを保存（ローカル /previews は保存しない）
  previewPath: previewUrl,

// S3運用ではローカル原本は捨てるため空にしておく（将来の誤参照防止）
filePath: '',

  mimeType,
  creatorName: creatorName || '',
  ownerUser: req.user?._id || null,
  createdBySecret: creatorSecret || '',
  ownerEmail: (req.user?.email || ownerEmail || ''),
  attestOwner: !!attestOwner,
  uploaderIp: req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || '',

  // ライセンス情報
  licensePreset: licensePresetSafe,
  requireCredit: false,
  licenseNotes:  licenseNotesSafe,
  aiGenerated:   aiGeneratedBool,
  aiModelName:   aiModelNameSafe,
});

const saleUrl = `${BASE_URL}/s/${item.slug}`;
if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
  return res.json({ ok: true, createdUrl: saleUrl });
}

// ← ここから追加：成功後に再描画する upload 画面にも必要情報を渡す
const connectNow  = await getConnectStatus(req.user);
const meAfter     = await User.findById(req.user._id).lean();
const LAfter      = meAfter?.legal || {};
const isBizAfter  = false;     // 本サービスは個人専用運用
const legalReadyA = true;

return res.render('upload', {
  baseUrl: BASE_URL,
  connect: connectNow,
  legal: LAfter,
  legalReady: legalReadyA,
  isBiz: isBizAfter,
  createdUrl: saleUrl,
  minPrice: MIN_PRICE,                   // ← 追加
  platformFeePct: PLATFORM_FEE_PERCENT  // ← 追加
});

} catch (e) {
  console.error(e);
  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.status(500).json({ ok: false, message: e?.message || 'アップロードに失敗しました。' });
  }
  return res.status(500).render('error', { message: 'アップロードに失敗しました。' });
}

});

// /s/:slug（販売ページ）— 必要な値をすべてサーバ側で用意して渡す
app.get('/s/:slug', async (req, res) => {
  try {
    const { slug } = req.params;

    // 商品を軽量に取得
    const item = await Item.findOne({ slug, isDeleted: { $ne: true } })
      .select('slug title price currency creatorName previewPath licensePreset licenseNotes aiGenerated aiModelName ownerUser s3Key filePath')
      .lean();

    if (!item) {
      return res.status(404).render('error', { message: '販売ページが見つかりません。' });
    }

    // 販売者情報（必要最小限）
    let seller = null;
    let sellerLegal = null;
    if (item.ownerUser) {
      seller = await User.findById(item.ownerUser)
        .select('name email legal stripeAccountId payoutsEnabled')
        .lean();
      sellerLegal = seller?.legal || null;
    }

    // オーナー本人が閲覧している時だけ Connect 状態を厳密に表示
    let connect = { hasAccount: true, payoutsEnabled: true }; // 公開閲覧時は常にOKで扱う
    if (req.user && seller && String(req.user._id) === String(item.ownerUser)) {
      const st = await getConnectStatus(req.user);
      connect = { hasAccount: !!st.hasAccount, payoutsEnabled: !!st.payoutsEnabled };
    }

    // 言語・ロケール
    const lng = getLng(req);
    const numLocale = toNumberLocale(lng);

    // 画像URL（絶対化 & フォールバック）
    const absPreview = (() => {
      const p = item.previewPath || `/previews/${item.slug}-preview.jpg`;
      return /^https?:\/\//i.test(p) ? p : `${BASE_URL}${p.startsWith('/') ? '' : '/'}${p}`;
    })();

    // OGP
    const og = {
      title: `${item.title} | ${req.t('brand')}`,
      desc : lng === 'en'
        ? `Buy high-resolution now (${Number(item.price).toLocaleString('en-US',{style:'currency',currency:(item.currency||'jpy').toUpperCase()})}).`
        : `高解像度を今すぐ購入（¥${Number(item.price).toLocaleString(numLocale)}）`,
      image: absPreview,
      url  : `${BASE_URL}/s/${item.slug}`
    };

    // 特商法ページURL（販売者別ページがあればクエリで識別）
    const tokushohoUrl = `/tokushoho${seller?._id ? `?seller=${seller._id}` : ''}`;

    // ライセンス表示
    const licenseView = licenseViewOf(item);

// ページに CSRF トークンが含まれるので第三者キャッシュは禁止
res.set('Cache-Control', 'private, max-age=60');
// 必要なら完全に避けたい場合は： res.set('Cache-Control', 'no-store');

    return res.render('sale', {
      baseUrl: BASE_URL,
      item,
      seller,
      sellerLegal,
      connect,
      tokushohoUrl,
      og,
      licenseView,
      lng
      // t, cspNonce は res.locals からそのまま使える
    });
  } catch (e) {
    console.error('[sale] route error:', e);
    return res.status(500).render('error', { message: '販売ページの表示に失敗しました。' });
  }
});

// /view/:slug（R2/CDN の透かし済み "full" を最優先で返す）
app.get('/view/:slug', async (req, res) => {
  try {
    const { slug } = req.params;
    const item = await Item.findOne({ slug }).lean();
    if (!item) return res.status(404).send('Not found');

    // 1) CDN（HTTPS）を最優先：/previews/<slug>-full.jpg
    if (S3_PUBLIC_IS_HTTPS && S3_PUBLIC_BASE) {
      const cdnFull = `${S3_PUBLIC_BASE}/previews/${slug}-full.jpg`;
      // 画像タグは 302 を普通に辿るためリダイレクトで十分
      return res.redirect(302, cdnFull);
    }

    // 2) 次善：ローカルの等倍フル（開発/フォールバック用）
    const localFull = path.join(PREVIEW_DIR, `${slug}-full.jpg`);
    if (fs.existsSync(localFull)) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return fs.createReadStream(localFull).pipe(res);
    }

    // 3) 最後の保険：CDN のプレビュー、またはローカルのプレビュー
    if (S3_PUBLIC_IS_HTTPS && S3_PUBLIC_BASE) {
      const cdnPreview = `${S3_PUBLIC_BASE}/previews/${slug}-preview.jpg`;
      return res.redirect(302, cdnPreview);
    }
    const localPreview = path.join(PREVIEW_DIR, `${slug}-preview.jpg`);
    if (fs.existsSync(localPreview)) {
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      return fs.createReadStream(localPreview).pipe(res);
    }

    return res.status(404).send('source image missing');
  } catch (e) {
    console.error('[view]', e);
    return res.status(500).send('viewer error');
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

// S3_PUBLIC_BASE が無い構成（＝ローカル /previews 配信）なら、Stripe用 1200x630 を優先
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

// 303 フォールバック（CSPに合わせてインラインJSを排除）
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

    // ★ リプレイ防止：同じ event.id を一度しか処理しない
    try {
      await ProcessedEvent.create({ eventId: event.id });
    } catch (dup) {
      // 既に登録済みなら無視して200を返す（idempotent）
      return res.json({ received: true, duplicate: true });
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

return res.render('success', {
  item, downloadUrl, expiresAt: doc.expiresAt, ttlMin: DOWNLOAD_TOKEN_TTL_MIN,
  lng: getLng(req)
});

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

if (!s3 || !item.s3Key) {
  // フォールバック：まだS3化していないレガシーアイテム向け
  const absRaw = (item.filePath || '').trim();
  const hasLocalFile = !!absRaw &&
    fs.existsSync(absRaw) &&
    (() => { try { return fs.statSync(absRaw).isFile(); } catch { return false; } })();

  if (!hasLocalFile) {
    return res.status(404).render('error', { message: 'ファイルが存在しません。' });
  }
  res.setHeader('Content-Type', item.mimeType || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(item.title)}${path.extname(absRaw) || ''}`);
  return fs.createReadStream(absRaw).pipe(res);
}

// 署名の有効期限（例：60秒）。必要なら環境変数で調整
const signedTtlSec = Number(process.env.S3_SIGNED_TTL_SEC || '60');

// ★ ビューページに <img> で埋め込むため、Content-Disposition は付けない（= inline）
const cmd = new GetObjectCommand({
  Bucket: S3_BUCKET,
  Key: item.s3Key
});
const signedUrl = await getSignedUrl(s3, cmd, { expiresIn: signedTtlSec });

return res.render('download-view', {
  imageUrl: signedUrl,
  item,
  expiresAt: doc.expiresAt,
  ttlMin: DOWNLOAD_TOKEN_TTL_MIN,
  lng: getLng(req)
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

// === Legal pages (legacy path → 301 redirect) ===
app.get('/legal/tokushoho', (req, res) => res.redirect(301, '/tokushoho'));
app.get('/legal/terms',     (req, res) => res.redirect(301, '/terms'));
app.get('/legal/privacy',   (req, res) => res.redirect(301, '/privacy'));

// ▼▼▼ 販売者ごとの特商法表示ページ ▼▼▼
app.get('/legal/seller/:userId', async (req, res) => { /* ... */ });

app.get(
  ['/image-license', '/image-license/', '/legal/image-license', '/image_license'],
  (req, res) => {
    res.locals.canonical = `${BASE_URL}/image-license`;
    const lng = getLng(req);
    res.render('legal/image-license', { lng });  // ← ★ 追加
  }
);

// ★★★ ここで初めて404を置く（この下に新規ルートを足さない）★★★
app.use((req, res) => res.status(404).render('error', { message: 'ページが見つかりません。' }));

// ★ 管理者用：レガシー previewPath(http外部URL) をローカル /previews に補正
// 実行: curl -XPOST -H "Authorization: Bearer $ADMIN_TOKEN" https://<host>/admin/fix-legacy-previews
app.post('/admin/fix-legacy-previews', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!process.env.ADMIN_TOKEN || token !== process.env.ADMIN_TOKEN) {
      return res.status(403).json({ ok: false, error: 'forbidden' });
    }
    const items = await Item.find({ previewPath: /^http:\/\//i }).lean();
    let fixed = 0;
    for (const it of items) {
      const prev = path.join(PREVIEW_DIR, `${it.slug}-preview.jpg`);
      const full = path.join(PREVIEW_DIR, `${it.slug}-full.jpg`);
      const stripe = path.join(PREVIEW_DIR, `${it.slug}-stripe.jpg`);
      const hasLocal = [prev, full, stripe].some(p => fs.existsSync(p));
      if (hasLocal) {
        await Item.updateOne({ _id: it._id }, { previewPath: `/previews/${path.basename(prev)}` });
        fixed++;
      }
    }
    return res.json({ ok: true, count: items.length, fixed });
  } catch (e) {
    console.error('[fix-legacy-previews]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

// ★ ここからグローバルエラーハンドラ（ファイル容量/形式NGやその他の例外を拾う）
app.use((err, req, res, next) => {
  const isAjax = req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest';

  // CSRF 不一致（期限切れ・キャッシュ済みトークン等）
  if (err && (err.code === 'EBADCSRFTOKEN' || /csrf/i.test(err.message || ''))) {
    const msg = 'フォームの有効期限が切れました。ページを再読み込みしてからもう一度お試しください。';
    if (isAjax) return res.status(403).json({ ok: false, message: 'invalid_csrf_token' });
    return res.status(403).render('error', { message: msg });
  }

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
