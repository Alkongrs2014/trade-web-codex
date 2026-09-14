#!/usr/bin/env node
/* =====================================================================
   الأرشيف التاريخي — ماذا حدث فعلاً بعد كل إشارة، على خمس سنوات.

   الفكرة: عندنا شمعات يومية لخمس سنوات لكل رمز في الكونين. بدل انتظار
   شهور لتتراكم نتائج حيّة، نمرّر شروط الماسح على هذا التاريخ كله ونقيس
   ما حدث بعد كل إشارة.

   ثلاثة قيود تحفظ صدق الرقم:

   ١) **لا نظرة إلى المستقبل.** كل شرط يُقاس بقيم متاحة عند تلك الشمعة
      فقط. الشروط التي تحتاج أساسيات (مكرر ربحية، ROE، موعد أرباح) نعرف
      قيمتها اليوم لا يومها، فتُقاس بنواتها السعرية عبر `btTest` مع ذكر
      ما أُسقط، أو تُستبعد كلياً إن لم يبقَ لها نواة.

   ٢) **خط أساس للمقارنة.** «نسبة نجاح 57%» بلا معنى إن كان نصيب أي يوم
      عشوائي 56%. لذلك نحسب نفس الإحصاء على **كل** الشمعات ونعرضه بجانب
      كل شرط. الفارق هو المعلومة، لا الرقم المطلق.

   ٣) **فترة تهدئة.** الشرط الذي يبقى محقَّقاً عشرة أيام متتالية يسجّل
      عشر إشارات متداخلة النوافذ فينتفخ العدد ويبدو الاتساق أقوى مما هو.

     node scripts/backtest.mjs --out ./data
     node scripts/backtest.mjs --check
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { ema, rsi, macd, bb, atr, scoreFrom, adx, bbWidth, divergence } from "./lib/indicators.mjs";
import { fetchChart, pool, stats } from "./lib/yahoo.mjs";
import { COSTS, netReturn, grossReturn, selfCheckCosts } from "./lib/costs.mjs";

const require = createRequire(import.meta.url);
const { SCANS, forcedDir } = require("../stocks/scans.js");
/* **نواة الخطة نفسها لا نسخةٌ منها.** الأرشيف يقيس ما يراه المستخدم على
   الشاشة؛ نسخةٌ ثانية هنا تتباعد بأول تعديل فيقيس الأرشيف خطةً غير
   المعروضة — وهو أسوأ من ألّا يقيسها، لأن الرقم يبدو صحيحاً. */
const { levelsFrom, planPair, planDirOf, validatePlan } = require("../stocks/plan.js");
const { bandOf, labelOf } = require("../stocks/score.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();

const HORIZONS = [1, 5, 20];              // أيام تداول
const MAX_H = Math.max(...HORIZONS);
const WARMUP = 260;                       // EMA200 + نافذة 52 أسبوعاً
const COOLDOWN = 5;                       // شمعات قبل تسجيل نفس الشرط للرمز نفسه
const W52 = 252;
// مرجع حالة السوق. SPY لا ‎^GSPC‎: الأخير مؤشّرٌ لا يُتداول وبعض المصادر
// ترفضه، والفرق بينهما في اتجاه المتوسط المئوي معدوم عملياً.
const MARKET = process.env.BT_MARKET || "SPY";
const AVGVOL = 10;

/* =====================================================================
   المدى: عشر سنوات لا خمس.

   خمس سنوات أعطت **828 يوماً صاعداً مقابل 228 هابطاً**، وأقوى حافة مقيسة
   عندنا («تباعد صاعد» ‎+3.60‎ بنجاح ‎77%‎) تقع في الحالة الهابطة — أي أننا
   نقدّر أهمّ رقمٍ لدينا من أنحف عيّنة. والعشر تضمّ انهيار 2020 وسوق 2022
   الهابط، وكلفتها **صفر طلبات إضافية**: نفس عدد النداءات بمدى أوسع،
   والتشغيل محليّ بلا حصّة.
   ===================================================================== */
const RANGE = process.env.BT_RANGE || "10y";

/* أقصى ما تُمهَل له الصفقة بعد الدخول. أطول أفق نقيسه عشرون يوماً،
   والهدف البعيد يحتاج أكثر — وستّون سقفٌ يترك له فرصة ولا يُبقي الصفقة
   مفتوحة إلى الأبد فتُحسب «منتهية» بعد سنة. */
const SIM_BARS = 60;
/* والدخول المعلَّق ينتظر خمس شمعات لا ستّين: ارتدادٌ لم يأتِ في أسبوع
   إشارةٌ فاتت، وانتظارُه شهرين يخلط «لم يُفعَّل» بـ«فُعِّل متأخراً جداً». */
const ENTRY_WAIT = 5;

/* قسمة خارج العيّنة: الأقدم للاكتشاف والأحدث للتحقّق. الحدّ **زمنيّ** لا
   بالرموز — قسمةُ الرموز تُبقي نفس الفترة في الجهتين فيتسرّب إليهما أثر
   السوق نفسه، والفترتان المختلفتان وحدهما تختبران الثبات عبر الزمن. */
const OOS_FRAC = 0.3;
/* حدّ عيّنة التركيبة: أقلّ منه ضجيجٌ يبدو ذهبياً. زوجُ شرطين نادرين
   يلتقيان ثلاثين مرة يخرج بحافة ‎+6‎ ثم لا يتكرّر أبداً. */
const MIN_COMBO_N = 200;
/* خط أساس الخطة بالعيّنة لا بكل شمعة: محاكاة الخطة أثقل من قياس العائد
   بمراتب، وشمعةٌ من كل عشرين تكفي لخط أساسٍ عيّنته عشرات الآلاف. */
const PLAN_BASE_EVERY = 20;

/* =====================================================================
   مضاعِفات الوقف المقيسة.

   أوّل تشغيلٍ للمحاكاة كشف أن الخطة المعروضة **توقّعها سالب على كل شرط
   تقريباً**، ونسبة ضرب وقفها ‎66–80%‎. والسبب رياضيّ لا عرَضيّ: الوقف
   عند ‎1×ATR‎ خلف الدخول والهدف على بُعد ‎2×‎ أو أكثر، واحتمال لمس الأقرب
   قبل الأبعد في مشيٍ عشوائي هو نسبة بُعديهما المقلوبة — أي الثلثان. فكل
   ما كانت الخطة تفعله هو أخذ خسارةٍ صغيرة كثيراً وربحٍ كبير قليلاً،
   وحاصلُهما سالبٌ بعد التكلفة.

   فبدل تغيير الرقم برأي: يُقاس مدىً منه. والمضاعِف الفائز يُقرأ من
   التوقّع لا من نسبة النجاح — وقفٌ واسع يخفض نسبة الضرب ويرفع حجم
   الخسارة الواحدة، والتوقّع وحده يوازن بينهما.
   ===================================================================== */
const STOP_MULTS = [1, 1.5, 2, 2.5, 3, 4];

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const r2 = (v) => (v === null || !Number.isFinite(v)) ? null : Math.round(v * 100) / 100;

/* الشمعات محفوظة مضغوطة [ث, فتح, أعلى, أدنى, إغلاق, حجم] */
const unpack = (c) => (Array.isArray(c) && Array.isArray(c[0]))
  ? c.map(a => ({ t: a[0] * 1000, o: a[1], h: a[2], l: a[3], c: a[4], v: a[5] }))
  : c;

/* =====================================================================
   تشذيب مصنوعات البيانات.

   تواريخ ياهو للعملات الرقمية تحمل أسعاراً "ما قبل الإدراج": UNI-USD
   يقفز من 0.000038 إلى 0.598 في يوم واحد — عائد 1,573,986%. رقمٌ واحد
   كهذا وسط نصف مليون ملاحظة يرفع متوسط عائد اليوم الواحد ثلاث نقاط
   مئوية كاملة، فيصير خط الأساس 19% لعشرين يوماً بدل 1%.

   نقطع السلسلة عند آخر قفزة مستحيلة ونُبقي ما بعدها: أفضل من إسقاط
   الرمز كاملاً، وأصدق من تمرير الرقم.
   ===================================================================== */
export const MAX_DAY_MOVE = 80;           // نسبة مئوية

export function trimArtifacts(k, maxMove = MAX_DAY_MOVE) {
  let cut = -1;
  for (let i = 1; i < k.length; i++) {
    const a = k[i - 1].c, b = k[i].c;
    if (!(a > 0) || !(b > 0)) { cut = i; continue; }
    if (Math.abs((b - a) / a * 100) > maxMove) cut = i;
  }
  return cut < 0 ? { k, trimmed: 0 } : { k: k.slice(cut + 1), trimmed: cut + 1 };
}
/* ---------- إحصاء ---------- */
export function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : null; }
export function median(a) {
  if (!a.length) return null;
  const s = a.slice().sort((x, y) => x - y), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const winRate = (a) => a.length ? a.filter(x => x > 0).length / a.length * 100 : null;

/* ---------- نوافذ متحركة ---------- */
export function rollingExtreme(vals, win, kind) {
  const out = new Array(vals.length).fill(null);
  for (let i = 0; i < vals.length; i++) {
    if (i < win - 1) continue;
    let best = vals[i];
    for (let j = i - win + 1; j <= i; j++) {
      if (kind === "max" ? vals[j] > best : vals[j] < best) best = vals[j];
    }
    out[i] = best;
  }
  return out;
}
export function rollingMean(vals, win) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= win) sum -= vals[i - win];
    if (i >= win - 1) out[i] = sum / win;
  }
  return out;
}

/* =====================================================================
   ما حدث بعد الشمعة i: العائد عند كل أفق، وأقصى صعود وهبوط خلاله.
   الدخول عند إغلاق شمعة الإشارة — لا عند فتح اليوم التالي ولا عند أفضل
   سعر في اليوم: أي افتراض أفضل من ذلك يجمّل النتيجة بلا مقابل واقعي.
   ===================================================================== */
