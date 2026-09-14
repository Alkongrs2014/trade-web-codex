#!/usr/bin/env node
/* =====================================================================
   الفحص الذاتي لماسح الاستراتيجيات — بلا شبكة.

   أهمّ ما فيه **المقارنة الذهبية للإيقاعين**: التصميم كلّه يقوم على أن
   دورة الدقيقتين تعيد حساب البوابات السعرية وحدها وتأخذ المؤشرية من
   الدورة السابقة. فإن أعطى المساران رقمين مختلفين بنفس المدخلات، صار
   ما يُحفظ غير ما يُعرض — وهي بالضبط العلّة التي جعلت `plan.js` و
   `scans.js` و`score.js` ملفّاتٍ مشتركة.

   وبقيّة الفحوص تحرس مصائد موثّقة في `CLAUDE.md`: الحجم الصفري،
   والفترات المحفوظة من يومٍ سابق، والتقريب الذي يمحو الأصول الرخيصة،
   والاختبار الذي يثبّت رقماً فيُسقِط نفسه عند أي إضافة.
   ===================================================================== */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { statusNow } from "./lib/session.mjs";
import { rp } from "./lib/round.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const S = require(path.join(ROOT, "stocks/strategies.js"));
const I = require(path.join(ROOT, "stocks/indicators.js"));
const E = require(path.join(ROOT, "stocks/evaluate.js"));
const P = require(path.join(ROOT, "stocks/plan.js"));
const K = require(path.join(ROOT, "stocks/consensus.js"));

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { fn(); console.log(`  ✓ ${name}`); pass++; }
  catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; }
};
const eq = (a, b, m) => {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  if (x !== y) throw new Error(`${m}: ${x} ≠ ${y}`);
};
const ok = (c, m) => { if (!c) throw new Error(m); };

/* ---------- سياقٌ حقيقي من القرص، وإلا سياقٌ مُصطنع ----------
   الفحص يجب أن يمرّ على جهازٍ بلا `data/` (مستودعٌ نظيف)، فلا يُشترط
   وجودها — لكنه يستعملها حين توجد لأن البيانات الحقيقية تكشف ما لا
   تكشفه سلسلةٌ مثالية مولَّدة. */
function realCtx(sym = "AAPL") {
  const f = path.join(ROOT, "data/sym", `${sym}.json`);
  const g = path.join(ROOT, "data/summary.json");
  if (!fs.existsSync(f) || !fs.existsSync(g)) return null;
  const rec = JSON.parse(fs.readFileSync(f, "utf8"));
  const row = JSON.parse(fs.readFileSync(g, "utf8")).rows.find(r => r.s === sym);
  const now = Date.now();
  return S.buildCtx({ rec, row, now, sess: statusNow(rec.period, now).state });
}

/* سلسلةٌ مُصطنعة صاعدة بحجمٍ حقيقي — تكفي EMA200 وكل المؤشرات */
function synth(n = 300, base = 100, step = 0.2, vol = 100000) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const c = base + i * step;
    out.push({ t: (1789000000 + i * 300) * 1000, o: c - step / 2, h: c + step, l: c - step, c, v: vol });
  }
  return out;
}

console.log("\n▶ فحص ماسح الاستراتيجيات (بلا شبكة)\n");

/* =====================================================================
   ١) المقارنة الذهبية — شرط قبول التصميم كلّه
   ===================================================================== */
t("المساران يعطيان نفس الرقم بالضبط (الإيقاعان)", () => {
  const c = realCtx();
  if (!c) { console.log("      (لا بيانات محلية — تُخطّى)"); return; }
  let tested = 0;
  for (const st of S.STRATEGIES) {
    const full = S.evalStrategy(st, c);
    if (!full.dir || full.sc === null) continue;
    tested++;
    // الدورة السريعة: البوابات السعرية تُعاد، والمؤشرية من السابقة
    const fast = S.evalStrategy(st, c, { only: "price", prev: full });
    eq(fast.sc, full.sc, `${st.id} النتيجة`);
    eq(fast.g, full.g, `${st.id} البوابات`);
    eq(fast.dir, full.dir, `${st.id} الاتجاه`);
  }
  ok(tested >= 1, "لم تُختبر استراتيجيةٌ واحدة — السياق بلا إشارات");
});

