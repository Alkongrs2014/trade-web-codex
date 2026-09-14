#!/usr/bin/env node
/* =====================================================================
   التحليلات المشتقّة — قوة نسبية وبيتا وارتباط وفجوات.

   كل ما هنا يُحسب من شمعاتٍ **عندنا أصلاً** في `data/sym/*.json`، فلا
   يكلّف إلا طلباً واحداً لسلسلة السوق. وهو سبب فصله عن مهام الجلب: لا
   حصّة يستهلكها ولا مصدر يسقط، فيُعاد تشغيله متى شئنا.

   ولماذا مهمة مستقلة لا سطورٌ في `fetch-daily`: الجلب مسؤوليته أن يأتي
   بالبيانات، والاشتقاق مسؤوليته أن يقرأها. خلطهما يجعل فشل طلبٍ واحد
   يسقط حساباً لا علاقة له بالشبكة.

     node scripts/analytics.mjs --out ./data
     node scripts/analytics.mjs --check
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchChart, stats } from "./lib/yahoo.mjs";
import { ema } from "./lib/indicators.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();

// آفاق القوة النسبية بأيام التداول: شهر وثلاثة وستة
export const HZ = { 1: 21, 3: 63, 6: 126 };
// أوزان التركيب. الأقرب أثقل لأن القوة النسبية صفةٌ تتغيّر، لكن ليس
// أثقل بكثير: وزنٌ يسحق الطويل يجعل الترتيب يتقلّب مع كل أسبوع.
export const W = { 1: 0.4, 3: 0.35, 6: 0.25 };
const CORR_WIN = 120;                 // نافذة الارتباط بأيام التداول
const MIN_BARS = 132;                 // ستة أشهر + هامش
const MARKET = process.env.AN_MARKET || "SPY";

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const r2 = (v) => Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
const r3 = (v) => Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;

/* =====================================================================
   الأساسيات الإحصائية
   ===================================================================== */
export function pctChange(closes, n) {
  if (!Array.isArray(closes) || closes.length < n + 1) return null;
  const a = closes[closes.length - 1 - n], b = closes[closes.length - 1];
  return (a > 0 && b > 0) ? (b - a) / a * 100 : null;
}

/* عوائد لوغاريتمية لا نسبية: الارتباط والبيتا يُبنيان على الجمع، والعائد
   النسبي لا يُجمع (‎+50%‎ ثم ‎−50%‎ ليس صفراً). */
export function logReturns(closes, n) {
  const out = [];
  const from = Math.max(1, closes.length - n);
  for (let i = from; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i];
    out.push((a > 0 && b > 0) ? Math.log(b / a) : null);
  }
  return out;
}

/* الارتباط على الأزواج المكتملة وحدها. رمزٌ لم يتداول يوماً (عطلة سوقه،
   أو إدراجٌ متأخر) يترك ثقباً، وملؤه بصفر يقول «لم يتحرك» وهو كذب
   يخفض الارتباط زوراً. */
export function corr(a, b) {
  const xs = [], ys = [];
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[a.length - n + i], y = b[b.length - n + i];
    if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
  }
  if (xs.length < 30) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
  }
  return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : null;
}

/* بيتا: ميل السهم على السوق. فوق الواحد يتحرك أعنف منه، وتحته أهدأ.
   السالبة نادرة وحقيقية (الذهب، بعض التحوّط) ولا تُقصّ عند صفر. */
export function beta(rs, rm) {
  const xs = [], ys = [];
  const n = Math.min(rs.length, rm.length);
  for (let i = 0; i < n; i++) {
    const y = rs[rs.length - n + i], x = rm[rm.length - n + i];
    if (Number.isFinite(x) && Number.isFinite(y)) { xs.push(x); ys.push(y); }
  }
  if (xs.length < 30) return null;
  const mx = xs.reduce((s, v) => s + v, 0) / xs.length;
  const my = ys.reduce((s, v) => s + v, 0) / ys.length;
  let cov = 0, varm = 0;
  for (let i = 0; i < xs.length; i++) { cov += (xs[i] - mx) * (ys[i] - my); varm += (xs[i] - mx) ** 2; }
  return varm > 0 ? cov / varm : null;
}

/* المئين: موضع القيمة بين قيم مرتّبة. الترتيب لا القيمة هو المعلومة —
   «أقوى من 92% من السوق» تُقرأ، و«فائض عائد 11.3%» لا تُقرأ بلا سياق. */
export function pctRankOf(sorted, v) {
  if (!sorted.length || !Number.isFinite(v)) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  return r2(lo / sorted.length * 100);
}

