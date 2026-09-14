#!/usr/bin/env node
/* =====================================================================
   المهمة الدورية (كل 10 دقائق أثناء ساعات السوق).
   تجلب الأسعار والشموع، تحسب المؤشرات، وتكتب ملفات JSON يقرأها المتصفح.

   الاستخدام:
     node scripts/fetch-market.mjs --out ./out
     node scripts/fetch-market.mjs --check        (فحص ذاتي بلا شبكة)
   ===================================================================== */
import fs from "node:fs";
import { rp, r2 } from "./lib/round.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchChart, fetchQuotes, fetchStooqDaily, pool, stats, num, tradingPeriodFromMeta
} from "./lib/yahoo.mjs";
import { fetchQuotesFinnhub, fhStats } from "./lib/finnhub.mjs";
import { fetchCandlesTD, hasTwelveData, tdSleep, tdStats } from "./lib/twelvedata.mjs";
import { analyze, overallScore, aggregate, TFS, TF_WEIGHT, bandStable } from "./lib/indicators.mjs";
import { marketStatus, approxMarketStatus } from "./lib/session.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();

const KEEP = 260;                 // يكفي لـ EMA200 مع هامش، ويُبقي الملفات خفيفة
const MAX_AGE = { "5m": 0, "15m": 0, "1h": 55 * 60e3, "1d": 20 * 3600e3 };
// صلاحية الفريم اليومي **أثناء الجلسة**. شمعةُ اليوم قيد التكوّن ما دامت
// الجلسة قائمة، فتجميدها عشرين ساعة يعني أن ارتفاع اليوم وانخفاضه لا
// يدخلان الحساب قبل الغد. والعشرون ساعة لا تقسم الأربعةَ والعشرين، فوقتُ
// الجلب ينزلق أربع ساعات للخلف كل يوم: يقع داخل الجلسة أياماً وقبل
// الافتتاح أياماً، بلا نمط ظاهر. وقع فعلاً 2026-09-11: جُلب 11:37 UTC —
// قبل الافتتاح بساعتين — فبقي 487 رمزاً من 510 على شمعة أمس طوال اليوم.
const DAILY_LIVE_AGE = 30 * 60e3;
// سقف رموز الطبقة الواسعة لكل تشغيل. صلاحية اليومي عشرون ساعة، ودورة
// السوق عشر دقائق، فـ 60 رمزاً/تشغيل تكفي لتجديد 414 رمزاً في ~70 دقيقة
// دون أن ترتفع دورة واحدة إلى مئات الطلبات فتستدعي 429.
const WIDE_PER_RUN = Number(process.env.WIDE_PER_RUN || 60);
const RANGE   = { "5m": "60d", "15m": "60d", "1h": "730d", "1d": "5y" };

/* =====================================================================
   فريم 5 دقائق — يُحسب ولا يدخل النتيجة الفنية.

   `TFS` أربعةٌ بأوزانها، و`overallScore` و`tfScore` يدوران عليها وحدها،
   و`allTF` في `scans.js` تشترط `v.length === 4` بالضبط. فإضافةُ خامسٍ
   إليها تغيّر نتيجة كل رمز في الكون، فتُبطل الأرشيف كلَّه وتُسقط شرطَي
   «توافق الفريمات» **بصمت** — لا خطأ ولا استثناء، فقط أرقامٌ أخرى.

   ولهذا `AN_TFS` قائمةٌ منفصلة للتحليل وحده: `rec.an["5m"]` يُكتب
   ويقرؤه ماسح الاستراتيجيات، و`rec.score` و`tfScore` لا يريانه.
   و`check-ui` يحرس هذا الفصل صراحةً.

   وبلا `prePost`: نطاق الافتتاح وVWAP الجلسة يحتاجان الجلسة الرسمية
   وحدها، وهي بالضبط ما يعطيه الطلب بلا جلسات ممتدة. ومكسبٌ ثانٍ أن
   260 شمعة تصير 3.3 يوم تداول بدل 1.8، فتكفي EMA200 بهامش. ولذلك لا
   يمرّ 5د بـ`tradingOnly`: حجمه حقيقيٌّ كله، والبوابة عليه تعريضٌ بلا
   مقابل (نفس سبب استثناء الساعة واليومي منها).
   ===================================================================== */
const AN_TFS = [...TFS, "5m"];

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "stocks/symbols.json"), "utf8"));

/* ---------- ميزانية طلبات Twelve Data لكل تشغيل ----------
   الخطة المجانية: 8 طلبات/دقيقة و800/يوم. تعبئة الفريمات الثلاثة لكل
   الرموز السبعين = 210 طلباً = 28 دقيقة، أطول من مهلة المهمة وأكبر من
   حصة اليوم لو تكرّر. فنحدّث دفعة صغيرة كل تشغيل (~100 ثانية) وتكتمل
   التغطية تدريجياً عبر التشغيلات، مع بقاء بيانات الشمعات السابقة كما هي.
   14 طلباً × 48 تشغيلاً يومياً ≈ 672 طلباً — داخل حصة الـ800. */
const TD_PER_RUN = Number(process.env.TD_PER_RUN || 14);
const tdBudget = { left: TD_PER_RUN };

/* على شبكة منزلية Yahoo غير محظور ومجاني بلا سقف، فيُقدَّم على Twelve Data
   وتسقط الحاجة لميزانية الطلبات. يُضبط PREFER_YAHOO=1 في التشغيل المحلي. */
const PREFER_YAHOO = process.env.PREFER_YAHOO === "1";

/* تقريب — Yahoo يعيد 62.014999389648438 والتخزين بلا تقريب يضاعف حجم الملفات */
const r4 = (v) => (v === null || v === undefined || !isFinite(v)) ? null : Math.round(v * 10000) / 10000;

/* التقريب السعري مشتركٌ — انظر `lib/round.mjs` (نسخةٌ ثالثة منه في
   `track-signals` كتبت لقطةَ شيبا أصفاراً). ويُعاد تصديره لمن يستورده
   من هنا. */
export { rp };

const slimCandles = (c) => c.map(x => ({
  t: x.t, o: rp(x.o), h: rp(x.h), l: rp(x.l), c: rp(x.c), v: Math.round(x.v || 0)
}));

/* =====================================================================
   شمعاتُ الحجم الصفري — أخطر تشويشٍ في المشروع، ولم يكن يبدو خللاً.

   فريم 15د وحده يُطلب بـ`prePost: true` (ما قبل الافتتاح وما بعد
   الإغلاق)، وياهو **يحشو** الساعات المغلقة بشمعاتٍ حجمها صفر تحمل آخر
   سعرٍ معروف مكرَّراً. قياس 2026-09-13 على أبل: **156 من 260** شمعة
   بحجم صفر — أي أن ‎60%‎ من فريم 15د لم يكن تداولاً أصلاً، بل سعراً
   واحداً منسوخاً على مئة شمعة.

   والنتيجة أن مؤشّرات الفريم تقيس اللاشيء: نطاق بولنجر لأبل ضاق إلى
   **35 سنتاً** (332.35–332.70)، والتصق EMA20 بالسعر على مسافة **1.5
   سنت**، وحام MACD على الصفر. فصارت كل بوابةٍ على حدّ السكين تنقلب في
   كل دورة — وهذا هو المصدر الحقيقي لـ‎195 حالة‎ تغيّرت فيها النتيجة
   والسعر لم يتغيّر بأيّ كسر.

   فنُسقِط الشمعات التي لا تداولَ فيها **قبل** `slice(-KEEP)`: الطلب
   يعيد 60 يوماً (~2600 شمعة مع الجلسات الممتدة، و~1070 بدونها)،
   فيبقى بعد الإسقاط 260 شمعةَ تداولٍ حقيقي تغطّي ~10 أيام تداول.

   والبوابةُ شرطُ سلامة لا تجميل: مصدرٌ لا يعطي حجماً إطلاقاً
   (Twelve Data وStooq) تُصفّره `Math.round(x.v || 0)` فيمحو السلسلة
   كاملةً. فإن لم يبقَ ما يكفي EMA200 أعدنا الأصل كما هو — بياناتٌ
   مشوَّشة أفضل من لا بيانات.

   وعلى 15د وحده: اليوميُّ والساعة يأتيان بلا `prePost` ونسبةُ الحجم
   الحقيقي فيهما ‎100%‎، وتطبيقُه عليهما يعرّضهما للبوابة بلا مقابل. */