t("البوابة المؤشرية بلا سابقة تُسقَط ولا تُعامَل محايدة", () => {
  const gates = [
    { id: "p", w: 2, kind: "price", v: () => 1 },
    { id: "i", w: 2, kind: "ind", v: () => -1 }
  ];
  const full = S.evalGates(gates, {}, 1);
  eq(full.sc, 50, "متعادلة في المسار الكامل");
  // بلا سابقة: تبقى السعرية وحدها فيكون المقام 2 لا 4
  const noPrev = S.evalGates(gates, {}, 1, { only: "price", prev: null });
  eq(noPrev.w, 2, "المقام بلا المؤشرية");
  eq(noPrev.sc, 100, "السعرية وحدها");
  // بسابقة: يعود التعادل
  const withPrev = S.evalGates(gates, {}, 1, { only: "price", prev: full });
  eq(withPrev.sc, full.sc, "السابقة تعيد نفس الرقم");
});

/* =====================================================================
   ٢) المنطقة الميتة
   ===================================================================== */
t("إزاحةٌ داخل المنطقة الميتة لا تقلب بوابة", () => {
  const atr = 10, tol = S.tolOf(atr);        // 1.5
  eq(S.cmp(100, 100 + tol * 0.9, atr), 0, "داخل الميتة");
  eq(S.cmp(100, 100 - tol * 0.9, atr), 0, "داخل الميتة سالباً");
  eq(S.cmp(100, 100 - tol * 1.5, atr), 1, "خارجها صعوداً");
  eq(S.cmp(100, 100 + tol * 1.5, atr), -1, "خارجها هبوطاً");
  eq(S.cmp(100, 100, atr), 0, "التساوي التامّ لا يصوّت");
  eq(S.cmp(100, null, atr), null, "الغائب null لا صفر");
  eq(S.cmp(null, 100, atr), null, "الغائب null لا صفر");
  // بلا ATR تعود حادّة — وكل مستهلكٍ في المشروع يمرّره
  eq(S.cmp(100, 100.0001, null), -1, "بلا ATR لا منطقة ميتة");
});

t("المنطقة الميتة تعمل على سياقٍ حقيقي", () => {
  const c = realCtx();
  if (!c) { console.log("      (لا بيانات محلية — تُخطّى)"); return; }
  const a = c.an["15m"] || c.an["1d"];
  if (!a || !(a.atr > 0)) return;
  const nudge = a.atr * 0.15 * 0.5;           // نصف العتبة
  const c2 = Object.assign({}, c, { px: c.px + nudge });
  for (const st of S.STRATEGIES) {
    const r1 = S.evalStrategy(st, c), r2 = S.evalStrategy(st, c2);
    if (!r1.dir || !r2.dir) continue;
    // البوابات السعرية التي طرفاها متباعدان قد تتغيّر بحقّ؛ المطلوب
    // ألّا تنقلب بوابةٌ كانت على حدّ التساوي بالضبط
    const g1 = Object.fromEntries((r1.g || []).map(g => [g[0], g[2]]));
    for (const g of (r2.g || [])) {
      if (g1[g[0]] === 0 && Math.abs(g[2]) === 1)
        throw new Error(`${st.id}/${g[0]} انقلبت من الحياد بإزاحةٍ داخل المنطقة الميتة`);
    }
  }
});

/* =====================================================================
   ٣) الحجم والجلسة
   ===================================================================== */
t("VWAP يعود null عند غياب الحجم لا متوسّطاً حسابياً", () => {
  const k = synth(60);
  const period = { regular: { start: k[0].t, end: k[k.length - 1].t } };
  ok(I.sessionVwap(k, period), "بحجمٍ حقيقي يجب أن يُحسب");
  const zero = k.map(x => ({ ...x, v: 0 }));
  eq(I.sessionVwap(zero, period), null, "بحجمٍ صفر");
  eq(I.sessionVwap(k, null), null, "بلا فترة");
  eq(I.sessionVwap(k, { regular: { start: null, end: null } }), null, "فترة بلا حدود");
});