export function median(a) {
  const v = a.filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

/* الفجوة الليلية: الفتح مقابل إغلاق الأمس. وهي ما لا يحميك منه وقف
   الخسارة — السعر يقفز فوقه لا عبره. */
export function gapStats(k, keep = 5) {
  if (!Array.isArray(k) || k.length < 30) return null;
  const g = [];
  for (let i = 1; i < k.length; i++) {
    const prev = k[i - 1][4], open = k[i][1];
    if (!(prev > 0) || !(open > 0)) continue;
    g.push({ t: k[i][0], v: (open - prev) / prev * 100 });
  }
  if (g.length < 20) return null;
  const abs = g.map(x => Math.abs(x.v));
  const top = [...g].sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, keep);
  return {
    n: g.length,
    avg: r2(abs.reduce((s, v) => s + v, 0) / abs.length),
    med: r2(median(abs)),
    top: top.map(x => ({ t: x.t, v: r2(x.v) }))
  };
}

/* =====================================================================
   القراءة من ملفات الرموز
   ===================================================================== */
function dailyCloses(dir, sym) {
  const j = readJSON(path.join(dir, "sym", `${sym}.json`));
  const c = j?.tf?.["1d"]?.c;
  if (!Array.isArray(c) || !c.length) return null;
  // مضغوطة [t,o,h,l,c,v] — انظر `unpackCandles` في الواجهة
  return c;
}

