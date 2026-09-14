#!/usr/bin/env node
/* =====================================================================
   تتبّع الإشارات الحيّة — سجلّ ما ظهر فعلاً في التطبيق، لا ما كان يمكن
   أن يظهر.

   الأرشيف التاريخي (`backtest.mjs`) يقيس الشروط على تاريخ مُعاد بناؤه.
   هذا يقيس ما رآه المستخدم بعينه: نفس الشروط الثمانية بنفس البيانات
   التي كانت أمامه لحظتها، بما فيها الشرطان اللذان لا يمكن قياسهما
   تاريخياً (مكرر الربحية وموعد الأرباح) لأننا لا نملك تاريخ مدخلاتهما
   — لكننا نملك حاضرها، ويكفي أن نثبّته لحظة ظهوره.

   الملف تراكمي: كل تشغيل يضيف الجديد ويحدّث المفتوح ويغلق ما بلغ أفقه.
   ولهذا بوابة سلامة خاصة — انظر `guard` أدناه.

     node scripts/track-signals.mjs --out ./data
     node scripts/track-signals.mjs --check
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SCANS, forcedDir } = require("../stocks/scans.js");
// نفس نواة الخطة وطبقة التقييم التي يقرأها المتصفح — نسخةٌ ثانية هنا
// تجعل السجلّ يقول إن الهدف كان 106 والمستخدم رأى 112
const { levelsFrom, planFrom, planPair, planDirOf, validatePlan } = require("../stocks/plan.js");
const { freshness, scanTF, entryQuality, etaFor, horizonsOf } = require("../stocks/evaluate.js");
// حدود النطاقات من نواة النتيجة نفسها: كانت مكتوبة هنا مرةً ثانية، وكان
// `bandOf` المحلي يخالف `labelOf` عند الحدّ بالضبط (‎−45‎ عنده «هابط قوي»
// وعند هذا «ميل هابط») — خلافٌ صامت في ملفٍ يقيس انقلابات الاتجاه
const { BANDS, bandOf } = require("../stocks/score.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();

const HOLD_DAYS = 28;                  // ~20 يوم تداول
const MAX_RECORDS = 20000;             // سقف الملف
const DAY = 86400e3;

/* تسلسل النتيجة الفنية — حدوده مشروحة عند `pushTrend` أدناه */
const TREND_MAX = 40;                  // نقاط لكل رمز
const TREND_DAYS = 14;                 // عمر النقطة الأقصى
const TREND_STEP = 5;                  // أصغر حركة تستحق نقطة

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
/* `rp` لا `r4`: كل ما تحت السطر التالي **سعر**، والتقريب بخانات ثابتة
   يمحو الأصول الرخيصة. خرجت لقطة `SHIB-USD` بدخولٍ صفر ووقفٍ صفر وATR
   صفر وبلا هدف — صفقةٌ في السجلّ بمخاطرةٍ غير موجبة. و`r2` تبقى لما
   ليس سعراً (العائد والنسبة والمضاعف). انظر `lib/round.mjs`. */
import { rp, r2 } from "./lib/round.mjs";