t("نطاق الافتتاح يعلن أنه قيد التكوّن", () => {
  const k = synth(10, 100, 0.2);
  const s0 = k[0].t;
  const period = { regular: { start: s0, end: s0 + 6.5 * 3600e3 } };
  // نافذةٌ تبتلع كل الشمعات: لا شمعة بعدها -> غير مكتمل
  const all = I.openingRange(k, period, 10 * 5);
  ok(all && all.complete === false, "بلا شمعةٍ بعد النافذة يجب أن يكون غير مكتمل");
  const part = I.openingRange(k, period, 15);
  ok(part && part.complete === true, "بوجود شمعاتٍ بعدها يكتمل");
  ok(part.hi > part.lo, "نطاقٌ حقيقي");
  eq(I.openingRange(k, { regular: { start: s0 - 86400e3 * 3, end: s0 - 86400e3 * 2 } }, 15), null,
     "نافذةٌ بلا شمعات");
});

t("استراتيجيات الجلسة تنسحب خارجها وعلى فتراتٍ من يومٍ سابق", () => {
  const c = realCtx();
  if (!c) { console.log("      (لا بيانات محلية — تُخطّى)"); return; }
  for (const id of ["orb", "vwapRec"]) {
    const st = S.STRAT_BY_ID[id];
    const closed = Object.assign({}, c, { sess: "CLOSED" });
    ok(S.evalStrategy(st, closed).off, `${id} يجب أن ينسحب خارج الجلسة`);
    const old = Object.assign({}, c, { today: false });
    ok(S.evalStrategy(st, old).off, `${id} يجب أن ينسحب على فتراتٍ من يومٍ سابق`);
  }
});

t("buildCtx يكشف الفترات التي تصف يوماً سابقاً", () => {
  const now = Date.UTC(2026, 8, 14, 18, 0, 0);
  ok(S.sameUtcDay(Date.UTC(2026, 8, 14, 13, 30), now), "نفس اليوم");
  ok(!S.sameUtcDay(Date.UTC(2026, 8, 13, 13, 30), now), "يومٌ سابق");
  ok(!S.sameUtcDay(null, now), "الغائب ليس نفس اليوم");
});

/* =====================================================================
   ٤) الخطط — البوابة بعد التقريب
   ===================================================================== */
t("كل خطة مولَّدة تمرّ validatePlan — وبعد التقريب", () => {
  const summary = path.join(ROOT, "data/summary.json");
  if (!fs.existsSync(summary)) { console.log("      (لا بيانات محلية — تُخطّى)"); return; }
  const rows = JSON.parse(fs.readFileSync(summary, "utf8")).rows;
  const now = Date.now();
  let n = 0, bad = 0;
  for (const row of rows) {
    const f = path.join(ROOT, "data/sym", `${row.s}.json`);
    if (!fs.existsSync(f)) continue;
    const rec = JSON.parse(fs.readFileSync(f, "utf8"));
    const c = S.buildCtx({ rec, row, now, sess: statusNow(rec.period, now).state });
    for (const r of S.evalAll(c)) {
      if (!r.dir) continue;
      const p = S.planFor(c, r);
      if (!p) continue;
      if (p.bad) { bad++; continue; }
      n++;
      /* ما يُفحص يجب أن يكون ما يُكتب: التقريب يقع **بعد** الحساب،
         فخطةٌ سليمة قد تخرج مكسورة بعده. وقع فعلاً في `track-signals`
         حين قرّبت لقطة شيبا بخانات ثابتة فخرجت بمخاطرةٍ صفر. */
      const round = {
        dir: p.dir, entry: rp(p.entry), stop: rp(p.stop), atr: rp(p.atr),
        risk: rp(p.entry) - rp(p.stop) > 0 === (p.dir > 0)
                ? Math.abs(rp(p.entry) - rp(p.stop)) : -1,
        targets: p.targets.map(x => ({ p: rp(x.p), rr: x.rr })),
        primary: p.primary ? { p: rp(p.primary.p) } : null
      };
      const errs = P.validatePlan(round);
      if (errs.length) throw new Error(`${row.s}/${r.id} بعد التقريب: ${errs.join("، ")}`);
      ok(Math.abs(rp(p.entry) - rp(p.stop)) > 0, `${row.s}/${r.id} المخاطرة صفر بعد التقريب`);
    }
  }
  ok(n > 0, "لم تُولَّد خطةٌ واحدة");
  ok(bad === 0, `${bad} خطة رُفضت من بوابة الاتجاه`);
  console.log(`      (${n} خطة فُحصت)`);
});