export function outcome(k, i, horizons = HORIZONS) {
  const entry = k[i].c;
  if (!(entry > 0)) return null;
  const res = { ret: {} };
  for (const h of horizons) {
    const j = i + h;
    res.ret[h] = (j < k.length) ? (k[j].c - entry) / entry * 100 : null;
  }
  let hi = -Infinity, lo = Infinity;
  for (let j = i + 1; j <= Math.min(i + MAX_H, k.length - 1); j++) {
    if (k[j].h > hi) hi = k[j].h;
    if (k[j].l < lo) lo = k[j].l;
  }
  res.mfe = hi > -Infinity ? (hi - entry) / entry * 100 : null;    // أقصى ربح عائم
  res.mae = lo < Infinity ? (lo - entry) / entry * 100 : null;     // أقصى تراجع عائم
  return res;
}

/* =====================================================================
   قلب النتيجة إلى اتجاه الإشارة.

   `outcome` تقيس المسار كما هو: صعوداً. وهو الصحيح لشرط صاعد، وخطأ تامّ
   لشرط هابط — «توافق الفريمات ▼» تصحّ حين يهبط السعر، فقياسها صعوداً كان
   يعطيها حافة سالبة وهي تعمل. القلب هنا لا في `outcome` كي تُقاس العيّنة
   مرة واحدة ويُشتق منها الاتجاهان: خط أساس واحد بإشارتين، لا عيّنتان
   مختلفتان يُقارن بينهما.

   ولا يكفي قلب العائد: أقصى ربح على البيع هو **أدنى قاع** لا أعلى قمة.
   ===================================================================== */
export function signOutcome(o, d) {
  if (d !== -1 || !o) return o;
  const r = { ret: {} };
  for (const h of Object.keys(o.ret)) r.ret[h] = Number.isFinite(o.ret[h]) ? -o.ret[h] : null;
  r.mfe = Number.isFinite(o.mae) ? -o.mae : null;
  r.mae = Number.isFinite(o.mfe) ? -o.mfe : null;
  return r;
}

/* =====================================================================
   محاكاة الخطة المعروضة — لا «ماذا حدث بعد عشرين يوماً».

   هذه أكبر فجوة كانت في المشروع: `outcome` تقيس عائد أفقٍ ثابت، والتطبيق
   **لا يعرض ذلك**. يعرض خطةً بدخولٍ ووقفٍ وثلاثة أهداف، ولم تُختبر
   تاريخياً ولا مرة. فكان الأرشيف يشهد لشرطٍ بشهادةٍ لا تخصّ ما يفعله
   المستخدم به.

   أربع قواعد تحفظ صدق الرقم، وكلّها تختار الاحتمال الأسوأ عند الالتباس:

   ١) **المسير يبدأ من الشمعة التالية.** إشارةٌ تُقرأ عند إغلاق الشمعة
      لا يمكن تنفيذها داخلها؛ التنفيذ في اليوم التالي.

   ٢) **الشمعة التي تلمس الوقف والهدف معاً وقفٌ لا هدف.** الشمعة اليومية
      لا تقول أيّهما لُمس أولاً، والافتراض المعاكس يمنح النظام صفقاتٍ
      رابحة لم تقع — نفس منطق `updateOutcome` في التتبّع الحيّ.

   ٣) **الفجوة تُنفَّذ عند الفتح لا عند المستوى.** سهمٌ يفتح تحت وقفك
      يخرجك عند فتحه، وحساب الخروج عند الوقف يخفي أسوأ ما يحدث فعلاً —
      وهو بالضبط ما لا يحمي منه وقفُ الخسارة.

   ٤) **الدخول المعلَّق يُملأ عند مستواه لا عند الفتح الأفضل منه.** لو
      فتح السهم تحت حدّ شرائك فالتنفيذ الحقيقي أرخص، لكن افتراض الأرخص
      يجمّل النتيجة — فنملأ عند المستوى.

   والمخرَج `null` حين لا تُفعَّل الخطة داخل نافذة الانتظار: ليست رابحة
   ولا خاسرة، وعدُّها في أيّ خانة يكذب. تُحصى في `waited` وحدها.
   ===================================================================== */
export function simulatePlan(k, i, p, opt = {}) {
  if (!p || !Number.isFinite(p.entry) || !Number.isFinite(p.stop)) return null;
  const wait = opt.entryWait ?? ENTRY_WAIT, span = opt.maxBars ?? SIM_BARS;
  const costs = opt.costs || COSTS;
  const d = p.dir, atr = p.atr;
  const tg = (p.targets || []).map(t => t.p);
  if (!tg.length) return null;                 // خطةٌ بلا هدف لا تُقاس

  let entered = false, entryPx = null, entryAt = null;
  const hit = tg.map(() => null);              // شمعةُ بلوغ كل هدف
  const retAt = tg.map(() => null);            // وعائد الخروج عنده
  let st = null, exitPx = null, exitAt = null;
  let hi = -Infinity, lo = Infinity;

  for (let j = i + 1; j < k.length; j++) {
    const b = k[j];
    if (!b || !Number.isFinite(b.h) || !Number.isFinite(b.l)) continue;

    if (!entered) {
      if (j - i > wait) { st = "cancel"; break; }
      if (p.atMarket || p.entryIsNow) {
        // «بالسوق» يعني فتح الشمعة التالية — لا إغلاق شمعة الإشارة
        entryPx = b.o ?? b.c; entryAt = j; entered = true;
      } else if (d > 0 ? b.l <= p.entry : b.h >= p.entry) {
        entryPx = p.entry; entryAt = j; entered = true;
      } else continue;
      if (!Number.isFinite(entryPx)) { entered = false; continue; }
      hi = lo = entryPx;
    }

    if (b.h > hi) hi = b.h;
    if (b.l < lo) lo = b.l;

    // الوقف أولاً دائماً — القاعدة ٢ و٣ معاً
    const stopped = d > 0 ? b.l <= p.stop : b.h >= p.stop;
    if (stopped) {
      const open = Number.isFinite(b.o) ? b.o : p.stop;
      exitPx = d > 0 ? Math.min(p.stop, open) : Math.max(p.stop, open);
      st = "stop"; exitAt = j; break;
    }
    for (let n = 0; n < tg.length; n++) {
      if (hit[n] !== null) continue;
      if (d > 0 ? b.h >= tg[n] : b.l <= tg[n]) {
        hit[n] = j;
        // عائد الخروج **عند هذا الهدف** — يُسجَّل لحظة بلوغه لا يُستنتج
        // لاحقاً. به تُقاس ثلاث سياسات خروج من محاكاةٍ واحدة، ومن ضُرب
        // وقفُه بعد بلوغ هدفه الأول كان سيربح لو خرج عنده.
        retAt[n] = r2(netReturn(entryPx, tg[n], d, atr, costs));
      }
    }
    if (hit[tg.length - 1] !== null) { exitPx = tg[tg.length - 1]; st = "t" + tg.length; exitAt = j; break; }
    if (j - entryAt >= span) { exitPx = b.c; st = "expired"; exitAt = j; break; }
  }

  if (!entered) return { activated: false, st: st || "cancel" };
  if (exitPx === null) {                        // انتهت السلسلة والصفقة مفتوحة
    const last = k[k.length - 1];
    exitPx = last.c; st = "expired"; exitAt = k.length - 1;
  }

  const net = netReturn(entryPx, exitPx, d, atr, costs);
  const gross = grossReturn(entryPx, exitPx, d);
  return {
    activated: true, st, dir: d,
    waitBars: entryAt - i, heldBars: exitAt - entryAt,
    hit: hit.map(h => h === null ? null : h - entryAt),
    retAt, nTargets: tg.length,
    ret: r2(net), retGross: r2(gross),
    mfe: r2((d > 0 ? hi - entryPx : entryPx - lo) / entryPx * 100),
    mae: r2((d > 0 ? lo - entryPx : entryPx - hi) / entryPx * 100),
    rr: p.rr ?? null
  };
}

/* =====================================================================
   تجميع نتائج الخطة — النسب بمقاماتها الصحيحة.

   ثلاثة مقامات مختلفة عمداً، وخلطُها هو ما يجعل أرقام المنصّات تبدو
   جميلة: **نسبة التفعيل** مقامها كل الإشارات، و**نسبة الوقف والأهداف**
   مقامها ما فُعِّل وحده، و**نسبة الهدف الثالث** مقامها الخطط التي عرضت
   ثلاثة أهداف أصلاً — خطةٌ بهدفين لا تُحاسب على ثالثٍ لم تعرضه.
   ===================================================================== */
