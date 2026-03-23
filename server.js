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
const MongoStore = require('connect-mongo');
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;

const Item = require('./models/Item');
const DownloadToken = require('./models/DownloadToken');
const User = require('./models/User');

const PendingTransfer = require('./models/PendingTransfer');
const {
  PLATFORM_FEE_DISPLAY,
  PLATFORM_FEE_DISPLAY_EN,
  calculateRevenueSplit,
} = require('./utils/revenue');

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
// 最低価格（本番仕様固定）
const MIN_PRICE = 100;
if (process.env.MIN_PRICE && Number(process.env.MIN_PRICE) != MIN_PRICE) {
  console.warn(`[WARN] MIN_PRICE=${process.env.MIN_PRICE} は無視されます（固定 ${MIN_PRICE}円）`);
}

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

function normalizeLng(input) {
  const value = String(input || '').toLowerCase();
  if (value.startsWith('en')) return 'en';
  return 'ja';
}

// 現在言語の取得（cookie 優先。古い querystring で上書きさせない）
function getLng(req) {
  const fromCookie = req.cookies?.i18next;
  const fromQuery = req.query?.lng;
  const fromI18n = req.i18n?.resolvedLanguage || req.i18n?.language || req.language;
  return normalizeLng(fromCookie || fromQuery || fromI18n || 'ja');
}

// 言語→数値ロケールの簡易マップ
function toNumberLocale(lng) {
  return (lng === 'en') ? 'en-US' : 'ja-JP';
}

function isXInAppBrowser(userAgent = '') {
  if (!userAgent || typeof userAgent !== 'string') return false;
  const ua = userAgent.toLowerCase();
  const hasXToken = ua.includes('x.com') || ua.includes('twitter');
  const hasInAppToken = ua.includes('twitter for') || ua.includes('twitterandroid') || ua.includes('twitterios');
  return hasXToken && hasInAppToken;
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

function saleUrlFor(item) {
  return `${BASE_URL}/s/${item.slug}`;
}

function dashboardPreviewPath(item) {
  return item.previewPath || `/previews/${item.slug}-preview.jpg`;
}

function dashboardItemView(item) {
  return {
    ...item,
    previewPath: dashboardPreviewPath(item),
    saleUrl: saleUrlFor(item)
  };
}

function pickEditableItemFields(body = {}) {
  const next = {};

  if (typeof body.title === 'string') {
    next.title = body.title.trim().slice(0, 120);
  }

  if (typeof body.price !== 'undefined') {
    const priceNum = Number(body.price);
    if (!Number.isFinite(priceNum) || !Number.isInteger(priceNum) || priceNum < MIN_PRICE) {
      throw new Error(`価格は${MIN_PRICE}円以上の整数で入力してください。`);
    }
    next.price = priceNum;
  }

  if (!next.title) {
    throw new Error('タイトルは必須です。');
  }

  return next;
}

async function findOwnedItem(itemId, userId) {
  if (!mongoose.Types.ObjectId.isValid(String(itemId))) return null;
  const item = await Item.findOne({ _id: itemId, ownerUser: userId, isDeleted: { $ne: true } }).lean();
  return item;
}

const CREATOR_SECRET = process.env.CREATOR_SECRET || 'changeme';
const DOWNLOAD_TOKEN_TTL_MIN = Number(process.env.DOWNLOAD_TOKEN_TTL_MIN || '120');
const SESSION_SECRET = process.env.SESSION_SECRET || 'change_me';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || '';
const USE_STRIPE_CONNECT = process.env.USE_STRIPE_CONNECT === 'true';
// 業種(MCC) と 商品説明の既定値（必要なら .env で上書き）
const DEFAULT_MCC  = process.env.DEFAULT_MCC || '5399'; // Misc. General Merchandise
const DEFAULT_PRODUCT_DESC =
  process.env.DEFAULT_PRODUCT_DESC || 'デジタルコンテンツの即時販売（個人間）';


const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;

const DAYS_180_MS = 1000 * 60 * 60 * 24 * 180;
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

const sessionStore = MongoStore.create({
  mongoUrl: MONGODB_URI,
  ttl: SESSION_TTL_SECONDS,
  autoRemove: 'native',
  touchAfter: 24 * 3600,
});

function calcRevenueSplit(grossAmount) {
  return calculateRevenueSplit(grossAmount);
}

function isExpiredPending(pending, now = new Date()) {
  return new Date(pending.expiresAt).getTime() <= now.getTime();
}

async function expirePendingTransferById(pendingId, reason, now = new Date()) {
  await PendingTransfer.updateOne(
    { _id: pendingId, status: 'queued' },
    {
      $set: {
        status: 'expired',
        expiredAt: now,
        expirationReason: reason,
        updatedAt: now
      }
    }
  );
}

async function getTransferEligibility(stripeAccountId) {
  if (!stripeAccountId) return { canTransfer: false, payoutsEnabled: false, transfersActive: false };
  try {
    const acc = await stripe.accounts.retrieve(stripeAccountId);
    const payoutsEnabled = !!acc?.payouts_enabled;
    const transfersActive = acc?.capabilities?.transfers === 'active';
    return { canTransfer: payoutsEnabled && transfersActive, payoutsEnabled, transfersActive };
  } catch (e) {
    return { canTransfer: false, payoutsEnabled: false, transfersActive: false, error: e };
  }
}

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
  store: sessionStore,
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

// ★★★ ここで先に parsers を通す（← 重要！）★★★
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());

// ★ CSRF（/webhooks/stripe と /logout は除外）
const csrfProtection = csurf({ cookie: false });
app.use((req, res, next) => {
  if (req.path.startsWith('/webhooks/stripe')) return next();
  if (req.path === '/logout') return next(); // ← 例外
  return csrfProtection(req, res, next);
});