t("التقريب يحفظ الأصول الرخيصة في مستويات الخطة", () => {
  // شيبا إينو — المصيدة الموثّقة بالحرف
  eq(rp(0.0000051), 0.0000051, "سعرٌ دون المليونية");
  const e = rp(0.00000529), s = rp(0.00000501);
  ok(e - s > 0, "الفرق بين الدخول والوقف يبقى موجباً بعد التقريب");
});

/* =====================================================================
   ٥) خصائص التعريف — بلا رقمٍ مثبَّت
   ===================================================================== */
t("تعريفات الاستراتيجيات سليمة خاصّيةً لا عدداً", () => {
  /* لا `length !== 10`: رقمٌ مثبَّت يُسقط الفحص عند أي إضافة، فيدفع
     إلى تخفيفه بدل قراءته — مصيدة موثّقة وقعت ثلاث مرات في المشروع. */
  ok(S.STRATEGIES.length >= 6, "عددٌ يكفي إجماعاً");
  const ids = new Set();
  for (const st of S.STRATEGIES) {
    ok(st.id && !ids.has(st.id), `معرّف مكرّر أو غائب: ${st.id}`);
    ids.add(st.id);
    ok(st.lbl && st.why, `${st.id} بلا وسمٍ أو شرح`);
    ok(S.FAMS[st.fam], `${st.id} عائلةٌ غير معروفة: ${st.fam}`);
    ok(E.TF_BAR[st.tf], `${st.id} فريمٌ لا طول له في TF_BAR: ${st.tf}`);
    ok(typeof st.side === "function", `${st.id} بلا مشغِّل`);
    ok(Array.isArray(st.gates) && st.gates.length >= 3, `${st.id} بوابات أقلّ من ثلاث`);
    const gids = new Set();
    for (const g of st.gates) {
      ok(g.id && !gids.has(g.id), `${st.id}/${g.id} معرّف بوابة مكرّر`);
      gids.add(g.id);
      ok(g.w > 0, `${st.id}/${g.id} وزن غير موجب`);
      ok(g.kind === "price" || g.kind === "ind", `${st.id}/${g.id} نوعٌ غير معروف`);
      ok(g.lbl, `${st.id}/${g.id} بلا وسم`);
    }
    // لا معنى لاستراتيجية كل بواباتها مؤشرية على إيقاعٍ سعري
    ok(st.gates.some(g => g.kind === "price"), `${st.id} بلا بوابةٍ سعرية واحدة`);
  }
  ok(new Set(S.STRATEGIES.map(s => s.fam)).size >= 3, "عائلاتٌ تكفي لقاعدة التوافق");
});

t("كل استراتيجية تصمد أمام بياناتٍ ناقصة ولا ترمي", () => {
  const empties = [
    { s: "X", px: 100, now: Date.now(), k: {}, an: {}, lv: {}, bw: {}, row: {} },
    { s: "X", px: null, now: Date.now(), k: {}, an: { "1d": {} }, lv: {}, bw: {}, row: {} },
    { s: "X", px: 100, now: Date.now(), k: { "1d": [] }, an: { "1d": { atr: 0 } }, lv: { L: null }, bw: {}, row: {} }
  ];
  for (const c of empties) for (const st of S.STRATEGIES) {
    const r = S.evalStrategy(st, c);
    ok(r && typeof r === "object", `${st.id} لم يُعِد كائناً`);
    ok(r.sc === null || Number.isFinite(r.sc), `${st.id} نتيجةٌ ليست رقماً ولا null`);
    if (r.sc !== null) ok(r.sc >= 0 && r.sc <= 100, `${st.id} نتيجةٌ خارج 0..100`);
  }
});