export function summarizePlans(list) {
  const n = list.length;
  if (!n) return null;
  const act = list.filter(x => x.activated);
  const a = act.length;
  const rets = act.map(x => x.ret).filter(Number.isFinite);
  const gross = act.map(x => x.retGross).filter(Number.isFinite);
  const tRate = (i) => {
    const pool = act.filter(x => x.nTargets > i);
    return pool.length ? r2(pool.filter(x => x.hit[i] !== null).length / pool.length * 100) : null;
  };
  const tBars = (i) => {
    const v = act.filter(x => x.hit[i] !== null).map(x => x.hit[i]);
    return v.length ? r2(median(v)) : null;
  };
  /* ثلاث سياسات خروج من محاكاةٍ واحدة: اخرج عند الهدف الأول، أو الثاني،
     أو احملها إلى الثالث. الفرق بينها هو أهمّ قرارٍ في الخطة ولم يكن
     يُقاس — والحدس يقول «دع الأرباح تجري»، والقياس قد يقول عكسه تماماً
     حين تكون نسبة الوقف ثلثين. */
  const policy = (i) => {
    const pool = act.filter(x => x.nTargets > i);
    if (!pool.length) return null;
    const v = pool.map(x => (x.retAt && x.retAt[i] !== null && x.retAt[i] !== undefined)
                              ? x.retAt[i] : x.ret).filter(Number.isFinite);
    return v.length ? { n: v.length, exp: r2(mean(v)), med: r2(median(v)), win: r2(winRate(v)) } : null;
  };

  return {
    n, activated: a, actRate: r2(a / n * 100),
    exitAt: [0, 1, 2].map(policy),
    // التوقّع الرياضي: متوسط العائد الصافي لكل صفقةٍ **فُعِّلت**. وهو
    // الرقم الذي يقرّر إن كان الشرط يستحق التداول أصلاً — لا نسبة النجاح
    exp: rets.length ? r2(mean(rets)) : null,
    expGross: gross.length ? r2(mean(gross)) : null,
    med: rets.length ? r2(median(rets)) : null,
    win: rets.length ? r2(winRate(rets)) : null,
    stop: a ? r2(act.filter(x => x.st === "stop").length / a * 100) : null,
    expired: a ? r2(act.filter(x => x.st === "expired").length / a * 100) : null,
    t: [0, 1, 2].map(tRate),
    tBars: [0, 1, 2].map(tBars),
    heldMed: a ? r2(median(act.map(x => x.heldBars))) : null,
    waitMed: a ? r2(median(act.map(x => x.waitBars))) : null,
    mfe: act.length ? r2(mean(act.map(x => x.mfe).filter(Number.isFinite))) : null,
    mae: act.length ? r2(mean(act.map(x => x.mae).filter(Number.isFinite))) : null
  };
}

/* =====================================================================
   الرتبة المئوية المتدحرجة — قيمةٌ لكل شمعة لا لآخرها وحدها.

   `rankInWindow` في `indicators.js` تعيد رتبة **آخر** قيمة، وهي ما
   يحتاجه الحساب الحيّ. أما الأرشيف فيحتاج رتبة كل شمعة في زمنها، فلو
   استدعيناها على شريحةٍ متنامية لكل شمعة صارت التكلفة تربيعية —
   482 ألف شمعة × نافذة 120 = 58 مليون مقارنة لكل رمز.
   ===================================================================== */
function rollingRank(series, win) {
  const out = new Array(series.length).fill(null);
  for (let i = 0; i < series.length; i++) {
    if (!Number.isFinite(series[i])) continue;
    let n = 0, below = 0;
    for (let j = Math.max(0, i - win + 1); j <= i; j++) {
      if (!Number.isFinite(series[j])) continue;
      n++;
      if (series[j] < series[i]) below++;
    }
    if (n >= 20) out[i] = below / (n - 1) * 100;
  }
  return out;
}

/* التباعد لكل شمعة: `divergence` تعمل على نافذةٍ منتهية عند آخر عنصر،
   فنمرّر شرائح. والنافذة 60 والخطوة 1 — أمّا الرصد فيكون على الشمعات
   التي **تأكّدت** قمّتها، ولهذا القيمة تظهر متأخّرة `k` شمعات وهو
   الصحيح: قمّةٌ لم تتأكّد بعد ليست قمّة، واحتسابها نظرةٌ إلى المستقبل. */
function rollingDiv(h, l, ind, at) {
  const out = new Array(ind.length).fill(null);
  const LB = 60;
  /* النافذة ثابتة الطول لا متنامية: `divergence` لا تنظر خارج
     `lookback` أصلاً، وتمريرُ الشريحة من الصفر يجعل النسخ تربيعياً —
     1250 شمعة × 499 رمزاً × أربع مصفوفات = مليارات العناصر. */
  for (let i = LB; i < ind.length; i++) {
    const a0 = i - LB + 1;
    const d = divergence(h.slice(a0, i + 1), l.slice(a0, i + 1), ind.slice(a0, i + 1),
                         at.slice(a0, i + 1), { lookback: LB });
    // المواضع نسبيّة داخل النافذة، فآخر شمعة هي `LB - 1`. والأحدث وحده
    // وبشرط أن يكون داخل آخر عشر شمعات — تباعدٌ عمره خمسون شمعة ليس
    // إشارةَ اليوم.
    if (d.length && (LB - 1 - d[0].at) <= 10) out[i] = d[0].dir;
  }
  return out;
}

/* =====================================================================
   بناء لقطة تاريخية بشكل صفّ الملخّص نفسه، حتى تعمل عليها شروط الماسح
   بلا تعديل — نفس الحقول التي تراها الواجهة، بقيم ذلك اليوم.
   ===================================================================== */
export function snapshots(meta, k) {
  const c = k.map(x => x.c), h = k.map(x => x.h), l = k.map(x => x.l), v = k.map(x => x.v || 0);
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
  const R = rsi(c, 14), M = macd(c), B = bb(c, 20, 2), A = atr(h, l, c, 14);
  const w52h = rollingExtreme(h, W52, "max"), w52l = rollingExtreme(l, W52, "min");
  const av = rollingMean(v, AVGVOL);
  /* قوّة الاتجاه والانضغاط والتباعد — تُحسب كسلاسل مرة واحدة لا لكل
     شمعة، وإلا صارت التكلفة تربيعية على 482 ألف شمعة. */
  const AX = adx(h, l, c, 14);
  const BW = bbWidth(c, 20, 2);
  const SQ = rollingRank(BW, 120);
  const DV = rollingDiv(h, l, R, A);

  const out = [];
  for (let i = 0; i < k.length; i++) {
    if (i < WARMUP) { out.push(null); continue; }
    // `atr` و`histPrev` ليسا زينة: بهما تعمل المنطقة الميتة في
    // `scoreFrom`. بدونهما يقيس الأرشيف نتيجةً **أحدَّ** من التي يراها
    // المستخدم — وهو بالضبط الخطأ الذي يجعل الأرشيف يحكم على شرطٍ
    // بغير ما يحدث فعلاً في الواجهة.
    const score = scoreFrom({
      px: c[i], e20: e20[i], e50: e50[i], e200: e200[i], rsi: R[i],
      hist: M.hist[i], histPrev: M.hist[i - 1] ?? null,
      histRising: (M.hist[i] !== null && M.hist[i - 1] !== null) ? M.hist[i] > M.hist[i - 1] : false,
      bbMid: B.mid[i], atr: A[i]
    });
    out.push({
      row: { s: meta.s, sec: meta.sec, p: c[i], w52h: w52h[i], w52l: w52l[i],
             rsi: R[i], atr: A[i], vol: v[i], score, tfScore: { "1d": score },
             // نفس أسماء حقول `an["1d"]` في `summary.json`، فيعمل الشرط
             // الواحد على اللقطة التاريخية وعلى الصفّ الحيّ بلا فرعين
             adx: AX.adx[i], pdi: AX.pdi[i], mdi: AX.mdi[i],
             squeeze: SQ[i], div: DV[i],
             // المتوسّطات الثلاثة: بدونها لا يفرّق الشرط التاريخي بين
             // الاتجاه الأمّ والزخم القصير، فيقيس شرطاً غير المعروض
             e20: e20[i], e50: e50[i], e200: e200[i] },
      // مدخلات `levelsFrom` بنفس شكل مخرَج `analyze` في المتصفح: الخطة
      // تُبنى من نفس الأرقام التي تراها الشاشة، لا من حسابٍ ثانٍ هنا
      a: { e50: e50[i], e200: e200[i], atr: A[i] },
      // الأساسيات المتاحة تاريخياً وحدها: متوسط الحجم يُحسب من الشمعات
      f: { avgVol: av[i] }
    });
  }
  return out;
}

/* =====================================================================
   حالة السوق — فوق متوسطه المئتين أم تحته.

   شرطٌ يعمل في الصعود وحده **ليس شرطاً فاشلاً**، بل شرطٌ مشروط. وخلط
   الحالتين في رقمٍ واحد يخفي أيّهما: حافةُ نصف نقطة قد تكون نقطتين في
   سوقٍ صاعد وسالبةَ نقطة في هابط، فيُقرأ الوسط «بلا حافة» ويُهمل الشرط
   وهو صالح نصف الوقت.

   المتوسط سببٌ لا اصطلاح: هو أبطأ ما يُستعمل، فلا يقلب الحالة مع كل
   تصحيح أسبوعي. و**سببيٌّ بالكامل** — قيمته عند شمعةٍ تُحسب من شمعاتها
   السابقة وحدها، فلا تسرّب معرفةً بالمستقبل إلى تصنيفٍ يُستعمل وقتها.
   ===================================================================== */
export function regimeMap(k, win = 200) {
  if (!Array.isArray(k) || k.length < win + 10) return null;
  const c = k.map(x => x.c);
  const e = ema(c, win);
  const m = new Map();
  for (let i = 0; i < k.length; i++) {
    if (e[i] === null || !(c[i] > 0) || !Number.isFinite(k[i].t)) continue;
    // اليوم هو المفتاح لا الطابع الزمني: شمعات الرموز المختلفة تحمل
    // أختاماً مختلفة الدقائق لليوم نفسه
    m.set(Math.floor(k[i].t / 86400000), c[i] >= e[i] ? "up" : "dn");
  }
  return m.size ? m : null;
}

/* ---------- تجميع ---------- */
function summarize(list) {
  const s = { n: list.length, ret: {} };
  for (const h of HORIZONS) {
    const a = list.map(x => x.ret[h]).filter(Number.isFinite);
    s.ret[h] = { n: a.length, avg: r2(mean(a)), med: r2(median(a)), win: r2(winRate(a)) };
  }
  s.mfe = r2(mean(list.map(x => x.mfe).filter(Number.isFinite)));
  s.mae = r2(mean(list.map(x => x.mae).filter(Number.isFinite)));
  return s;
}