export function median(a) {
  const s = (a || []).filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

/* وسائط القطاعات — نفس ما تبنيه الواجهة، فشرط «أرخص من قطاعه» يقارن
   بالمرجع نفسه في الموضعين. */
export function sectorMedians(rows, F) {
  const bySec = {};
  for (const r of rows) if (F[r.s]) (bySec[r.sec] ||= []).push(F[r.s]);
  const out = {};
  for (const [sec, list] of Object.entries(bySec)) {
    out[sec] = {
      n: list.length,
      pe: median(list.map(x => x.pe)),
      pb: median(list.map(x => x.pb)),
      roe: median(list.map(x => x.roe)),
      margin: median(list.map(x => x.margin)),
      grow: median(list.map(x => x.revGrow))
    };
  }
  return out;
}
/* =====================================================================
   بوابة سلامة خاصة بملف تراكمي.

   `data/` مستبعد من git ويُنشر إلى فرع `data` بدفعة `-f`. سجلّ الإشارات
   ملف **يتراكم عبر الشهور**: تشغيل واحد يكتب نسخة أقصر — لأن القرص
   امتلأ، أو لأن الملف قُرئ تالفاً فعاد `[]` — يدوس تاريخاً لا يُستعاد.
   لذلك: لا نكتب أقصر مما كان، إلا حين يتجاوز الملف سقفه فيُشذَّب عمداً.
   ===================================================================== */
export function guard(prevCount, nextCount, { pruning = false } = {}) {
  if (pruning) return true;
  if (nextCount >= prevCount) return true;
  throw new Error(`السجلّ يتقلّص ${prevCount} ← ${nextCount} — مرفوض`);
}

/* هل هذه الإشارة مفتوحة أصلاً لهذا الرمز؟ إشارة تبقى محقَّقة أسبوعين
   تُسجَّل مرة واحدة لا أربع عشرة. */
export const openKey = (s) => `${s.sym}|${s.scan}`;

/* اتجاه الشرط من تعريفه الواحد في `scans.js` — لا نسخة ثانية هنا، فنسختان
   من الاتجاه تتباعدان فيقيس الأرشيف شرطاً غير الذي يراه المستخدم. */
export const scanDir = (id) => {
  const s = SCANS.find(x => x.id === id);
  return (s && s.dir === -1) ? -1 : 1;
};

/* تحديث إشارة مفتوحة بسعر اليوم.

   العائد يُقاس **باتجاه الإشارة** المثبَّت في سجلّها: إشارة هبوط تربح حين
   يهبط السعر. قياسُ كل الإشارات بمنطق الشراء كان يقلب معنى إشارتي الهبوط
   تماماً، فتُحتسب «توافق الفريمات ▼» رابحة حين يصعد السعر — أي أن الأرشيف
   كان يحكم على شرطٍ يعمل بأنه فاشل، والرقم يبدو موثوقاً لأنه محسوب. */
export function update(sig, price, now) {
  if (!(price > 0) || !(sig.entry > 0)) return sig;
  const d = sig.dir === -1 ? -1 : 1;
  const ret = (price - sig.entry) / sig.entry * 100 * d;
  sig.last = r2(price);
  sig.ret = r2(ret);
  sig.mfe = r2(Math.max(sig.mfe ?? ret, ret));
  sig.mae = r2(Math.min(sig.mae ?? ret, ret));
  sig.at2 = now;
  if (now - sig.at >= HOLD_DAYS * DAY) { sig.open = false; sig.closed = now; }
  return sig;
}

/* =====================================================================
   تسلسل النتيجة الفنية لكل رمز — «متى صارت هذه التوصية، وماذا كانت قبل».

   الشاشة تعرض حالة السهم **الآن** فقط، فمن يرى «هابط ‎−97‎» لا يعرف إن
   كانت هذه حالته منذ أسبوع أم انقلبت قبل ساعة — والفرق بينهما هو الفرق
   بين اتجاه راسخ وانقلاب طازج.

   ولا نحفظ كل دورة: 96 رمزاً × 144 دورة يومياً = ~14 ألف نقطة في اليوم،
   أي ملفٌ بالميغابايتات يصف حركةً لا معنى لها — نتيجةٌ تتحرك من 78.8 إلى
   79.1 ليست حدثاً. فتُحفظ النقطة في حالتين فقط:

     ١) **تغيّر النطاق** (عبور ‎±15‎ أو ‎±45‎، حدود `labelOf` نفسها) —
        هذا هو انقلاب الاتجاه الذي لا يجوز أن يُفقد أبداً، ولو كانت
        الحركة نقطةً واحدة.
     ٢) حركة ‎±5‎ نقاط أو أكثر عن آخر نقطة محفوظة.

   والزمن **بالثواني لا بالملّي**: ثلاثة أرقام زائدة في كل نقطة تصير
   18 كيلوبايت في ملف بستة آلاف نقطة، بلا أن تُقرأ.

   ⚠ دقة الزمن هي دورة السوق (عشر دقائق)، لا الدقيقة. من قرأ «10:35»
   فالحدث بين 10:25 و10:35 — والواجهة تقول ذلك صراحةً.
   ===================================================================== */
export { bandOf };

export function pushTrend(list, ts, score, price) {
  if (!Number.isFinite(score)) return list;
  const pts = Array.isArray(list) ? list : [];
  const last = pts[pts.length - 1];
  const sec = Math.round(ts / 1000);
  if (last) {
    const moved = Math.abs(score - last[1]) >= TREND_STEP;
    const flipped = bandOf(score) !== bandOf(last[1]);
    if (!moved && !flipped) return pts;
    // نقطتان في نفس اللحظة تعني تشغيلين في دقيقة — نُبقي الأحدث
    if (last[0] === sec) { pts[pts.length - 1] = [sec, r2(score), price ?? null]; return pts; }
  }
  pts.push([sec, r2(score), price ?? null]);
  return pts;
}

/* التشذيب بالعمر ثم بالسقف. لا يمسّ الترتيب: النقاط تُدفع زمنياً أصلاً. */
export function trimTrend(pts, now) {
  const cut = Math.round((now - TREND_DAYS * DAY) / 1000);
  const fresh = (pts || []).filter(p => Array.isArray(p) && p[0] >= cut);
  return fresh.length > TREND_MAX ? fresh.slice(-TREND_MAX) : fresh;
}

/* بوابة المجموع بعد فصل المفتوح عن المغلق: `signals.json` يتقلّص مشروعاً
   كلما أُغلق سجلّ وانتقل إلى `history.json`، فقياسُه وحده يرفض تشغيلاً
   سليماً. المجموعُ هو الذي لا يجوز أن يتقلّص. */
export function guardTotal(prevTotal, nextTotal, { pruning = false } = {}) {
  if (pruning) return true;
  if (nextTotal >= prevTotal) return true;
  throw new Error(`مجموع السجلّ يتقلّص ${prevTotal} ← ${nextTotal} — مرفوض`);
}

/* بوابة `trend.json`: النقاط تتقلّص بالتشذيب كل تشغيل فلا تصلح مقياساً،
   أما **الرموز** فلا تختفي إلا بخلل — ملف قُرئ تالفاً أو ملخّص فارغ. */
export function guardTrend(prevSyms, nextSyms) {
  if (prevSyms > 0 && nextSyms < prevSyms * 0.8)
    throw new Error(`رموز التسلسل تتقلّص ${prevSyms} ← ${nextSyms} — مرفوض`);
  return true;
}

/* =====================================================================
   اللقطة الثابتة — المرحلة الثامنة: منع النظرة إلى المستقبل.

   المشكلة التي تمنعها: نظامٌ يعيد بعد أسبوع حسابَ توصيةٍ قديمة ببيانات
   اليوم، ثم يقول «هذه كانت التوصية». الأرقام تخرج أجمل دائماً، لأنها
   حُسبت وقد صار المستقبل معلوماً — وهو ما جعل خط الأساس في أول أرشيف
   يقول 19% بدل 1%.

   فالفصل بنيوي لا اختياري:
     · `snap` تُكتب **مرة واحدة** لحظة الإشارة ولا تُلمس بعدها أبداً.
     · `out`  تُحدَّث بما جاء **بعد** اللقطة وحده.

   وما تحفظه اللقطة هو ما رآه المستخدم بعينه: الخطة بأهدافها ووقفها،
   والطزاجة، والزمن المتوقّع، والآفاق الثلاثة، وقيم المؤشرات لحظتها.
   وكلها من نفس الوحدات المشتركة التي يحسب بها المتصفح.
   ===================================================================== */
export function buildSnap({ row, sym, an, k4h, k1d, f, at }) {
  const px = row.p;
  if (!(px > 0)) return null;
  const base = (k4h && k4h.length > 20) ? "4h" : "1d";
  const a = (an && an[base]) || null;
  const L = levelsFrom({ k4h, k1d, px, a, now: at,
    w52h: f && Number.isFinite(f.w52h) ? f.w52h : null,
    w52l: f && Number.isFinite(f.w52l) ? f.w52l : null });
  if (!L) return null;

  // ATR **اليومي** لا ATR فريم الأساس — نفس اختيار `tradePlan` في المتصفح
  const atr = (Number.isFinite(row.atr) && row.atr > 0) ? row.atr : L.atr;
  /* `row.__scan` هو الشرط الذي أطلق هذه الإشارة — والشرط قد يفرض اتجاه
     خطته. يُقرأ هنا لا في المتصفح وحده: السجلّ يحفظ ما رآه المستخدم،
     فاختلافُ الاتجاه بين الخادم والواجهة يجعل المحفوظ غير المرئي. */
  const dir = planDirOf(row.score, forcedDir(row.__scan));
  const { a: p, b: pb } = planPair({ px: L.px, atr, resAll: L.resAll, supAll: L.supAll }, dir);
  if (!p) return null;
  const bad = validatePlan(p);
  if (bad.length) { console.warn(`  ⚠ خطة ${sym} مرفوضة: ${bad[0]}`); return null; }
  // المسار الثاني يمرّ بنفس البوابة: خطةٌ مرفوضة لا تُسجَّل ولو كانت ثانويةً
  const badB = pb ? validatePlan(pb) : ["لا مسار ثانٍ"];
  const b = (pb && !badB.length) ? pb : null;

  const tf = scanTF(row.__scan);
  const hz = horizonsOf(row.tfScore);
  const snap = {
    px: p.px, e: rp(p.entry), s: rp(p.stop), rr: r2(p.rr), atr: rp(p.atr), dir,
    t: p.targets.map(t => rp(t.p)),
    tpct: p.targets.map(t => r2(t.pct)),
    trr: p.targets.map(t => r2(t.rr)),
    // العمر صفرٌ لحظة الإشارة، فالطزاجة «جديدة» دائماً هنا — نحفظ الفريم
    // المرجعي لأنه هو ما تُقاس عليه الطزاجة لاحقاً، لا حالتَها الآن
    tf,
    // ATR المستعمل يوميٌّ دائماً (من الملخّص)، فوحدة الزمن يومية — لا
    // فريم الشرط، وإلا خُلطت وحدتان
    eta: p.targets.map(t => {
      const e = etaFor({ from: p.entry, target: t.p, atr, dir, atrTf: "1d", tfScore: row.tfScore });
      return e ? [Math.round(e.lo), Math.round(e.hi)] : null;
    }),
    hz: Object.fromEntries(hz.map(h => [h.id, r2(h.score)])),
    /* المسار الثاني: الدخول بسعر اللحظة بدل انتظار الارتداد. تُحفظ حقولُه
       الأربعة وحدها لأن ما عداها (الاتجاه والمدى والفريم والزمن المتوقَّع)
       مشتركٌ بين المسارين. وهو **غائبٌ عمداً** حين لا حاجز قريب: المساران
       يتطابقان حينئذٍ، وتسجيلُهما يضاعف الصفقة نفسها في مقامين. */
    ...(b ? { b: { e: rp(b.entry), s: rp(b.stop), rr: r2(b.rr),
                   t: b.targets.map(t => rp(t.p)),
                   trr: b.targets.map(t => r2(t.rr)) } } : {}),
    an: a ? { rsi: r2(a.rsi), e50: rp(a.e50), e200: rp(a.e200),
              hist: a.hist === null || a.hist === undefined ? null : Number(a.hist.toFixed(6)),
              up: a.histRising === true } : null
  };

  /* =====================================================================
     البوابة **على المحفوظ** لا على المحسوب — والفرق بينهما التقريب.

     `validatePlan(p)` أعلاه تفحص الخطة قبل تقريبها، ثم يُبنى ما يُحفظ
     فعلاً بأرقامٍ مقرَّبة — فأيُّ تشويهٍ يقع **بعد** الفحص يمرّ بلا
     اعتراض. وهو ما وقع: التقريب بخانات ثابتة (`r4`) صفّر دخولَ
     `SHIB-USD` ووقفَه وATRه وأفرغ أهدافه، فحُفظت صفقةٌ مخاطرتُها غير
     موجبة تحت خطةٍ اجتازت الفحص قبل لحظة.

     والقاعدة أعمّ من التقريب: **ما يُفحص يجب أن يكون ما يُكتب.** فحصٌ
     على تمثيلٍ وسيط يشهد لشيءٍ لا يصل القرص. ولذلك تُعاد البوابة هنا
     على اللقطة نفسها بحقولها المحفوظة — وهي رخيصةٌ (مقارناتُ إشارة)
     وتُغلق الباب على كل مشوِّهٍ قادم لا على هذا وحده.

     واللقطةُ المردودة **لا تُحفظ ناقصة**: لا إشارة خيرٌ من إشارةٍ
     أرقامُها كاذبة — نفس قاعدة «اعرض ‎—‎ لا رقماً ملفّقاً». */
  const badSnap = validatePlan({
    dir: snap.dir, entry: snap.e, stop: snap.s, risk: (snap.e - snap.s) * snap.dir,
    atr: snap.atr, targets: (snap.t || []).map((tp, i) => ({ p: tp, rr: (snap.trr || [])[i] ?? 1 })),
    primary: (snap.t && snap.t.length) ? { p: snap.t[snap.t.length - 1] } : null
  });
  if (badSnap.length) {
    console.warn(`  ⚠ لقطة ${sym} مرفوضة بعد التقريب: ${badSnap[0]}`);
    return null;
  }
  return snap;
}

/* =====================================================================
   النتيجة — ما جاء بعد اللقطة، ولا شيء غيره.

   دورة حياة الصفقة كما تُقاس فعلاً:
     `wait` لم يُلمس الدخول بعد → `open` دخلت → `t1/t2/t3` أو `stop`
     → `expired` انتهى الأفق مفتوحةً → `cancel` انتهى الأفق بلا دخول.

   ولماذا `wait` منفصلة: خطةٌ دخولها عند دعمٍ لم يُلمس **لم تُفتح**، وحسابُ
   «بلغ الهدف» عليها يمنح النظام صفقةً رابحة لم يكن يمكن الدخول فيها.

   ⚠ القياس عند حدود الدورة (عشر دقائق): قفزةٌ داخل الدورة لا تُرى. هذا
   يُنقص عدد الأهداف المحقَّقة ولا يزيده — وهو الخطأ المقبول، لأن العكس
   يمنح النظام نجاحاً لم يحدث.
   ===================================================================== */
const TERMINAL = new Set(["stop", "t3", "expired", "cancel"]);

/* =====================================================================
   مساران لدورتَي حياة مستقلّتين تماماً.

   المسار «أ» يحتفظ بحقوله الأصلية (`out` · `open` · `closed`) بلا أيّ
   تغيير في معناها، فكلّ ما يقرأها في الملفّ يبقى صحيحاً. و«ب» يأخذ
   حقولاً موازية.

   والفصل **إلزامي لا تنظيمي**: لو تشاركا `open` لأغلق وقفُ «أ» في اليوم
   الثالث تتبّعَ «ب» وهو لم يبلغ هدفه بعد — فيُسجَّل للمسار الثاني انتهاءٌ
   لم يقع، وهو بالضبط تزييف النتيجة الذي تمنعه المرحلة الثامنة.
   ===================================================================== */
const TRACKS = {
  a: { out: "out",  open: "open",  closed: "closed",
       e: (s) => s.e, stop: (s) => s.s, t: (s) => s.t || [] },
  b: { out: "outB", open: "openB", closed: "closedB",
       e: (s) => s.b.e, stop: (s) => s.b.s, t: (s) => (s.b && s.b.t) || [] }
};

export function updateOutcome(sig, price, now, tr = "a") {
  const T = TRACKS[tr] || TRACKS.a;
  const snap = sig.snap;
  if (!snap || !(price > 0)) return sig;
  // السجلّات السابقة للمسار الثاني لا تملك `snap.b`، ولا تُملأ بأثر رجعي:
  // لقطةٌ تُبنى بعد الحدث تدّعي أنها رأت ما لم ترَه.
  if (tr === "b" && !snap.b) return sig;
  const d = snap.dir === -1 ? -1 : 1;
  const E = T.e(snap), S = T.stop(snap), TG = T.t(snap);
  const out = (sig[T.out] ||= { st: "wait", hit: TG.map(() => null), stopAt: null, enterAt: null });

  /* الصفقة المنتهية لا تُحدَّث. بلا هذا الحدّ كانت الصفقةُ التي ضُرب
     وقفُها تسجّل أهدافها حين يرتدّ السعر بعدها — فتظهر «خاسرة بلغت أهدافها
     الثلاثة». حلقةُ التشغيل تنادي المفتوحةَ وحدها فلم يظهر ذلك في تشغيل،
     لكن سجلٌّ يقبل التعديل بعد إغلاقه ينقض المرحلة الثامنة من أساسها. */
  if (TERMINAL.has(out.st) || !sig[T.open]) return sig;

  // ١) الدخول: السعر لمس منطقة الدخول (أو كانت «السعر الآن» فدخلت فوراً)
  if (out.st === "wait") {
    if ((E - price) * d >= 0 || Math.abs(price - E) / E < 1e-9) {
      out.enterAt = now; out.st = "open";
    }
  }

  if (out.st === "wait") {
    // بلا دخول لا وقف ولا هدف. وانتهاء الأفق بلا دخول إلغاءٌ لا خسارة.
    if (now - sig.at >= HOLD_DAYS * DAY) { out.st = "cancel"; sig[T.open] = false; sig[T.closed] = now; }
    return sig;
  }

  // ٢) الوقف قبل الأهداف: صفقةٌ ضُرب وقفها لا تُكمل إلى هدفها
  if (out.st === "open" || out.st === "t1" || out.st === "t2") {
    if ((price - S) * d <= 0) {
      out.stopAt = now; out.st = "stop"; sig[T.open] = false; sig[T.closed] = now;
      return sig;
    }
  }

  // ٣) الأهداف بالترتيب — لا يُسجَّل الثاني قبل الأول
  TG.forEach((tp, i) => {
    if (out.hit[i] !== null || !Number.isFinite(tp)) return;
    if ((price - tp) * d >= 0) out.hit[i] = now;
  });
  const reached = out.hit.filter(x => x !== null).length;
  if (reached >= 3) { out.st = "t3"; sig[T.open] = false; sig[T.closed] = now; }
  else if (reached === 2) out.st = "t2";
  else if (reached === 1) out.st = "t1";

  // ٤) انتهاء الأفق وهي مفتوحة
  if (sig[T.open] && now - sig.at >= HOLD_DAYS * DAY) {
    out.st = reached ? `t${reached}` : "expired";
    sig[T.open] = false; sig[T.closed] = now;
  }
  return sig;
}

/* السجلّ حيٌّ ما دام **أيُّ** مسارٍ فيه يُقاس. وقفُ «أ» لا ينقل السجلّ إلى
   التاريخ و«ب» ما زالت مفتوحة، وإلا خرجت من حلقة التحديث فتجمّدت عند آخر
   سعرٍ رأته وسُجّل لها انتهاءٌ لم يقع. */
export const stillLive = (sig) => !!(sig.open || sig.openB);

/* الصفقة رابحة أو خاسرة أو **لا واحدة منهما**. المفتوحة ليست رابحة، ولا
   الملغاة خاسرة — وعدُّها في أيّ الخانتين يزيّف نسبة النجاح كلها. */
export function verdictOf(sig, tr = "a") {
  const T = TRACKS[tr] || TRACKS.a;
  const st = sig[T.out] && sig[T.out].st;
  if (!st) return "unknown";
  if (st === "wait") return "wait";              // لم تُفتح بعد — لا هي ولا ضدّها
  if (st === "t1" || st === "t2" || st === "t3") return sig[T.open] ? "running" : "win";
  if (st === "stop") return "loss";
  if (st === "expired") return "flat";
  if (st === "cancel") return "cancel";
  return "running";
}

/* =====================================================================
   إحصاء النتائج — المرحلة السابعة.

   القاعدة التي تُطبَّق **في الحساب لا في النص**: الصفقة المفتوحة ليست
   رابحة ولا خاسرة، والملغاة (انتهى أفقها بلا أن يُلمس دخولها) ليست
   خسارة. مقامُ كل نسبة هو المغلقات وحدها — وعدُّ المفتوحات في المقام
   يجعل نسبة النجاح تنخفض كلما ظهرت إشارة جديدة، وهو رقمٌ يقيس النشاط
   لا الأداء.

   ونسبة بلوغ الهدف تُقاس على **ما دخل** لا على كل ما ظهر: خطةٌ لم يُلمس
   دخولها لم تكن صفقةً، فحسابها في المقام يخفض النسبة بلا سبب.
   ===================================================================== */
export function outcomeStats(records, tr = "a") {
  const T = TRACKS[tr] || TRACKS.a;
  const O = (s) => s[T.out];
  // مقام المسار الثاني سجلّاتُه وحدها: السجلّات السابقة له لا تملك `snap.b`،
  // وضمُّها إلى المقام يخفض نسبته بصفقاتٍ لم يخُضها قط.
  const withSnap = records.filter(s => s.snap && !s.conv && s.mkt !== "crypto"
    && (tr !== "b" || s.snap.b));
  const entered = withSnap.filter(s => O(s) && O(s).st !== "wait" && O(s).st !== "cancel");
  const closed = entered.filter(s => !s[T.open]);
  const tgts = (s) => T.t(s.snap);

  const hitRate = (i) => {
    // مقام الهدف i: من دخل **ومعه هدفٌ بهذا الرقم أصلاً** — خطة بهدفين
    // لا تُحاسب على ثالث لم تعرضه
    const pool = entered.filter(s => tgts(s).length > i);
    if (!pool.length) return null;
    return r2(pool.filter(s => O(s).hit[i] !== null).length / pool.length * 100);
  };
  const timeTo = (i) => {
    const times = entered
      .filter(s => O(s).hit[i] !== null && O(s).enterAt)
      .map(s => O(s).hit[i] - O(s).enterAt)
      .filter(Number.isFinite);
    // الوسيط لا المتوسط: صفقةٌ بلغت هدفها بعد 27 يوماً تُزيح المتوسط وحدها
    return times.length ? { n: times.length, med: Math.round(median(times)) } : null;
  };
  const byDir = (d) => {
    const g = closed.filter(s => (s.snap.dir === -1 ? -1 : 1) === d);
    const w = g.filter(s => verdictOf(s, tr) === "win").length;
    const l = g.filter(s => verdictOf(s, tr) === "loss").length;
    return { n: g.length, win: w, loss: l,
             rate: (w + l) ? r2(w / (w + l) * 100) : null,
             med: r2(median(g.map(s => s.ret))) };
  };

  return {
    total: withSnap.length,
    waiting: withSnap.filter(s => O(s) && O(s).st === "wait").length,
    cancelled: withSnap.filter(s => O(s) && O(s).st === "cancel").length,
    open: entered.filter(s => s[T.open]).length,
    closed: closed.length,
    win: closed.filter(s => verdictOf(s, tr) === "win").length,
    loss: closed.filter(s => verdictOf(s, tr) === "loss").length,
    flat: closed.filter(s => verdictOf(s, tr) === "flat").length,
    t1: hitRate(0), t2: hitRate(1), t3: hitRate(2),
    stopRate: closed.length ? r2(closed.filter(s => O(s).st === "stop").length / closed.length * 100) : null,
    ttT1: timeTo(0), ttT2: timeTo(1), ttT3: timeTo(2),
    up: byDir(1), dn: byDir(-1)
  };
}

/* ---------- تجميع ---------- */
export function aggregate(records) {
  const byScan = {};
  // الكريبتو مسجَّل ولا يُحصى: عملة واحدة تتحرك 30% في أسبوع تزيح وسيط
  // عشرات الإشارات السهمية. نفس الاستبعاد في الأرشيف التاريخي.
  for (const s of records) {
    if (s.mkt === "crypto") continue;
    // سجلات ما قبل توقيع الاتجاه: مقاييسها بمواضعة الشراء، فجمعُها مع
    // المواضعة الصحيحة يخرج وسيطاً لا يصف أياً منهما
    if (s.conv) continue;
    (byScan[s.scan] ||= { open: [], done: [] })[s.open ? "open" : "done"].push(s);
  }
  const out = [];
  for (const scan of SCANS) {
    const g = byScan[scan.id];
    if (!g) continue;
    const rets = g.done.map(x => x.ret).filter(Number.isFinite);
    out.push({
      id: scan.id, lbl: scan.lbl, dir: scanDir(scan.id),
      open: g.open.length, closed: g.done.length,
      med: r2(median(rets)), avg: r2(mean(rets)),
      win: rets.length ? r2(rets.filter(x => x > 0).length / rets.length * 100) : null,
      mfe: r2(mean(g.done.map(x => x.mfe).filter(Number.isFinite))),
      mae: r2(mean(g.done.map(x => x.mae).filter(Number.isFinite)))
    });
  }
  return out.sort((a, b) => (b.med ?? -99) - (a.med ?? -99));
}

async function main() {
  const now = Date.now();
  const summary = readJSON(path.join(OUT, "summary.json"));
  if (!summary?.rows?.length) throw new Error("لا ملخّص — شغّل fetch-market.mjs أولاً");
  const F = readJSON(path.join(OUT, "fundamentals.json"))?.f || {};

  // نتتبّع **ما يراه المستخدم بالضبط**، والكريبتو يظهر في ماسح الفرص،
  // فاستبعاده هنا يجعل السجلّ يصف قائمة غير التي أمامه. نسجّله ونضع
  // عليه علامة `mkt`، ويخرج من الإحصاء وحده — كما في الأرشيف التاريخي،
  // لأن مداه اليومي أوسع بمراتب فيزيح أي وسيط يشاركه.
  const rows = summary.rows;
  const stocks = rows.filter(r => r.mkt !== "crypto");
  const ctx = { secMed: sectorMedians(stocks, F) };
  const price = Object.fromEntries(rows.map(r => [r.s, r.p]));

  const prev = readJSON(path.join(OUT, "signals.json"));
  const records = Array.isArray(prev?.records) ? prev.records : [];
  const prevCount = records.length;

  // ٠) هجرة اتجاه — مرّة واحدة لكل سجلّ قديم
  //
  // السجلات المكتوبة قبل توقيع الاتجاه قِيست كلها بمنطق الشراء. تحويلها
  // لا يصحّ: `mfe` و`mae` مسارٌ تراكمي لا يُعاد حسابه من سعر واحد، ودمج
  // مواضعتين في حقل واحد يفبرك رقماً لا يصف أياً منهما. فتُوسَم `conv`
  // وتُغلق فتخرج من الإحصاء، وتُعاد الإشارة صحيحةً في الدورة التالية.
  // الكلفة ساعاتُ تتبّع لا شهور — والبديل رقمٌ مقلوب يبدو موثوقاً.
  let migrated = 0;
  for (const sig of records) {
    if (sig.conv || sig.dir === -1) continue;      // مهاجَر، أو مكتوب بعد التصحيح
    if (scanDir(sig.scan) !== -1) continue;        // شرط صاعد: مواضعته صحيحة أصلاً
    sig.conv = "long";
    if (sig.open) { sig.open = false; sig.closed = now; }
    migrated++;
  }
  if (migrated) console.log(`  ⟳ هجرة اتجاه: أُغلق ${migrated} سجلاً بمواضعة الشراء`);

  /* ٠ب) سجلّان لا يصفان ما يُعرض اليوم — يُغلقان ولا يُحوَّلان.

     الأول: شرطٌ صار يفرض اتجاه خطته (`planDir`)، وسجلّاته القديمة بُنيت
     باتجاه النتيجة الفنية. `snap` تُكتب مرّة ولا تُلمس — وهذا الفصل هو
     ما يمنع النظرَ إلى المستقبل — فإعادةُ بنائها الآن تجعل السجلّ يدّعي
     أنه رأى ما لم يره. و`mfe`/`mae` مسارٌ تراكمي لا يُشتقّ من سعر واحد.

     الثاني: شرطٌ أُزيل من `SCANS` فلا تعريف له — لا وسمَ يُعرض ولا حافةَ
     تُقارَن، وإبقاؤه مفتوحاً يُبقي في الإحصاء صفقةً لا شاشة تفسّرها. */
  let reDir = 0, gone = 0;
  for (const sig of records) {
    if (sig.conv) continue;
    const known = SCANS.some(x => x.id === sig.scan);
    if (!known) { sig.conv = "gone"; if (sig.open) { sig.open = false; sig.closed = now; } gone++; continue; }
    const fd = forcedDir(sig.scan);
    if (fd === null || !sig.snap || sig.snap.dir === fd) continue;
    sig.conv = "dir";
    if (sig.open) { sig.open = false; sig.closed = now; }
    reDir++;
  }
  if (reDir) console.log(`  ⟳ هجرة سياسة الاتجاه: أُغلق ${reDir} سجلاً بُني باتجاه النتيجة`);
  if (gone) console.log(`  ⟳ شروطٌ أُزيلت: أُغلق ${gone} سجلاً بلا تعريف`);

  /* ٠ج) لقطةٌ لا تصف خطةً صالحة — تُغلق ولا تُصحَّح.

     `snap` تُكتب مرّة ولا تُلمس، وهذا الفصل هو ما يمنع النظر إلى
     المستقبل — فإعادةُ بنائها الآن بأسعار اليوم تجعل السجلّ يدّعي أنه
     رأى ما لم يره. واللقطة المكسورة لا تُقاس أصلاً: دخولٌ صفرٌ ووقفٌ
     صفر يعني مخاطرةً غير موجبة، وكلُّ نسبةٍ تُبنى عليها قسمةٌ على صفر.

     كتبتها البوابةُ المطبَّقة قبل التقريب لا بعده (انظر `snapFor`)،
     فمرّت لقطةُ `SHIB-USD` بأصفارها. والبوابة صارت على المحفوظ، فلا
     تُكتب مثلُها مجدّداً — وتبقى هذه الهجرة للقديم وحده. */
  let broke = 0;
  for (const sig of records) {
    if (sig.conv || !sig.snap) continue;
    const s0 = sig.snap;
    if (!Number.isFinite(s0.e) || !Number.isFinite(s0.s) || !Number.isFinite(s0.dir)) continue;
    const bad0 = validatePlan({
      dir: s0.dir, entry: s0.e, stop: s0.s, risk: (s0.e - s0.s) * s0.dir, atr: s0.atr,
      targets: (s0.t || []).map((tp, i) => ({ p: tp, rr: (s0.trr || [])[i] ?? 1 })),
      primary: (s0.t && s0.t.length) ? { p: s0.t[s0.t.length - 1] } : null
    });
    if (!bad0.length) continue;
    sig.conv = "snap";
    if (sig.open) { sig.open = false; sig.closed = now; }
    broke++;
  }
  if (broke) console.log(`  ⟳ لقطاتٌ مكسورة: أُغلق ${broke} سجلاً لا تصف لقطتُه خطةً صالحة`);

  // ١) حدّث المفتوحة بسعر اليوم
  let closedNow = 0;
  for (const sig of records) {
    if (!stillLive(sig)) continue;
    const p = price[sig.sym];
    if (p === undefined) continue;
    const before = sig.open;
    // `update` تخصّ المسار الأول: `ret`/`mfe`/`mae` مسارٌ تراكمي واحد يُقاس
    // من سعر الإشارة، ولا يعرف مساراً من آخر
    if (sig.open) update(sig, p, now);
    // النتيجة تُحدَّث بعد الرحلة: `update` تغلق بالأفق، و`updateOutcome`
    // تغلق بالوقف أو الهدف — والأسبق منهما هو الذي يحكم
    if (sig.snap) {
      updateOutcome(sig, p, now, "a");
      if (sig.snap.b) updateOutcome(sig, p, now, "b");
    }
    if (before && !sig.open) closedNow++;
  }

  // ٢) سجّل الجديد
  //
  // ملفّ الرمز يُقرأ **عند ظهور إشارة له فقط**: قراءة 96 ملفاً كل عشر
  // دقائق لبناء لقطاتٍ لا تُطلب هدرٌ لا فائدة فيه، والدورة كلها تُقاس
  // بالثواني. والذاكرة تمنع قراءته مرتين لشرطين في نفس التشغيل.
  const symCache = {};
  const symFile = (s) => {
    if (s in symCache) return symCache[s];
    return (symCache[s] = readJSON(path.join(OUT, "sym", `${s}.json`)));
  };

  const openNow = new Set(records.filter(s => s.open).map(openKey));
  let added = 0, snapped = 0, noSnap = 0;
  for (const r of rows) {
    const f = F[r.s] || null;
    for (const scan of SCANS) {
      let hit = false;
      try { hit = !!scan.test(r, f, ctx); } catch { hit = false; }
      if (!hit) continue;
      const key = `${r.s}|${scan.id}`;
      if (openNow.has(key)) continue;
      if (!(r.p > 0)) continue;

      // اللقطة تُبنى الآن أو لا تُبنى أبداً — بعد دقيقة تصير معلومةً
      // لاحقة، وهو بالضبط ما تمنعه المرحلة الثامنة
      let snap = null;
      try {
        const sf = symFile(r.s);
        if (sf) snap = buildSnap({ row: { ...r, __scan: scan.id }, sym: r.s, an: sf.an,
          k4h: sf.tf && sf.tf["4h"] && sf.tf["4h"].c, k1d: sf.tf && sf.tf["1d"] && sf.tf["1d"].c,
          f, at: now });
      } catch (e) { console.warn(`  ⚠ لقطة ${r.s}: ${e.message}`); }
      snap ? snapped++ : noSnap++;

      const rec = {
        sym: r.s, scan: scan.id, at: now, at2: now,
        entry: r2(r.p), last: r2(r.p), ret: 0, mfe: 0, mae: 0,
        atr: rp(r.atr), open: true,
        // `dir` يُكتب حين يخالف +1 وحده — نفس أسلوب `mkt` الشرطي، فسجلّ
        // يتراكم بعشرات الآلاف لا يحمل حقلاً قيمته هي الافتراض
        ...(scan.dir === -1 ? { dir: -1 } : {}),
        // لقطة اللحظة: النتيجة الفنية وحالة الفريمات كما كانت **حين ظهرت
        // الإشارة**، لا كما تُحسب اليوم. لا تُحدَّث أبداً — إعادةُ حسابها
        // لاحقاً ببيانات لم تكن متاحة تجعل السجلّ يدّعي أنه رأى ما لم يرَه.
        ...(Number.isFinite(r.score) ? { sc: r2(r.score) } : {}),
        ...(r.tfScore ? { tfs: Object.fromEntries(
              Object.entries(r.tfScore).map(([k, v]) => [k, r2(v)])) } : {}),
        ...(r.mkt ? { mkt: r.mkt } : {}),
        ...(snap ? { snap, out: { st: "wait", hit: snap.t.map(() => null), stopAt: null, enterAt: null } } : {}),
        // المسار الثاني حيٌّ فقط حين تُبنى لقطتُه — وهي تُبنى الآن أو لا
        // تُبنى أبداً، شأنَ الأولى
        ...(snap && snap.b ? { openB: true,
              outB: { st: "wait", hit: snap.b.t.map(() => null), stopAt: null, enterAt: null } } : {})
      };
      // خطةٌ دخولها «السعر الآن» تُفتح في نفس اللحظة، وإلا بقيت `wait`
      // حتى يلمس السعر منطقة الدخول — أو ينتهي الأفق فتُلغى.
      // والمسار الثاني دخولُه السعرُ نفسه، فيُفتح دائماً في اللحظة صفر.
      if (snap) {
        updateOutcome(rec, r.p, now, "a");
        if (snap.b) updateOutcome(rec, r.p, now, "b");
      }
      records.push(rec);
      openNow.add(key);
      added++;
    }
  }

  // ٣) تشذيب مقصود عند تجاوز السقف — الأقدم المغلق أولاً
  let pruning = false;
  if (records.length > MAX_RECORDS) {
    pruning = true;
    records.sort((a, b) => (stillLive(a) === stillLive(b)) ? a.at - b.at : (stillLive(a) ? 1 : -1));
    records.splice(0, records.length - MAX_RECORDS);
  }

  guard(prevCount, records.length, { pruning });
  records.sort((a, b) => b.at - a.at);
  fs.mkdirSync(OUT, { recursive: true });

  /* ٣ب) الفصل بين المفتوح والمغلق — ملفّان لا ملف.
   *
   * `signals.json` يُقرأ في **كل تحميل صفحة**، واللقطة الثابتة أضافت
   * ~200 بايت لكل سجلّ. سجلٌّ يتراكم بالآلاف يعني مئات الكيلوبايتات
   * تُنزَّل في كل جلسة لأجل صفقاتٍ مغلقة لا تُقرأ إلا في تبويب السجلّ.
   * فالمفتوحة هنا، والمغلقة في `history.json` يُحمَّل عند فتح السجلّ.
   *
   * والبوابة على **المجموع** لا على أحدهما: نقل سجلّ من ملف إلى ملف
   * تقلّصٌ مشروع في الأول، وضياعُه تقلّصٌ في المجموع — والثاني وحده خلل.
   */
  const prevHist = readJSON(path.join(OUT, "history.json"));
  const histPrev = Array.isArray(prevHist?.records) ? prevHist.records : [];
  const openRecs = records.filter(stillLive);
  const closedNew = records.filter(s => !stillLive(s));

  // المغلقة تُدمج فوق التاريخ بالمفتاح نفسه + لحظة الظهور: نفس الإشارة
  // قد تُغلق وتُعاد لاحقاً، وهما صفقتان لا واحدة
  const histMap = new Map(histPrev.map(s => [`${s.sym}|${s.scan}|${s.at}`, s]));
  for (const s of closedNew) histMap.set(`${s.sym}|${s.scan}|${s.at}`, s);
  let hist = [...histMap.values()].sort((a, b) => b.at - a.at);
  let histPruned = false;
  if (hist.length > MAX_RECORDS) { histPruned = true; hist = hist.slice(0, MAX_RECORDS); }

  guardTotal(prevCount + histPrev.length, openRecs.length + hist.length,
             { pruning: pruning || histPruned });

  fs.writeFileSync(path.join(OUT, "signals.json"),
    JSON.stringify({ updated: now, holdDays: HOLD_DAYS, count: openRecs.length,
                     closedIn: "history.json", records: openRecs }));
  fs.writeFileSync(path.join(OUT, "history.json"),
    JSON.stringify({ updated: now, holdDays: HOLD_DAYS, count: hist.length, records: hist }));

  // ٤) تسلسل النتيجة — ملف مستقل لأنه يُقرأ عند فتح سهم لا عند فتح
  //    التطبيق. دمجُه في `signals.json` كان سيُثقل كل تحميل صفحة ببيانات
  //    لا تُقرأ، ويكرّر تسلسل السهم بعدد شروطه المحقَّقة.
  const prevTrend = readJSON(path.join(OUT, "trend.json"));
  const syms = (prevTrend && prevTrend.syms) || {};
  const prevSymCount = Object.keys(syms).length;
  let added2 = 0;
  for (const r of rows) {
    if (!Number.isFinite(r.score)) continue;
    const before = (syms[r.s] || []).length;
    // السعر يُؤخذ كما هو من الملخّص: مقرَّبٌ أصلاً بالأرقام المعنوية هناك،
    // وإعادة تقريبه بخانتين تمحو الأصول الرخيصة (شيبا إينو ← صفر)
    const next = trimTrend(pushTrend(syms[r.s], now, r.score, r.p), now);
    syms[r.s] = next;
    if (next.length > before) added2++;
  }
  guardTrend(prevSymCount, Object.keys(syms).length);
  fs.writeFileSync(path.join(OUT, "trend.json"), JSON.stringify({
    updated: now, keepDays: TREND_DAYS, maxPoints: TREND_MAX,
    minStep: TREND_STEP, bands: BANDS, syms }));

  // الإحصاء على المفتوح **والتاريخ** معاً: قياسُه على تشغيلٍ واحد يجعل
  // «مغلقة: 0» أبداً بعد الفصل، وهو رقمٌ خاطئ لا نقصٌ في العرض
  const all = openRecs.concat(hist);
  const scans = aggregate(all);
  fs.writeFileSync(path.join(OUT, "archive.json"),
    JSON.stringify({ updated: now, holdDays: HOLD_DAYS,
                     open: openRecs.length, closed: hist.length,
                     // المستبعَد يُعلَن: عددٌ ناقص بلا سبب يُقرأ كخلل
                     legacy: all.filter(s => s.conv).length,
                     noSnap: all.filter(s => !s.snap && !s.conv).length,
                     // المسار الثاني ومقامُه المعلَن: سجلّاته وحدها، فعددٌ
                     // أصغر من `total` ليس نقصاً بل هو المقام الصحيح
                     withB: all.filter(s => s.snap && s.snap.b).length,
                     outcome: outcomeStats(all), outcomeB: outcomeStats(all, "b"), scans }));

  const prevMeta = readJSON(path.join(OUT, "meta.json"), {});
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
    ...prevMeta, signalsUpdated: now,
    signalsRun: { at: new Date(now).toISOString(), open: openRecs.length, history: hist.length,
                  added, closed: closedNow, snapped, noSnap,
                  trendSyms: Object.keys(syms).length,
                  trendPts: Object.values(syms).reduce((a, b) => a + b.length, 0) }
  }));

  const st = outcomeStats(all), stB = outcomeStats(all, "b");
  console.log(`✔ ${openRecs.length} مفتوحة · ${hist.length} في السجلّ (+${added} جديدة · ${closedNow} أُغلقت اليوم)`);
  if (added) console.log(`  لقطات: ${snapped} بُنيت${noSnap ? ` · ${noSnap} بلا لقطة (لا ملف شمعات)` : ""}`);
  console.log(`  دخول الارتداد: ${st.open} جارية · ${st.waiting} تنتظر الدخول · ${st.closed} مغلقة` +
    (st.closed ? ` (${st.win} رابحة · ${st.loss} خاسرة)` : "") +
    (st.t1 !== null ? ` · الهدف الأول ${st.t1}%` : ""));
  // الرقم الذي استدعى المسار الثاني أصلاً — يُطبع ليُرى كل تشغيل
  if (st.total) console.log(`  ولم تُفعَّل ${st.waiting} من ${st.total} (${
    r2(st.waiting / st.total * 100)}%) — وهذا سبب قياس المسار الثاني`);
  console.log(`  دخول السوق:    ${stB.open} جارية · ${stB.waiting} تنتظر · ${stB.closed} مغلقة` +
    (stB.closed ? ` (${stB.win} رابحة · ${stB.loss} خاسرة)` : "") +
    ` · من ${stB.total} سجلاً له مسارٌ ثانٍ`);
  console.log(`  تسلسل النتيجة: ${Object.keys(syms).length} رمزاً · ${
    Object.values(syms).reduce((a, b) => a + b.length, 0)} نقطة (+${added2} الآن)`);
  for (const s of scans)
    console.log(`  ${s.lbl}: ${s.open} مفتوحة · ${s.closed} مغلقة${s.closed ? ` · وسيط ${s.med}% · موجب ${s.win}%` : ""}`);
  return 0;
}