const NEED_BARS = 220;                  // EMA200 + هامش
function tradingOnly(candles, tf) {
  if (tf !== "15m") return candles;
  const live = candles.filter(x => (x.v || 0) > 0);
  return live.length >= NEED_BARS ? live : candles;
}

/* =====================================================================
   السلسلة المجمّدة — بياناتٌ خاطئة لا حالةَ سوق، والفرق يهمّ.

   `ARB-USD` عند ياهو ليس أربيتروم: أصلٌ ميت مجمَّد على 0.000629 بحجم
   صفر منذ 260 يوماً. والتطبيق كان يعرضه بسعره ذاك، ويحسب له اتجاهاً
   («ميل هابط»، نتيجة ‎−50.59‎ — لأن `px > e200` تعيد `false` عند التساوي
   التامّ)، ويرشّحه للفرص. أربيتروم الحقيقية `ARB11841-USD` بسعر 0.14
   وحجم 240 مليون يومياً.

   ولم يكشفه شيء: السعر رقمٌ صالح، والشارت خطٌّ مستقيم، والنتيجة رقمٌ
   في مداه. نفس مصيدة «الأرقام تبدو صحيحة» مطبَّقةً على رمزٍ كامل.

   الشرطان **مجتمعان** لا أحدهما: مسطَّحةٌ *وبلا* حجم. فسهمٌ هادئ له حجم،
   ومصدرٌ لا يعطي حجماً (Twelve Data وStooq) قد يعطي سلسلةً سليمة —
   ولهذا الحارس على مصدر ياهو وحده، وهو الذي يعطي الحجم فعلاً. */
const FROZEN_BARS = 30;
function frozenSeries(rec) {
  if (rec.src !== "yahoo") return false;
  const c = rec.tf?.["1d"]?.c;
  if (!c || c.length < FROZEN_BARS) return false;
  const t = c.slice(-FROZEN_BARS);
  const hi = Math.max(...t.map(x => x.c)), lo = Math.min(...t.map(x => x.c));
  if (!(lo > 0)) return true;                       // أسعار صفرية أو سالبة
  const flat = (hi - lo) / lo < 0.005;              // مدى ‎30‎ يوماً أقلّ من نصف بالمئة
  const traded = t.filter(x => (x.v || 0) > 0).length;
  return flat && traded <= 2;
}
/* ضغط الشمعات عند الكتابة فقط: مصفوفة بدل كائن يوفّر ~45% من الحجم.
   [الوقت بالثواني, فتح, أعلى, أدنى, إغلاق, حجم] */
const packCandles = (c) => c.map(x => [Math.round(x.t / 1000), x.o, x.h, x.l, x.c, x.v]);
/* الملفات المحفوظة تحوي الشكل المضغوط، فإعادة استخدامها في تشغيل تالٍ
   بلا فكّ ضغط تمرّر مصفوفات حيث يُتوقّع كائنات فينهار الحساب على
   x.c.toFixed. لم يظهر هذا إلا بعد أن صار هناك بيانات سابقة فعلاً. */
const unpackCandles = (c) => (Array.isArray(c) && Array.isArray(c[0]))
  ? c.map(a => ({ t: a[0] * 1000, o: a[1], h: a[2], l: a[3], c: a[4], v: a[5] }))
  : c;
const slimAnalysis = (a) => {
  const o = {};
  // rp لا r4: قيم المؤشرات على مقياس السعر (ATR والمتوسطات وبولنجر)،
  // فتقريبها بخانات ثابتة يمحوها لأصل رخيص كما مُحي سعره
  for (const [k, v] of Object.entries(a)) o[k] = (typeof v === "number") ? rp(v) : v;
  return o;
};

/* ---------- أدوات ملفات ---------- */
const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
function writeJSON(rel, obj) {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
  return fs.statSync(p).size;
}

/* ---------- أي فريم يحتاج تحديثاً؟ ---------- */
/* هل الشمعة اليومية قيد التكوّن الآن؟ الكريبتو دائماً — لا إغلاق له.
   و`POST` مشمولة عمداً: آخر جلب أثناء الجلسة يقع قبل الإغلاق بنصف ساعة
   على الأكثر، فإغلاقُ اليوم المحفوظ يكون سعرَ 19:40 لا الإغلاق الرسمي —
   ورقمٌ خاطئ هنا ينتقل إلى بيفوت الغد كلّه. `PRE` مستثناة: شمعة اليوم
   لم تبدأ بعد، فالجلب فيها طلبٌ بلا مقابل. */
function dailyIsLive(now, mkt) {
  if (mkt === "crypto") return true;
  const st = approxMarketStatus(now).state;
  return st === "REGULAR" || st === "POST";
}

/* `live` يمرّرها النداء لا تُحسب هنا: الطبقة الواسعة بوابتُها `wideDue`
   بصلاحية العشرين ساعة، وتقصيرُها لها يجعل 414 رمزاً تستحق التجديد كل
   نصف ساعة بينما السقف 60 لكل تشغيل — فلا تكتمل دورةٌ أبداً. */
function stale(prev, tf, now, live = false) {
  const u = prev?.tf?.[tf]?.updated;
  if (!u) return true;
  const age = (tf === "1d" && live) ? DAILY_LIVE_AGE : MAX_AGE[tf];
  return (now - u) >= age;
}

/* حالة الجلسة في scripts/lib/session.mjs — تستعملها مهمة الأسعار
   السريعة أيضاً، ونسخة واحدة تمنع اختلاف الترويسة بين المهمتين. */

/* `frames` تحدد عمق الرمز: الطبقة الأساسية تأخذ الفريمات الثلاثة،
   والطبقة الواسعة اليوميَّ وحده. جلب 500 رمز × 3 فريمات كل عشر دقائق
   يستدعي 429 حتى من شبكة منزلية، واليوميُّ وحده يكفي للبحث ولمستويات
   الدعم والمقاومة و52 أسبوعاً — وهو كل ما يُطلب من رمز خارج المرصودة. */