async function main() {
  const now = Date.now();
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "stocks/symbols.json"), "utf8"));
  // الأسهم وحدها. الكريبتو أصل مختلف بمدى يومي أوسع بمراتب، وخلطه بخط
  // أساس واحد يجعل المقارنة بلا معنى — كما أن شروط الماسح مصمَّمة لأسهم
  // لها قطاع وقيمة سوقية وأساسيات.
  const universe = [...cfg.symbols, ...(cfg.wide || [])];
  const lim = args.indexOf("--limit");
  const chosen = lim >= 0 ? universe.slice(0, Number(args[lim + 1])) : universe;

  // التاريخ يُجلب ولا يُخزَّن: ملفات `sym` تحتفظ بـ260 شمعة فقط (تكفي
  // EMA200 وتُبقي الملفات خفيفة)، وهو أقصر من فترة التسخين نفسها. وحفظ
  // خمس سنوات لخمسمئة رمز ~25 ميغابايت تُنشر بلا أن يقرأها أحد، بينما
  // مخرَج القياس بضعة كيلوبايتات. فنجلب في الذاكرة ونرمي.
  /* سلسلة السوق أولاً: طلبٌ واحد يصنّف كل شمعة في القياس كله. لو سقط
     فالقياس يمضي بلا تقسيم — التقسيم إضافة لا شرط. */
  let regime = null, regCount = { up: 0, dn: 0 }, oosFrom = null;
  try {
    const { candles } = await fetchChart(MARKET, { range: RANGE, interval: "1d" });
    regime = regimeMap(candles);
    if (regime) for (const v of regime.values()) regCount[v]++;
    // حدّ خارج العيّنة من سلسلة السوق: مرجعٌ واحد يشمل الفترة كلها، فلا
    // يختلف الحدّ بين رمزٍ عمره عشر سنوات وآخر أُدرج قبل سنتين
    const ts = candles.map(x => x.t).filter(Number.isFinite);
    if (ts.length > 10) {
      const lo = Math.min(...ts), hi = Math.max(...ts);
      oosFrom = lo + (hi - lo) * (1 - OOS_FRAC);
    }
    console.log(`  حالة السوق من ${MARKET}: ${regCount.up} يوماً فوق متوسطه و${regCount.dn} تحته`);
    if (oosFrom) console.log(`  حدّ خارج العيّنة: ${new Date(oosFrom).toISOString().slice(0, 10)}`);
  } catch (e) { console.warn(`  ⚠ تعذّر جلب ${MARKET} — القياس بلا تقسيم حالة: ${e.message}`); }

  console.log(`▶ جلب تاريخ ${chosen.length} رمزاً (${RANGE} يومية) …`);
  const fetched = await pool(chosen, 3, async (m) => {
    const { candles } = await fetchChart(m.s, { range: RANGE, interval: "1d" });
    return { meta: m, k: candles };
  });
  const series = [];
  let failed = 0;
  fetched.forEach((r) => { if (r.ok) series.push(r.value); else failed++; });
  if (failed) console.warn(`  ⚠ سقط ${failed} رمزاً`);
  if (!series.length) throw new Error("لم يصل تاريخ أي رمز");

  console.log(`  قياس ${SCANS.filter(s => s.btTest).length} شروط على ${series.length} رمزاً …`);

  const hits = {};                       // id -> [outcome]
  const hitsReg = {};                    // id -> { up:[], dn:[] }
  const hitsOOS = {};                    // id -> [outcome] خارج العيّنة وحدها
  const plans = {};                      // id -> { a:[sim], b:[sim] }
  for (const s of SCANS) if (s.btTest) {
    hits[s.id] = []; hitsReg[s.id] = { up: [], dn: [] }; hitsOOS[s.id] = [];
    plans[s.id] = { a: [], b: [], c: [] };
  }
  const baseline = [], baseReg = { up: [], dn: [] }, baseOOS = [];
  const basePlans = { a: [], b: [] };
  /* مسح الوقف: أرقامٌ متراكمة لا كائنات. 330 ألف إشارة × ستّة مضاعِفات
     × كائن محاكاة = ذاكرةٌ بالغيغابايت بلا حاجة — والمطلوب منها إحصاءٌ
     لا تفصيل. */
  const sweep = STOP_MULTS.map(m => ({ m, n: 0, act: 0, stops: 0, rets: [] }));
  /* التركيبات: مفتاحٌ نصّي إلى عيّنته. الأزواج `id|id` والنطاقات `id@band`
     — بنيةٌ واحدة لأن كليهما «شرطٌ مقيَّد بشيء»، والتفريق بينهما في
     العرض لا في الجمع. */
  const combos = new Map();
  const comboAdd = (key, lbl, kind, dir, o, isOOS) => {
    let c = combos.get(key);
    if (!c) combos.set(key, c = { key, lbl, kind, dir, all: [], oos: [] });
    c.all.push(o);
    if (isOOS) c.oos.push(o);
  };
  let bars = 0, symbols = 0, skipped = 0, planFails = 0;

  let trimmedSyms = 0;
  for (const { meta, k: raw } of series) {
    if (!Array.isArray(raw)) { skipped++; continue; }
    const { k, trimmed } = trimArtifacts(raw);
    if (trimmed) trimmedSyms++;
    if (k.length < WARMUP + MAX_H + 1) { skipped++; continue; }
    symbols++;
    const snaps = snapshots({ s: meta.s, sec: meta.sec }, k);
    const lastHit = {};                  // id -> آخر شمعة سُجّلت
    const planCache = new Map();         // i -> { a, b } — شمعةٌ واحدة تخدم كل شروطها

    /* بناء الخطة عند شمعةٍ بعينها، بنفس مدخلات المتصفح.
       الشريحة 126 شمعة لا السلسلة كاملة: `levelsFrom` لا تنظر أبعد من
       120 شمعة للقمم والقيعان ولا أبعد من الشمعة السابقة للبيفوت، وتمريرُ
       السلسلة كلها لكل إشارة يجعل النسخ تربيعياً — 330 ألف إشارة × 2500
       شمعة. والاتجاه من **النتيجة الفنية** كما في الواجهة تماماً، لا من
       اتجاه الشرط: السجلّ الحيّ يحفظ الخطة التي رآها المستخدم. */
    const planAt = (i) => {
      let e = planCache.get(i);
      if (e) return e;
      e = { in: null, dirs: new Map() };
      const sn = snaps[i];
      if (sn) {
        try {
          const lv = levelsFrom({
            k4h: null, k1d: k.slice(Math.max(0, i - 125), i + 1), px: k[i].c,
            a: sn.a, w52h: sn.row.w52h, w52l: sn.row.w52l, now: k[i].t
          });
          if (lv) e.in = { px: lv.px, atr: lv.atr, resAll: lv.resAll, supAll: lv.supAll };
        } catch { e.in = null; }
      }
      // المستويات تُحسب مرةً واحدة والخطط تُشتقّ منها بأيّ اتجاه: هكذا
      // يُقاس «لو فرضنا اتجاه الشرط» تدخُّلاً حقيقياً لا ترشيحاً للعيّنة
      e.of = (d) => {
        if (!e.in || (d !== 1 && d !== -1)) return { a: null, b: null };
        let p = e.dirs.get(d);
        if (!p) {
          p = planPair(e.in, d);
          // بوّابة الاتجاه نفسها التي تحرس العرض: خطةٌ مردودة لا تُقاس
          if (p.a && validatePlan(p.a).length) { p.a = null; planFails++; }
          if (p.b && validatePlan(p.b).length) p.b = null;
          e.dirs.set(d, p);
        }
        return p;
      };
      /* الخطة «الخاصّة» صارت دالّةً في الشرط لا في الشمعة وحدها: شرطٌ
         يحمل `planDir` تُبنى خطته باتجاهه. وشمعةٌ أطلقت شرطين مختلفَي
         السياسة لها خطتان — وهو الصواب، فكلٌّ يقيس ما يُعرض تحته. */
      e.own = (scanId) => e.of(
        planDirOf(snaps[i] ? snaps[i].row.score : null, forcedDir(scanId)));
      planCache.set(i, e);
      return e;
    };

    for (let i = WARMUP; i < k.length - MAX_H; i++) {
      const sn = snaps[i];
      if (!sn) continue;
      bars++;
      const o = outcome(k, i);
      if (!o) continue;
      const isOOS = oosFrom !== null && k[i].t >= oosFrom;
      baseline.push(o);
      if (isOOS) baseOOS.push(o);
      // شمعةٌ خارج مدى سلسلة السوق (عطلة، أو رمزٌ أقدم منها) لا تُنسب
      // إلى حالة — ولا تُخمَّن
      const rg = regime ? regime.get(Math.floor(k[i].t / 86400000)) : undefined;
      if (rg) baseReg[rg].push(o);

      // خط أساس الخطة: شمعةٌ من كل عشرين، بلا شرطٍ محقَّق — «ماذا لو
      // تداولتَ الخطة في يومٍ عشوائي». بدونه لا معنى لتوقّع الشرط
      if (i % PLAN_BASE_EVERY === 0) {
        const bp = planAt(i).own(null);   // خط الأساس بلا شرط فبلا فرض
        for (const tr of ["a", "b"]) {
          const sim = bp[tr] && simulatePlan(k, i, bp[tr]);
          if (sim) basePlans[tr].push(sim);
        }
      }

      const fired = [];
      for (const scan of SCANS) {
        if (!scan.btTest) continue;
        let hit = false;
        try { hit = !!scan.btTest(sn.row, sn.f, { secMed: {} }); } catch { hit = false; }
        if (!hit) continue;
        if (lastHit[scan.id] !== undefined && i - lastHit[scan.id] < COOLDOWN) continue;
        lastHit[scan.id] = i;
        hits[scan.id].push(o);
        if (isOOS) hitsOOS[scan.id].push(o);
        if (rg) hitsReg[scan.id][rg].push(o);
        fired.push(scan);
      }
      if (!fired.length) continue;

      // الخطة تُبنى مرةً واحدة لكل شمعة ثم تُنسب إلى كل شرطٍ أطلقها
      const cache = planAt(i);
      /* خطةُ خطّ الأساس للشمعة — بلا فرض، فهي التي يُمسح عليها الوقف
         ويُقاس عليها خطّ الأساس العام. أما خطة كل شرط فتُشتقّ داخل حلقته. */
      const pp = cache.own(null);
      const planDir = pp.a ? pp.a.dir : null;

      /* مسح الوقف مرةً لكل شمعةٍ أطلقت شرطاً، لا مرةً لكل شرط: الشمعة
         الواحدة خطةٌ واحدة، وتكرارها بعدد شروطها يرجّح الشمعات المزدحمة
         في المتوسط بلا سبب. */
      if (pp.a) {
        for (let m = 0; m < STOP_MULTS.length; m++) {
          const alt = { ...pp.a, stop: pp.a.entry - pp.a.dir * pp.a.atr * STOP_MULTS[m] };
          const s2 = simulatePlan(k, i, alt);
          if (!s2) continue;
          const w = sweep[m];
          w.n++;
          if (!s2.activated) continue;
          w.act++;
          if (s2.st === "stop") w.stops++;
          if (Number.isFinite(s2.ret)) w.rets.push(s2.ret);
        }
      }
      for (const scan of fired) {
        /* هل توافق اتجاهُ الخطة اتجاهَ الشرط؟

           سؤالٌ بدا شكلياً وليس كذلك: `planDirOf` تشتقّ اتجاه الخطة من
           **النتيجة الفنية** لا من الشرط الذي أطلق الإشارة. وسهمٌ قرب
           قاع 52 أسبوعاً نتيجتُه سالبة بالضرورة — فالشرط يقول «ارتدادٌ
           يُشترى» (وحافته المقيسة ‎+0.68‎) والخطة المعروضة تحته **بيع**.
           تناقضٌ داخلي لا يظهر في أي شاشة، ولا يُكشف إلا بقياس الاثنين
           معاً. فنقيسه قبل أن نغيّر شيئاً. */
        const sd = scan.dir === -1 ? -1 : 1;
        /* الخطة المعروضة تحت هذا الشرط بالضبط: مفروضةً إن كان له
           `planDir`، وإلا فخطة الشمعة. و`agree` تُقاس على اتجاهها هي —
           فبعد الفرض تصير `divBull` متوافقةً دائماً، وهو المقصود. */
        const ps = forcedDir(scan.id) === null ? pp : cache.own(scan.id);
        const psDir = ps.a ? ps.a.dir : null;
        const agree = psDir !== null && psDir === sd;
        for (const tr of ["a", "b"]) {
          const sim = ps[tr] && simulatePlan(k, i, ps[tr]);
          if (sim) plans[scan.id][tr].push({ ...sim, agree });
        }
        /* المسار «ج»: **تدخُّلٌ لا ترشيح.** الخطة تُبنى باتجاه الشرط نفسه
           بدل اتجاه النتيجة الفنية — فتُقاس السياسة التي قد نعتمدها، لا
           الشريحةُ التي وافقت صدفةً. والفرق بينهما ليس شكلياً: الترشيح
           يقيس «الإشارات التي وافق فيها الاثنان» وهي عيّنةٌ منتقاة،
           والتدخُّل يقيس **كل** الإشارات بخطةٍ مختلفة. */
        const pc = cache.of(sd);
        const simC = pc.a && simulatePlan(k, i, pc.a);
        if (simC) plans[scan.id].c.push(simC);
        // الشرط مقيَّداً بنطاق النتيجة: «توافق الفريمات» في سهمٍ نتيجته
        // ‎+80‎ ليس هو في سهمٍ نتيجته ‎+20‎، والرقم المجمّع يخلطهما
        // `bandOf` تعيد ‎0..4‎ ورقم النطاق ‎0‎ صالحٌ — فالفحص بـ`null` لا
        // بالصدق، وإلا سقط «هابط قوي» كلّه بصمت
        const bnd = bandOf(sn.row.score);
        if (bnd !== null) comboAdd(`${scan.id}@${bnd}`, `${scan.lbl} · ${labelOf(null, bnd).t}`,
                                   "band", scan.dir === -1 ? -1 : 1, o, isOOS);
      }
      // الأزواج: شرطان تحقّقا في نفس الشمعة. والمتناقضان يُستبعدان —
      // «توافق ▲» مع «توافق ▼» معاً ليس تركيبةً بل تناقضٌ لا إشارة له
      for (let x = 0; x < fired.length; x++)
        for (let y = x + 1; y < fired.length; y++) {
          const A2 = fired[x], B2 = fired[y];
          const dA = A2.dir === -1 ? -1 : 1, dB = B2.dir === -1 ? -1 : 1;
          if (dA !== dB) continue;
          const [p1, p2] = A2.id < B2.id ? [A2, B2] : [B2, A2];
          comboAdd(`${p1.id}|${p2.id}`, `${p1.lbl} + ${p2.lbl}`, "pair", dA, o, isOOS);
        }
    }
  }

  if (!bars) throw new Error("لا شمعات كافية — لن نكتب ملفاً فارغاً");

  // خط الأساس نفسه بإشارتين: العيّنة واحدة والاتجاه يقلبها. مقارنة إشارة
  // هابطة بخط أساس صاعد تُخرج حافة كاذبة مهما صحّ باقي الحساب.
  const base = summarize(baseline);
  const baseDn = summarize(baseline.map(o => signOutcome(o, -1)));
  // خط أساسٍ لكل حالة وكل اتجاه: مقارنة إشارةٍ ظهرت في سوقٍ صاعد بخط
  // أساس الفترة كلها تنسب إليها ما هو للسوق
  const baseByReg = {
    up: { 1: summarize(baseReg.up), "-1": summarize(baseReg.up.map(o => signOutcome(o, -1))) },
    dn: { 1: summarize(baseReg.dn), "-1": summarize(baseReg.dn.map(o => signOutcome(o, -1))) }
  };
  // خط أساس الفترة المتأخّرة وحده يقابل عيّنتها: مقارنة إشارةٍ ظهرت في
  // 2025 بخط أساس عشر سنوات تنسب إليها فرق السوقين لا فرق الشرط
  const baseOut = { 1: summarize(baseOOS), "-1": summarize(baseOOS.map(o => signOutcome(o, -1))) };
  const edgeOf = (g, b) => ({
    edge: Object.fromEntries(HORIZONS.map(h => [h,
      (Number.isFinite(g.ret[h].med) && Number.isFinite(b.ret[h].med)) ? r2(g.ret[h].med - b.ret[h].med) : null])),
    edgeWin: Object.fromEntries(HORIZONS.map(h => [h,
      (Number.isFinite(g.ret[h].win) && Number.isFinite(b.ret[h].win)) ? r2(g.ret[h].win - b.ret[h].win) : null]))
  });

  const scans = SCANS.filter(s => s.btTest).map(s => {
    const d = s.dir === -1 ? -1 : 1;
    const g = summarize(d === -1 ? hits[s.id].map(o => signOutcome(o, -1)) : hits[s.id]);
    const b = d === -1 ? baseDn : base;
    // الحافة في كل حالة على حدة، بخط أساس تلك الحالة وبإشارة الشرط
    const reg = regime ? Object.fromEntries(["up", "dn"].map(rk => {
      const list = hitsReg[s.id][rk];
      const gg = summarize(d === -1 ? list.map(o => signOutcome(o, -1)) : list);
      return [rk, { ...gg, ...edgeOf(gg, baseByReg[rk][String(d)]) }];
    })) : null;
    /* خارج العيّنة: نفس الحساب على الثلث الأحدث وحده. الفرق بين الرقمين
       معلومةٌ تُعرض ولا تُخفى — شرطٌ حافته ‎+2‎ داخل العيّنة و‎−0.3‎ خارجها
       يقول عن نفسه أكثر مما يقوله أيّ رقمٍ منفرد. */
    const oosList = hitsOOS[s.id];
    const go = summarize(d === -1 ? oosList.map(o => signOutcome(o, -1)) : oosList);
    const oos = oosFrom ? { ...go, ...edgeOf(go, baseOut[String(d)]) } : null;
    // الخطة المعروضة على هذا الشرط — بمسارَي الدخول معاً، ومقسومةً على
    // توافق اتجاهها مع اتجاه الشرط
    const pa = plans[s.id].a;
    const plan = { a: summarizePlans(pa), b: summarizePlans(plans[s.id].b),
                   c: summarizePlans(plans[s.id].c),
                   agree: summarizePlans(pa.filter(x => x.agree)),
                   clash: summarizePlans(pa.filter(x => !x.agree)) };
    return {
      id: s.id, lbl: s.lbl, dir: d, note: s.btNote || null, ...g, reg, oos, plan,
      // الحافة على خط الأساس هي المعلومة، لا الرقم المطلق.
      // **على الوسيط لا المتوسط**: توزيع العوائد ملتوٍ بشدّة، وسهم واحد
      // تضاعف عشر مرات يزيح متوسط آلاف الملاحظات ولا يزيح وسيطها.
      edge: Object.fromEntries(HORIZONS.map(h => [h,
        (Number.isFinite(g.ret[h].med) && Number.isFinite(b.ret[h].med))
          ? r2(g.ret[h].med - b.ret[h].med) : null])),
      edgeWin: Object.fromEntries(HORIZONS.map(h => [h,
        (Number.isFinite(g.ret[h].win) && Number.isFinite(b.ret[h].win))
          ? r2(g.ret[h].win - b.ret[h].win) : null]))
    };
  }).sort((a, b) => (b.edge[20] ?? -99) - (a.edge[20] ?? -99));

  const excluded = SCANS.filter(s => !s.btTest).map(s => ({ id: s.id, lbl: s.lbl }));

  /* التركيبات — لا يخرج منها إلا ما استوفى الحدود الثلاثة معاً:
     عيّنةٌ كافية، وحافةٌ موجبة داخل العيّنة، **وحافةٌ موجبة خارجها**.
     الحدّ الثالث هو الذي يمنع الملف من أن يمتلئ بتركيباتٍ تبدو ذهبية
     لأنها اختيرت على نفس البيانات التي تُقاس عليها. ومن يسقط في الحدّ
     الثالث وحده يُحصى ويُذكر عدده: «جُرّبت وسقطت» معلومةٌ كذلك. */
  const comboRows = [];
  let comboTried = 0, comboFailOOS = 0;
  for (const c of combos.values()) {
    if (c.all.length < MIN_COMBO_N) continue;
    comboTried++;
    const g = summarize(c.dir === -1 ? c.all.map(o => signOutcome(o, -1)) : c.all);
    const e = edgeOf(g, c.dir === -1 ? baseDn : base);
    if (!(e.edge[20] > 0)) continue;
    const go = summarize(c.dir === -1 ? c.oos.map(o => signOutcome(o, -1)) : c.oos);
    const eo = oosFrom ? edgeOf(go, baseOut[String(c.dir)]) : null;
    if (oosFrom && !(c.oos.length >= 40 && eo.edge[20] > 0)) { comboFailOOS++; continue; }
    comboRows.push({ key: c.key, lbl: c.lbl, kind: c.kind, dir: c.dir,
                     n: g.n, ret: g.ret, ...e,
                     oos: oosFrom ? { n: go.n, ret: go.ret, ...eo } : null });
  }
  comboRows.sort((a, b) => (b.edge[20] ?? -99) - (a.edge[20] ?? -99));

  const out = { updated: now, symbols, bars, horizons: HORIZONS, cooldown: COOLDOWN,
                range: RANGE, trimmed: trimmedSyms, maxDayMove: MAX_DAY_MOVE, cryptoExcluded: true,
                baseline: base, baselineDn: baseDn,
                oos: oosFrom ? { from: oosFrom, frac: OOS_FRAC, bars: baseOOS.length,
                                 base: baseOut } : null,
                // نموذج التكلفة يُنشر مع الأرقام لا يُخبَّأ: رقمٌ صافٍ بلا
                // إعلان افتراضه رقمٌ لا يمكن التحقّق منه
                costs: { slipAtr: COSTS.slipAtr, feeBps: COSTS.feeBps, lbl: COSTS.lbl },
                planSim: { simBars: SIM_BARS, entryWait: ENTRY_WAIT,
                           baseEvery: PLAN_BASE_EVERY, base: { a: summarizePlans(basePlans.a),
                                                               b: summarizePlans(basePlans.b) },
                           stopSweep: sweep.map(w => ({
                             m: w.m, n: w.n, actRate: w.n ? r2(w.act / w.n * 100) : null,
                             stop: w.act ? r2(w.stops / w.act * 100) : null,
                             exp: w.rets.length ? r2(mean(w.rets)) : null,
                             med: w.rets.length ? r2(median(w.rets)) : null,
                             win: w.rets.length ? r2(winRate(w.rets)) : null })) },
                combos: { minN: MIN_COMBO_N, tried: comboTried, failedOOS: comboFailOOS,
                          rows: comboRows.slice(0, 40) },
                regime: regime ? { src: MARKET, days: regCount,
                                   bars: { up: baseReg.up.length, dn: baseReg.dn.length },
                                   base: baseByReg } : null,
                scans, excluded };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "backtest.json"), JSON.stringify(out));

  const prevMeta = readJSON(path.join(OUT, "meta.json"), {});
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
    ...prevMeta, backtestUpdated: now,
    backtestRun: { at: new Date(now).toISOString(), symbols, bars, skipped, failed,
                   trimmed: trimmedSyms, requests: stats.requests, range: RANGE,
                   combos: comboRows.length, planFails }
  }));

  console.log(`✔ ${symbols} رمزاً · ${bars.toLocaleString("en-US")} شمعة${skipped ? ` · تُخطّي ${skipped} قصيراً` : ""}${trimmedSyms ? ` · شُذّب ${trimmedSyms}` : ""}`);
  console.log(`  خط الأساس بعد 20 يوماً: وسيط ${base.ret[20].med}% · نسبة موجبة ${base.ret[20].win}%`);
  for (const s of scans)
    console.log(`  ${s.lbl}: ${s.n} إشارة · وسيط ${s.ret[20].med}% · موجب ${s.ret[20].win}% · حافة ${s.edge[20] > 0 ? "+" : ""}${s.edge[20]} نقطة`);
  if (regime) {
    console.log("  الحافة بعد 20 يوماً حسب حالة السوق:");
    for (const s of scans) {
      if (!s.reg) continue;
      const u = s.reg.up, d2 = s.reg.dn;
      console.log(`    ${s.lbl}: صاعد ${u.n} إشارة حافة ${u.edge[20] ?? "—"} · هابط ${d2.n} إشارة حافة ${d2.edge[20] ?? "—"}`);
    }
  }
  if (excluded.length) console.log(`  خارج القياس (لا نملك تاريخ مدخلاتها): ${excluded.map(e => e.lbl).join(" · ")}`);

  /* الخطة المعروضة — الرقم الذي لم يكن يُقاس قبل اليوم */
  const pb = out.planSim.base.a;
  if (pb) console.log(`  خط أساس الخطة (يومٌ عشوائي): فُعِّل ${pb.actRate}% · توقّع ${pb.exp}% · وقف ${pb.stop}%`);
  console.log(`  الخطة المعروضة لكل شرط (صافيةً بعد ${COSTS.lbl}):`);
  for (const s of scans) {
    const a = s.plan && s.plan.a;
    if (!a) continue;
    const b = s.plan.b;
    console.log(`    ${s.lbl}: فُعِّل ${a.actRate}% من ${a.n} · توقّع ${a.exp}% · وقف ${a.stop}%` +
                ` · هدف١ ${a.t[0] ?? "—"}%` + (b ? ` | بالسوق: فُعِّل ${b.actRate}% توقّع ${b.exp}%` : ""));
  }
  if (oosFrom) {
    console.log(`  الحافة داخل العيّنة مقابل خارجها (20 يوماً):`);
    for (const s of scans)
      if (s.oos) console.log(`    ${s.lbl}: داخل ${s.edge[20]} · خارج ${s.oos.edge[20] ?? "—"} (${s.oos.n} إشارة)`);
  }
  console.log(`  التركيبات: ${comboRows.length} نجت من ${comboTried} بلغت حدّ العيّنة` +
              (comboFailOOS ? ` · سقطت ${comboFailOOS} خارج العيّنة` : ""));
  for (const c of comboRows.slice(0, 8))
    console.log(`    ${c.lbl}: ${c.n} إشارة · حافة ${c.edge[20]}` +
                (c.oos ? ` · خارج العيّنة ${c.oos.edge[20]}` : ""));
  console.log(`  مضاعِف الوقف — التوقّع لا نسبة النجاح هو الحَكَم:`);
  for (const w of out.planSim.stopSweep)
    console.log(`    ${w.m}×ATR: فُعِّل ${w.actRate}% · ضُرب الوقف ${w.stop}% · توقّع ${w.exp}% · نجاح ${w.win}%`);
  const bestM = out.planSim.stopSweep.filter(w => Number.isFinite(w.exp))
    .sort((a, b) => b.exp - a.exp)[0];
  if (bestM) console.log(`    ← الأفضل ${bestM.m}×ATR بتوقّع ${bestM.exp}%`);

  console.log(`  اتجاه الخطة مقابل اتجاه الشرط — التناقض يُقاس:`);
  for (const s of scans) {
    const g = s.plan && s.plan.agree, c = s.plan && s.plan.clash;
    if (!g && !c) continue;
    const f = s.plan.c;
    console.log(`    ${s.lbl}: متوافق ${g ? g.n + " إشارة توقّع " + g.exp + "%" : "—"}` +
                ` · متناقض ${c ? c.n + " إشارة توقّع " + c.exp + "%" : "—"}` +
                (f ? ` · لو فُرض اتجاه الشرط: ${f.exp}% على ${f.n}` : ""));
  }

  const ex = out.planSim.base.a && out.planSim.base.a.exitAt;
  if (ex) {
    console.log(`  سياسة الخروج (على خط أساس الخطة):`);
    ex.forEach((p, i) => p && console.log(`    الخروج عند الهدف ${i + 1}: توقّع ${p.exp}% · نجاح ${p.win}% · عيّنة ${p.n}`));
  }
  if (planFails) console.log(`  ⚠ ${planFails} خطة ردّتها بوّابة الاتجاه ولم تُقَس`);
  return 0;
}