/* ---------- فحص ذاتي بلا شبكة ---------- */
function selfCheck() {
  console.log("▶ فحص ذاتي (بلا شبكة)\n");
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; } };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
  const throws = (fn, m) => { let ok = false; try { fn(); } catch { ok = true; } if (!ok) throw new Error(`${m}: لم يرمِ`); };

  t("البوابة ترفض تقلّص السجلّ وتسمح بالتشذيب المقصود", () => {
    eq(guard(10, 12), true, "نموّ");
    eq(guard(10, 10), true, "ثبات");
    throws(() => guard(10, 3), "تقلّص");
    eq(guard(10, 3, { pruning: true }), true, "تشذيب معلن");
    // الحالة التي تُتلف التاريخ: ملف قُرئ تالفاً فعاد فارغاً
    throws(() => guard(5000, 0), "ملف فارغ");
  });

  t("update يتتبّع أقصى ربح وأقصى تراجع لا آخر سعر فقط", () => {
    const now = 1_700_000_000_000;
    const s = { sym: "X", scan: "a", at: now, entry: 100, open: true };
    update(s, 110, now + DAY);
    update(s, 90, now + 2 * DAY);
    update(s, 105, now + 3 * DAY);
    eq([s.ret, s.mfe, s.mae], [5, 10, -10], "الرحلة كاملة");
    eq(s.open, true, "ما زالت مفتوحة");
  });

  t("update يغلق الإشارة عند بلوغ أفق الاحتفاظ", () => {
    const now = 1_700_000_000_000;
    const s = { sym: "X", scan: "a", at: now, entry: 100, open: true };
    update(s, 101, now + (HOLD_DAYS - 1) * DAY);
    eq(s.open, true, "قبل الأفق");
    update(s, 102, now + HOLD_DAYS * DAY);
    eq(s.open, false, "عند الأفق");
    if (!s.closed) throw new Error("بلا وقت إغلاق");
  });

  t("update يتجاهل الأسعار الفاسدة بدل أن يكتب صفراً", () => {
    const s = { sym: "X", scan: "a", at: 1, entry: 100, open: true, ret: 5, mfe: 5, mae: 0 };
    update(s, 0, 2); update(s, null, 3); update(s, NaN, 4);
    eq([s.ret, s.mfe, s.mae], [5, 5, 0], "بلا تغيير");
  });

  t("update يقيس إشارة الهبوط باتجاهها لا بمنطق الشراء", () => {
    const now = 1_700_000_000_000;
    // نفس الرحلة السعرية بالضبط، وسجلّان باتجاهين: النتيجة معكوسة تماماً
    const trip = (dir) => {
      const s = { sym: "X", scan: "alignDn", at: now, entry: 100, open: true, ...(dir === -1 ? { dir } : {}) };
      update(s, 90, now + DAY); update(s, 110, now + 2 * DAY); update(s, 95, now + 3 * DAY);
      return [s.ret, s.mfe, s.mae];
    };
    eq(trip(1), [-5, 10, -10], "بمنطق الشراء");
    eq(trip(-1), [5, 10, -10], "باتجاه الهبوط: الهبوط ربح");
  });

  t("إشارة هبوط ناجحة تُحتسب موجبة لا سالبة", () => {
    const now = 1_700_000_000_000;
    const s = { sym: "X", scan: "alignDn", at: now, entry: 200, open: true, dir: -1 };
    update(s, 180, now + DAY);                       // هبط 10% — نجحت
    eq([s.ret, s.mfe], [10, 10], "الهبوط ربح للإشارة الهابطة");
    update(s, 220, now + 2 * DAY);                   // صعد 10% فوق الدخول — خسرت
    eq([s.ret, s.mae], [-10, -10], "الصعود خسارة لها");
  });

  t("scanDir يقرأ الاتجاه من scans.js ولا يخترعه", () => {
    eq(scanDir("alignDn"), -1, "الشرط الهابط");
    eq(scanDir("align"), 1, "الشرط الصاعد");
    eq(scanDir("vol"), 1, "بلا حقل = صعود");
    eq(scanDir("لا-يوجد"), 1, "شرط مجهول");
  });

  t("aggregate يستبعد سجلات ما قبل توقيع الاتجاه", () => {
    const rec = [
      { scan: "alignDn", open: false, ret: 6, mfe: 8, mae: -1, dir: -1 },
      { scan: "alignDn", open: false, ret: 4, mfe: 5, mae: -2, dir: -1 },
      // مقلوب المواضعة: لو دخل الإحصاء لأزاح الوسيط إلى -50
      { scan: "alignDn", open: false, ret: -50, mfe: 0, mae: -50, conv: "long" }
    ];
    const g = aggregate(rec).find(x => x.id === "alignDn");
    eq([g.closed, g.med, g.win], [2, 5, 100], "القديم خارج الحساب");
    eq(g.dir, -1, "الاتجاه معلن في المخرَج");
  });

  t("bandOf يطابق حدود labelOf الخمسة", () => {
    eq([bandOf(-100), bandOf(-45), bandOf(-14), bandOf(15), bandOf(90)], [0, 1, 2, 3, 4], "النطاقات");
    eq(bandOf(-45.1), 0, "تحت الحدّ");
    eq(bandOf(-45), 1, "على الحدّ داخله");
  });

  t("pushTrend يتجاهل الحركة التافهة ويحفظ المعنوية", () => {
    const T = 1_700_000_000_000;
    let p = pushTrend([], T, 70, 100);
    eq(p.length, 1, "الأولى تُحفظ دائماً");
    p = pushTrend(p, T + 6e5, 70.3, 101);
    eq(p.length, 1, "0.3 نقطة ليست حدثاً");
    p = pushTrend(p, T + 12e5, 76, 102);
    eq(p.length, 2, "6 نقاط حدث");
    eq(p[1][1], 76, "القيمة محفوظة");
    eq(p[1][0], Math.round((T + 12e5) / 1000), "الزمن بالثواني");
  });

  t("pushTrend يحفظ انقلاب الاتجاه ولو بنقطة واحدة", () => {
    const T = 1_700_000_000_000;
    // 16 ← 14: حركة نقطتين لكنها تعبر ‎+15‎ فتُقرأ «صاعد» ← «عرضي»
    let p = pushTrend([], T, 16, 100);
    p = pushTrend(p, T + 6e5, 14, 100);
    eq(p.length, 2, "عبور النطاق يُحفظ رغم صغر الحركة");
    // وداخل النطاق نفسه تُهمَل نفس الحركة
    let q = pushTrend([], T, 30, 100);
    q = pushTrend(q, T + 6e5, 32, 100);
    eq(q.length, 1, "نقطتان داخل النطاق تُهمَلان");
  });

  t("pushTrend يتجاهل النتيجة غير الرقمية ولا يكتب صفراً", () => {
    const T = 1_700_000_000_000;
    const p = pushTrend([[T / 1000, 50, 10]], T + 6e5, null, 11);
    eq(p.length, 1, "بلا نقطة ملفّقة");
    eq(pushTrend([], T, undefined, 1).length, 0, "بلا أولى ملفّقة");
  });

  t("trimTrend يقطع بالعمر ثم بالسقف ويُبقي الأحدث", () => {
    const now = 1_700_000_000_000;
    const old = Math.round((now - 30 * DAY) / 1000);
    const fresh = Math.round((now - DAY) / 1000);
    eq(trimTrend([[old, 1, 1], [fresh, 2, 2]], now), [[fresh, 2, 2]], "القديم يُقطع");
    const many = Array.from({ length: TREND_MAX + 12 }, (_, i) => [fresh + i, i, i]);
    const cut = trimTrend(many, now);
    eq(cut.length, TREND_MAX, "السقف");
    eq(cut[cut.length - 1][1], TREND_MAX + 11, "الأحدث باقٍ");
  });

  t("بوابة التسلسل ترفض اختفاء الرموز ولا تعاقب التشذيب", () => {
    eq(guardTrend(96, 96), true, "ثبات");
    eq(guardTrend(96, 120), true, "نموّ");
    eq(guardTrend(0, 0), true, "أول تشغيل");
    throws(() => guardTrend(96, 3), "ملخّص شبه فارغ");
    throws(() => guardTrend(96, 0), "ملف قُرئ تالفاً");
  });

  /* ---------- دورة حياة الصفقة (المرحلتان ٦ و٨) ---------- */
  const T0 = 1_700_000_000_000;
  const mkSig = (over = {}) => ({
    sym: "X", scan: "align", at: T0, at2: T0, entry: 100, last: 100, ret: 0, mfe: 0, mae: 0,
    open: true, snap: { px: 100, e: 98, s: 95, atr: 3, dir: 1, t: [104, 110, 118] },
    out: { st: "wait", hit: [null, null, null], stopAt: null, enterAt: null }, ...over
  });

  t("الصفقة تنتظر الدخول ولا تُحتسب هدفاً قبل أن تُفتح", () => {
    const s = mkSig();
    updateOutcome(s, 101, T0 + 6e5);              // فوق الدخول 98 — لم تُلمس
    eq(s.out.st, "wait", "ما زالت تنتظر");
    updateOutcome(s, 120, T0 + 12e5);             // قفز فوق كل الأهداف بلا دخول
    eq(s.out.hit, [null, null, null], "لا هدف بلا دخول");
    eq(verdictOf(s), "wait", "ليست رابحة ولا ضدّها");
    // ثم انتهى الأفق وهي لم تُفتح: إلغاء لا خسارة
    updateOutcome(s, 120, T0 + HOLD_DAYS * DAY);
    eq([s.out.st, s.open, verdictOf(s)], ["cancel", false, "cancel"], "أُلغيت بلا دخول");
  });

  t("لمسُ منطقة الدخول يفتح الصفقة، ثم تُقاس الأهداف بالترتيب", () => {
    const s = mkSig();
    updateOutcome(s, 98, T0 + 6e5);
    eq([s.out.st, s.out.enterAt], ["open", T0 + 6e5], "فُتحت عند الدخول");
    updateOutcome(s, 105, T0 + 12e5);
    eq([s.out.st, s.out.hit[0], s.out.hit[1]], ["t1", T0 + 12e5, null], "الهدف الأول");
    updateOutcome(s, 111, T0 + 18e5);
    eq(s.out.st, "t2", "الهدف الثاني");
    updateOutcome(s, 119, T0 + 24e5);
    eq([s.out.st, s.open, verdictOf(s)], ["t3", false, "win"], "الثالث يُغلق الصفقة رابحة");
  });

  t("الوقف يُغلق الصفقة خاسرة ويمنع تسجيل هدف بعده", () => {
    const s = mkSig();
    updateOutcome(s, 98, T0 + 6e5);
    updateOutcome(s, 94, T0 + 12e5);              // تحت الوقف 95
    eq([s.out.st, s.open, verdictOf(s)], ["stop", false, "loss"], "خاسرة");
    updateOutcome(s, 120, T0 + 18e5);             // ارتد فوق كل الأهداف
    eq(s.out.hit, [null, null, null], "لا هدف بعد الوقف");
    eq(verdictOf(s), "loss", "تبقى خاسرة");
  });

  t("انتهاء الأفق مفتوحةً بلا هدف = محايدة لا خاسرة", () => {
    const s = mkSig();
    updateOutcome(s, 98, T0 + 6e5);
    updateOutcome(s, 99, T0 + HOLD_DAYS * DAY);
    eq([s.out.st, s.open, verdictOf(s)], ["expired", false, "flat"], "محايدة");
  });

  t("النتيجة معكوسة تماماً في الاتجاه الهابط", () => {
    const s = mkSig({ snap: { px: 100, e: 102, s: 105, atr: 3, dir: -1, t: [96, 90, 82] } });
    updateOutcome(s, 102, T0 + 6e5);
    eq(s.out.st, "open", "الدخول عند المقاومة");
    updateOutcome(s, 95, T0 + 12e5);              // هبط: نجاح للبيع
    eq(s.out.st, "t1", "الهبوط يبلغ هدف البيع");
    updateOutcome(s, 106, T0 + 18e5);             // صعد فوق الوقف: خسارة
    eq([s.out.st, verdictOf(s)], ["stop", "loss"], "الصعود يضرب وقف البيع");
  });

  t("خطةُ «السعر الآن» تُفتح في نفس اللحظة", () => {
    const s = mkSig({ snap: { px: 100, e: 100, s: 97, atr: 3, dir: 1, t: [104, 110] } });
    updateOutcome(s, 100, T0);
    eq([s.out.st, s.out.enterAt], ["open", T0], "فُتحت فوراً");
  });

  t("الإحصاء لا يعدّ المفتوحة رابحة ولا الملغاة خاسرة", () => {
    const win = mkSig({ open: false, ret: 8, out: { st: "t3", hit: [T0+1,T0+2,T0+3], stopAt: null, enterAt: T0 } });
    const loss = mkSig({ open: false, ret: -3, out: { st: "stop", hit: [null,null,null], stopAt: T0+9, enterAt: T0 } });
    const live = mkSig({ open: true, ret: 5, out: { st: "t1", hit: [T0+1,null,null], stopAt: null, enterAt: T0 } });
    const waitS = mkSig();
    const canc = mkSig({ open: false, out: { st: "cancel", hit: [null,null,null], stopAt: null, enterAt: null } });
    const st = outcomeStats([win, loss, live, waitS, canc]);
    eq([st.total, st.open, st.waiting, st.cancelled, st.closed], [5, 1, 1, 1, 2], "التقسيم");
    eq([st.win, st.loss], [1, 1], "المغلقة وحدها تُحتسب");
    eq(st.stopRate, 50, "نسبة الوقف على المغلقة");
    // الجارية والملغاة والمنتظرة خارج المقام
    eq(st.up.rate, 50, "نسبة النجاح صعوداً");
    // مقام الهدف الأول: الثلاث التي دخلت (رابحة وخاسرة وجارية)، وبلغته
    // اثنتان. الخاسرة دخلت فعلاً فتبقى في المقام — استثناؤها يرفع النسبة
    // كذباً بحذف كل صفقة فشلت.
    eq(st.t1, 66.67, "الهدف الأول: اثنتان من ثلاث دخلت");
  });

  t("نسبة الهدف الثالث لا تحاسب خطةً بهدفين", () => {
    const two = mkSig({ open: false, snap: { px: 100, e: 98, s: 95, atr: 3, dir: 1, t: [104, 110] },
      out: { st: "t2", hit: [T0+1, T0+2], stopAt: null, enterAt: T0 } });
    const three = mkSig({ open: false,
      out: { st: "t3", hit: [T0+1, T0+2, T0+3], stopAt: null, enterAt: T0 } });
    const st = outcomeStats([two, three]);
    eq(st.t3, 100, "مقام الثالث خطةٌ واحدة لا اثنتان");
    eq(st.t2, 100, "مقام الثاني اثنتان");
  });

  t("زمن بلوغ الهدف بالوسيط ومن لحظة الدخول لا لحظة الإشارة", () => {
    const a = mkSig({ open: false, out: { st: "t1", hit: [T0 + 10*60e3, null, null], stopAt: null, enterAt: T0 } });
    const b = mkSig({ open: false, out: { st: "t1", hit: [T0 + 30*60e3, null, null], stopAt: null, enterAt: T0 } });
    const c = mkSig({ open: false, out: { st: "t1", hit: [T0 + 500*60e3, null, null], stopAt: null, enterAt: T0 } });
    const st = outcomeStats([a, b, c]);
    eq(st.ttT1.n, 3, "ثلاث ملاحظات");
    eq(st.ttT1.med, 30 * 60e3, "الوسيط لا المتوسط");
  });

  t("بوابة المجموع تقبل نقل المغلق وترفض ضياعه", () => {
    eq(guardTotal(100, 100), true, "نقلٌ بين ملفين");
    eq(guardTotal(100, 105), true, "نموّ");
    throws(() => guardTotal(100, 60), "ضياع");
    eq(guardTotal(100, 60, { pruning: true }), true, "تشذيب معلن");
  });

  t("openKey يمنع تكرار نفس الإشارة للرمز نفسه", () => {
    eq(openKey({ sym: "AAPL", scan: "vol" }), "AAPL|vol", "المفتاح");
    if (openKey({ sym: "AAPL", scan: "vol" }) === openKey({ sym: "AAPL", scan: "align" }))
      throw new Error("شرطان مختلفان بمفتاح واحد");
  });

  t("sectorMedians تطابق وسيط القطاع لا متوسطه", () => {
    const rows = [{ s: "A", sec: "تقنية" }, { s: "B", sec: "تقنية" }, { s: "C", sec: "تقنية" }];
    const F = { A: { pe: 10 }, B: { pe: 20 }, C: { pe: 300 } };
    eq(sectorMedians(rows, F)["تقنية"].pe, 20, "الوسيط لا المتوسط (110)");
  });

  t("median يتجاهل غير الأرقام ولا يحوّلها إلى أصفار", () => {
    eq(median([1, null, 3, undefined, NaN]), 2, "وسيط الصالح");
    eq(median([]), null, "فارغ");
  });

  t("aggregate يفصل المفتوح عن المغلق ويحصي المغلق وحده", () => {
    const rec = [
      { scan: "vol", open: true, ret: 99, mfe: 99, mae: 0 },
      { scan: "vol", open: false, ret: 4, mfe: 6, mae: -2 },
      { scan: "vol", open: false, ret: -2, mfe: 1, mae: -5 }
    ];
    const g = aggregate(rec).find(x => x.id === "vol");
    eq([g.open, g.closed], [1, 2], "التقسيم");
    eq(g.med, 1, "وسيط المغلق فقط");
    eq(g.win, 50, "نسبة الموجب");
  });

  t("aggregate يسجّل الكريبتو ولا يحصيه", () => {
    const rec = [
      { scan: "vol", open: false, ret: 3, mfe: 4, mae: -1 },
      { scan: "vol", open: false, ret: 300, mfe: 300, mae: 0, mkt: "crypto" }
    ];
    const g = aggregate(rec).find(x => x.id === "vol");
    eq([g.closed, g.med], [1, 3], "العملة خارج الإحصاء");
  });

  /* ---------- المسار الثاني: الدخول بالسوق ---------- */
  const mkB = (over = {}) => mkSig({
    snap: { px: 100, e: 98, s: 95, atr: 3, dir: 1, t: [104, 110, 118],
            b: { e: 100, s: 96.5, rr: 2, t: [104, 110, 118] } },
    openB: true, outB: { st: "wait", hit: [null, null, null], stopAt: null, enterAt: null }, ...over
  });

  t("المساران مستقلّان: وقفُ الأول لا يغلق الثاني", () => {
    const s = mkB();
    updateOutcome(s, 100, T0, "a");                  // أ تنتظر 98 فتبقى wait
    updateOutcome(s, 100, T0, "b");                  // ب تدخل عند 100 فوراً
    eq([s.out.st, s.outB.st], ["wait", "open"], "الدخولان مختلفان باختلاف سعرهما");
    updateOutcome(s, 97, T0 + DAY, "a");             // أ دخلت عند 98
    updateOutcome(s, 97, T0 + DAY, "b");             // ب ما زالت فوق وقفها 96.5
    eq([s.out.st, s.outB.st], ["open", "open"], "كلاهما مفتوح");
    updateOutcome(s, 96, T0 + 2 * DAY, "b");         // ضُرب وقف ب وحده
    eq([s.outB.st, s.openB, s.out.st, s.open], ["stop", false, "open", true],
      "انتهاء الثاني لا يمسّ الأول");
    if (!stillLive(s)) throw new Error("السجلّ أُغلق والمسار الأول حيّ");
  });

  t("وقفُ الأول لا يجمّد الثاني — السجلّ يبقى حيّاً", () => {
    const s = mkB();
    updateOutcome(s, 100, T0, "b");
    updateOutcome(s, 98, T0, "a");
    updateOutcome(s, 94, T0 + DAY, "a");             // أ ضُرب وقفها 95
    eq([s.out.st, s.open], ["stop", false], "الأول أُغلق");
    if (!stillLive(s)) throw new Error("السجلّ خرج من التتبّع والثاني حيّ");
    updateOutcome(s, 94, T0 + DAY, "b");             // وب تحت وقفها 96.5 كذلك
    eq([s.outB.st, s.openB], ["stop", false], "الثاني قُيس بنفسه");
    if (stillLive(s)) throw new Error("انتهى المساران والسجلّ ما زال حيّاً");
  });

  t("الحالة النهائية تردّ في المسار الثاني كما في الأول", () => {
    const s = mkB();
    updateOutcome(s, 100, T0, "b");
    updateOutcome(s, 96, T0 + DAY, "b");
    eq(s.outB.st, "stop", "ضُرب الوقف");
    updateOutcome(s, 120, T0 + 2 * DAY, "b");        // ارتدّ فوق كل الأهداف
    eq([s.outB.st, s.outB.hit[0]], ["stop", null], "لا هدف يُسجَّل بعد الإغلاق");
  });

  t("سجلٌّ بلا `snap.b` لا يكتسب مساراً ثانياً ولا يُحشى بأثر رجعي", () => {
    const s = mkSig();                                // لقطة قديمة بلا b
    updateOutcome(s, 100, T0, "b");
    eq([s.outB, s.openB, s.snap.b], [undefined, undefined, undefined], "لم يُلمس");
    // ولا يدخل مقام المسار الثاني
    eq(outcomeStats([s], "b").total, 0, "خارج المقام");
    eq(outcomeStats([s], "a").total, 1, "وداخل مقام الأول");
  });

  t("مقاما المسارين منفصلان تماماً", () => {
    const withB = mkB({ open: false, openB: false,
      out:  { st: "stop", hit: [null, null, null], stopAt: T0 + DAY, enterAt: T0 },
      outB: { st: "t3", hit: [T0 + 1, T0 + 2, T0 + 3], stopAt: null, enterAt: T0 } });
    const onlyA = mkSig({ open: false,
      out: { st: "t3", hit: [T0 + 1, T0 + 2, T0 + 3], stopAt: null, enterAt: T0 } });
    const A = outcomeStats([withB, onlyA], "a"), B = outcomeStats([withB, onlyA], "b");
    eq([A.total, A.win, A.loss], [2, 1, 1], "الأول يرى السجلّين");
    eq([B.total, B.win, B.loss], [1, 1, 0], "والثاني يرى سجلّه وحده");
  });

  /* =====================================================================
     الأصل دون السنت ينجو من التقريب — وقياسٌ بسعرٍ حقيقي لا رمزيّ.

     `SHIB-USD` عند ‎0.00000529‎: التقريب بأربع خانات عشرية يجعل الدخول
     والوقف وATR **أصفاراً** والأهداف فارغة، فتُحفظ صفقةٌ مخاطرتُها غير
     موجبة. وقع فعلاً وحُفظ في `signals.json` قبل أن يكشفه فحصٌ مستقلّ
     يمرّر اللقطات المحفوظة على `validatePlan`.

     ويُفحص الطرفان معاً: أن `rp` تُبقي المعنى، وأن الفرق بين الدخول
     والوقف يبقى **موجباً بعد التقريب** — فالشرط الثاني هو ما انكسر.
     ===================================================================== */
  t("لقطة أصلٍ دون السنت تنجو من التقريب", () => {
    const px = 0.00000529, atr = 0.00000031;
    const mk = (a) => a.map(p => ({ p, names: new Set(["مستوى"]) }));
    const { a: p } = planPair(
      { px, atr, supAll: mk([0.00000498, 0.00000471]), resAll: mk([0.00000572, 0.00000615]) }, 1);
    if (!p) throw new Error("لا خطة");
    if (validatePlan(p).length) throw new Error("الخطة نفسها مرفوضة: " + validatePlan(p)[0]);

    const e = rp(p.entry), st = rp(p.stop), ts = p.targets.map(x => rp(x.p));
    if (!(e > 0)) throw new Error(`الدخول صفّره التقريب: ${e}`);
    if (!(st > 0)) throw new Error(`الوقف صفّره التقريب: ${st}`);
    if (!(rp(p.atr) > 0)) throw new Error("ATR صفّره التقريب");
    if (!(e - st > 0)) throw new Error(`المخاطرة انعدمت بعد التقريب: ${e} − ${st}`);
    if (!ts.length || ts.some(x => !(x > 0))) throw new Error("هدفٌ صفّره التقريب");
    // والبوابة نفسها التي تحرس الكتابة تمرّ على الأرقام المحفوظة
    const bad = validatePlan({ dir: 1, entry: e, stop: st, risk: e - st, atr: rp(p.atr),
      targets: ts.map(x => ({ p: x, rr: 1 })), primary: { p: ts[ts.length - 1] } });
    if (bad.length) throw new Error("البوابة على المحفوظ: " + bad[0]);
    return `دخول ${e} · وقف ${st} · ${ts.length} هدفاً`;
  });

  /* والعكس يجب أن يُرفض: تقريبٌ يُسطّح الدخول والوقف على قيمةٍ واحدة
     يعني مخاطرةً صفراً، والبوابة تردّه بدل أن يُحفظ. */
  t("البوابة تردّ لقطةً سطّحها التقريب", () => {
    const bad = validatePlan({ dir: 1, entry: 0, stop: 0, risk: 0, atr: 0,
                               targets: [], primary: null });
    if (!bad.length) throw new Error("مرّت لقطةٌ كلُّها أصفار");
    return `${bad.length} اعتراضاً`;
  });

  t("`planPair` لا تنتج مساراً ثانياً حين لا حاجز قريب", () => {
    const mk = (a) => a.map(p => ({ p, names: new Set(["قمة سابقة"]) }));
    const near = planPair({ px: 100, atr: 3, supAll: mk([98]), resAll: mk([106, 112]) }, 1);
    if (!near.b) throw new Error("حاجزٌ قريب بلا مسار ثانٍ");
    if (near.b.entry !== 100) throw new Error(`دخول ب ${near.b.entry}`);
    // ودخولُ ب أبعدُ عن وقفه، فمخاطرتُه أكبر — هذه هي المفاضلة المقيسة
    if (!(near.b.risk > near.a.risk)) throw new Error("مخاطرة ب ليست أكبر");
    const far = planPair({ px: 100, atr: 3, supAll: mk([80]), resAll: mk([106, 112]) }, 1);
    if (far.b !== null) throw new Error("مسارٌ ثانٍ مضاعِف بلا حاجز");
    return "بحاجز ب موجودة · بلا حاجز null";
  });

  t("كل شرط في SCANS قابل للتتبّع الحيّ", () => {
    // الخاصيّة لا العدد: تثبيتُ الرقم يُسقط الفحص عند كل شرطٍ جديد
    // فيُقرأ فشلاً وهو نجاح، ثم يُخفَّف الفحص بدل أن يُقرأ
    if (!Array.isArray(SCANS) || SCANS.length < 8) throw new Error(String(SCANS?.length));
    // التتبّع الحيّ يستعمل `test` لا `btTest`، فيشمل حتى ما لا يُقاس تاريخياً
    for (const s of SCANS) {
      if (typeof s.test !== "function") throw new Error(`${s.id}: بلا test`);
      if (!s.id || !s.lbl || !s.why) throw new Error(`${s.id}: ناقص الوصف`);
      if (s.dir !== undefined && s.dir !== -1 && s.dir !== 1) throw new Error(`${s.id}: dir غريب`);
    }
    // ولا معرّف مكرّر: شرطان بنفس الـid يدمج سجلّيهما في الإحصاء
    const ids = SCANS.map(s => s.id);
    if (new Set(ids).size !== ids.length) throw new Error("معرّف مكرّر");
    return `${SCANS.length} شرطاً`;
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل`);
  process.exit(fail ? 1 : 0);
}

/* =====================================================================
   لا يعمل إلا حين يكون هو نقطة الدخول.

   `track-strategies.mjs` يستورد `updateOutcome` و`guard` من هنا — نسخةٌ
   ثانية منها تجعل السجلَّين يُقاسان بمسطرتين. وبلا هذا الحدّ كان مجرّد
   الاستيراد يشغّل هذا الملفّ بكامله: استيرادٌ بـ`--check` في `argv`
   يُجري فحصَ هذا الملفّ ثم `process.exit` قبل أن يبدأ المستورِد أصلاً،
   واستيرادٌ بلا `--check` يشغّل `main()` فيكتب البيانات مرّتين.

   وهي نفس المصيدة الموثّقة في `fetch-market` («استيرادُه يشغّل main()
   فيجلب الكون») — عولجت هناك بعدم الاستيراد، وتُعالَج هنا عند جذرها
   كي يصير الملفّ قابلاً للاستيراد بأمان. */
const IS_MAIN = process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (IS_MAIN) {
  if (CHECK) selfCheck();
  else main().catch(e => { console.error("✗ فشل التشغيل:", e.message); process.exit(1); });
}
