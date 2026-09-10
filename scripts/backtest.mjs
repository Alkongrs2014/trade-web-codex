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
import { ema, rsi, macd, bb, atr, scoreFrom } from "./lib/indicators.mjs";
import { fetchChart, pool, stats } from "./lib/yahoo.mjs";

const require = createRequire(import.meta.url);
const { SCANS } = require("../stocks/scans.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();

const HORIZONS = [1, 5, 20];              // أيام تداول
const MAX_H = Math.max(...HORIZONS);
const WARMUP = 260;                       // EMA200 + نافذة 52 أسبوعاً
const COOLDOWN = 5;                       // شمعات قبل تسجيل نفس الشرط للرمز نفسه
const W52 = 252;
const AVGVOL = 10;

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
   بناء لقطة تاريخية بشكل صفّ الملخّص نفسه، حتى تعمل عليها شروط الماسح
   بلا تعديل — نفس الحقول التي تراها الواجهة، بقيم ذلك اليوم.
   ===================================================================== */
export function snapshots(meta, k) {
  const c = k.map(x => x.c), h = k.map(x => x.h), l = k.map(x => x.l), v = k.map(x => x.v || 0);
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
  const R = rsi(c, 14), M = macd(c), B = bb(c, 20, 2), A = atr(h, l, c, 14);
  const w52h = rollingExtreme(h, W52, "max"), w52l = rollingExtreme(l, W52, "min");
  const av = rollingMean(v, AVGVOL);

  const out = [];
  for (let i = 0; i < k.length; i++) {
    if (i < WARMUP) { out.push(null); continue; }
    const score = scoreFrom({
      px: c[i], e20: e20[i], e50: e50[i], e200: e200[i], rsi: R[i],
      hist: M.hist[i], histRising: (M.hist[i] !== null && M.hist[i - 1] !== null) ? M.hist[i] > M.hist[i - 1] : false,
      bbMid: B.mid[i]
    });
    out.push({
      row: { s: meta.s, sec: meta.sec, p: c[i], w52h: w52h[i], w52l: w52l[i],
             rsi: R[i], atr: A[i], vol: v[i], score, tfScore: { "1d": score } },
      // الأساسيات المتاحة تاريخياً وحدها: متوسط الحجم يُحسب من الشمعات
      f: { avgVol: av[i] }
    });
  }
  return out;
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
  console.log(`▶ جلب تاريخ ${chosen.length} رمزاً (خمس سنوات يومية) …`);
  const fetched = await pool(chosen, 3, async (m) => {
    const { candles } = await fetchChart(m.s, { range: "5y", interval: "1d" });
    return { meta: m, k: candles };
  });
  const series = [];
  let failed = 0;
  fetched.forEach((r) => { if (r.ok) series.push(r.value); else failed++; });
  if (failed) console.warn(`  ⚠ سقط ${failed} رمزاً`);
  if (!series.length) throw new Error("لم يصل تاريخ أي رمز");

  console.log(`  قياس ${SCANS.filter(s => s.btTest).length} شروط على ${series.length} رمزاً …`);

  const hits = {};                       // id -> [outcome]
  for (const s of SCANS) if (s.btTest) hits[s.id] = [];
  const baseline = [];
  let bars = 0, symbols = 0, skipped = 0;

  let trimmedSyms = 0;
  for (const { meta, k: raw } of series) {
    if (!Array.isArray(raw)) { skipped++; continue; }
    const { k, trimmed } = trimArtifacts(raw);
    if (trimmed) trimmedSyms++;
    if (k.length < WARMUP + MAX_H + 1) { skipped++; continue; }
    symbols++;
    const snaps = snapshots({ s: meta.s, sec: meta.sec }, k);
    const lastHit = {};                  // id -> آخر شمعة سُجّلت

    for (let i = WARMUP; i < k.length - MAX_H; i++) {
      const sn = snaps[i];
      if (!sn) continue;
      bars++;
      const o = outcome(k, i);
      if (!o) continue;
      baseline.push(o);
      for (const scan of SCANS) {
        if (!scan.btTest) continue;
        let hit = false;
        try { hit = !!scan.btTest(sn.row, sn.f, { secMed: {} }); } catch { hit = false; }
        if (!hit) continue;
        if (lastHit[scan.id] !== undefined && i - lastHit[scan.id] < COOLDOWN) continue;
        lastHit[scan.id] = i;
        hits[scan.id].push(o);
      }
    }
  }

  if (!bars) throw new Error("لا شمعات كافية — لن نكتب ملفاً فارغاً");

  const base = summarize(baseline);
  const scans = SCANS.filter(s => s.btTest).map(s => {
    const g = summarize(hits[s.id]);
    return {
      id: s.id, lbl: s.lbl, note: s.btNote || null, ...g,
      // الحافة على خط الأساس هي المعلومة، لا الرقم المطلق.
      // **على الوسيط لا المتوسط**: توزيع العوائد ملتوٍ بشدّة، وسهم واحد
      // تضاعف عشر مرات يزيح متوسط آلاف الملاحظات ولا يزيح وسيطها.
      edge: Object.fromEntries(HORIZONS.map(h => [h,
        (Number.isFinite(g.ret[h].med) && Number.isFinite(base.ret[h].med))
          ? r2(g.ret[h].med - base.ret[h].med) : null])),
      edgeWin: Object.fromEntries(HORIZONS.map(h => [h,
        (Number.isFinite(g.ret[h].win) && Number.isFinite(base.ret[h].win))
          ? r2(g.ret[h].win - base.ret[h].win) : null]))
    };
  }).sort((a, b) => (b.edge[20] ?? -99) - (a.edge[20] ?? -99));

  const excluded = SCANS.filter(s => !s.btTest).map(s => ({ id: s.id, lbl: s.lbl }));

  const out = { updated: now, symbols, bars, horizons: HORIZONS, cooldown: COOLDOWN,
                trimmed: trimmedSyms, maxDayMove: MAX_DAY_MOVE, cryptoExcluded: true,
                baseline: base, scans, excluded };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "backtest.json"), JSON.stringify(out));

  const prevMeta = readJSON(path.join(OUT, "meta.json"), {});
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
    ...prevMeta, backtestUpdated: now,
    backtestRun: { at: new Date(now).toISOString(), symbols, bars, skipped, failed,
                   trimmed: trimmedSyms, requests: stats.requests }
  }));

  console.log(`✔ ${symbols} رمزاً · ${bars.toLocaleString("en-US")} شمعة${skipped ? ` · تُخطّي ${skipped} قصيراً` : ""}${trimmedSyms ? ` · شُذّب ${trimmedSyms}` : ""}`);
  console.log(`  خط الأساس بعد 20 يوماً: وسيط ${base.ret[20].med}% · نسبة موجبة ${base.ret[20].win}%`);
  for (const s of scans)
    console.log(`  ${s.lbl}: ${s.n} إشارة · وسيط ${s.ret[20].med}% · موجب ${s.ret[20].win}% · حافة ${s.edge[20] > 0 ? "+" : ""}${s.edge[20]} نقطة`);
  if (excluded.length) console.log(`  خارج القياس (لا نملك تاريخ مدخلاتها): ${excluded.map(e => e.lbl).join(" · ")}`);
  return 0;
}