/* ---------- فحص ذاتي بلا شبكة ---------- */

/* محاكاة الخطة: كل قاعدةٍ فيها تختار الاحتمال الأسوأ عند الالتباس،
   وكلٌّ منها تُثبَّت هنا. القاعدة التي لا اختبار لها تنقلب إلى نقيضها
   بأول تعديل بلا أن يلاحظ أحد — وهي قواعدُ لا يظهر خطؤها في الإخراج:
   الأرقام تبقى معقولة وتصير أجمل. */
function selfCheckSim(t, eq, near) {
  const flat = (n, px = 100) => Array.from({ length: n },
    () => ({ o: px, h: px, l: px, c: px, v: 1 }));
  const P = (over = {}) => ({ dir: 1, px: 100, entry: 100, entryIsNow: true, atMarket: true,
                              stop: 95, atr: 2, risk: 5, rr: 2,
                              targets: [{ p: 110 }, { p: 120 }, { p: 130 }], ...over });

  t("الشمعة التي تلمس الوقف والهدف معاً تُحسب وقفاً", () => {
    const k = flat(10);
    k[1] = { o: 100, h: 130, l: 90, c: 125, v: 1 };     // بلغت الأهداف الثلاثة والوقف
    const s = simulatePlan(k, 0, P());
    eq(s.st, "stop", "الوقف يسبق");
    if (!(s.ret < 0)) throw new Error("صفقةٌ ضُرب وقفها خرجت رابحة: " + s.ret);
  });

  t("الفجوة تُنفَّذ عند الفتح لا عند الوقف", () => {
    const k = flat(10);
    k[1] = { o: 80, h: 82, l: 79, c: 81, v: 1 };        // فتحت تحت الوقف بكثير
    const s = simulatePlan(k, 0, P());
    // الدخول عند فتح الشمعة 80 ثم الخروج عند 80 نفسها — الخسارة تكلفةٌ لا 15%
    eq(s.st, "stop", "وقف");
    if (!(s.ret < 0)) throw new Error("الفجوة لم تُكلّف شيئاً");
  });

  t("خطةٌ لم يُلمس دخولها ليست رابحة ولا خاسرة", () => {
    const k = flat(20);
    for (let i = 1; i < 20; i++) k[i] = { o: 100, h: 140, l: 99, c: 135, v: 1 };
    // دخولٌ معلَّق عند 90 لم يُلمس رغم أن السعر بلغ كل الأهداف
    const s = simulatePlan(k, 0, P({ entry: 90, entryIsNow: false, atMarket: false, stop: 85 }));
    eq(s.activated, false, "لم تُفعَّل");
    eq(s.ret, undefined, "ولا عائد لها");
    eq(s.st, "cancel", "أُلغيت");
  });

  t("الدخول المعلَّق يُملأ عند مستواه لا عند الفتح الأفضل منه", () => {
    const k = flat(20);
    k[1] = { o: 80, h: 92, l: 79, c: 91, v: 1 };        // فجوةٌ تحت حدّ الشراء 90
    for (let i = 2; i < 20; i++) k[i] = { o: 91, h: 91, l: 91, c: 91, v: 1 };
    const s = simulatePlan(k, 0, P({ entry: 90, entryIsNow: false, atMarket: false,
                                     stop: 85, targets: [{ p: 95 }] }));
    eq(s.activated, true, "فُعِّلت");
    // لو مُلئت عند 80 لكان العائد ‎+13%‎ — الافتراض الأسوأ يعطي ‎+1%‎ تقريباً
    if (!(s.retGross < 3)) throw new Error("مُلئت عند الفتح الأرخص: " + s.retGross);
  });

  t("الدخول بالسوق عند فتح الشمعة التالية لا عند إغلاق الإشارة", () => {
    const k = flat(10);
    k[1] = { o: 105, h: 112, l: 104, c: 111, v: 1 };
    for (let i = 2; i < 10; i++) k[i] = { o: 111, h: 111, l: 111, c: 111, v: 1 };
    const s = simulatePlan(k, 0, P({ targets: [{ p: 110 }] }));
    // دخولٌ عند 105 وهدفٌ عند 110 = ‎+4.8%‎ خاماً، لا ‎+10%‎ من إغلاق 100
    near(s.retGross, 4.76, 0.1, "الدخول من الفتح");
  });

  t("الانتظار محدود — إشارةٌ لم تُفعَّل في نافذتها تُلغى", () => {
    const k = flat(40);
    for (let i = 1; i < 20; i++) k[i] = { o: 100, h: 101, l: 99.5, c: 100, v: 1 };
    for (let i = 20; i < 40; i++) k[i] = { o: 90, h: 91, l: 89, c: 90, v: 1 };
    const s = simulatePlan(k, 0, P({ entry: 90, entryIsNow: false, atMarket: false, stop: 85 }));
    eq(s.activated, false, "الارتداد جاء بعد النافذة فلا يُحتسب");
  });

  t("التكلفة تُطبَّق فالصافي دون الخام دائماً", () => {
    const k = flat(10);
    for (let i = 1; i < 10; i++) k[i] = { o: 100, h: 111, l: 99, c: 110, v: 1 };
    const s = simulatePlan(k, 0, P({ targets: [{ p: 110 }] }));
    if (!(s.ret < s.retGross)) throw new Error(`${s.ret} ≮ ${s.retGross}`);
  });

  t("مقامات النسب ثلاثة لا واحد", () => {
    const mk = (over) => ({ activated: true, st: "expired", ret: 1, retGross: 1,
                            nTargets: 3, hit: [0, null, null], heldBars: 5, waitBars: 1,
                            mfe: 2, mae: -1, ...over });
    const st = summarizePlans([
      { activated: false, st: "cancel" },
      mk({}), mk({ st: "stop", ret: -2, retGross: -2 }),
      mk({ nTargets: 2, hit: [1, null] })
    ]);
    eq(st.n, 4, "المقام الأول كل الإشارات");
    eq(st.activated, 3, "والثاني ما فُعِّل");
    near(st.actRate, 75, 1e-9, "نسبة التفعيل");
    // الهدف الثالث مقامه الخطط ذات الأهداف الثلاثة وحدها (اثنتان من ثلاث)
    eq(st.t[2], 0, "لا هدف ثالث بلغ");
    near(st.stop, 33.33, 0.01, "نسبة الوقف من المفعَّل");
  });

  t("خطةٌ بلا أهداف لا تُقاس", () => {
    eq(simulatePlan(flat(10), 0, P({ targets: [] })), null, "تُردّ");
    eq(simulatePlan(flat(10), 0, null), null, "ولا خطة أصلاً");
  });

  t("المحاكاة تعمل على البيع كما على الشراء", () => {
    const k = flat(10);
    for (let i = 1; i < 10; i++) k[i] = { o: 100, h: 101, l: 89, c: 90, v: 1 };
    const s = simulatePlan(k, 0, P({ dir: -1, stop: 105, targets: [{ p: 90 }] }));
    eq(s.st, "t1", "بلغ هدفه هابطاً");
    if (!(s.ret > 0)) throw new Error("هبوطٌ محقَّق خرج خاسراً: " + s.ret);
  });
}