// EJS から <%= csrfToken %> を使えるように
app.use((req, res, next) => {
  try {
    if (typeof req.csrfToken === 'function') {
      res.locals.csrfToken = req.csrfToken();
    } else {
      res.locals.csrfToken = '';
    }
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

// ▼ OGP共通デフォルト（アクセスされたホストで固定）
// 逆プロキシ配下でも https を優先して推定
app.use((req, res, next) => {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const ORIGIN = `${proto}://${host}`;

  res.locals.og = {
    title: 'Instant Sale | 生成画像を3ステップで即販売',
    desc : 'AIクリエイター向け。画像をアップロード → 価格入力 → 販売リンク完成。Stripeで安全決済・自動ダウンロード。',
    url  : `${ORIGIN}${req.originalUrl || '/'}`,
    image: `${ORIGIN}/public/og/instantsale_ogp.jpg` // ← ここが重要：投稿されたドメインで返す
  };
  next();
});

// ★ 各リクエスト毎に CSP nonce
app.use((req, res, next) => {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
});

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
      order: ['cookie','querystring'],
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

// ★ 初回訪問時：常に日本語を既定として i18next クッキーを1年固定
app.use((req, res, next) => {
  if (!req.cookies.i18next) {
    const lang = 'ja';
    res.cookie('i18next', lang, {
      maxAge: 365 * 24 * 60 * 60 * 1000,
      httpOnly: false,
      sameSite: 'lax'
    });

    // i18next の言語にも反映（req.i18n があるときだけ）
    if (req.i18n && typeof req.i18n.changeLanguage === 'function') {
      try {
        req.i18n.changeLanguage(lang);
      } catch (e) {
        console.error('[lang auto-detect] changeLanguage failed:', e);
      }
    }
  }
  next();
});

// ★ EJS で使う共通変数（翻訳関数・現在言語・切替リンク）
app.use((req, res, next) => {
  const lng = getLng(req);
  res.locals.t   = (key, options = {}) => req.t(key, { lng, ...options });
  res.locals.lng = lng;

  // 今のURL（クエリ・ハッシュ含む）から lng だけ除去して return に付与
  const now = stripLngParamFromPath(req.originalUrl || '/');
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
  hsts: isProd ? { maxAge: 31536000, includeSubDomains: true, preload: false } : false,
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      "default-src": ["'self'"],
      "base-uri": ["'self'"],                             // ★ 追加
      "form-action": ["'self'", "https://checkout.stripe.com"], // ★ 追加（将来の埋め込み/POST遷移を許可）
      "script-src": [
        "'self'",
        (req, res) => `'nonce-${res.locals.cspNonce}'`,
        "https://js.stripe.com"
      ],
      "img-src": ["'self'", "data:", "blob:", "https:", "http:"],
      "connect-src": ["'self'", "https://api.stripe.com", "https://r.stripe.com"],
      "frame-src": [
        "'self'",
        "https://js.stripe.com",
        "https://hooks.stripe.com",
        "https://checkout.stripe.com"                    // ★ 追加（Embedded Checkout等の将来互換）
      ],
      "style-src": ["'self'", "'unsafe-inline'"],
      "frame-ancestors": ["'none'"],
      "object-src": ["'none'"]
    }
  },
  referrerPolicy: { policy: "no-referrer" },
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

  // ★ X/Twitter・Facebook・Slack 等のカード取得ボットは 301 を回避
  const ua = String(req.headers['user-agent'] || '');
  const isCardBot = /(Twitterbot|facebookexternalhit|Slackbot|Discordbot|LinkedInBot)/i.test(ua);

  if (!isCardBot && host && host !== CANON_HOST) {
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

function maskStripeAccountId(accountId) {
  if (!accountId) return null;
  const value = String(accountId);
  if (value.length <= 10) return value;
  return `${value.slice(0, 8)}...${value.slice(-4)}`;
}

const ensureAuthed = (req, res, next) => {
  if (req.user) return next();
  // ★ AJAX から来た場合は JSON 返却にする（フロントがアラート表示→/login遷移）
  if (req.xhr || req.headers['x-requested-with'] === 'XMLHttpRequest') {
    return res.status(401).json({ ok: false, message: 'login_required' });
  }
  return res.redirect('/login');
};


function getSellerProfileCompletion(user) {
  const profile = user?.sellerProfile || {};
  const businessType = profile.businessType;
  const commonReady = !!(
    businessType &&
    profile.creatorDisplayName &&
    /^\d{7}$/.test(profile.postalCode || '') &&
    profile.address &&
    /^\d{10,11}$/.test(profile.phoneNumber || '')
  );

  if (businessType === 'sole_proprietor') {
    return !!(commonReady && profile.legalName);
  }

  if (businessType === 'corporation') {
    return !!(commonReady && profile.legalName && profile.representativeName);
  }

  return false;
}

function sanitizeSellerProfileInput(body = {}) {
  const normalize = (value, max) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
  const normalizePostal = (value) => String(value || '').replace(/-/g, '').replace(/\D/g, '').slice(0, 7);
  const normalizePhone = (value) => String(value || '').replace(/-/g, '').replace(/\D/g, '').slice(0, 11);
  const normalizeBusinessType = (value) => String(value || '').trim();

  const businessType = normalizeBusinessType(body.businessType);
  return {
    businessType,
    creatorDisplayName: normalize(body.creatorDisplayName, 120),
    legalName: normalize(body.legalName, 120),
    representativeName: businessType === 'corporation' ? normalize(body.representativeName, 120) : '',
    postalCode: normalizePostal(body.postalCode),
    address: normalize(body.address, 240),
    phoneNumber: normalizePhone(body.phoneNumber),
  };
}

function validateSellerProfileInput(input = {}) {
  const errors = {};

  if (!['sole_proprietor', 'corporation'].includes(input.businessType)) {
    errors.businessType = '事業種別を選択してください';
  }

  if (!input.creatorDisplayName) {
    errors.creatorDisplayName = 'クリエイター名を入力してください';
  } else if (input.creatorDisplayName.length > 120) {
    errors.creatorDisplayName = 'クリエイター名は120文字以内で入力してください';
  }

  if (!input.legalName) {
    errors.legalName = input.businessType === 'corporation'
      ? '法人名を入力してください'
      : '法定名義を入力してください';
  } else if (input.legalName.length > 120) {
    errors.legalName = input.businessType === 'corporation'
      ? '法人名は120文字以内で入力してください'
      : '法定名義は120文字以内で入力してください';
  }

  if (input.businessType === 'corporation') {
    if (!input.representativeName) {
      errors.representativeName = '代表者名または通信販売責任者名を入力してください';
    } else if (input.representativeName.length > 120) {
      errors.representativeName = '代表者名または通信販売責任者名は120文字以内で入力してください';
    }
  }

  if (!input.postalCode) {
    errors.postalCode = '郵便番号を入力してください';
  } else if (!/^\d{7}$/.test(input.postalCode)) {
    errors.postalCode = '郵便番号は半角数字7桁で入力してください';
  }

  if (!input.address) errors.address = '住所を入力してください';
  else if (input.address.length > 240) errors.address = '住所は240文字以内で入力してください';

  if (!input.phoneNumber) {
    errors.phoneNumber = '電話番号を入力してください';
  } else if (!/^\d+$/.test(input.phoneNumber)) {
    errors.phoneNumber = '電話番号はハイフンなしの半角数字で入力してください';
  } else if (input.phoneNumber.length < 10 || input.phoneNumber.length > 11) {
    errors.phoneNumber = '電話番号はハイフンなしの半角数字で入力してください';
  }

  return errors;
}

function sanitizeReturnPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/')) return '/creator';
  if (value.startsWith('//')) return '/creator';

  const parsed = new URL(value, BASE_URL);
  const pathname = parsed.pathname || '/creator';
  const allowedPrefixes = ['/creator', '/dashboard'];
  const isAllowed = allowedPrefixes.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));

  if (!isAllowed) return '/creator';
  return `${pathname}${parsed.search}${parsed.hash}`;
}

function withQueryParam(pathname, key, value) {
  const safePath = sanitizeReturnPath(pathname);
  const base = new URL(safePath, BASE_URL);
  base.searchParams.set(key, value);
  return `${base.pathname}${base.search}${base.hash}`;
}

function buildSellerProfilePath(returnTo, extraParams = {}) {
  const safeReturnTo = sanitizeReturnPath(returnTo);
  const base = new URL('/creator/seller-profile', BASE_URL);
  base.searchParams.set('returnTo', safeReturnTo);

  Object.entries(extraParams).forEach(([key, value]) => {
    if (typeof value === 'undefined' || value === null || value === '') return;
    base.searchParams.set(key, String(value));
  });

  return `${base.pathname}${base.search}${base.hash}`;
}

function resolveSellerProfileBackPath(returnTo, sellerProfileCompleted) {
  const safeReturnTo = sanitizeReturnPath(returnTo);
  if (sellerProfileCompleted) return safeReturnTo;
  if (safeReturnTo === '/dashboard' || safeReturnTo.startsWith('/dashboard?')) return safeReturnTo;
  return '/dashboard';
}

async function ensureSellerProfileCompleted(req, res, next) {
  try {
    if (!req.user?._id) return res.redirect('/login');
    const me = await User.findById(req.user._id).select('sellerProfile').lean();
    if (getSellerProfileCompletion(me)) return next();

    return res.redirect(buildSellerProfilePath(req.originalUrl || '/creator'));
  } catch (e) {
    console.error('[sellerProfile:guard]', e);
    return res.status(500).render('error', { message: '販売者情報の確認に失敗しました。' });
  }
}

async function getOwnedItemSummary(userId) {
  const ownerObjectId = new mongoose.Types.ObjectId(String(userId));
  const [items, totalCount] = await Promise.all([
    Item.find({ ownerUser: ownerObjectId, isDeleted: { $ne: true } })
      .sort({ createdAt: -1, _id: -1 })
      .select('slug title price currency creatorName previewPath ownerUser createdAt updatedAt')
      .lean(),
    Item.countDocuments({ ownerUser: ownerObjectId, isDeleted: { $ne: true } })
  ]);

  return {
    items: items.map(dashboardItemView),
    totalCount
  };
}

function dashboardBaseView(req, extra = {}) {
  const lng = getLng(req);
  const locale = toNumberLocale(lng);
  return {
    baseUrl: BASE_URL,
    lng,
    locale,
    minPrice: MIN_PRICE,
    editableFields: ['title', 'price'],
    nonEditableFields: ['previewPath', 'filePath', 's3Key', 'licensePreset', 'licenseNotes', 'requireCredit', 'mimeType'],
    ...extra
  };
}

function sellerProfileFormValues(profile = {}) {
  return {
    businessType: profile.businessType || '',
    creatorDisplayName: profile.creatorDisplayName || '',
    legalName: profile.legalName || '',
    representativeName: profile.representativeName || '',
    postalCode: profile.postalCode || '',
    address: profile.address || '',
    phoneNumber: profile.phoneNumber || ''
  };
}

async function saveSellerProfile(userId, formValues) {
  const now = new Date();
  const completedProfile = {
    ...formValues,
    updatedAt: now
  };
  const isCompleted = getSellerProfileCompletion({ sellerProfile: completedProfile });

  await User.updateOne(
    { _id: userId },
    {
      $set: {
        'sellerProfile.businessType': formValues.businessType,
        'sellerProfile.creatorDisplayName': formValues.creatorDisplayName,
        'sellerProfile.legalName': formValues.legalName,
        'sellerProfile.representativeName': formValues.representativeName,
        'sellerProfile.postalCode': formValues.postalCode,
        'sellerProfile.address': formValues.address,
        'sellerProfile.phoneNumber': formValues.phoneNumber,
        'sellerProfile.isCompleted': isCompleted,
        'sellerProfile.updatedAt': now
      }
    }
  );

  console.info('[sellerProfile:saved]', {
    userId: String(userId),
    completed: isCompleted,
    updatedAt: now.toISOString()
  });

  return { isCompleted, updatedAt: now };
}

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

async function processQueuedPendingTransfersForSeller({ sellerId, stripeAccountId }) {
  const now = new Date();
  const pendings = await PendingTransfer.find({ seller: sellerId, status: 'queued' }).lean();
  const results = [];

  for (const p of pendings) {
    if (isExpiredPending(p, now)) {
      await expirePendingTransferById(p._id, 'expired_after_180_days', now);
      results.push({ id: p._id, status: 'expired' });
      continue;
    }

    const latest = await PendingTransfer.findOne({ _id: p._id, status: 'queued' }).lean();
    if (!latest) {
      results.push({ id: p._id, status: 'skip_not_queued' });
      continue;
    }

    const revenueSplit = calcRevenueSplit(latest.grossAmount);
    if (revenueSplit.sellerAmount <= 0) {
      await PendingTransfer.updateOne(
        { _id: latest._id, status: 'queued' },
        {
          $set: {
            amount: revenueSplit.sellerAmount,
            platformFeeAmount: revenueSplit.platformFeeAmount,
            reason: 'non_positive_amount',
            updatedAt: now
          }
        }
      );
      results.push({ id: latest._id, status: 'non_positive_amount' });
      continue;
    }

    try {
      const tr = await stripe.transfers.create({
        amount: revenueSplit.sellerAmount,
        currency: latest.currency,
        destination: stripeAccountId,
        transfer_group: latest.transferGroup || undefined
      }, {
        idempotencyKey: `pending_transfer_${latest.paymentIntentId}`
      });

      const updated = await PendingTransfer.updateOne(
        { _id: latest._id, status: 'queued' },
        {
          $set: {
            amount: revenueSplit.sellerAmount,
            platformFeeAmount: revenueSplit.platformFeeAmount,
            status: 'transferred',
            transferId: tr.id,
            transferredAt: new Date(),
            updatedAt: new Date(),
            reason: latest.reason || 'queued_then_transferred'
          }
        }
      );

      if (updated.modifiedCount === 1) {
        results.push({ id: latest._id, status: 'transferred', transferId: tr.id, amount: revenueSplit.sellerAmount });
      } else {
        results.push({ id: latest._id, status: 'skip_race_condition' });
      }
    } catch (e) {
      results.push({ id: latest._id, status: 'error', error: e?.raw?.message || e.message });
    }
  }

  return results;
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

app.get('/', (req, res) => {
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host  = req.headers['x-forwarded-host'] || req.headers.host;
  const ORIGIN = `${proto}://${host}`;

  const og = {
    title: 'Instant Sale | 生成画像で収益発生',
    desc : 'AIで作った一枚を、3ステップで即販売。Stripe決済＆自動ダウンロードで安心・手軽。',
    url  : `${ORIGIN}/`,
    image: `${ORIGIN}/public/og/instantsale_ogp.jpg`
  };
  res.render('home', { baseUrl: ORIGIN, og }); // baseUrl も合わせて渡す
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

function stripLngParamFromPath(input) {
  const safe = safeReturnUrl(input);
  if (safe === '/') return '/';
  try {
    const u = new URL(safe, 'http://localhost');
    u.searchParams.delete('lng');
    const q = u.searchParams.toString();
    return `${u.pathname}${q ? `?${q}` : ''}${u.hash || ''}` || '/';
  } catch {
    return '/';
  }
}

app.get('/lang', (req, res) => {
  const nextLng = String(req.query.lng || '').toLowerCase();
  if (['ja','en'].includes(nextLng)) {
    res.cookie('i18next', nextLng, {
      httpOnly: false,
      sameSite: 'lax',
      maxAge: 365 * 24 * 60 * 60 * 1000
    });

    // i18n インスタンスがあるときだけ安全に呼ぶ
    if (req.i18n && typeof req.i18n.changeLanguage === 'function') {
      try {
        req.i18n.changeLanguage(nextLng);
      } catch (e) {
        console.error('[lang] changeLanguage failed:', e);
      }
    }
  }

  const back = stripLngParamFromPath(req.query.return);
  if (back !== '/') return res.redirect(303, back);

  // Referer 保険（同一オリジンだけ）
  try {
    const ref = req.get('Referer');
    if (ref) {
      const u = new URL(ref);
      if (u.host === (req.headers['x-forwarded-host'] || req.headers.host)) {
        return res.redirect(303, stripLngParamFromPath(u.pathname + (u.search || '') + (u.hash || '')));
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
app.get('/auth/sign-in', (req, res) => {
  if (req.user) return res.redirect('/creator');
  const ua = req.get('user-agent') || '';
  res.render('auth-sign-in', {
    canonical: `${BASE_URL}/auth/sign-in`,
    robots: 'noindex,follow',
    isXInAppBrowser: isXInAppBrowser(ua)
  });
});

app.get('/login', (req, res) => {
  res.render('error', {
    title: 'ログインが必要です',
    pageLabel: 'AUTH',
    message: '「Googleでログイン」をクリックしてください。',
    primaryAction: { href: '/auth/google', label: 'Googleでログイン' },
    secondaryAction: { href: '/', label: 'トップに戻る' }
  });
});

app.get('/auth/google',
  passport.authenticate('google', { scope: ['profile', 'email'] })
);

app.get('/auth/google/callback',
  passport.authenticate('google', { failureRedirect: '/login' }),
  (req, res) => res.redirect('/creator')
);

app.all('/logout', (req, res) => {
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
    const eligibility = await getTransferEligibility(user.stripeAccountId);
    if (eligibility.canTransfer) {
      const results = await processQueuedPendingTransfersForSeller({
        sellerId: user._id,
        stripeAccountId: user.stripeAccountId
      });
      console.log('[pending-transfer] connect/return processed', { seller: String(user._id), count: results.length });
    }

    return res.render('error', {
      variant: 'success',
      pageLabel: '接続結果',
      title: '接続設定を受け付けました。',
      message: '受取設定の状態を確認し、必要な処理を反映しました。',
      primaryAction: { href: '/creator', label: 'アップロードへ戻る' },
      secondaryAction: { href: '/', label: 'トップに戻る' }
    });
  } catch (e) {
    console.error(e);
    return res.status(500).render('error', { message: '接続状態の確認に失敗しました。' });
  }
});

// オンボーディングの中断→再開用
app.get('/connect/refresh', ensureAuthed, (req, res) => {
  return res.render('error', {
    pageLabel: '接続結果',
    title: 'オンボーディングを再開してください。',
    message: '手続きが中断されたため、続きから設定を再開してください。',
    primaryAction: { href: '/connect/onboard', label: 'もう一度始める' },
    secondaryAction: { href: '/creator', label: 'アップロードへ戻る' }
  });
});

// ★ 出品者用：Stripe Express ダッシュボード（売上/入金）へ遷移
app.get('/connect/portal', ensureAuthed, async (req, res) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');

  const userId = req.user?._id || req.user?.id || null;
  const sessionAccountId = req.user?.stripeAccountId || '';
  const stripeMode = STRIPE_SECRET_KEY
    ? (STRIPE_SECRET_KEY.startsWith('sk_live_') ? 'live' : (STRIPE_SECRET_KEY.startsWith('sk_test_') ? 'test' : 'unknown'))
    : 'not_configured';
  console.info('[connect/portal] start', {
    userId: userId ? String(userId) : null,
    stripeAccountId: maskStripeAccountId(sessionAccountId),
    stripeMode,
    hasSessionUser: !!req.user,
    hasSessionStripeAccountId: !!sessionAccountId
  });

  try {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');

    if (!stripe) {
      console.error('[connect/portal] stripe_not_configured', { stripeMode });
      return res.status(500).render('error', { message: 'Stripeが未設定です（STRIPE_SECRET_KEY）。' });
    }

    if (!userId) {
      console.error('[connect/portal] missing_user_id');
      return res.redirect('/login');
    }

    let connectStatus = null;
    try {
      connectStatus = await getConnectStatus({ _id: userId });
      console.info('[connect/portal] connect_status', {
        userId: String(userId),
        hasAccount: !!connectStatus?.hasAccount,
        payoutsEnabled: !!connectStatus?.payoutsEnabled
      });
    } catch (statusErr) {
      console.warn('[connect/portal] connect_status_failed', {
        userId: String(userId),
        message: statusErr?.message,
        type: statusErr?.type || statusErr?.name || null
      });
    }

    // DBから最新ユーザーを取得（stripeAccountIdを確実に参照）
    const me = await User.findById(userId).select('_id stripeAccountId payoutsEnabled').lean();
    const accountId = me?.stripeAccountId || sessionAccountId;
    console.info('[connect/portal] account_lookup', {
      userId: String(userId),
      stripeAccountId: maskStripeAccountId(accountId),
      stripeMode,
      hasDbUser: !!me,
      hasDbStripeAccountId: !!me?.stripeAccountId,
      hasSessionStripeAccountId: !!sessionAccountId,
      usingFallbackSessionStripeAccountId: !me?.stripeAccountId && !!sessionAccountId
    });

    // 「はじめる（Stripe）」と同じく、未完了ユーザーはオンボーディング導線へ寄せる
    if (!accountId) {
      console.warn('[connect/portal] missing_stripe_account_id', {
        userId: String(userId),
        stripeAccountId: null,
        stripeMode,
        hasDbUser: !!me,
        connectStatus
      });
      return res.redirect('/connect/onboard');
    }
    if (connectStatus && (!connectStatus.hasAccount || !connectStatus.payoutsEnabled)) {
      console.info('[connect/portal] redirect_to_onboard:incomplete_connect_status', {
        userId: String(userId),
        stripeAccountId: maskStripeAccountId(accountId),
        stripeMode,
        connectStatus
      });
      return res.redirect('/connect/onboard');
    }

    let stripeAccount;
    try {
      stripeAccount = await stripe.accounts.retrieve(accountId);
      console.info('[connect/portal] account_retrieve:success', {
        userId: String(userId),
        stripeAccountId: maskStripeAccountId(accountId),
        stripeMode,
        type: stripeAccount?.type || null,
        payoutsEnabled: !!stripeAccount?.payouts_enabled,
        chargesEnabled: !!stripeAccount?.charges_enabled,
        detailsSubmitted: !!stripeAccount?.details_submitted
      });

      if (!stripeAccount?.payouts_enabled || !stripeAccount?.details_submitted) {
        console.info('[connect/portal] redirect_to_onboard:incomplete_stripe_account', {
          userId: String(userId),
          stripeAccountId: maskStripeAccountId(accountId),
          stripeMode,
          payoutsEnabled: !!stripeAccount?.payouts_enabled,
          detailsSubmitted: !!stripeAccount?.details_submitted
        });
        return res.redirect('/connect/onboard');
      }
    } catch (retrieveErr) {
      console.error('[connect/portal] account_retrieve:failed', {
        userId: String(userId),
        stripeAccountId: maskStripeAccountId(accountId),
        stripeMode,
        message: retrieveErr?.message,
        type: retrieveErr?.type || retrieveErr?.name || null,
        code: retrieveErr?.code || retrieveErr?.raw?.code || null,
        rawMessage: retrieveErr?.raw?.message || null,
        rawCode: retrieveErr?.raw?.code || null
      });

      const shouldReOnboard = ['resource_missing', 'account_invalid', 'invalid_request_error'].includes(retrieveErr?.code)
        || ['resource_missing', 'account_invalid', 'invalid_request_error'].includes(retrieveErr?.raw?.code)
        || retrieveErr?.statusCode === 404;

      if (shouldReOnboard) {
        console.info('[connect/portal] redirect_to_onboard:retrieve_failed', {
          userId: String(userId),
          stripeAccountId: maskStripeAccountId(accountId),
          stripeMode,
          code: retrieveErr?.code || retrieveErr?.raw?.code || null
        });
        return res.redirect('/connect/onboard');
      }

      return res.status(500).render('error', {
        message: '売上ダッシュボードに遷移できませんでした。時間をおいて再度お試しください。',
        primaryAction: { href: '/connect/portal', label: '再試行する' },
        secondaryAction: { href: '/dashboard', label: 'ダッシュボードに戻る' }
      });
    }

    console.info('[connect/portal] create_login_link:start', {
      userId: String(userId),
      stripeAccountId: maskStripeAccountId(accountId),
      stripeMode,
      accountType: stripeAccount?.type || null,
      redirectUrl: `${BASE_URL}/creator`
    });

    // 一時ログインリンクを発行（数十秒〜1分有効）
    const link = await stripe.accounts.createLoginLink(accountId, {
      redirect_url: `${BASE_URL}/creator`  // 閲覧後の戻り先
    });

    console.info('[connect/portal] create_login_link:success', {
      userId: String(userId),
      stripeAccountId: maskStripeAccountId(accountId),
      stripeMode,
      hasLinkUrl: !!link?.url
    });

    return res.redirect(link.url);
  } catch (err) {
    console.error('[connect/portal] failed', {
      userId: userId ? String(userId) : null,
      stripeAccountId: maskStripeAccountId(sessionAccountId),
      stripeMode,
      message: err?.message,
      type: err?.type || err?.name || null,
      code: err?.code || err?.raw?.code || null,
      rawMessage: err?.raw?.message || null,
      rawCode: err?.raw?.code || null,
      stack: err?.stack ? String(err.stack).split('\n').slice(0, 5).join(' | ') : null
    });
    return res.status(500).render('error', {
      message: '売上ダッシュボードに遷移できませんでした。時間をおいて再度お試しください。',
      primaryAction: { href: '/connect/portal', label: '再試行する' },
      secondaryAction: { href: '/dashboard', label: 'ダッシュボードに戻る' }
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

    const sellers = await PendingTransfer.distinct('seller', { status: 'queued' });
    const results = [];
    for (const sellerId of sellers) {
      try {
        const seller = await User.findById(sellerId);
        if (!seller?.stripeAccountId) { results.push({ seller: sellerId, status: 'skip_no_account' }); continue; }

        const eligibility = await getTransferEligibility(seller.stripeAccountId);
        if (!eligibility.canTransfer) { results.push({ seller: sellerId, status: 'skip_transfer_not_eligible' }); continue; }

        const sellerResults = await processQueuedPendingTransfersForSeller({
          sellerId,
          stripeAccountId: seller.stripeAccountId
        });
        results.push(...sellerResults.map(r => ({ seller: sellerId, ...r })));
      } catch (e) {
        results.push({ seller: sellerId, status: 'error', error: e?.raw?.message || e.message });
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

app.get('/dashboard', ensureAuthed, async (req, res) => {
  try {
    const [summary, me] = await Promise.all([
      getOwnedItemSummary(req.user._id),
      User.findById(req.user._id).select('sellerProfile').lean()
    ]);
    return res.render('dashboard/hub', dashboardBaseView(req, {
      title: 'ダッシュボード',
      summary,
      sellerProfileCompleted: getSellerProfileCompletion(me),
      og: {
        title: `Dashboard | ${req.t('brand')}`,
        desc: '出品情報や販売者情報を確認・編集できます。',
        url: `${BASE_URL}/dashboard`,
        image: `${BASE_URL}/public/og/instantsale_ogp.jpg`
      }
    }));
  } catch (e) {
    console.error('[dashboard:hub]', e);
    return res.status(500).render('error', { message: 'ダッシュボードの表示に失敗しました。' });
  }
});

app.get('/dashboard/listings', ensureAuthed, async (req, res) => {
  try {
    const summary = await getOwnedItemSummary(req.user._id);
    return res.render('dashboard/index', dashboardBaseView(req, {
      title: '出品情報',
      summary,
      dashboardItems: summary.items,
      og: {
        title: `Listings | ${req.t('brand')}`,
        desc: '自分の出品作品を一覧で確認できます。',
        url: `${BASE_URL}/dashboard/listings`,
        image: `${BASE_URL}/public/og/instantsale_ogp.jpg`
      }
    }));
  } catch (e) {
    console.error('[dashboard:listings]', e);
    return res.status(500).render('error', { message: '出品情報の表示に失敗しました。' });
  }
});

app.get('/dashboard/items/:id/original', ensureAuthed, async (req, res) => {
  try {
    const item = await findOwnedItem(req.params.id, req.user._id);
    if (!item) {
      return res.status(404).render('error', { message: '作品が見つからないか、アクセス権がありません。' });
    }

    const absRaw = path.resolve(String(item.filePath || '').trim());
    const hasLocalFile = !!(item.filePath || '').trim() &&
      fs.existsSync(absRaw) &&
      (() => { try { return fs.statSync(absRaw).isFile(); } catch { return false; } })();

    if (hasLocalFile) {
      if (item.mimeType) {
        res.setHeader('Content-Type', item.mimeType);
      }
      return res.sendFile(absRaw);
    }

    if (s3 && item.s3Key) {
      const signedTtlSec = Number(process.env.S3_SIGNED_TTL_SEC || '60');
      const cmd = new GetObjectCommand({
        Bucket: S3_BUCKET,
        Key: item.s3Key
      });
      const signedUrl = await getSignedUrl(s3, cmd, { expiresIn: signedTtlSec });
      return res.redirect(302, signedUrl);
    }

    if (item.previewPath) {
      return res.redirect(302, item.previewPath);
    }

    return res.status(404).render('error', { message: '表示できる画像が見つかりません。' });
  } catch (e) {
    console.error('[dashboard:original]', e);
    return res.status(500).render('error', { message: '作品画像の表示に失敗しました。' });
  }
});

app.get('/dashboard/items/:id', ensureAuthed, async (req, res) => {
  try {
    const [item, me] = await Promise.all([
      findOwnedItem(req.params.id, req.user._id),
      User.findById(req.user._id).select('sellerProfile.creatorDisplayName').lean()
    ]);
    if (!item) {
      return res.status(404).render('error', { message: '作品が見つからないか、アクセス権がありません。' });
    }

    const viewItem = dashboardItemView(item);
    const creatorDisplayName = me?.sellerProfile?.creatorDisplayName || item.creatorName || '';
    return res.render('dashboard/show', dashboardBaseView(req, {
      title: `${item.title} | ダッシュボード`,
      item: viewItem,
      creatorDisplayName,
      licenseView: licenseViewOf(item),
      og: {
        title: `${item.title} | Dashboard`,
        desc: '出品作品の販売ページURLと販売情報を確認できます。',
        url: `${BASE_URL}/dashboard/items/${item._id}`,
        image: toAbs(viewItem.previewPath)
      }
    }));
  } catch (e) {
    console.error('[dashboard:show]', e);
    return res.status(500).render('error', { message: '作品詳細の表示に失敗しました。' });
  }
});

app.get('/dashboard/items/:id/edit', ensureAuthed, ensureSellerProfileCompleted, async (req, res) => {
  try {
    const item = await findOwnedItem(req.params.id, req.user._id);
    if (!item) {
      return res.status(404).render('error', { message: '作品が見つからないか、アクセス権がありません。' });
    }

    return res.render('dashboard/edit', dashboardBaseView(req, {
      title: `${item.title} | 編集`,
      item: dashboardItemView(item),
      formValues: {
        title: item.title || '',
        price: item.price || MIN_PRICE
      },
      errorMessage: '',
      successMessage: '',
      licenseView: licenseViewOf(item)
    }));
  } catch (e) {
    console.error('[dashboard:edit:get]', e);
    return res.status(500).render('error', { message: '編集画面の表示に失敗しました。' });
  }
});

app.post('/dashboard/items/:id/delete', ensureAuthed, async (req, res) => {
  try {
    const item = await findOwnedItem(req.params.id, req.user._id);
    if (!item) {
      return res.status(404).render('error', { message: '作品が見つからないか、アクセス権がありません。' });
    }

    await Item.updateOne(
      { _id: req.params.id, ownerUser: req.user._id, isDeleted: { $ne: true } },
      { $set: { isDeleted: true, deletedAt: new Date() } }
    );

    return res.redirect(303, '/dashboard/listings');
  } catch (e) {
    console.error('[dashboard:delete]', e);
    return res.status(500).render('error', { message: '作品の削除に失敗しました。' });
  }
});

app.post('/dashboard/items/:id/edit', ensureAuthed, ensureSellerProfileCompleted, async (req, res) => {
  try {
    const current = await findOwnedItem(req.params.id, req.user._id);
    if (!current) {
      return res.status(404).render('error', { message: '作品が見つからないか、アクセス権がありません。' });
    }

    const updates = pickEditableItemFields(req.body);
    const updated = await Item.findOneAndUpdate(
      { _id: req.params.id, ownerUser: req.user._id },
      { $set: updates },
      { new: true, runValidators: true }
    ).lean();

    return res.render('dashboard/edit', dashboardBaseView(req, {
      title: `${updated.title} | 編集`,
      item: dashboardItemView(updated),
      formValues: {
        title: updated.title || '',
        price: updated.price || MIN_PRICE
      },
      errorMessage: '',
      successMessage: '販売情報を更新しました。',
      licenseView: licenseViewOf(updated)
    }));
  } catch (e) {
    console.error('[dashboard:edit:post]', e);
    const item = await findOwnedItem(req.params.id, req.user._id);
    if (!item) {
      return res.status(404).render('error', { message: '作品が見つからないか、アクセス権がありません。' });
    }

    return res.status(400).render('dashboard/edit', dashboardBaseView(req, {
      title: `${item.title} | 編集`,
      item: dashboardItemView(item),
      formValues: {
        title: typeof req.body.title === 'string' ? req.body.title : item.title || '',
        price: typeof req.body.price !== 'undefined' ? req.body.price : item.price || MIN_PRICE
      },
      errorMessage: e?.message || '販売情報の更新に失敗しました。',
      successMessage: '',
      licenseView: licenseViewOf(item)
    }));
  }
});

app.get('/creator/seller-profile', ensureAuthed, async (req, res) => {
  const me = await User.findById(req.user._id).select('name email sellerProfile').lean();
  const sellerProfile = me?.sellerProfile || {};
  const returnTo = sanitizeReturnPath(req.query.returnTo || '/creator');

  return res.render('seller-profile', {
    baseUrl: BASE_URL,
    formValues: sellerProfileFormValues(sellerProfile),
    errors: {},
    sellerProfile,
    pageTitle: '販売者情報の登録',
    pageLead: '出品を行うには、販売者情報の登録が必要です。',
    actionPath: '/creator/seller-profile',
    submitLabel: '保存する',
    cancelLabel: '戻る',
    errorMessage: '',
    successMessage: (req.query.saved === '1' || req.query.sellerProfileSaved === '1') ? '販売者情報を保存しました。' : '',
    returnTo,
    backPath: resolveSellerProfileBackPath(returnTo, getSellerProfileCompletion(me))
  });
});

app.get('/dashboard/seller-profile', ensureAuthed, async (req, res) => {
  try {
    const me = await User.findById(req.user._id).select('sellerProfile').lean();
    const sellerProfile = me?.sellerProfile || {};
    return res.render('dashboard/seller-profile', dashboardBaseView(req, {
      title: '販売者情報',
      sellerProfile,
      sellerProfileCompleted: getSellerProfileCompletion(me),
      successMessage: req.query.sellerProfileSaved === '1' ? '販売者情報を保存しました。' : ''
    }));
  } catch (e) {
    console.error('[dashboard:seller-profile]', e);
    return res.status(500).render('error', { message: '販売者情報の表示に失敗しました。' });
  }
});

app.get('/dashboard/seller-profile/edit', ensureAuthed, async (req, res) => {
  try {
    const me = await User.findById(req.user._id).select('sellerProfile').lean();
    const sellerProfile = me?.sellerProfile || {};
    return res.render('seller-profile', {
      ...dashboardBaseView(req),
      formValues: sellerProfileFormValues(sellerProfile),
      errors: {},
      sellerProfile,
      pageTitle: '販売者情報の編集',
      pageLead: 'クリエイター名や販売者情報を更新できます。',
      actionPath: '/dashboard/seller-profile/edit',
      submitLabel: '保存して戻る',
      cancelLabel: 'キャンセル',
      errorMessage: '',
      successMessage: '',
      returnTo: '/dashboard/seller-profile',
      backPath: '/dashboard/seller-profile'
    });
  } catch (e) {
    console.error('[dashboard:seller-profile:edit:get]', e);
    return res.status(500).render('error', { message: '販売者情報の編集画面の表示に失敗しました。' });
  }
});

app.get('/creator/legal', ensureAuthed, (req, res) => {
  return res.redirect(302, buildSellerProfilePath(req.query.returnTo || '/creator', { legacy: '1' }));
});

async function handleSellerProfileSave(req, res, options = {}) {
  const formValues = sanitizeSellerProfileInput(req.body);
  const errors = validateSellerProfileInput(formValues);
  const returnTo = sanitizeReturnPath(req.body.returnTo || req.query.returnTo || options.defaultReturnTo || '/creator');
  const isDashboardEdit = options.variant === 'dashboard-edit';

  if (Object.keys(errors).length) {
    return res.status(400).render('seller-profile', {
      ...dashboardBaseView(req),
      formValues,
      errors,
      sellerProfile: { isCompleted: false },
      pageTitle: isDashboardEdit ? '販売者情報の編集' : '販売者情報の登録',
      pageLead: isDashboardEdit ? 'クリエイター名や販売者情報を更新できます。' : '出品を行うには、販売者情報の登録が必要です。',
      actionPath: isDashboardEdit ? '/dashboard/seller-profile/edit' : '/creator/seller-profile',
      submitLabel: isDashboardEdit ? '保存して戻る' : '保存する',
      cancelLabel: isDashboardEdit ? 'キャンセル' : '戻る',
      errorMessage: '入力内容を確認してください。',
      successMessage: '',
      returnTo,
      backPath: isDashboardEdit ? '/dashboard/seller-profile' : resolveSellerProfileBackPath(returnTo, false)
    });
  }

  await saveSellerProfile(req.user._id, formValues);
  const redirectPath = isDashboardEdit ? '/dashboard/seller-profile?sellerProfileSaved=1' : withQueryParam(returnTo, 'sellerProfileSaved', '1');
  return res.redirect(303, redirectPath);
}

app.post('/creator/legal', ensureAuthed, (req, res) => handleSellerProfileSave(req, res));
app.post('/creator/seller-profile', ensureAuthed, (req, res) => handleSellerProfileSave(req, res));
app.post('/dashboard/seller-profile/edit', ensureAuthed, (req, res) => handleSellerProfileSave(req, res, { variant: 'dashboard-edit', defaultReturnTo: '/dashboard/seller-profile' }));

app.get('/creator', ensureAuthed, ensureSellerProfileCompleted, async (req, res) => {
  const connect = await getConnectStatus(req.user);
  const me = await User.findById(req.user._id).select('sellerProfile').lean();
  const sellerProfileCompleted = getSellerProfileCompletion(me);

res.render('upload', {
  baseUrl: BASE_URL,
  connect,
  sellerProfileCompleted,
  minPrice: MIN_PRICE,                    // ← 追加
  platformFeeDisplay: PLATFORM_FEE_DISPLAY,
  platformFeeDisplayEn: PLATFORM_FEE_DISPLAY_EN
});

});

// upload
app.post('/upload', ensureAuthed, ensureSellerProfileCompleted, upload.single('image'), async (req, res) => {
  try {

const {
  title, creatorSecret, ownerEmail, attestOwner,
  licensePreset, licenseNotes, aiGenerated, aiModelName
} = req.body;
const sellerProfileForUpload = req.user?._id
  ? await User.findById(req.user._id).select('sellerProfile').lean()
  : null;
// クリエイター名の正規ソースは sellerProfile.creatorDisplayName。
const creatorDisplayName = sellerProfileForUpload?.sellerProfile?.creatorDisplayName || '';
const price = req.body.price;

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
    
if (!title || !Number.isInteger(priceNum) || priceNum < MIN_PRICE) {
  await fsp.unlink(req.file.path).catch(() => {});
  return res.status(400).render('error', { message: `タイトルと価格（${MIN_PRICE}円以上の整数）は必須です。` });
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

// ====== 透かしSVG生成（タイル＋四隅） ======
const createTiledWatermarkSvg = ({ width, height, alpha = 0.22 }) => Buffer.from(`
  <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <pattern id="wm-tile" width="280" height="180" patternUnits="userSpaceOnUse" patternTransform="rotate(-18)">
        <text x="18" y="112" fill="rgba(255,255,255,${alpha})" font-size="46" font-weight="700" font-family="Arial, sans-serif">SAMPLE</text>
      </pattern>
    </defs>
    <rect width="100%" height="100%" fill="url(#wm-tile)" />
  </svg>
`);

const createCornerWatermarkSvg = ({ width, height, alpha = 0.18 }) => {
  const margin = Math.max(24, Math.round(Math.min(width, height) * 0.03));
  const wmSize = Math.max(26, Math.round(Math.min(width, height) * 0.055));
  return Buffer.from(`
    <svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <style>.wm{ fill: rgba(255,255,255,${alpha}); font-size: ${wmSize}px; font-weight: 700; font-family: Arial, sans-serif; }</style>
      <text x="${margin}" y="${margin + wmSize}" class="wm">SAMPLE</text>
      <text x="${width - margin}" y="${margin + wmSize}" text-anchor="end" class="wm">SAMPLE</text>
      <text x="${margin}" y="${height - margin}" dominant-baseline="ideographic" class="wm">SAMPLE</text>
      <text x="${width - margin}" y="${height - margin}" text-anchor="end" dominant-baseline="ideographic" class="wm">SAMPLE</text>
    </svg>
  `);
};

const previewWatermarkSvg = createTiledWatermarkSvg({ width: 1200, height: 630, alpha: 0.24 });

await sharp(previewBase)
  .composite([{ input: previewWatermarkSvg }])
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
  .composite([{ input: createTiledWatermarkSvg({ width: 1200, height: 630, alpha: 0.21 }) }])
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

// full は購入前閲覧用：視認性を保ちつつ最も弱い四隅透かし
const svgFull = createCornerWatermarkSvg({ width: fw, height: fh, alpha: 0.18 });

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
  // Item.creatorName は後方互換用の補助保存。正規ソースは sellerProfile.creatorDisplayName。
  // Item.creatorName は後方互換用の補助保存。正規ソースは sellerProfile.creatorDisplayName。
  creatorName: creatorDisplayName || '',
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
const connectNow = await getConnectStatus(req.user);
const meAfter = await User.findById(req.user._id).select('sellerProfile').lean();
const sellerProfileCompletedAfter = getSellerProfileCompletion(meAfter);

return res.render('upload', {
  baseUrl: BASE_URL,
  connect: connectNow,
  sellerProfileCompleted: sellerProfileCompletedAfter,
  createdUrl: saleUrl,
  minPrice: MIN_PRICE,                   // ← 追加
  platformFeeDisplay: PLATFORM_FEE_DISPLAY,
  platformFeeDisplayEn: PLATFORM_FEE_DISPLAY_EN
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
  creatorName: creatorDisplayName || '',
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
const connectNow = await getConnectStatus(req.user);
const meAfter = await User.findById(req.user._id).select('sellerProfile').lean();
const sellerProfileCompletedAfter = getSellerProfileCompletion(meAfter);

return res.render('upload', {
  baseUrl: BASE_URL,
  connect: connectNow,
  sellerProfileCompleted: sellerProfileCompletedAfter,
  createdUrl: saleUrl,
  minPrice: MIN_PRICE,                   // ← 追加
  platformFeeDisplay: PLATFORM_FEE_DISPLAY,
  platformFeeDisplayEn: PLATFORM_FEE_DISPLAY_EN
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

    // 販売者情報（公開ページでは個人情報を出さず、オーナー判定と受取状態確認だけに利用）
    let seller = null;
    if (item.ownerUser) {
      seller = await User.findById(item.ownerUser)
        .select('stripeAccountId payoutsEnabled sellerProfile.creatorDisplayName')
        .lean();
    }

    // オーナー本人が閲覧している時だけ注意表示に必要な最小限の値を渡す
    let ownerPayoutWarning = null;
    if (req.user && seller && String(req.user._id) === String(item.ownerUser)) {
      const st = await getConnectStatus(req.user);
      ownerPayoutWarning = {
        shouldShow: !st.hasAccount || !st.payoutsEnabled
      };
    }

    // 言語・ロケール
    const lng = getLng(req);
    const numLocale = toNumberLocale(lng);

    // 画像URL（絶対化 & フォールバック）
    const absPreview = (() => {
      const p = item.previewPath || `/previews/${item.slug}-preview.jpg`;
      return /^https?:\/\//i.test(p) ? p : `${BASE_URL}${p.startsWith('/') ? '' : '/'}${p}`;
    })();

    // 販売ページの表示名は sellerProfile.creatorDisplayName を正とし、item.creatorName は既存データ用フォールバックのみ。
    const creatorDisplayName = seller?.sellerProfile?.creatorDisplayName || item.creatorName || '';

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
    const tokushohoUrl = `/tokushoho`; // 出品者個人情報は公開ページに表示しない

    // ライセンス表示
    const licenseView = licenseViewOf(item);

// ページに CSRF トークンが含まれるので第三者キャッシュは禁止
res.set('Cache-Control', 'private, max-age=60');
// 必要なら完全に避けたい場合は： res.set('Cache-Control', 'no-store');

    return res.render('sale', {
      baseUrl: BASE_URL,
      item,
      ownerPayoutWarning,
      creatorDisplayName,
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
    const item = await Item.findOne({ slug, isDeleted: { $ne: true } }).lean();
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
    const item = await Item.findOne({ slug, isDeleted: { $ne: true } });
    if (!item) return res.status(404).render('error', { message: '商品が見つかりません。' });

// 仕様固定の収益分配（プラットフォーム手数料 4% + 30円）
const { platformFeeAmount: platformFee } = calcRevenueSplit(item.price);

// 販売者（オーナー）
let seller = null;
if (USE_STRIPE_CONNECT && item.ownerUser) {
  seller = await User.findById(item.ownerUser);
}

// destination を安全に使えるかを確認（transfers=active かつ payouts_enabled）
let destinationAccountId = null;
if (USE_STRIPE_CONNECT && seller?.stripeAccountId) {
  try {
    const { canTransfer: canUseDestination } = await getTransferEligibility(seller.stripeAccountId);
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
  images: [`${BASE_URL}/public/logo.png`],   // ★ ロゴを表示させる
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

              // 仕様固定の手数料計算（4% + 30円）
              const { sellerAmount, platformFeeAmount, grossAmount } = calcRevenueSplit(item.price);
              const transferGroup = pi.transfer_group || `item_${item._id}`;
              const now = new Date();

              // 送金すべきだが、前提が揃わない場合は保留登録
              const markPending = async (reason) => {
                try {
                  const existing = await PendingTransfer.findOne({ paymentIntentId: pi.id }).lean();
                  if (existing?.status === 'transferred' || existing?.status === 'expired') {
                    return;
                  }
                  await PendingTransfer.updateOne(
                    { paymentIntentId: pi.id },
                    {
                      $setOnInsert: {
                        seller: item.ownerUser,
                        item: item._id,
                        amount: sellerAmount,
                        grossAmount,
                        platformFeeAmount,
                        currency: item.currency,
                        paymentIntentId: pi.id,
                        transferGroup,
                        expiresAt: new Date(now.getTime() + DAYS_180_MS),
                        createdAt: now
                      },
                      $set: {
                        status: 'queued',
                        reason,
                        updatedAt: now
                      }
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
                const existing = await PendingTransfer.findOne({ paymentIntentId: pi.id }).lean();
                let skipTransfer = false;
                if (existing?.status === 'transferred') {
                  console.log('[transfer] skip already transferred', { pi: pi.id, pendingId: existing._id });
                  skipTransfer = true;
                }
                if (existing?.status === 'expired') {
                  console.log('[transfer] skip already expired', { pi: pi.id, pendingId: existing._id });
                  skipTransfer = true;
                }
                if (existing?.status === 'queued' && isExpiredPending(existing, now)) {
                  await expirePendingTransferById(existing._id, 'expired_after_180_days', now);
                  console.log('[transfer] skip expired pending', { pi: pi.id, pendingId: existing._id });
                  skipTransfer = true;
                }

                if (!skipTransfer) {
                  const eligibility = await getTransferEligibility(seller.stripeAccountId);
                  const canTransfer = eligibility.canTransfer;
                  if (!canTransfer && eligibility.error) {
                    console.warn('[transfer] retrieve account failed', eligibility.error?.raw?.message || eligibility.error?.message);
                  }

                  if (canTransfer) {
                    const tr = await stripe.transfers.create({
                      amount: sellerAmount,
                      currency: item.currency,
                      destination: seller.stripeAccountId,
                      transfer_group: transferGroup,
                    }, {
                      idempotencyKey: `pi_transfer_${pi.id}`
                    });
                    console.log('[transfer] success', {
                      pi: pi.id,
                      dest: seller.stripeAccountId,
                      amount: sellerAmount
                    });

                    await PendingTransfer.updateOne(
                      {
                        paymentIntentId: pi.id,
                        status: { $in: ['queued', 'transferred'] }
                      },
                      {
                        $setOnInsert: {
                          seller: item.ownerUser,
                          item: item._id,
                          amount: sellerAmount,
                          grossAmount,
                          platformFeeAmount,
                          currency: item.currency,
                          paymentIntentId: pi.id,
                          transferGroup,
                          expiresAt: new Date(now.getTime() + DAYS_180_MS),
                          createdAt: now
                        },
                        $set: {
                          status: 'transferred',
                          transferId: tr.id,
                          transferredAt: new Date(),
                          updatedAt: new Date(),
                          reason: 'transferred_after_webhook_retry'
                        }
                      },
                      { upsert: true }
                    );
                  } else {
                    await markPending(eligibility.payoutsEnabled ? 'transfers_capability_inactive' : 'payouts_disabled');
                  }
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
              const { sellerAmount, platformFeeAmount, grossAmount } = calcRevenueSplit(item.price);
              const existing = await PendingTransfer.findOne({ paymentIntentId: piId }).lean();
              if (existing?.status === 'transferred' || existing?.status === 'expired') {
                console.log('[transfer] exception queue skipped (already finalized)', { pi: piId, status: existing.status });
              } else {
              await PendingTransfer.updateOne(
                { paymentIntentId: piId },
                {
                  $setOnInsert: {
                    seller: item.ownerUser,
                    item: item._id,
                    amount: sellerAmount,
                    grossAmount,
                    platformFeeAmount,
                    currency: item.currency,
                    paymentIntentId: piId,
                    transferGroup: `item_${item._id}`,
                    expiresAt: new Date(Date.now() + DAYS_180_MS),
                    createdAt: new Date()
                  },
                  $set: { status: 'queued', reason: 'exception', updatedAt: new Date() }
                },
                { upsert: true }
              );
              console.warn('[transfer] pending queued by exception:', { pi: piId, sellerAmount });
              }
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

    const item = await Item.findOne({ slug, isDeleted: { $ne: true } });
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
    res.render('legal/image-license', {
      lng,
      lastUpdated: '2025-11-01'
    });
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