/* ---------- فحص ذاتي بلا شبكة ---------- */
function selfCheck() {
  console.log("▶ فحص ذاتي (بلا شبكة)\n");
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; } };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
  const near = (a, b, tol, m) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${m}: ${a} ≠ ${b}`); };

  t("SCANS تُقرأ من الملف المشترك مع المتصفح", () => {
    if (!Array.isArray(SCANS) || SCANS.length !== 8) throw new Error(`${SCANS?.length}`);
    for (const s of SCANS) if (!s.id || !s.lbl || typeof s.test !== "function") throw new Error(`${s.id} ناقص`);
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
    const a = { px: 110, e20: 105, e50: 100, e200: 95, rsi: 60, hist: 0.4, histRising: true, bbMid: 104 };
    const s = scoreFrom(a);
    if (!(s > 90)) throw new Error(`كل الشروط موجبة يُفترض أن تقارب 100: ${s}`);
    const b = scoreFrom({ px: 90, e20: 95, e50: 100, e200: 105, rsi: 30, hist: -0.4, histRising: false, bbMid: 96 });
    if (!(b < -90)) throw new Error(`كل الشروط سالبة: ${b}`);
    eq(scoreFrom({ px: 100 }), 0, "بلا مؤشرات");
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل`);
  process.exit(fail ? 1 : 0);
}

if (CHECK) selfCheck();
else main().catch(e => { console.error("✗ فشل التشغيل:", e.message); process.exit(1); });