async function buildSymbol(meta, prevDir, now, quotes, frames = ["1d", "1h", "15m"], tier = "core") {
  const sym = meta.s;
  const prev = readJSON(path.join(prevDir, "sym", `${sym}.json`));
  // نُعيد الشمعات المحفوظة إلى شكل الكائنات فور القراءة، فما بعدها من
  // حساب ورسم يتعامل مع شكل واحد فقط
  for (const o of Object.values(prev?.tf || {})) if (o?.c) o.c = unpackCandles(o.c);
  const rec = { s: sym, ar: meta.ar, en: meta.en, sec: meta.sec, tf: {}, src: "yahoo", updated: now };
  if (meta.mkt) rec.mkt = meta.mkt;
  let touched = false, errors = [], usedTD = false;
  // سلسلة الساعة كاملةً قبل القصّ — تُستعمل لاشتقاق 4h ولا تُخزَّن
  let full1h = null;

  // الترتيب مقصود: اليومي أولاً لأنه أساس الشارت والنتيجة الفنية، فحين
  // تنفد ميزانية الطلبات في تشغيل واحد تكون الفريمات الأهم قد امتلأت
  for (const tf of frames) {
    /* 4h يُشتقّ من الساعة الكاملة، فسلسلةٌ قصيرة محفوظة من قبل لا تُصلَح
       إلا بإعادة جلب الساعة. بلا هذا تبقى 65 شمعة حتى تنتهي صلاحية
       الساعة وحدها — إصلاحٌ يعتمد على التوقيت بدل أن يكون حتمياً. */
    const shortDerived = tf === "1h" && (prev?.tf?.["4h"]?.c?.length || 0) < 200;
    if (!shortDerived && !stale(prev, tf, now, tier === "core" && dailyIsLive(now, meta.mkt)) && prev?.tf?.[tf]?.c?.length) {
      rec.tf[tf] = prev.tf[tf];                       // ما زال حديثاً — أبقِه
      continue;
    }
    // Twelve Data أولاً حين يتوفّر مفتاحه: Yahoo يحظر رينرات GitHub
    // (429 حتى عبر curl) فلا يُعتمد عليه، لكنه يبقى محاولة ثانية مجانية
    // لأنه ينجح أحياناً ويعطي فترات التداول التي لا يعطيها غيره.
    // طلب واحد لكل رمز في التشغيل الواحد: بلا هذا القيد تبتلع أول أربعة
    // رموز الميزانية كاملةً (ثلاثة فريمات لكل رمز) ويبقى 66 رمزاً بلا أي
    // شمعة لساعات. بالقيد يأخذ كل رمز يومِيَّه أولاً فتكتمل الشارتات
    // والنتائج الفنية لكل الرموز خلال ~6 تشغيلات بدل 18.
    let got = false;

    const tryYahoo = async () => {
      const { candles, meta: m } = await fetchChart(sym, {
        range: RANGE[tf], interval: tf, prePost: tf === "15m"
      });
      const full = tradingOnly(candles, tf);
      // الساعة تُطلب بمدى سنتين (`RANGE["1h"]`) فتعود بآلاف الشمعات، ثم
      // تُقصّ إلى KEEP. و4h تُشتقّ منها — فاشتقاقُها **بعد** القصّ يعطي
      // 260/4 = 65 شمعة، وEMA200 تحتاج 200. السلسلة الكاملة تُمرَّر
      // للاشتقاق ولا تُخزَّن: الملفّ يبقى بـ KEEP لكل فريم.
      if (tf === "1h") full1h = full;
      rec.tf[tf] = { updated: now, c: slimCandles(full.slice(-KEEP)) };
      // فترات التداول الحقيقية لا يوفّرها غير Yahoo — وهي أدق من التقدير
      if (tf === "15m" && m) { rec.period = tradingPeriodFromMeta(m); rec.cur = num(m.regularMarketPrice); }
      rec.src = "yahoo";
      touched = true; got = true;
    };

    const tryTD = async () => {
      if (!hasTwelveData() || tdBudget.left <= 0 || usedTD) return;
      tdBudget.left--; usedTD = true;
      try {
        const { candles } = await fetchCandlesTD(sym, tf, { outputsize: KEEP });
        rec.tf[tf] = { updated: now, c: slimCandles(candles.slice(-KEEP)) };
        rec.src = "twelvedata";
        touched = true; got = true;
      } catch (e) { errors.push(`${tf}/td: ${e.message}`); }
      await tdSleep();                       // حد 8 طلبات/دقيقة على الخطة المجانية
    };

    // ترتيب المصادر يعتمد على مكان التشغيل، لأن الحظر مرتبط بعنوان الشبكة:
    // من رينر سحابي (GitHub) يرفض Yahoo كل طلب بـ429، فـ Twelve Data أولاً
    // بميزانيته المحدودة. من شبكة منزلية Yahoo غير محظور ومجاني بلا سقف،
    // فيصير هو الأول ويُستغنى عن ميزانية الطلبات كلياً.
    const yahooFirst = PREFER_YAHOO;
    if (yahooFirst) {
      try { await tryYahoo(); } catch (e) { errors.push(`${tf}: ${e.message}`); }
      if (!got) await tryTD();
    } else {
      await tryTD();
      if (!got) try { await tryYahoo(); } catch (e) { errors.push(`${tf}: ${e.message}`); }
    }
    if (!got && prev?.tf?.[tf]?.c?.length) rec.tf[tf] = prev.tf[tf];  // أبقِ القديم بدل الحذف
  }

  // Yahoo سقط كلياً لهذا الرمز -> جرّب Stooq لليومي حتى لا ينقطع السهم
  if (!rec.tf["1d"]?.c?.length) {
    try {
      const { candles } = await fetchStooqDaily(sym);
      rec.tf["1d"] = { updated: now, c: slimCandles(candles.slice(-KEEP)) };
      rec.src = "stooq";
      touched = true;
    } catch (e) { errors.push(`stooq: ${e.message}`); }
  }

  if (!Object.keys(rec.tf).length) {
    // لا شموع من أي مصدر — لو عندنا سعر من Finnhub نُدرج السهم بسعر فقط
    // بلا شارت/مؤشرات بدل استبعاده بالكامل (الواجهة تتعامل مع هذا أصلاً)
    const q = quotes?.[sym];
    if (!(q && Number.isFinite(q.regularMarketPrice) && q.regularMarketPrice > 0)) {
      throw new Error(errors.join(" | ") || "no data");
    }
    rec.src = "finnhub";
    rec.noChart = true;
  }

  /* اشتقاق فريم 4 ساعات من الساعة (Yahoo لا يوفّره).

     من السلسلة **الكاملة** حين تتوفّر، فتخرج 260 شمعة بدل 65 — وهو فرقُ
     وجودِ EMA200 من عدمه. وبلا e200 تسقط بوابتا الاتجاه الأمّ (‎4.0‎ من
     ‎8.5‎) فيقيس الفريم المدى القصير وحده ويُسمّى «اتجاهاً»، وأصغر خطوةٍ
     فيه تصير ‎11.11‎ — أي أنه عاجزٌ بنيوياً عن التعبير عن ميلٍ ضعيف
     فيسقط من `allTF` وإن كان له جهةٌ حقيقية. قِيس: 96 رمزاً من 96 بلا
     e200 على 4h، و`MSFT` و`V` تسقطان من توافق الفريمات بسببها وحدها.

     وحين لا تتوفّر الكاملة (الساعة لم تُجدَّد هذا التشغيل) نُبقي 4h
     المخزَّنة كما هي بدل إعادة اشتقاقها قصيرة — وإلا تذبذب طولها بين
     التشغيلات فتذبذبت معه النتيجة. */
  if (full1h?.length) {
    rec.tf["4h"] = { updated: rec.tf["1h"].updated, c: slimCandles(aggregate(full1h, 4).slice(-KEEP)), derived: true };
  } else if (prev?.tf?.["4h"]?.c?.length) {
    /* 4h ليس في `frames` فلا يمرّ بحلقة الجلب، ولا يُنقل من `prev`
       تلقائياً. وبلا نقله هنا يُعاد اشتقاقه من الساعة **المقصوصة** في كل
       تشغيلٍ لا تُجدَّد فيه الساعة — فيهبط من 260 شمعة إلى 65 ويضيع
       e200 الذي بُني قبل دقائق. أثرٌ صامت: الطول يتذبذب بين التشغيلات
       ومعه نتيجة الفريم كلها. */
    rec.tf["4h"] = prev.tf["4h"];
  } else if (rec.tf["1h"]?.c?.length) {
    // أول مرة ولا ساعةَ كاملة: مشتقٌّ قصير خيرٌ من فريمٍ غائب
    rec.tf["4h"] = { updated: rec.tf["1h"].updated, c: slimCandles(aggregate(rec.tf["1h"].c, 4).slice(-KEEP)), derived: true };
  }

  // المؤشرات لكل فريم
  rec.an = {};
  for (const tf of AN_TFS) {
    const a = rec.tf[tf]?.c ? analyze(rec.tf[tf].c) : null;
    if (!a) continue;
    const { series, ...rest } = a;                    // لا نحفظ السلاسل الكاملة (حجم)
    rec.an[tf] = slimAnalysis(rest);
  }
  rec.score = r2(overallScore(rec.an));
  /* النطاق المثبَّت — لا يُغيَّر إلا بتجاوز حدّه بهامش. يُحسب هنا لا في
     المتصفح لأن الهيستريسس يحتاج ذاكرةً بالدورة السابقة، والخادم هو من
     يملكها (`prev`). والمتصفح يعرضه كما هو فلا يختلف وسمُ شاشتين. */
  rec.band = bandStable(rec.score, prev?.band);
  rec.stale = !touched;
  if (errors.length) rec.errors = errors;
  return rec;
}