async function main() {
  const now = Date.now();
  fs.mkdirSync(OUT, { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "stocks/symbols.json"), "utf8"));

  const sum = readJSON(path.join(OUT, "summary.json"));
  const wide = readJSON(path.join(OUT, "wide.json"));
  const rowsAll = [...(sum?.rows || []), ...(wide?.rows || [])];
  if (!rowsAll.length) throw new Error("لا ملخّص ولا طبقة واسعة — لا شيء نحلّله");

  const cryptoSet = new Set((cfg.crypto || []).map(c => c.s));
  const meta = new Map(rowsAll.map(r => [r.s, r]));

  /* سلسلة السوق: طلبٌ واحد. وحين تسقط نستعمل **وسيط الكون** بديلاً —
     القوة النسبية مقارنةٌ بمرجع، وأي مرجعٍ معلن خيرٌ من إسقاط القسم. */
  let mktCloses = null, mktSrc = MARKET, reg = null;
  try {
    // سنتان لا سنة: المتوسط المئوي يحتاج تسخيناً، وقيمته على 252 شمعة
    // تحمل أثر أول قيمة فيها
    const { candles } = await fetchChart(MARKET, { range: "2y", interval: "1d" });
    if (Array.isArray(candles) && candles.length >= MIN_BARS) {
      mktCloses = candles.map(c => c.c).filter(Number.isFinite);
      // حالة السوق **الآن** — نفس تعريف `regimeMap` في الأرشيف، وبها
      // يصير قياس الحافة حسب الحالة قابلاً للتطبيق لا مجرّد جدول
      const e200 = ema(mktCloses, 200);
      const px = mktCloses[mktCloses.length - 1], em = e200[e200.length - 1];
      if (Number.isFinite(px) && Number.isFinite(em))
        reg = { src: MARKET, state: px >= em ? "up" : "dn", px: r2(px), ema: r2(em),
                gap: r2((px - em) / em * 100) };
    }
  } catch (e) { console.warn(`  ⚠ تعذّر جلب ${MARKET}: ${e.message}`); }

  // الأسعار لكل رمز
  const series = new Map();
  for (const r of rowsAll) {
    const k = dailyCloses(OUT, r.s);
    if (!k || k.length < MIN_BARS) continue;
    series.set(r.s, k);
  }
  if (!series.size) throw new Error("لا شمعات يومية محفوظة — شغّل fetch-market أولاً");

  // المرجع البديل: وسيط عوائد الأسهم (بلا كريبتو — مداه يزيح كل شيء)
  if (!mktCloses) {
    mktSrc = "وسيط الكون";
    const stocks = [...series.entries()].filter(([s]) => !cryptoSet.has(s));
    const len = Math.min(...stocks.map(([, k]) => k.length));
    mktCloses = [];
    for (let i = 0; i < len; i++) {
      const at = stocks.map(([, k]) => k[k.length - len + i][4]).filter(Number.isFinite);
      mktCloses.push(median(at));
    }
  }
  const mktRet = Object.fromEntries(Object.entries(HZ).map(([k, n]) => [k, r2(pctChange(mktCloses, n))]));
  const mktLog = logReturns(mktCloses, CORR_WIN);

  /* ---------- القوة النسبية والبيتا ---------- */
  const rs = [];
  for (const [s, k] of series) {
    const closes = k.map(x => x[4]);
    const row = {};
    let ok = true;
    for (const [key, n] of Object.entries(HZ)) {
      const v = pctChange(closes, n);
      row["r" + key] = r2(v);
      row["x" + key] = (Number.isFinite(v) && Number.isFinite(mktRet[key])) ? r2(v - mktRet[key]) : null;
      if (!Number.isFinite(v)) ok = false;
    }
    if (!ok) continue;
    // التركيب على **الفائض** لا على العائد: سوقٌ صعد 20% يجعل كل سهم
    // يبدو قوياً، والسؤال أيّها أقوى من السوق لا أيّها ارتفع
    row.sc = r2(Object.entries(W).reduce((a, [key, w]) => a + w * (row["x" + key] ?? 0), 0));
    row.s = s;
    row.sec = meta.get(s)?.sec || null;
    row.cx = cryptoSet.has(s) ? 1 : undefined;
    row.beta = r3(beta(logReturns(closes, CORR_WIN), mktLog));
    rs.push(row);
  }
  // الرتبة المئوية داخل **الأسهم** وحدها: الكريبتو مداه يزيح التوزيع
  const scSorted = rs.filter(r => !r.cx).map(r => r.sc).sort((a, b) => a - b);
  for (const r of rs) r.rk = pctRankOf(scSorted, r.sc);
  rs.sort((a, b) => (b.sc ?? -1e9) - (a.sc ?? -1e9));

  /* ---------- القوة النسبية بالقطاع ---------- */
  const bySec = new Map();
  for (const r of rs) {
    if (r.cx || !r.sec) continue;
    (bySec.get(r.sec) || bySec.set(r.sec, []).get(r.sec)).push(r);
  }
  const sectors = [...bySec.entries()].map(([sec, list]) => ({
    sec, n: list.length,
    x1: r2(median(list.map(x => x.x1))), x3: r2(median(list.map(x => x.x3))),
    x6: r2(median(list.map(x => x.x6))), sc: r2(median(list.map(x => x.sc)))
  })).sort((a, b) => (b.sc ?? -1e9) - (a.sc ?? -1e9));

  /* ---------- مصفوفة الارتباط ---------- */
  /* على المرصودة وحدها: 510 رمزاً تعني 130 ألف زوج — ملفٌّ بالميغابايتات
     لا يُقرأ منه إلا ما يخصّ ما تتابعه. */
  const watch = (sum?.rows || []).map(r => r.s).filter(s => series.has(s)).sort();
  const logs = new Map(watch.map(s => [s, logReturns(series.get(s).map(x => x[4]), CORR_WIN)]));
  const tri = [];                       // المثلث الأعلى صفّاً صفّاً
  const pairs = [];
  for (let i = 0; i < watch.length; i++) {
    for (let j = i + 1; j < watch.length; j++) {
      const c = corr(logs.get(watch[i]), logs.get(watch[j]));
      // ‎×100‎ كعدد صحيح: الارتباط بخانتين عشريتين وهمٌ دقّة، وأربعة آلاف
      // كسرٍ عشري تضاعف الملف بلا معلومة
      tri.push(c === null ? -128 : Math.round(c * 100));
      if (c !== null) pairs.push([watch[i], watch[j], Math.round(c * 100)]);
    }
  }
  pairs.sort((a, b) => b[2] - a[2]);

  /* ---------- الفجوات الليلية ---------- */
  const gaps = [];
  for (const s of watch) {
    const g = gapStats(series.get(s));
    if (g) gaps.push({ s, ...g });
  }
  gaps.sort((a, b) => b.avg - a.avg);

  const out = {
    updated: now, market: mktSrc, hz: HZ, w: W, corrWin: CORR_WIN, regime: reg,
    mkt: mktRet, n: rs.length,
    rs, sectors,
    corr: { win: CORR_WIN, syms: watch, m: tri },
    pairs: { high: pairs.slice(0, 12), low: pairs.slice(-12).reverse() },
    gaps: gaps.slice(0, 40)
  };

  const p = path.join(OUT, "analytics.json");
  const prev = readJSON(p);
  // بوابة السلامة: لا نكتب ملفاً أفقر مما عندنا
  if (prev && Array.isArray(prev.rs) && rs.length < prev.rs.length * 0.8)
    throw new Error(`القوة النسبية تقلّصت ${prev.rs.length}→${rs.length} — لن نكتب`);
  fs.writeFileSync(p, JSON.stringify(out));

  const prevMeta = readJSON(path.join(OUT, "meta.json"), {});
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
    ...prevMeta, analyticsUpdated: now,
    analyticsRun: { at: new Date(now).toISOString(), symbols: rs.length, market: mktSrc,
                    pairs: pairs.length, sectors: sectors.length, requests: stats.requests }
  }));

  const size = fs.statSync(p).size;
  console.log(`✔ ${rs.length} رمزاً · مرجع ${mktSrc} · ${pairs.length} زوجاً · ${sectors.length} قطاعاً · ${(size / 1024).toFixed(0)} ك.ب`);
  console.log(`  السوق: شهر ${mktRet[1]}% · ثلاثة ${mktRet[3]}% · ستة ${mktRet[6]}%`);
  if (reg) console.log(`  حالة السوق الآن: ${reg.state === "up" ? "فوق" : "تحت"} متوسطه المئوي بـ${reg.gap}%`);
  console.log(`  الأقوى: ${rs.slice(0, 5).map(r => `${r.s} (${r.rk})`).join(" · ")}`);
  console.log(`  الأضعف: ${rs.slice(-5).reverse().map(r => `${r.s} (${r.rk})`).join(" · ")}`);
  if (pairs.length) console.log(`  أعلى ارتباط: ${pairs[0][0]}/${pairs[0][1]} ${pairs[0][2] / 100}`);
  return 0;
}

