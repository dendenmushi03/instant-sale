import fs from "fs";
import { TwitterApi } from "twitter-api-v2";

// --- Twitter 認証 ---
const client = new TwitterApi({
  appKey: process.env.TWITTER_API_KEY,
  appSecret: process.env.TWITTER_API_SECRET,
  accessToken: process.env.TWITTER_ACCESS_TOKEN,
  accessSecret: process.env.TWITTER_ACCESS_SECRET,
});

// --- ① データ読み込み ---
const tweets = fs.readFileSync("./data/tweets.txt", "utf8").split("\n").filter(Boolean);
const urls = fs.readFileSync("./data/urls.txt", "utf8").split("\n").filter(Boolean);

// --- ② ランダム選択 ---
const tweet = tweets[Math.floor(Math.random() * tweets.length)];
const url = urls[Math.floor(Math.random() * urls.length)];

// --- ③ 固定タグ（共通ハッシュタグ） ---
const hashtags = "#InstantSale #AIクリエイター支援 #画像販売";

// --- ④ ツイート本文組み立て ---
const tweetText = `${tweet}\n${url}\n${hashtags}`;

console.log("🔹 Posting Tweet:", tweetText);

// --- ⑤ 投稿 ---
await client.v2.tweet(tweetText);

console.log("✅ Tweet sent successfully!");