/* ---------- التشغيل ---------- */
async function main() {
  const now = Date.now();
  const prevDir = fs.existsSync(path.join(OUT, "meta.json")) ? OUT : OUT;   // نبني فوق ما هو موجود
  fs.mkdirSync(OUT, { recursive: true });

  const universe = cfg.symbols;
  const cryptoAll = cfg.crypto || [];
  const wideAll = cfg.wide || [];
  console.log(`▶ ${universe.length} مرشّحاً أساسياً · ${cryptoAll.length} عملة رقمية · ${wideAll.length} في الطبقة الواسعة`);

  // الترتيب اليومي يحدد الـ70؛ إن لم يوجد بعد نأخذ ترتيب الملف
  const ranking = readJSON(path.join(OUT, "ranking.json"));
  // الأساسيات اليومية تسدّ ما لا تعطيه أسعار Finnhub المجانية (نطاق 52
  // أسبوعاً ومتوسط الحجم). بدونها كانت هذه الحقول null دائماً في الملخص،
  // فيسقط فرز "حجم التداول" في الواجهة صامتاً.
  const fundamentals = readJSON(path.join(OUT, "fundamentals.json"))?.f || {};
  const chosen = ranking?.top?.length
    ? universe.filter(u => ranking.top.includes(u.s)).sort((a, b) => ranking.top.indexOf(a.s) - ranking.top.indexOf(b.s))
    : universe.slice(0, cfg.top);
  console.log(`  الرموز المختارة: ${chosen.length} ${ranking?.top?.length ? "(من الترتيب اليومي)" : "(ترتيب مبدئي)"}`);

  // ترتيب المعالجة حسب الحاجة، لا حسب القيمة السوقية: صلاحية فريم 15 دقيقة
  // صفر أي "قديم دائماً"، فالرموز الممتلئة تستهلك ميزانية التشغيل كاملةً في
  // تحديث نفسها ولا يصل الدور أبداً لمن لا يملك شمعة واحدة — عالقاً عند 14
  // من 70 مهما تكرّرت التشغيلات. من يفتقد اليومي أولاً، ثم الساعة، ثم 15د.
  const needRank = (s) => {
    const tf = readJSON(path.join(OUT, "sym", `${s}.json`))?.tf || {};
    if (!tf["1d"]?.c?.length) return 0;
    if (!tf["1h"]?.c?.length) return 1;
    if (!tf["15m"]?.c?.length) return 2;
    return 3;
  };
  const order = new Map(chosen.map(c => [c.s, needRank(c.s)]));
  chosen.sort((a, b) => order.get(a.s) - order.get(b.s));
  const needy = [...order.values()].filter(v => v < 3).length;
  if (needy) console.log(`  رموز ناقصة الشمعات: ${needy} — لها أولوية الميزانية`);

  // الطبقة الواسعة: من انقضت صلاحية يوميّه فقط، بسقف لكل تشغيل.
  // نقرأ أعمارها من wide.json لا من 414 ملفاً على القرص — فحص الملفات
  // واحداً واحداً يقرأ عشرات الميغابايتات في كل دورة بلا داعٍ.
  const prevWide = readJSON(path.join(OUT, "wide.json"))?.rows || [];
  const wideAge = new Map(prevWide.map(r => [r.s, r.u || 0]));
  const wideDue = wideAll
    .filter(m => (now - (wideAge.get(m.s) ?? 0)) >= MAX_AGE["1d"])
    .sort((a, b) => (wideAge.get(a.s) ?? 0) - (wideAge.get(b.s) ?? 0))   // الأقدم أولاً
    .slice(0, WIDE_PER_RUN);
  if (wideAll.length)
    console.log(`  الطبقة الواسعة: ${wideDue.length} مستحقّ من ${wideAll.length} (سقف ${WIDE_PER_RUN}/تشغيل)`);

  // الوظائف: الأساسية والكريبتو بالفريمات الثلاثة، والواسعة باليومي وحده
  const FULL = ["1d", "1h", "15m", "5m"];
  const jobs = [
    ...chosen.map(m => ({ m, frames: FULL, tier: "core" })),
    ...cryptoAll.map(m => ({ m, frames: FULL, tier: "core" })),
    ...wideDue.map(m => ({ m, frames: ["1d"], tier: "wide" }))
  ];

  // 1) دفعة الأسعار.
  // ترتيب المصدر يتبع مكان التشغيل كما في الشموع: Finnhub المجاني طلبٌ لكل
  // رمز بحد 60/دقيقة، فـ 160 رمزاً تعني أكثر من دقيقتين ونصف — أطول من دورة
  // الأسعار نفسها. Yahoo يجمع 40 رمزاً في الطلب الواحد، فيكفيه أربعة طلبات.
  // محلياً Yahoo أولاً إذن، وسحابياً يبقى Finnhub أولاً لأن Yahoo محظور هناك.
  const allSymbols = [...jobs.map(j => j.m.s), ...cfg.indices.map(i => i.s),
                      ...cfg.indices.map(i => i.proxy).filter(Boolean)];
  let quotes = null;
  const tryQuotes = async (label, fn) => {
    if (quotes) return;
    try {
      quotes = await fn(allSymbols);
      console.log(`  ✓ أسعار ${label}: ${quotes ? Object.keys(quotes).length : 0} رمز`);
    } catch (e) { console.warn(`  ⚠ أسعار ${label} فشلت: ${e.message}`); }
  };
  if (PREFER_YAHOO) {
    await tryQuotes("Yahoo (دفعات)", fetchQuotes);
    await tryQuotes("Finnhub (احتياط)", fetchQuotesFinnhub);
  } else {
    await tryQuotes("Finnhub", fetchQuotesFinnhub);
    await tryQuotes("Yahoo (احتياط)", fetchQuotes);
  }

  // 2) الشموع
  // حد Twelve Data (8/دقيقة) عام لا لكل رمز، فالتوازي معه يتجاوزه ويهدر
  // الرصيد على طلبات مرفوضة — نسلسل حين يكون مفعَّلاً
  // التسلسل مفروض بحد Twelve Data (8/دقيقة عام لا لكل رمز). حين يكون Yahoo
  // هو المصدر الأول (تشغيل محلي) فلا حد يقيّدنا، فنتوازى ونختصر الوقت
  // من ~28 دقيقة إلى دقائق معدودة لكل الرموز السبعين.
  const lanes = (hasTwelveData() && !PREFER_YAHOO) ? 1 : 3;
  const results = await pool(jobs, lanes, (j) => buildSymbol(j.m, OUT, now, quotes, j.frames, j.tier));
  const rows = [], wideRecs = [], failed = [], frozen = [];
  results.forEach((r, i) => {
    const j = jobs[i];
    if (!r.ok) { failed.push({ s: j.m.s, error: r.error }); console.warn(`  ✗ ${j.m.s}: ${r.error}`); return; }
    // رمزٌ مجمَّد يُستبعد من الملخّص كاملاً: وجودُه بسعرٍ وهميّ أسوأ من
    // غيابه، لأنه يبدو حالةَ سوق ويدخل الإحصاء والفرص
    if (frozenSeries(r.value)) {
      frozen.push(j.m.s);
      console.warn(`  ⃠ ${j.m.s}: سلسلة مجمّدة بلا حجم — مستبعد`);
      return;
    }
    (j.tier === "wide" ? wideRecs : rows).push(r.value);
  });
  if (frozen.length) console.warn(`  ⃠ مستبعدة لتجمّد سلسلتها: ${frozen.join(" ")}`);
  console.log(`  ✓ نجح ${rows.length + wideRecs.length} / ${jobs.length}`);
  // بوابة السلامة على الطبقة الأساسية وحدها: الواسعة تراكمية، وتشغيل لم
  // يستحقّ فيه أي رمز واسع تحديثاً ليس فشلاً.
  if (!rows.length) throw new Error("لم ينجح أي رمز أساسي — لن نكتب فوق البيانات السليمة");

  // 3) ملفات الأسهم + صفوف الملخص
  let bytes = 0;
  // نفس بناء الصف للطبقتين — نسختان تعنيان حقلاً يُضاف لواحدة وتُنسى فيه
  // الأخرى، فيظهر السهم الموسّع ناقصاً بلا سبب ظاهر. الفرق الوحيد `spark`:
  // ثلاثون رقماً لكل صف تضاعف حجم ملف الطبقة الواسعة بلا فائدة في القائمة.
  const buildRow = (rec, withSpark) => {
    const packed = { ...rec, v: 2, tf: {} };
    for (const [tf, o] of Object.entries(rec.tf)) packed.tf[tf] = { ...o, c: packCandles(o.c) };
    bytes += writeJSON(`sym/${rec.s}.json`, packed);
    const q = quotes?.[rec.s];
    const fnd = fundamentals[rec.s];
    const d1 = rec.tf["1d"]?.c || [];
    const lastC = d1.length ? d1[d1.length - 1].c : null;
    const prevC = d1.length > 1 ? d1[d1.length - 2].c : null;
    const lastV = d1.length ? num(d1[d1.length - 1].v) : null;

    const price = num(q?.regularMarketPrice) ?? rec.cur ?? lastC;
    const chg = num(q?.regularMarketChangePercent)
      ?? (lastC && prevC ? (lastC - prevC) / prevC * 100 : null);

    // سعر ما قبل / بعد الإغلاق
    let ext = null;
    if (num(q?.preMarketPrice) !== null)
      ext = { k: "PRE", p: rp(num(q.preMarketPrice)), c: r2(num(q.preMarketChangePercent)) };
    else if (num(q?.postMarketPrice) !== null)
      ext = { k: "POST", p: rp(num(q.postMarketPrice)), c: r2(num(q.postMarketChangePercent)) };

    // الشرارة أيضاً: toFixed(2) يجعل خط شيبا صفراً مستقيماً
    const spark = (rec.tf["1h"]?.c || d1).slice(-30).map(x => rp(x.c));

    return {
      s: rec.s, ar: rec.ar, en: rec.en, sec: rec.sec, ...(rec.mkt ? { mkt: rec.mkt } : {}),
      p: rp(price), chg: r2(chg), ext, ...(withSpark ? { spark } : {}),
      score: rec.score,
      ...(Number.isFinite(rec.band) ? { band: rec.band } : {}),
      atr: rp(rec.an["1d"]?.atr ?? null), rsi: r2(rec.an["1d"]?.rsi ?? null),
      /* قوّة الاتجاه والانضغاط والتباعد من الفريم اليومي.
         تُنشر في صفّ الملخّص لا في ملف الرمز وحده لأن شروط الماسح تعمل
         على الصفوف كلّها قبل فتح أي رمز — قراءتُها من ملف الرمز تعني
         تحميل 510 ملفاً لعرض شاشة الفرص.
         و`div` رقمٌ لا كائن: ‎+1‎ صاعد و‎−1‎ هابط، والاتجاه هو كلّ ما
         يُصفّى عليه. وتخزينُ كائنٍ لكل صفّ يضاعف حجماً يُقرأ في كل
         تحميل صفحة. */
      /* المتوسّطات الثلاثة في الصفّ: شرطُ «ارتدادٍ داخل اتجاه صاعد»
         يحتاج أن يفرّق بين الاتجاه الأمّ (e200/e50) والزخم القصير
         (e20) — وهو تفريقٌ لا تعطيه `score` لأنها تجمعهما في رقمٍ
         واحد، بل إنّ تساويَهما بالضبط هو ما يُخرجها صفراً. وتُنشر في
         الصفّ لا في ملف الرمز لأن الماسح يمرّ على الكون قبل فتح رمز. */
      e20: rp(rec.an["1d"]?.e20 ?? null), e50: rp(rec.an["1d"]?.e50 ?? null),
      e200: rp(rec.an["1d"]?.e200 ?? null),
      adx: r2(rec.an["1d"]?.adx ?? null), pdi: r2(rec.an["1d"]?.pdi ?? null),
      mdi: r2(rec.an["1d"]?.mdi ?? null), squeeze: r2(rec.an["1d"]?.squeeze ?? null),
      ...(rec.an["1d"]?.div?.dir ? { div: rec.an["1d"].div.dir } : {}),
      tfScore: Object.fromEntries(TFS.filter(t => rec.an[t]).map(t => [t, +rec.an[t].score.toFixed(1)])),
      mc: num(q?.marketCap) ?? ranking?.mc?.[rec.s] ?? null,
      // حجم آخر شمعة يومية = حجم الجلسة الجارية (أو آخر جلسة مكتملة حين
      // يكون السوق مغلقاً). أدق من متوسط عشرة أيام، فنقدّمه عليه.
      vol: num(q?.regularMarketVolume) ?? (lastV || null) ?? num(fnd?.avgVol),
      w52h: rp(num(q?.fiftyTwoWeekHigh) ?? num(fnd?.w52h)),
      w52l: rp(num(q?.fiftyTwoWeekLow) ?? num(fnd?.w52l)),
      stale: !!rec.stale, src: rec.src
    };
  };

  const summary = rows.map(rec => buildRow(rec, true));
  summary.sort((a, b) => (b.mc ?? 0) - (a.mc ?? 0));

  // الطبقة الواسعة تراكمية: كل تشغيل يجدّد حصّته فقط، فندمج الجديد فوق
  // القديم بدل استبداله. بلا الدمج يخرج الملف بستين صفاً كل مرة وينهار
  // البحث إلى آخر دفعة جُلبت.
  /* رمزٌ رُقّي إلى الأساسية يخرج من الواسعة. الملف تراكمي فلا يخرج
     وحده، ولو بقي لظهر **مرّتين** في `allRows()` — صفٌّ بأربعة فريمات
     وآخر بفريمٍ واحد — فيُحسب مرّتين في كل ما يمرّ على الكون. */
  const coreSyms = new Set(cfg.symbols.map(x => x.s));
  const wideMerged = new Map(prevWide.filter(r => !coreSyms.has(r.s)).map(r => [r.s, r]));
  for (const rec of wideRecs) if (!coreSyms.has(rec.s)) wideMerged.set(rec.s, { ...buildRow(rec, false), u: now });
  const wideRows = [...wideMerged.values()].sort((a, b) => (b.mc ?? 0) - (a.mc ?? 0));
  /* البوابة تقارن بما كان **بعد** استبعاد المرقّى: تقلّصٌ مشروح بالترقية
     ليس خطأ دمج، وتقلّصٌ بلا سبب هو الخطأ الذي بُنيت له. */
  const prevKept = prevWide.filter(r => !coreSyms.has(r.s)).length;
  if (wideRows.length < prevKept)
    throw new Error(`الطبقة الواسعة تقلّصت ${prevKept}→${wideRows.length} — لن نكتب`);
  bytes += writeJSON("wide.json", { updated: now, count: wideRows.length, rows: wideRows });
  console.log(`  ✓ الطبقة الواسعة: ${wideRows.length} صفاً (+${wideRecs.length} محدَّثاً)`);

  // 4) المؤشرات العامة + اتساع السوق + القطاعات
  const idxRows = [];
  for (const ix of cfg.indices) {
    const q = quotes?.[ix.s];
    let p = num(q?.regularMarketPrice), chg = num(q?.regularMarketChangePercent);
    if (p === null) {
      try {
        const { candles } = await fetchChart(ix.s, { range: "1mo", interval: "1d" });
        const a = candles[candles.length - 1], b = candles[candles.length - 2];
        p = a?.c ?? null; chg = (a && b) ? (a.c - b.c) / b.c * 100 : null;
      } catch (e) { console.warn(`  ⚠ مؤشر ${ix.s}: ${e.message}`); }
    }
    // Finnhub المجاني يرفض رموز المؤشرات (^GSPC) لكنه يعطي صناديق ETF التي
    // تتبعها. نسبة التغيّر منها تكاد تطابق المؤشر وهي المطلوبة لمزاج السوق،
    // أما المستوى نفسه (4,600 نقطة) فلا يُشتق من سعر الصندوق فنتركه شرطة
    // بدل عرض سعر ETF موهماً أنه مستوى المؤشر.
    let viaProxy = false;
    if (chg === null && ix.proxy) {
      const pq = quotes?.[ix.proxy];
      const pc = num(pq?.regularMarketChangePercent);
      if (pc !== null) { chg = pc; viaProxy = true; }
    }
    idxRows.push({ s: ix.s, ar: ix.ar, en: ix.en, p: r2(p), chg: r2(chg), ...(viaProxy ? { proxy: ix.proxy } : {}) });
  }

  // اتساع السوق ومزاجه وقطاعاته تصف **السوق الأمريكي**. الكريبتو يتحرك
  // بمدى يومي أوسع بمراتب، فبيتكوين وحده يزيح متوسط "مزاج السوق" ويحتل
  // قائمتَي الرابحين والخاسرين كل يوم تقريباً. يبقى في الملخّص ويخرج من
  // الإحصاء.
  const usRows = summary.filter(r => r.mkt !== "crypto");
  // Number.isFinite لا isFinite: العالمية تحوّل null إلى صفر، فسهم بلا
  // سعر يُحسب "تغيّر 0%" ويدخل متوسط قطاعه ويجرّه نحو الصفر
  const withChg = usRows.filter(r => Number.isFinite(r.chg));
  const bySector = {};
  for (const r of withChg) {
    (bySector[r.sec] ||= { sec: r.sec, n: 0, sum: 0 });
    bySector[r.sec].n++; bySector[r.sec].sum += r.chg;
  }
  const sectors = Object.values(bySector)
    .map(x => ({ sec: x.sec, n: x.n, avg: r2(x.sum / x.n) }))
    .sort((a, b) => b.avg - a.avg);

  const scored = usRows.filter(r => Number.isFinite(r.score));
  // فترات التداول من رمز أمريكي حصراً: الكريبتو يتداول 24/7 وميتاداتاه
  // تعطي نافذة يوم كامل، فتقول الترويسة "السوق مفتوح" ليل السبت.
  const period = rows.find(r => r.mkt !== "crypto" && r.period)?.period || null;
  const status = period ? marketStatus(period, now) : approxMarketStatus(now);

  const mktScore = scored.length ? r2(scored.reduce((a, r) => a + r.score, 0) / scored.length) : null;
  const mktBand = bandStable(mktScore, readJSON(path.join(OUT, "market.json"), {})?.band);

  writeJSON("market.json", {
    updated: now, status, period, indices: idxRows, sectors,
    breadth: {
      up: withChg.filter(r => r.chg > 0).length,
      down: withChg.filter(r => r.chg < 0).length,
      flat: withChg.filter(r => r.chg === 0).length,
      total: withChg.length
    },
    marketScore: mktScore,
    // ونطاقُه مثبَّتٌ كنطاق السهم: «مزاج السوق» يتقلّب بين وسمين في نصف
    // ساعة يُقرأ إشاراتٍ متناقضة لا رقماً يهتزّ
    ...(Number.isFinite(mktBand) ? { band: mktBand } : {}),
    gainers: [...withChg].sort((a, b) => b.chg - a.chg).slice(0, 5).map(r => ({ s: r.s, ar: r.ar, chg: r.chg, p: r.p })),
    losers:  [...withChg].sort((a, b) => a.chg - b.chg).slice(0, 5).map(r => ({ s: r.s, ar: r.ar, chg: r.chg, p: r.p }))
  });

  writeJSON("summary.json", { updated: now, count: summary.length, rows: summary });

  const prevMeta = readJSON(path.join(OUT, "meta.json"), {});
  writeJSON("meta.json", {
    ...prevMeta,
    marketUpdated: now,
    marketRun: {
      at: new Date(now).toISOString(),
      ok: rows.length, failed: failed.length, failures: failed,
      // مستبعدة لتجمّد سلسلتها — تظهر في التشخيص لا تختفي بصمت
      ...(frozen.length ? { frozen } : {}),
      stale: summary.filter(r => r.stale).map(r => r.s),
      quotes: quotes ? Object.keys(quotes).length : 0,
      requests: stats.requests, retries: stats.retries, sources: stats.sources,
      finnhub: { requests: fhStats.requests, failures: fhStats.failures },
      twelvedata: { requests: tdStats.requests, failures: tdStats.failures, budget: TD_PER_RUN }
    }
  });

  console.log(`✔ كُتب ${summary.length} سهماً (${(bytes / 1024).toFixed(0)} ك.ب) · حالة السوق: ${status.ar}`);
  console.log(`  طلبات: ${stats.requests} · إعادة محاولة: ${stats.retries} · إخفاقات: ${stats.failures}`);
  if (failed.length) console.log(`  ⚠ رموز فاشلة: ${failed.map(f => f.s).join(", ")}`);
}