t("الوضع المُصغَّر يسمّي ما سقط ولا يُخفيه", () => {
  const summary = path.join(ROOT, "data/summary.json");
  if (!fs.existsSync(summary)) { console.log("      (لا بيانات محلية — تُخطّى)"); return; }
  // رمزٌ واسع: الشمعة اليومية وحدها
  const wideFile = path.join(ROOT, "data/wide.json");
  if (!fs.existsSync(wideFile)) { console.log("      (لا طبقة واسعة — تُخطّى)"); return; }
  const w = JSON.parse(fs.readFileSync(wideFile, "utf8"));
  const row = (w.rows || [])[0];
  if (!row) return;
  const rec = { s: row.s, tf: {}, an: {}, period: null };
  const c = S.buildCtx({ rec, row, now: Date.now(), sess: "REGULAR", wide: true });
  const res = S.evalAll(c);
  const off = res.filter(r => r.off);
  ok(off.length >= 4, `يُتوقّع سقوط أربعٍ على الأقل بلا فريمات لحظية، سقط ${off.length}`);
  for (const r of off) ok(r.off.length > 5, `${r.id} سببٌ غير مفهوم: ${r.off}`);
  ok(res.every(r => r.sc === null || Number.isFinite(r.sc)), "نتيجةٌ ملفّقة في الوضع المُصغَّر");
});

/* =====================================================================
   ٦) الوسم المثبَّت وحالة الإشارة
   ===================================================================== */
t("وسم القوّة مثبَّت بهامش فلا يهتزّ على الحدّ", () => {
  eq(S.sBandOf(54), 0, "تحت أول حدّ");
  eq(S.sBandOf(55), 1, "عند الحدّ");
  // رقمٌ يحوم على 55 لا يغيّر الوسم ذهاباً وإياباً
  eq(S.sBandStable(56, 0), 0, "لم يتجاوز الهامش صعوداً");
  eq(S.sBandStable(58, 0), 1, "تجاوز الهامش");
  eq(S.sBandStable(53, 1), 1, "لم يتجاوز الهامش هبوطاً");
  eq(S.sBandStable(52, 1), 0, "تجاوزه هبوطاً");
  // قفزةٌ بنطاقين تُمشى خطوةً خطوة فيُعبر كل حدٍّ بهامشه
  eq(S.sBandStable(95, 0), 3, "قفزةٌ كاملة");
  eq(S.sBandStable(60, null), 1, "بلا سابقة يُؤخذ الحالي");
});

t("حالة الإشارة تميّز الستّ ولا تخلط العمر بالحركة", () => {
  const mk = (age, px) => {
    const fr = E.freshness(age, "15m");
    const eq2 = E.entryQuality({ px, sigPx: 100, atr: 1, dir: 1, target: 105, stop: 98 });
    return E.signalStatus(fr, eq2, age, "15m").k;
  };
  eq(mk(5 * 60e3, 100.1), "NEW", "داخل الشمعة الجارية");
  eq(mk(25 * 60e3, 100.1), "FRESH", "شمعتان");
  eq(mk(80 * 60e3, 100.1), "ACTIVE", "ستّ شمعات");
  eq(mk(80 * 60e3, 101.5), "LATE", "تحرّك أكثر من مدى");
  eq(mk(80 * 60e3, 102.5), "EXTENDED", "تحرّك أكثر من مدى يومين");
  eq(mk(30 * 60e3, 97), "EXPIRED", "ضُرب الوقف");
  eq(mk(10 * 3600e3, 100.1), "EXPIRED", "قديمة بمقياس فريمها");
  // العمر وحده لا يكفي: نفس العمر بحركتين مختلفتين حالتان مختلفتان
  ok(mk(80 * 60e3, 100.1) !== mk(80 * 60e3, 102.5), "العمر وحده لا يحدّد الحالة");
});