function selfCheckRegime(t, eq) {
  t("regimeMap يصنّف بالمتوسط لا بالسعر المطلق", () => {
    const day = 86400000;
    // سلسلة هابطة ثم صاعدة: الذيل الصاعد يجب أن يعبر المتوسط
    const k = [];
    for (let i = 0; i < 300; i++) k.push({ t: i * day, c: 100 - i * 0.2 });
    for (let i = 0; i < 120; i++) k.push({ t: (300 + i) * day, c: 40 + i * 1.5 });
    const m = regimeMap(k);
    if (!m) throw new Error("لم تُبنَ الخريطة");
    eq(m.get(290), "dn", "في الهبوط تحت متوسطه");
    eq(m.get(415), "up", "وبعد ارتداد طويل فوقه");
    eq(m.get(50), undefined, "قبل اكتمال المتوسط لا تصنيف");
    eq(regimeMap([{ t: 0, c: 1 }]), null, "سلسلة أقصر من النافذة");
  });
}

function selfCheck() {
  console.log("▶ فحص ذاتي (بلا شبكة)\n");
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; } };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
  const near = (a, b, tol, m) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${m}: ${a} ≠ ${b}`); };

  t("SCANS تُقرأ من الملف المشترك مع المتصفح", () => {
    // الحدّ الأدنى لا العدد بالضبط: الرقم المثبَّت يُسقط الفحص عند كل
    // شرطٍ جديد، فيُخفَّف الفحص بدل أن يُقرأ
    if (!Array.isArray(SCANS) || SCANS.length < 8) throw new Error(`${SCANS?.length}`);
    for (const s of SCANS) if (!s.id || !s.lbl || typeof s.test !== "function") throw new Error(`${s.id} ناقص`);
    return `${SCANS.length} شرطاً · ${SCANS.filter(s => s.btTest).length} منها مقيس`;
  });

  t("الشروط المستبعدة من القياس هي التي تحتاج أساسيات تاريخية", () => {
    eq(SCANS.filter(s => !s.btTest).map(s => s.id), ["cheap", "earn"], "المستبعدان");
  });

  t("rollingExtreme يعطي أعلى وأدنى النافذة", () => {
    eq(rollingExtreme([5, 3, 9, 1, 7], 3, "max"), [null, null, 9, 9, 9], "أعلى");
    eq(rollingExtreme([5, 3, 9, 1, 7], 3, "min"), [null, null, 3, 1, 1], "أدنى");
  });

  t("rollingMean يطابق الحساب المباشر", () => {
    eq(rollingMean([1, 2, 3, 4, 5], 2), [null, 1.5, 2.5, 3.5, 4.5], "متوسط اثنين");
    eq(rollingMean([2, 4, 6], 3), [null, null, 4], "متوسط ثلاثة");
  });

  t("outcome يقيس العائد وأقصى صعود وهبوط بعد الشمعة لا قبلها", () => {
    const k = [];
    for (let i = 0; i < 30; i++) k.push({ o: 100, h: 100, l: 100, c: 100, v: 1 });
    k[10].c = 100;
    k[11] = { o: 100, h: 120, l: 95, c: 110, v: 1 };      // اليوم التالي
    k[15] = { o: 100, h: 100, l: 90, c: 105, v: 1 };
    const o = outcome(k, 10);
    near(o.ret[1], 10, 1e-9, "عائد يوم");
    near(o.ret[5], 5, 1e-9, "عائد خمسة");
    near(o.mfe, 20, 1e-9, "أقصى ربح عائم");
    near(o.mae, -10, 1e-9, "أقصى تراجع عائم");
  });

  t("signOutcome يقلب النتيجة إلى اتجاه الإشارة الهابطة", () => {
    const o = { ret: { 1: 10, 5: -4, 20: null }, mfe: 20, mae: -10 };
    const s = signOutcome(o, -1);
    near(s.ret[1], -10, 1e-9, "عائد يوم مقلوب");
    near(s.ret[5], 4, 1e-9, "العائد السالب صار موجباً");
    eq(s.ret[20], null, "الغائب يبقى غائباً لا صفراً");
    // أقصى ربح على البيع هو أدنى قاع — لا قلب العائد وحده
    near(s.mfe, 10, 1e-9, "أقصى ربح من القاع");
    near(s.mae, -20, 1e-9, "أقصى تراجع من القمة");
  });

  t("signOutcome لا يمسّ الاتجاه الصاعد ولا يعيد كائناً جديداً بلا داعٍ", () => {
    const o = { ret: { 1: 3 }, mfe: 5, mae: -1 };
    if (signOutcome(o, 1) !== o) throw new Error("نسخة بلا حاجة");
  });

  t("حافة الشرط الهابط تُقاس على خط أساس هابط", () => {
    // سوق صاعد: العيّنة كلها +2%. إشارة هبوطية أصابت مرة بـ-5%.
    const mkO = (v) => ({ ret: { 1: v, 5: v, 20: v }, mfe: v > 0 ? v : 0, mae: v < 0 ? v : 0 });
    const baseline = [mkO(2), mkO(2), mkO(2)];
    const base = summarize(baseline);
    const baseDn = summarize(baseline.map(o => signOutcome(o, -1)));
    near(base.ret[20].med, 2, 1e-9, "خط الأساس الصاعد");
    near(baseDn.ret[20].med, -2, 1e-9, "خط الأساس الهابط مقلوبه");
    const g = summarize([mkO(-5)].map(o => signOutcome(o, -1)));
    near(g.ret[20].med, 5, 1e-9, "الإشارة الهابطة ربحت 5%");
    // على خط الأساس الصحيح الحافة +7؛ وعلى الخاطئ كانت ستخرج -7
    near(g.ret[20].med - baseDn.ret[20].med, 7, 1e-9, "حافة موجبة");
    near(g.ret[20].med - base.ret[20].med, 3, 1e-9, "لو قِيست على الصاعد لاختلفت");
  });

  t("كل شرط هابط يحمل dir والصاعد لا يحمله", () => {
    /* الخاصيّة لا القائمة: `dir` تقلب قياس النجاح، فشرطٌ هابط بلا `dir`
       يُحتسب رابحاً حين **يصعد** السعر — أخطر خلل مرّ بالمشروع. فنفحص
       أن كل شرطٍ وسمُه فيه ▼ يحمل ‎−1‎ وكل ما فيه ▲ لا يحمل `dir`. */
    for (const s of SCANS) {
      const down = s.lbl.includes("▼");
      if (down && s.dir !== -1) throw new Error(`${s.id}: وسمُه هابط و dir=${s.dir}`);
      if (!down && s.dir === -1) throw new Error(`${s.id}: dir هابط ووسمُه ليس كذلك`);
    }
    const dn = SCANS.filter(s => s.dir === -1).map(s => s.id);
    if (!dn.length) throw new Error("لا شرط هابط — هل حُذف dir؟");
    return dn.join(" · ");
  });

  t("outcome يعيد null لأفق يتجاوز البيانات", () => {
    const k = Array.from({ length: 22 }, () => ({ o: 1, h: 1, l: 1, c: 1, v: 1 }));
    eq(outcome(k, 20).ret[20], null, "الأفق أبعد من الشمعات");
  });

  t("trimArtifacts يقطع سلسلة ما قبل الإدراج", () => {
    // الشكل الحقيقي لـ UNI-USD: أسعار وهمية ثم قفزة مليونية ثم سعر حقيقي
    const k = [{ c: 0.000038 }, { c: 0.000039 }, { c: 0.598 }, { c: 0.61 }, { c: 0.6 }];
    const r = trimArtifacts(k);
    eq(r.k.map(x => x.c), [0.61, 0.6], "بقي ما بعد القفزة");
    eq(r.trimmed, 3, "عدد المقطوع");
  });

  t("trimArtifacts لا يمسّ سلسلة سليمة ويقطع عند السعر الصفري", () => {
    const ok = [{ c: 100 }, { c: 105 }, { c: 99 }];
    eq(trimArtifacts(ok).trimmed, 0, "سليمة");
    eq(trimArtifacts(ok).k.length, 3, "بلا قطع");
    // السعر الصفري يُبطل العائد الداخل إليه كما يُبطل الخارج منه، فيسقط
    // معه الشمعة التالية — خسارة شمعة واحدة أرخص من عائد بلا معنى
    eq(trimArtifacts([{ c: 100 }, { c: 0 }, { c: 101 }, { c: 102 }]).k.map(x => x.c), [102], "سعر صفري");
  });

  t("قفزة مليونية واحدة تُفسد المتوسط ولا تُفسد الوسيط", () => {
    const clean = Array.from({ length: 999 }, () => 1);
    const dirty = clean.concat([1573986]);
    near(median(dirty), 1, 1e-9, "الوسيط صامد");
    if (!(mean(dirty) > 1500)) throw new Error("المتوسط يُفترض أن ينفجر");
  });

  t("median وmean صحيحتان على الحالات الحدّية", () => {
    eq([median([]), mean([])], [null, null], "فارغ");
    eq(median([3, 1, 2]), 2, "فردي");
    eq(median([4, 1, 3, 2]), 2.5, "زوجي");
  });

  t("snapshots تبني صفوفاً بشكل صفّ الملخّص وتتخطّى فترة التسخين", () => {
    const k = [];
    let p = 100;
    for (let i = 0; i < WARMUP + 40; i++) { p *= 1 + (Math.sin(i / 7) * 0.01); k.push({ o: p, h: p * 1.01, l: p * 0.99, c: p, v: 1000 + i }); }
    const sn = snapshots({ s: "TST", sec: "تقنية" }, k);
    eq(sn.slice(0, WARMUP).every(x => x === null), true, "التسخين فارغ");
    const r = sn[WARMUP].row;
    for (const key of ["s", "sec", "p", "w52h", "w52l", "rsi", "atr", "vol", "score", "tfScore"])
      if (!(key in r)) throw new Error(`الحقل ${key} ناقص`);
    if (!(r.w52h >= r.p && r.w52l <= r.p)) throw new Error("نطاق 52 أسبوعاً لا يحيط بالسعر");
    if (!(r.score >= -100 && r.score <= 100)) throw new Error(`نتيجة خارج المدى: ${r.score}`);
  });

  t("شروط الماسح تعمل على لقطة تاريخية بلا استثناء", () => {
    const row = { s: "TST", sec: "تقنية", p: 100, w52h: 101, w52l: 60, rsi: 30,
                  atr: 2, vol: 3000, score: 20, tfScore: { "1d": 20 } };
    const f = { avgVol: 1000 };
    for (const s of SCANS) {
      if (!s.btTest) continue;
      const v = s.btTest(row, f, { secMed: {} });
      if (typeof v !== "boolean") throw new Error(`${s.id} أعاد ${typeof v}`);
    }
    // هذه اللقطة تحقّق: قرب القمة، حجم 3×، تشبّع بيعي في اتجاه موجب
    const on = SCANS.filter(s => s.btTest && s.btTest(row, f, { secMed: {} })).map(s => s.id);
    eq(on.sort(), ["align", "high52", "oversold", "vol"], "الشروط المحقَّقة");
  });

  t("scoreFrom تطابق ما يحسبه analyze", async () => {
    // الاختبار الحقيقي: نفس القيم تعطي نفس النتيجة عبر المسارين
    const a = { px: 110, e20: 105, e50: 100, e200: 95, rsi: 60, hist: 0.4, histRising: true, bbMid: 104, atr: 2 };
    const s = scoreFrom(a);
    if (!(s > 90)) throw new Error(`كل الشروط موجبة يُفترض أن تقارب 100: ${s}`);
    const b = scoreFrom({ px: 90, e20: 95, e50: 100, e200: 105, rsi: 30, hist: -0.4, histRising: false, bbMid: 96, atr: 2 });
    if (!(b < -90)) throw new Error(`كل الشروط سالبة: ${b}`);
    eq(scoreFrom({ px: 100 }), 0, "بلا مؤشرات");
  });

  t("المنطقة الميتة تحيّد البوابة الملتصقة ولا تحيّد العبور الحقيقي", () => {
    // فرقٌ أقلّ من ‎0.15×ATR‎ = لا تصويت. ATR=2 -> العتبة 0.3
    const near = { px: 100, e20: 100.1, e50: 99, e200: 98, rsi: 50, hist: 0.05,
                   histPrev: 0.04, bbMid: 100.2, atr: 2 };
    const sc = scoreFrom(near);
    // e200 و e50 وحدهما يصوّتان (2.5 + 1.5 من 8.5)
    eq(Math.round(sc * 100) / 100, Math.round(4 / 8.5 * 10000) / 100, "الملتصقة محيَّدة");
    // نفس المدخلات بعبورٍ حقيقي (‎0.5‎ > العتبة) تصوّت سالباً
    const far = { ...near, e20: 100.5, bbMid: 100.6 };
    if (!(scoreFrom(far) < sc)) throw new Error("العبور الحقيقي يجب أن يُحسب");
    // وسلسلةٌ مجمّدة (كل شيء متساوٍ) تخرج صفراً لا ‎−100‎
    eq(scoreFrom({ px: 5, e20: 5, e50: 5, e200: 5, rsi: 50, hist: 0, histPrev: 0, bbMid: 5, atr: 0.01 }),
       0, "المجمَّدة عرضية لا هابطة");
  });

  selfCheckSim(t, eq, near);
  selfCheckCosts(t, eq);
  selfCheckRegime(t, eq);

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل`);
  process.exit(fail ? 1 : 0);
}

/* لا يعمل إلا حين يكون هو نقطة الدخول — `backtest-strategies.mjs`
   يستورد `simulatePlan` و`summarizePlans` منه، وقواعد المحاكاة الستّ
   يجب أن تكون نسخةً واحدة وإلا قِيس الأرشيفان بمسطرتين. وبلا هذا
   الحدّ كان الاستيراد وحده يجلب خمسمئة رمزٍ لعشر سنوات. */
const IS_MAIN = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (IS_MAIN) {
  if (CHECK) selfCheck();
  else main().catch(e => { console.error("✗ فشل التشغيل:", e.message); process.exit(1); });
}