/* ---------- فحص ذاتي بلا شبكة ---------- */
function selfCheck() {
  console.log("▶ فحص ذاتي (بلا شبكة)\n");
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; } };
  const near = (a, b, tol, m) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${m}: ${a} ≠ ${b}`); };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

  t("pctChange يقيس من الشمعة رقم n إلى الأخيرة", () => {
    near(pctChange([100, 110, 121], 2), 21, 1e-9, "على شمعتين");
    near(pctChange([100, 110, 121], 1), 10, 1e-9, "على شمعة");
    eq(pctChange([100], 5), null, "أقصر من المدى");
    eq(pctChange([0, 10], 1), null, "سعر صفر لا يُقسم عليه");
  });

  t("corr يساوي ١ للسلسلة مع نفسها و‎−١‎ لمقلوبها", () => {
    const a = Array.from({ length: 60 }, (_, i) => Math.sin(i / 3));
    near(corr(a, a), 1, 1e-9, "مع نفسها");
    near(corr(a, a.map(v => -v)), -1, 1e-9, "مع مقلوبها");
    near(corr(a, a.map(v => v * 3 + 7)), 1, 1e-9, "تحويل خطّي موجب لا يغيّره");
    eq(corr([1, 2], [1, 2]), null, "عيّنة أقصر من الحد");
    // ثقبٌ في إحدى السلسلتين يُسقط الزوج لا يُملأ بصفر
    const b = a.slice(); b[5] = null;
    if (!(corr(a, b) > 0.99)) throw new Error("الثقب أفسد الارتباط");
  });

  t("beta ميلٌ لا ارتباط", () => {
    const m = Array.from({ length: 80 }, (_, i) => Math.sin(i / 4) / 100);
    near(beta(m.map(v => v * 2), m), 2, 1e-9, "ضعف حركة السوق");
    near(beta(m.map(v => v * 0.5), m), 0.5, 1e-9, "نصفها");
    near(beta(m.map(v => -v), m), -1, 1e-9, "عكسها");
    eq(beta([1, 2], [1, 2]), null, "عيّنة قصيرة");
  });

  t("logReturns تُجمع والنسبية لا", () => {
    const r = logReturns([100, 150, 100], 2);
    near(r[0] + r[1], 0, 1e-12, "صعود ثم هبوط إلى نفس السعر = صفر");
    eq(logReturns([100, 0, 50], 2)[0], null, "سعر صفر ثقبٌ لا صفر");
  });

  t("pctRankOf موضعٌ في التوزيع", () => {
    const s = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    near(pctRankOf(s, 5.5), 50, 1e-9, "الوسط");
    near(pctRankOf(s, 0), 0, 1e-9, "الأدنى");
    near(pctRankOf(s, 99), 100, 1e-9, "الأعلى");
    eq(pctRankOf([], 5), null, "توزيع فارغ");
  });

  t("median وسيطٌ لا متوسط", () => {
    near(median([1, 2, 3, 1000]), 2.5, 1e-9, "الشاذّ لا يزيحه");
    near(median([3, 1, 2]), 2, 1e-9, "فردي");
    eq(median([]), null, "فارغ");
    eq(median([null, undefined, NaN]), null, "بلا قيم صالحة");
  });

  t("gapStats تقيس الفتح مقابل إغلاق الأمس", () => {
    // [t,o,h,l,c,v] — إغلاق 100 ثم فتح 110 = فجوة 10%
    const k = [];
    for (let i = 0; i < 40; i++) k.push([i, 100, 101, 99, 100, 1]);
    k[20] = [20, 110, 112, 109, 110, 1];
    const g = gapStats(k);
    near(g.top[0].v, 10, 1e-9, "أكبر فجوة");
    eq(g.top[0].t, 20, "موضعها");
    if (!(g.avg > 0 && g.avg < 1)) throw new Error("المتوسط غير معقول: " + g.avg);
    eq(gapStats([[0, 1, 1, 1, 1, 1]]), null, "سلسلة قصيرة");
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل`);
  process.exit(fail ? 1 : 0);
}

if (CHECK) selfCheck();
else main().catch(e => { console.error("✗ فشل التشغيل:", e.message); process.exit(1); });