t("جودة الدخول رقمٌ مشتقٌّ من نفس مقياسَي الوسم", () => {
  const fr = E.freshness(20 * 60e3, "15m");
  const good = E.entryQuality({ px: 100.05, sigPx: 100, atr: 1, dir: 1, target: 105, stop: 98 });
  const late = E.entryQuality({ px: 102.5, sigPx: 100, atr: 1, dir: 1, target: 105, stop: 98 });
  const a = E.entryScore(good, fr), b = E.entryScore(late, fr);
  ok(a.v > b.v, "الدخول القريب أعلى من المتأخر");
  ok(a.v >= 0 && a.v <= 100 && b.v >= 0 && b.v <= 100, "خارج 0..100");
  // الحركة ضدّ الإشارة لا تُكافأ
  const against = E.entryQuality({ px: 99, sigPx: 100, atr: 1, dir: 1, target: 105, stop: 98 });
  ok(E.entryScore(against, fr).v <= a.v + 1, "الحركة المعاكسة لا تُكافأ فوق الدخول القريب");
  eq(E.entryScore(null, fr), null, "بلا جودةٍ لا رقم");
  const gone = E.entryQuality({ px: 97, sigPx: 100, atr: 1, dir: 1, target: 105, stop: 98 });
  eq(E.entryScore(gone, fr).v, 0, "المنتهية صفر");
});

/* =====================================================================
   ٧) الإجماع
   ===================================================================== */
const mk = (id, dir, sc, fam) => ({ id, lbl: id, fam: fam || "trend", dir, sc, active: sc >= 55 });

t("التعارض يُفحص قبل الاتجاه ولا يُعطى جهة", () => {
  const near = K.consensusOf([mk("a", 1, 80, "trend"), mk("b", 1, 80, "revert"),
                              mk("c", -1, 80, "vol"), mk("d", -1, 75, "session")]);
  eq(near.k, "mixed", "أربعٌ متقاربة يجب أن تكون متعارضة");
  eq(near.dir, 0, "لا جهة مع التعارض");
  ok(near.why.indexOf("%") > 0, "السبب يذكر النسبة");
  const clear = K.consensusOf([mk("a", 1, 90, "trend"), mk("b", 1, 85, "revert"),
                               mk("c", 1, 80, "vol"), mk("d", -1, 60, "session")]);
  eq(clear.dir, 1, "أغلبيةٌ واضحة");
  ok(clear.k !== "mixed", "ليست متعارضة");
});

t("الإشارة المنفردة لا تُسمّى إجماعاً", () => {
  const solo = K.consensusOf([mk("a", 1, 95, "trend")]);
  eq(solo.agree, 1, "اتفاقٌ حسابيّ تامّ");
  eq(solo.k, "solo", "لكنه يُوسم منفرداً");
  eq(solo.conf, "low", "وثقتُه منخفضة");
  ok(solo.why.indexOf("لا إجماع") > 0, "يُقال صراحةً");
  const three = K.consensusOf([mk("a", 1, 85, "trend"), mk("b", 1, 85, "revert"), mk("c", 1, 85, "vol")]);
  ok(three.mass > solo.mass, "الكتلة تنمو بالعدد");
  ok(three.sc < solo.sc, "والمتوسّط لا ينمو — ولذلك لا يصلح للترتيب");
});

t("الوزن محايدٌ بلا قياس ولا يُخترع", () => {
  const w = K.weightFor("orb", {});
  eq(w.w, 1, "بلا حافّة وزنٌ محايد");
  eq(w.measured, false, "ويُوسم غير مقيس");
  eq(K.edgeWeight(null), 1, "الحافّة الغائبة لا تصير صفراً");
  eq(K.edgeWeight(0), 1, "حافّةٌ صفر وزنٌ محايد");
  ok(K.edgeWeight(1) > 1, "الحافّة الموجبة ترفع");
  ok(K.edgeWeight(-1) < 1, "والسالبة تخفض");
  ok(K.edgeWeight(99) <= K.W_MAX && K.edgeWeight(-99) >= K.W_MIN, "الوزن محصور");
  const edge = { orb: { edge: -0.3, n: 500, byRegime: { range: -0.1, trend: -0.9 } } };
  const better = K.weightFor("orb", { edge, regime: "range" });
  const worse = K.weightFor("orb", { edge, regime: "trend" });
  ok(better.w > worse.w, "أفضل من عادتها في النطاق يرفع وزنها");
  ok(better.measured && better.note.indexOf("مقيسة") >= 0, "الوسم يقول إنها مقيسة");
});