/* ---------- فحص ذاتي بلا شبكة ---------- */
function selfCheck() {
  console.log("▶ فحص ذاتي (بلا شبكة)\n");
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; } };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

  /* الخاصيّة لا الرقم: `!== 90` كان يُسقط الفحص عند إضافة أيّ مرشّح،
     فيدفع إلى تخفيف الفحص بدل قراءته. المطلوب أن يكفي المرشّحون للاختيار
     منهم وأن يكون لكلٍّ حقولُه — لا أن يبقى العدد كما كان يوم كُتب. */
  t("symbols.json صالح ومرشّحوه يكفون الاختيار", () => {
    if (!Array.isArray(cfg.symbols) || !cfg.symbols.length) throw new Error("لا مرشّحين");
    if (!Number.isFinite(cfg.top) || cfg.top <= 0) throw new Error("top غير صالح");
    if (cfg.symbols.length < cfg.top)
      throw new Error(`${cfg.symbols.length} مرشّحاً و${cfg.top} مطلوب`);
    for (const s of cfg.symbols) if (!s.s || !s.ar || !s.sec) throw new Error(`حقل ناقص في ${s.s}`);
  });

  t("الطبقتان الواسعة والكريبتو لا تتقاطعان مع الأساسية", () => {
    const core = new Set(cfg.symbols.map(s => s.s));
    if (!cfg.wide?.length) throw new Error("لا طبقة واسعة");
    if (!cfg.crypto?.length) throw new Error("لا كريبتو");
    const seen = new Set(core);
    for (const s of [...cfg.wide, ...cfg.crypto]) {
      if (!s.s || !s.en || !s.sec) throw new Error(`حقل ناقص في ${s.s}`);
      if (seen.has(s.s)) throw new Error(`${s.s} مكرّر بين الطبقات`);
      seen.add(s.s);
    }
    for (const c of cfg.crypto) if (c.mkt !== "crypto") throw new Error(`${c.s} بلا mkt`);
  });

  t("سقف الطبقة الواسعة يكفي لتجديدها داخل صلاحية اليومي", () => {
    const runsPerTTL = MAX_AGE["1d"] / (10 * 60e3);          // دورة السوق 10 دقائق
    if (WIDE_PER_RUN * runsPerTTL < cfg.wide.length)
      throw new Error(`${WIDE_PER_RUN}/تشغيل لا تكفي ${cfg.wide.length} رمزاً`);
  });

  const H = 3600e3;
  t("stale() يحترم أعمار الفريمات", () => {
    const now = 1_700_000_000_000;
    eq(stale({ tf: { "15m": { updated: now - 60e3 } } }, "15m", now), true, "15m دائماً");
    eq(stale({ tf: { "1h": { updated: now - 10 * 60e3 } } }, "1h", now), false, "1h حديث");
    eq(stale({ tf: { "1h": { updated: now - 2 * H } } }, "1h", now), true, "1h قديم");
    eq(stale({ tf: { "1d": { updated: now - 5 * H } } }, "1d", now), false, "1d حديث");
    eq(stale({ tf: { "1d": { updated: now - 25 * H } } }, "1d", now), true, "1d قديم");
    eq(stale(null, "1d", now), true, "لا بيانات سابقة");
  });

  t("الفريم اليومي يتجدّد أثناء الجلسة ويتجمّد خارجها", () => {
    const T = (iso) => Date.parse(iso);
    const REG  = T("2026-09-11T15:00:00Z");   // 11:00 نيويورك — جلسة
    const PRE  = T("2026-09-11T12:00:00Z");   // 08:00 — ما قبل الافتتاح
    const POST = T("2026-09-11T22:00:00Z");   // 18:00 — بعد الإغلاق
    const SAT  = T("2026-09-12T10:00:00Z");   // السبت — مغلق

    eq(dailyIsLive(REG),  true,  "الجلسة حيّة");
    eq(dailyIsLive(POST), true,  "بعد الإغلاق حيّ — لالتقاط الإغلاق الرسمي");
    eq(dailyIsLive(PRE),  false, "ما قبل الافتتاح: شمعة اليوم لم تبدأ");
    eq(dailyIsLive(SAT),  false, "السبت مغلق");
    eq(dailyIsLive(SAT, "crypto"), true, "الكريبتو بلا إغلاق");

    // الأثر: يوميٌّ عمره ساعتان قديمٌ في الجلسة وحديثٌ خارجها
    const twoH = { tf: { "1d": { updated: REG - 2 * H } } };
    eq(stale(twoH, "1d", REG, dailyIsLive(REG)), true,  "ساعتان في الجلسة = قديم");
    eq(stale({ tf: { "1d": { updated: SAT - 2 * H } } }, "1d", SAT, dailyIsLive(SAT)),
      false, "ساعتان خارج الجلسة = حديث");
    // والطبقة الواسعة تبقى على العشرين ساعة مهما كانت الجلسة
    eq(stale(twoH, "1d", REG, false), false, "الواسعة لا تتأثر بالجلسة");
    // والفريمات الأخرى لم تُمَس
    eq(stale({ tf: { "1h": { updated: REG - 10 * 60e3 } } }, "1h", REG, true), false, "1h كما كان");
  });

  t("marketStatus يميّز الجلسات الأربع", () => {
    const base = 1_700_000_000_000;
    const p = { pre: { start: base, end: base + 5 * H }, regular: { start: base + 5 * H, end: base + 11 * H }, post: { start: base + 11 * H, end: base + 15 * H } };
    eq(marketStatus(p, base + 1 * H).state, "PRE", "قبل الافتتاح");
    eq(marketStatus(p, base + 7 * H).state, "REGULAR", "مفتوح");
    eq(marketStatus(p, base + 12 * H).state, "POST", "بعد الإغلاق");
    eq(marketStatus(p, base + 20 * H).state, "CLOSED", "مغلق");
    eq(marketStatus(null, base).state, "UNKNOWN", "بلا فترات");
  });

  t("approxMarketStatus يميّز الجلسات بتوقيت نيويورك", () => {
    // 15 يناير 2024 — لا توقيت صيفي (EST = UTC-5)
    eq(approxMarketStatus(Date.UTC(2024, 0, 15, 12, 0)).state, "PRE", "7ص محلي");
    eq(approxMarketStatus(Date.UTC(2024, 0, 15, 15, 0)).state, "REGULAR", "10ص محلي");
    eq(approxMarketStatus(Date.UTC(2024, 0, 15, 22, 0)).state, "POST", "5م محلي");
    eq(approxMarketStatus(Date.UTC(2024, 0, 13, 15, 0)).state, "CLOSED", "سبت");
  });

  t("packCandles/unpackCandles رحلة ذهاب وعودة", () => {
    const c = [{ t: 1_700_000_000_000, o: 1.5, h: 2.5, l: 1, c: 2, v: 100 },
               { t: 1_700_000_060_000, o: 2, h: 3, l: 1.8, c: 2.8, v: 200 }];
    const round = unpackCandles(packCandles(c));
    eq(round, c, "الشكل يعود كما كان");
    // الخلل الفعلي: مصفوفة مضغوطة تُستخدم بلا فك، فـ x.c غير معرّف
    if (packCandles(c)[0].c !== undefined) throw new Error("المضغوط يجب ألا يحمل c");
    if (typeof round[0].c.toFixed !== "function") throw new Error("المفكوك يجب أن يحمل رقماً في c");
    eq(unpackCandles(c), c, "المفكوك أصلاً يمرّ كما هو");
  });

  t("أولوية الميزانية للرموز الناقصة لا الممتلئة", () => {
    // نحاكي منطق needRank: الرمز الفارغ يسبق الممتلئ مهما كان ترتيبه الأصلي
    const rank = (tf) => !tf["1d"]?.c?.length ? 0
                       : !tf["1h"]?.c?.length ? 1
                       : !tf["15m"]?.c?.length ? 2 : 3;
    const full  = { "1d": { c: [1] }, "1h": { c: [1] }, "15m": { c: [1] } };
    const empty = {};
    eq([rank(empty), rank(full)], [0, 3], "الفارغ أولى من الممتلئ");
    eq(rank({ "1d": { c: [1] } }), 1, "ناقص الساعة");
    eq(rank({ "1d": { c: [1] }, "1h": { c: [1] } }), 2, "ناقص 15 دقيقة");
    const sorted = [{ s: "ممتلئ", t: full }, { s: "فارغ", t: empty }]
      .sort((a, b) => rank(a.t) - rank(b.t)).map(x => x.s);
    eq(sorted, ["فارغ", "ممتلئ"], "الترتيب يقدّم الناقص");
  });

  t("tradingOnly يُسقط حشو الجلسات المغلقة ولا يمحو سلسلةً بلا حجم", () => {
    // 300 شمعة تداول + 300 حشو بحجم صفر -> يبقى التداول وحده
    const mk = (n, v) => Array.from({ length: n }, (_, i) => ({ t: i, o: 1, h: 1, l: 1, c: 1, v }));
    eq(tradingOnly([...mk(300, 5000), ...mk(300, 0)], "15m").length, 300, "الحشو يُسقط");
    // مصدرٌ لا يعطي حجماً إطلاقاً: الإسقاط يمحو كل شيء، فالبوابة تُعيد الأصل
    eq(tradingOnly(mk(300, 0), "15m").length, 300, "بلا حجم يبقى الأصل");
    // ما بقي أقلّ من EMA200 + هامش -> الأصل كذلك، بياناتٌ مشوَّشة أفضل من لا بيانات
    eq(tradingOnly([...mk(100, 5000), ...mk(300, 0)], "15m").length, 400, "الناقص يبقى الأصل");
    // الفريمات الأخرى لا تُمسّ: تأتي بلا prePost وحجمها حقيقي أصلاً
    eq(tradingOnly([...mk(10, 5000), ...mk(10, 0)], "1d").length, 20, "اليومي لا يُمسّ");
  });

  t("frozenSeries يكشف الأصل الميت ولا يطعن في السهم الهادئ", () => {
    const bars = (n, c, v) => Array.from({ length: n }, (_, i) => ({ t: i, o: c, h: c, l: c, c, v }));
    const rec = (c, src = "yahoo") => ({ src, tf: { "1d": { c } } });
    // `ARB-USD` بالحرف: سعرٌ واحد بحجم صفر
    if (!frozenSeries(rec(bars(40, 0.000629, 0)))) throw new Error("الميت لم يُكشف");
    // سهمٌ هادئ جداً لكن له حجم -> ليس ميتاً
    if (frozenSeries(rec(bars(40, 50, 900000)))) throw new Error("الهادئ اتُّهم ظلماً");
    // مصدرٌ لا يعطي حجماً -> لا حكم عليه أصلاً
    if (frozenSeries(rec(bars(40, 50, 0), "twelvedata"))) throw new Error("مصدر بلا حجم لا يُحاكم");
    // سلسلةٌ متحركة بحجم صفر (حشو): مسطَّحة؟ لا -> ليست مجمّدة
    const moving = Array.from({ length: 40 }, (_, i) => ({ t: i, o: 50 + i, h: 50 + i, l: 50 + i, c: 50 + i, v: 0 }));
    if (frozenSeries(rec(moving))) throw new Error("المتحركة ليست مجمّدة");
    // سلسلةٌ أقصر من نافذة الحكم: لا حكم
    if (frozenSeries(rec(bars(10, 1, 0)))) throw new Error("القصيرة لا يُحكم عليها");
  });

  t("فريم 5د يُحلَّل ولا يتسرّب إلى النتيجة الفنية", () => {
    // الحارس الحقيقي: `overallScore` و`tfScore` يدوران على `TFS` وحدها،
    // فوجود `an["5m"]` يجب ألّا يغيّر رقماً واحداً. وبلا هذا الفحص يمرّ
    // تعديلٌ يضيف 5د إلى `TFS` بلا أن يبدو شيءٌ معطّلاً — فتتغيّر نتيجة
    // كل رمز في الكون ويُبطل الأرشيف بصمت.
    eq(TFS.length, 4, "TFS أربعة لا خمسة");
    if (TFS.includes("5m")) throw new Error("5د تسرّب إلى TFS");
    if (!AN_TFS.includes("5m")) throw new Error("5د غائب عن قائمة التحليل");
    const four = { "15m": { score: 10 }, "1h": { score: 20 }, "4h": { score: 30 }, "1d": { score: 40 } };
    const five = { ...four, "5m": { score: -100 } };
    eq(overallScore(five), overallScore(four), "5د لا يغيّر النتيجة الكلية");
    const tfs = (an) => Object.fromEntries(TFS.filter(t => an[t]).map(t => [t, an[t].score]));
    eq(Object.keys(tfs(five)).length, 4, "tfScore يبقى بأربعة مفاتيح");
    // و`allTF` في scans.js تشترط أربعة بالضبط — خامسٌ يُسقط الشرطين معاً
    eq(Object.values(tfs(five)).length === 4, true, "allTF ما زالت تجد أربعة");
  });

  t("aggregate يبني 4h صحيحة من 1h", () => {
    const c = [{ t: 0, o: 1, h: 5, l: 0.5, c: 2, v: 10 }, { t: 1, o: 2, h: 6, l: 1, c: 3, v: 10 },
               { t: 2, o: 3, h: 4, l: 2, c: 4, v: 10 }, { t: 3, o: 4, h: 9, l: 3, c: 5, v: 10 }];
    const [b] = aggregate(c, 4);
    eq([b.o, b.h, b.l, b.c, b.v], [1, 9, 0.5, 5, 40], "شمعة مجمّعة");
  });

  t("analyze يعطي إشارات صحيحة", () => {
    const up = Array.from({ length: 300 }, (_, i) => ({ t: i, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i, v: 1 }));
    if (analyze(up).score < 50) throw new Error("صعود لم يُكتشف");
    const dn = up.slice().reverse().map((x, i) => ({ ...x, t: i }));
    if (analyze(dn).score > -50) throw new Error("هبوط لم يُكتشف");
    if (analyze(up.slice(0, 5)) !== null) throw new Error("سلسلة قصيرة يجب أن تعيد null");
  });

  t("overallScore يزن الفريمات الكبيرة أكثر", () => {
    const s = overallScore({ "15m": { score: -100 }, "1h": { score: -100 }, "4h": { score: 100 }, "1d": { score: 100 } });
    const expect = (-100 * 0.5 + -100 * 1 + 100 * 1.5 + 100 * 2) / 5;
    if (Math.abs(s - expect) > 1e-9) throw new Error(`${s} ≠ ${expect}`);
    if (s <= 0) throw new Error("الفريمات الكبيرة يجب أن ترجّح النتيجة للصعود");
    eq(overallScore({}), null, "بلا فريمات");
  });

  t("rp يحفظ أسعار الأصول الرخيصة ولا يمحوها", () => {
    // شيبا إينو بسعر حقيقي 0.0000051 — التقريب لأربع خانات كان يعطي صفراً
    eq(rp(0.0000051), 0.0000051, "سعر دون المليونية");
    eq(rp(0.00000512345678), 0.00000512346, "ستة أرقام معنوية");
    eq(rp(0.5), 0.5, "أقل من واحد");
    // الأسعار العادية كما كانت: أربع خانات عشرية
    eq(rp(62.014999389648438), 62.015, "سعر سهم");
    eq(rp(5812.3456789), 5812.3457, "سعر مرتفع");
    eq(rp(-0.0000051), -0.0000051, "سالب");
    eq([rp(null), rp(undefined), rp(NaN), rp(0)], [null, null, null, 0], "الحالات الحدّية");
  });

  t("num() لا يختلق أرقاماً", () => {
    eq([num(3), num({ raw: 4 }), num(null), num(undefined), num(NaN), num("5")], [3, 4, null, null, null, null], "num");
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل`);
  process.exit(fail ? 1 : 0);
}

if (CHECK) selfCheck();
else main().catch(e => { console.error("✗ فشل التشغيل:", e.message); process.exit(1); });