t("الثقة تنخفض حين لا شيء منها مقيس", () => {
  const four = [mk("a", 1, 92, "trend"), mk("b", 1, 90, "revert"),
                mk("c", 1, 88, "vol"), mk("d", 1, 86, "session")];
  eq(K.consensusOf(four).conf, "med", "بلا قياس لا ثقة عالية");
  const edge = { a: { edge: 0.5, n: 900 }, b: { edge: 0.4, n: 900 } };
  eq(K.consensusOf(four, { edge }).conf, "high", "مع قياس ترتفع");
});

t("التوافق الاستثنائي يشترط عائلتين وطزاجة", () => {
  const side = [Object.assign(mk("a", 1, 92, "trend"), { st: "FRESH", eq: 88 }),
                Object.assign(mk("b", 1, 90, "trend"), { st: "FRESH", eq: 80 }),
                Object.assign(mk("c", 1, 88, "trend"), { st: "FRESH", eq: 75 })];
  eq(K.confluenceOf(K.consensusOf(side), side), null, "ثلاثُ نكهاتٍ من عائلةٍ واحدة ليست توافقاً");
  const mix = side.slice(0, 2).concat([Object.assign(mk("c", 1, 88, "revert"), { st: "FRESH", eq: 75 })]);
  ok(K.confluenceOf(K.consensusOf(mix), mix), "عائلتان متمايزتان توافق");
  const stale = mix.map(x => Object.assign({}, x, { st: "LATE" }));
  eq(K.confluenceOf(K.consensusOf(stale), stale), null, "توافقٌ على حركةٍ وقعت ليس فرصة");
  const bad = mix.map(x => Object.assign({}, x, { eq: 20 }));
  eq(K.confluenceOf(K.consensusOf(bad), bad), null, "جودة دخولٍ متدنّية تُسقط التوافق");
});

t("حالة السوق تُشتقّ من حقولٍ موجودة", () => {
  eq(K.marketRegime({ "1d": { squeeze: 10, adx: 30 } }), "squeeze", "الانضغاط أخصّ");
  eq(K.marketRegime({ "1d": { squeeze: 50, adx: 30 } }), "trend", "قوّة اتجاه");
  eq(K.marketRegime({ "1d": { squeeze: 90, adx: 20 } }), "expansion", "توسّع بلا اتجاه");
  eq(K.marketRegime({ "1d": { squeeze: 50, adx: 10 } }), "range", "نطاق");
  eq(K.marketRegime({ "1d": { squeeze: 50, adx: 20 } }), "mixed", "غير واضحة");
  eq(K.marketRegime({}), null, "بلا حقول لا حالة");
  eq(K.marketRegime({ "1d": {} }), null, "بحقولٍ فارغة لا حالة");
  Object.keys(K.REGIMES).forEach(x => ok(K.REGIMES[x].t && K.REGIMES[x].d, x + " بلا وسمٍ أو شرح"));
});

t("مقارنة المحرّكين تقول ولا تحسم", () => {
  const up = K.consensusOf([mk("a", 1, 90, "trend"), mk("b", 1, 85, "revert")]);
  eq(K.compareEngines(1, up).k, "agree", "اتفاق");
  eq(K.compareEngines(-1, up).k, "clash", "تعارض");
  ok(K.compareEngines(-1, up).why.indexOf("أيّهما أصدق") > 0, "لا يحسم أحدهما");
  eq(K.compareEngines(0, up), null, "بلا اتجاه من الفرص لا مقارنة");
  const mx = K.consensusOf([mk("a", 1, 80, "trend"), mk("b", -1, 80, "revert")]);
  eq(K.compareEngines(1, mx), null, "لا مقارنة مع التعارض");
});

console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل\n`);
process.exit(fail ? 1 : 0);

