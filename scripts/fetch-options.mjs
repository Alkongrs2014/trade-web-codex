#!/usr/bin/env node
/* =====================================================================
   عقود الخيارات — دورة مستقلة.

   لماذا مهمة منفصلة: كل رمز يحتاج طلباً لكل تاريخ استحقاق، فسبعون رمزاً
   × استحقاقين = 140 طلباً. إقحامها في دورة السوق العشرية يضاعف حجمها
   بلا داعٍ — سلسلة الخيارات لا تتغيّر بمعدّل الشمعة، ونصف ساعة تكفي.

   المصدر Yahoo وحده (Finnhub المجاني لا يعطي خيارات)، فهذه الميزة
   **محلية**: على رينر GitHub يردّ Yahoo 429 فلا تُملأ. تتدهور بهدوء —
   الواجهة تخفي القسم بدل عرض أصفار.

     node scripts/fetch-options.mjs --out ./data
     node scripts/fetch-options.mjs --check
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchOptions, fetchChart, pool, stats, num } from "./lib/yahoo.mjs";
import { bs, erf, N, evaluate, liquid, rank, yearsToExpiry, impliedVol,
         chainMode, flowRatio, flowLabel, PROB_BAND, FILTER, FLOW,
         maxPain, putCall, walls, expectedMove, gammaByStrike, ivRank } from "./lib/options.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "stocks/symbols.json"), "utf8"));

// عدد الاستحقاقات لكل رمز. الأول مجاني (يأتي مع نداء كشف التواريخ)،
// وكل إضافي طلبٌ مستقل — فالرقم هو ما يحدّد حجم الدورة فعلياً.
const EXPIRIES = Number(process.env.OPT_EXPIRIES || 2);
// أقصى ما نحفظه من كل جانب لكل استحقاق: السلسلة الكاملة مئات العقود
// أغلبها بلا سيولة، وحفظها يضخّم الملف بلا أن يقرأه أحد.
const KEEP_PER_SIDE = 30;
const DAY = 86400e3;
// سقف رموز الطبقة الواسعة لكل تشغيل — نفس فكرة `WIDE_PER_RUN` في دورة
// الشمعات: خمسمئة رمز × استحقاقين = ألف طلب في الدورة الواحدة، بينما
// التدوير يغطّيها كلها خلال ساعات بلا ذروة تستدعي الرفض.
const WIDE_PER_RUN = Number(process.env.OPT_WIDE_PER_RUN || 40);
// صلاحية عقود الطبقة الواسعة: أطول من الأساسية لأنها ليست تحت المراقبة
const WIDE_MAX_AGE = Number(process.env.OPT_WIDE_AGE_H || 6) * 3600e3;
// طول تاريخ التقلّب الضمني المحفوظ. سنة تداول هي العرف في رتبة التقلّب،
// ونقطةٌ واحدة لكل يوم لا لكل تشغيل — ستّ عشرة نقطة يومياً تصف نفس اليوم.
const IV_KEEP = Number(process.env.OPT_IV_KEEP || 252);

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
function writeJSON(rel, obj) {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
  return fs.statSync(p).size;
}
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 100) / 100;
const r4 = (v) => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 10000) / 10000;

/* =====================================================================
   المعدّل الخالي من المخاطر — من أذون الخزانة لثلاثة أشهر (‎^IRX‎).
   رقم ثابت في الشيفرة يتقادم بصمت ويزيح كل الجريكس معه.
   ===================================================================== */
async function riskFreeRate() {
  try {
    const { meta } = await fetchChart("^IRX", { range: "5d", interval: "1d" });
    const p = num(meta?.regularMarketPrice);
    // ‎^IRX‎ مُسعَّر بالنسبة المئوية (3.76 = 3.76%)
    if (p !== null && p >= 0 && p < 25) return p / 100;
  } catch (e) { console.warn(`  ⚠ تعذّر جلب ^IRX: ${e.message}`); }
  return 0.04;                       // تقدير محافظ حين يسقط المصدر
}

/* =====================================================================
   التقلّب المحقَّق (20 يوماً) من شمعاتنا اليومية.

   وحده يجعل رقم IV مقروءاً: 45% تقلّب ضمني لا يعني شيئاً حتى تعرف أن
   السهم يتحرك فعلياً بـ25% — عندها العقود غالية بنسبة معلومة. هذه
   المقارنة لا يعرضها المصدر ولا تكلّف طلباً واحداً.
   ===================================================================== */
export function realizedVol(closes, days = 20) {
  if (!Array.isArray(closes) || closes.length < days + 2) return null;
  const win = closes.slice(-(days + 1));
  const rets = [];
  for (let i = 1; i < win.length; i++) {
    if (!(win[i] > 0 && win[i - 1] > 0)) return null;
    rets.push(Math.log(win[i] / win[i - 1]));
  }
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1);
  return Math.sqrt(varr) * Math.sqrt(252);
}

/* =====================================================================
   رتبة التقلّب المحقَّق — من شمعاتنا، متاحة اليوم لا بعد سنة.

   رتبة التقلّب **الضمني** تحتاج تاريخاً لا نملكه بعد (نبدأ تجميعه من
   هذا التشغيل)، أما المحقَّق فتاريخه في شمعاتنا اليومية أصلاً. والسؤال
   الذي يجيب عنه مختلف لكنه مفيد بذاته: هل يتحرّك هذا السهم الآن أكثر
   من عادته؟ سهمٌ تقلّبه المحقَّق في المئين التسعين يتحرّك كما لم يتحرّك
   في سنته — وهو سياقٌ لا يعطيه رقم التقلّب وحده.
   ===================================================================== */
export function hvSeries(closes, win = 20, look = 252) {
  if (!Array.isArray(closes) || closes.length < win + 12) return null;
  const out = [];
  // نافذةٌ متدحرجة: كل نقطة تقلّبُ العشرين يوماً المنتهية عندها
  for (let i = win + 1; i <= closes.length; i++) {
    const v = realizedVol(closes.slice(0, i), win);
    if (Number.isFinite(v)) out.push(v);
  }
  return out.length >= 12 ? out.slice(-look) : null;
}

/* التقلّب الضمني عند المال: وسيط IV لأقرب سترايكين للسعر من الجانبين.
   أخذُ عقد واحد يجعل الرقم رهينة عقد شاذ. */
export function atmIV(calls, puts, spot) {
  const near = [...calls, ...puts]
    .filter(c => Number.isFinite(c.strike) && Number.isFinite(c.impliedVolatility)
                 && c.impliedVolatility > 0.02 && c.impliedVolatility < 5)
    .map(c => ({ d: Math.abs(c.strike - spot), iv: c.impliedVolatility }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 4)
    .map(x => x.iv)
    .sort((a, b) => a - b);
  if (!near.length) return null;
  const m = Math.floor(near.length / 2);
  return near.length % 2 ? near[m] : (near[m - 1] + near[m]) / 2;
}

/* =====================================================================
   عائد التوزيعات ككسر.

   `divY` في fundamentals.json مخزَّن **بمقياسين مختلفين** كما يعطيه ياهو:
   أبل 0.0034 (كسر) وفيرايزون 5.5842 (نسبة مئوية). الواجهة تتعايش مع ذلك
   عبر `normPct` لأنها تعرض النسبة، أما الحساب فلا يتعايش: تمرير 5.5842
   كـ q إلى Black–Scholes يخفض السعر الآجل إلى 59% من الفوري، فيخرج
   التقلّب الضمني لفيرايزون 164% بدل 28%.

   نفس قاعدة `normPct` معكوسة، مع سقف: عائدٌ فوق 50% ليس عائداً.
   ===================================================================== */
export function divYield(f) {
  const v = f?.divY;
  if (!Number.isFinite(v) || v <= 0) return 0;
  const frac = v < 1 ? v : v / 100;
  return frac < 0.5 ? frac : 0;
}

/* نفس فكرة atmIV لكن على عقودنا بعد التقييم — حين يُستخرج التقلّب
   بأنفسنا لا يوجد حقل `impliedVolatility` نقرأه من المصدر. */
export function atmIVfrom(calls, puts, spot) {
  const near = [...calls, ...puts]
    .filter(c => Number.isFinite(c.iv) && c.iv > 0.02 && c.iv < 5)
    .sort((a, b) => Math.abs(a.k - spot) - Math.abs(b.k - spot))
    .slice(0, 4).map(c => c.iv).sort((a, b) => a - b);
  if (!near.length) return null;
  const m = Math.floor(near.length / 2);
  return near.length % 2 ? near[m] : (near[m - 1] + near[m]) / 2;
}

/* اختيار الاستحقاقات: الأقرب دائماً، ثم الأقرب إلى ثلاثين يوماً.
   الأسبوعي يكشف رهان الحدث، والشهري هو ما يتداوله أغلب الناس. */
/* `EXP_END`: ياهو يعطي تاريخ الانتهاء عند منتصف ليل UTC، والعقد يعيش
   حتى إغلاق نيويورك (~21:00 UTC). المقارنة بمنتصف الليل تُسقط استحقاق
   **اليوم** من الظهيرة فصاعداً — وهو أكثر الاستحقاقات تداولاً. وهي نفس
   إزاحة `yearsToExpiry` كي لا تختلف دالتان في تعريف «منتهٍ». */
const EXP_END = 21 * 3600 * 1000;

export function pickExpiries(list, now, want = EXPIRIES) {
  const future = (list || []).filter(e => e * 1000 + EXP_END > now).sort((a, b) => a - b);
  if (!future.length) return [];
  const out = [future[0]];
  const targets = [30, 60, 90];
  for (const tgt of targets) {
    if (out.length >= want) break;
    const best = future
      .filter(e => !out.includes(e))
      .sort((a, b) => Math.abs((a * 1000 - now) / DAY - tgt) - Math.abs((b * 1000 - now) / DAY - tgt))[0];
    if (best) out.push(best);
  }
  return out.slice(0, want).sort((a, b) => a - b);
}

/* تاريخ السلسلة يُؤخذ من عقودها لا من التاريخ المطلوب.

   ياهو يردّ بأقرب سلسلة حين لا يطابق المطلوبُ استحقاقاً قائماً، فكانت
   عقود اليوم تُلصَق بتاريخ الاثنين: العقود صحيحة (كل عقد يحمل انتهاءه)
   لكن ترويسة الاستحقاق تقول «بعد 3 أيام» وهي صفر. ومعها كل ما يُحسب
   على مستوى الاستحقاق — الحركة المتوقّعة واحتمال الربح في باني
   الاستراتيجيات — يُحسب بزمنٍ يفوق الحقيقي ثلاثة أضعاف. */
function asChain(requested, res) {
  const exps = [...new Set([...(res.calls || []), ...(res.puts || [])]
    .map(c => c.expiration).filter(Number.isFinite))];
  return { e: exps.length === 1 ? exps[0] : requested, calls: res.calls, puts: res.puts };
}

async function buildSymbol(meta, now, r, fund) {
  const sym = meta.s;
  const first = await fetchOptions(sym);
  const spot = first.spot;
  if (!(spot > 0)) throw new Error("لا سعر للأصل");
  const q = divYield(fund);

  const exps = pickExpiries(first.expirations, now);
  const chains = [];
  for (const e of exps) {
    // النداء الأول جاء بأقرب استحقاق أصلاً — لا نعيد طلبه
    if (chains.length === 0 && first.calls.length && exps[0] === e) {
      chains.push(asChain(e, first));
      continue;
    }
    try {
      const c = await fetchOptions(sym, e);
      chains.push(asChain(e, c));
    } catch (err) { /* استحقاق واحد سقط — البقية تكفي */ }
  }
  if (!chains.length) throw new Error("لا سلاسل");

  // وضع التسعير يُقرأ من البيانات لا من ساعة الحائط: ياهو يصفّر العرض
  // والطلب والتقلّب الضمني خارج الجلسة، فوجودها هو الدليل الوحيد.
  const mode = chainMode([...chains[0].calls, ...chains[0].puts]);

  const out = { s: sym, ar: meta.ar, en: meta.en, spot: r2(spot), r: r4(r), q: r4(q),
                updated: now, mode, exp: [] };
  const allCalls = [], allPuts = [];
  const pcAll = { cv: 0, pv: 0, co: 0, po: 0 };

  for (const ch of chains) {
    const side = (raw, type) => {
      const kept = raw.filter(c => liquid(c, FILTER, mode, now));
      const ev = kept.map(c => evaluate(c, { spot, r, q, type, now, mode })).filter(Boolean);
      // نُبقي الأقرب إلى السعر: الأطراف البعيدة لا تُقرأ ولا تُتداول
      return ev.sort((a, b) => Math.abs(a.k - spot) - Math.abs(b.k - spot)).slice(0, KEEP_PER_SIDE);
    };
    const calls = side(ch.calls, "call");
    const puts = side(ch.puts, "put");
    allCalls.push(...calls); allPuts.push(...puts);
    // المقاييس البنيوية تُقاس على السلسلة **الخام** لا على المرشَّحة
    // سيولةً: أطراف السلسلة حيث تتراكم المراكز الكبيرة، وحذفها يزيح
    // أقصى الألم والجدران معاً
    const pc = putCall(ch.calls, ch.puts);
    const wl = walls(ch.calls, ch.puts);
    pcAll.cv += pc.cv; pcAll.pv += pc.pv; pcAll.co += pc.co; pcAll.po += pc.po;

    out.exp.push({
      e: ch.e,
      days: Math.round(yearsToExpiry(ch.e, now) * 365),
      // الزمن بالسنوات بدقّةٍ كاملة إلى جانب الأيام المقرَّبة: عقد اليوم
      // `days` صفر، وقسمةُ أي احتمالٍ على صفرٍ تُسقط الحساب — بينما زمنه
      // الحقيقي ساعات. ستّ خانات تكفي لساعةٍ واحدة (0.000114)
      t: Math.round(yearsToExpiry(ch.e, now) * 1e6) / 1e6,
      // والسوق مغلق يأتي التقلّب من عقودنا المستخرَجة لا من حقل مصفَّر
      iv: r4(mode === "live" ? atmIV(ch.calls, ch.puts, spot) : atmIVfrom(calls, puts, spot)),
      mp: r2(maxPain(ch.calls, ch.puts)),
      pc: { v: r2(pc.vol), o: r2(pc.oi) },
      wl: { c: wl.call, p: wl.put },
      em: expectedMove(calls, puts, spot),
      gx: gammaByStrike(calls, puts, spot),
      calls: calls.sort((a, b) => a.k - b.k),
      puts: puts.sort((a, b) => a.k - b.k)
    });
  }

  // التقلّب المحقَّق من شمعاتنا — بلا طلب إضافي
  const d1 = readJSON(path.join(OUT, "sym", `${sym}.json`))?.tf?.["1d"]?.c;
  const closes = Array.isArray(d1) ? d1.map(x => Array.isArray(x) ? x[4] : x.c) : null;
  out.hv20 = r4(realizedVol(closes, 20));
  // رتبة المحقَّق: موضع تقلّب اليوم من سنته. العتبة اثنتا عشرة نقطة لا
  // عشرون — السلسلة هنا مشتقّة من شمعاتنا ونملك 260 منها، فالنقص يعني
  // رمزاً جديداً لا عيّنة قصيرة
  const hvs = hvSeries(closes);
  out.hvR = (hvs && out.hv20) ? ivRank(hvs, out.hv20, 12) : null;
  // نسبة البوت إلى الكول على الاستحقاقات كلها
  out.pc = { v: pcAll.cv > 0 ? r2(pcAll.pv / pcAll.cv) : null,
             o: pcAll.co > 0 ? r2(pcAll.po / pcAll.co) : null,
             cv: pcAll.cv, pv: pcAll.pv, co: pcAll.co, po: pcAll.po };
  // التقلّب الضمني المُقارَن يُؤخذ من الاستحقاق الأقرب إلى ثلاثين يوماً لا
  // من أقرب استحقاق مطلقاً: عقد اليوم الواحد تقلّبه الضمني منتفخ بطبيعته
  // (48% مقابل 26% للشهري على أبل)، فمقارنته بتقلّب محقَّق لعشرين يوماً
  // تجعل كل سهم يبدو "غالي العقود".
  out.ivAtm = out.exp
    .filter(x => Number.isFinite(x.iv))
    .sort((a, b) => Math.abs(a.days - 30) - Math.abs(b.days - 30))[0]?.iv ?? null;
  // نسبة الضمني إلى المحقَّق: فوق الواحد = العقود أغلى من حركة السهم
  out.ivHv = (out.ivAtm && out.hv20) ? r2(out.ivAtm / out.hv20) : null;

  /* الأرباح مقابل ما يسعّره السوق لها.

     الرقم الذي يسأل عنه متداول العقود قبل الأرباح ليس «متى» بل «كم
     يتوقّع السوق أن يتحرّك». والجواب في ستراد أول استحقاق **يغطّي**
     التاريخ: استحقاقٌ ينتهي قبل الإعلان لا يسعّره أصلاً، فحركته
     المتوقّعة تصف أسبوعاً عادياً وتُقرأ خطأً على أنها حركة الأرباح. */
  const eAt = fund && fund.earnings && fund.earnings.at;
  if (Number.isFinite(eAt) && eAt > now) {
    const dTo = Math.round((eAt - now) / DAY);
    const cov = out.exp.find(x => x.days >= dTo) || null;
    out.er = { at: eAt, days: dTo, est: !!fund.earnings.estimated,
               em: cov ? cov.em : null, tf: cov ? cov.days : null };
  } else out.er = null;

  out.bestCalls = rank(allCalls, PROB_BAND, 3);
  out.bestPuts = rank(allPuts, PROB_BAND, 3);
  out.n = allCalls.length + allPuts.length;

  // أقوى نشاط غير معتاد في السلسلة كلها، مع جانبه: كول أم بوت.
  // الجانب هو المعلومة — نشاط على البوت ليس نشاطاً على الكول.
  //
  // ونستبعد ما ينتهي خلال أيام: عقدٌ يبقى له يوم واحد حجمُه يفوق مراكزه
  // القائمة بطبيعته (المراكز تُغلق قبل الانتهاء)، فتصدّرت القائمةَ كلُّها
  // عقودُ الغد بنسب 25–50 ضعفاً — تحيّز بنيوي لا إشارة. ما يبقى له أسبوع
  // فأكثر يعني تموضعاً فعلياً.
  const withFlow = [...allCalls.map(c => ({ ...c, side: "call" })),
                    ...allPuts.map(c => ({ ...c, side: "put" }))]
    .filter(c => c.days >= FLOW.minDays && Number.isFinite(c.vx) && c.vx >= FLOW.high)
    .sort((a, b) => b.vx - a.vx);
  const top = withFlow[0];
  out.flow = top ? { side: top.side, k: top.k, exp: top.exp, days: top.days,
                     vx: top.vx, vol: top.vol, oi: top.oi,
                     lbl: flowLabel(top.vx)?.ar || null } : null;
  return out;
}

async function main() {
  const now = Date.now();
  fs.mkdirSync(OUT, { recursive: true });

  const ranking = readJSON(path.join(OUT, "ranking.json"));
  const universe = cfg.symbols;
  const core = ranking?.top?.length
    ? universe.filter(u => ranking.top.includes(u.s))
    : universe.slice(0, cfg.top);

  // الطبقة الواسعة بالتدوير: الأقدم عقوداً أولاً، بسقف لكل تشغيل.
  // عمرُ عقود كل رمز محفوظ في options.json فلا نقرأ 500 ملف لنعرفه.
  const prev = readJSON(path.join(OUT, "options.json"))?.rows || [];
  const age = new Map(prev.map(r => [r.s, r.updated || 0]));
  const wideDue = (cfg.wide || [])
    .filter(m => (now - (age.get(m.s) ?? 0)) >= WIDE_MAX_AGE)
    .sort((a, b) => (age.get(a.s) ?? 0) - (age.get(b.s) ?? 0))
    .slice(0, WIDE_PER_RUN);

  const chosen = [...core, ...wideDue];
  const fund = readJSON(path.join(OUT, "fundamentals.json"))?.f || {};

  console.log(`▶ خيارات ${core.length} أساسياً + ${wideDue.length} من الطبقة الواسعة · ${EXPIRIES} استحقاقاً لكل رمز …`);
  const r = await riskFreeRate();
  console.log(`  المعدّل الخالي من المخاطر: ${(r * 100).toFixed(2)}%`);

  const results = await pool(chosen, 3, (m) => buildSymbol(m, now, r, fund[m.s]));
  const ok = [], failed = [];
  results.forEach((res, i) => {
    if (res.ok) ok.push(res.value);
    else failed.push({ s: chosen[i].s, error: res.error });
  });
  if (failed.length) console.warn(`  ⚠ سقط ${failed.length}: ${failed.slice(0, 3).map(f => f.s + " (" + f.error + ")").join(" · ")}`);
  // بوابة السلامة: لا نكتب فوق ملفات سليمة حين يسقط المصدر كلياً
  if (!ok.length) throw new Error("لم ينجح أي رمز — لن نكتب فوق البيانات السليمة");

  let bytes = 0;
  for (const o of ok) bytes += writeJSON(`options/${o.s}.json`, o);

  /* تاريخ التقلّب الضمني — نقطةٌ واحدة لكل رمز في اليوم الواحد.

     الدورة نصف ساعة، فالكتابة في كل تشغيل تعطي ستّ عشرة نقطة تصف نفس
     اليوم: «رتبة سنة» تصير عندها رتبة ستة عشر يوماً بينما يقول العدّاد
     252. اليوم هو الوحدة، وآخر قراءة فيه تغلب — فهي أقرب إلى الإغلاق. */
  const day = Math.floor(now / 86400e3);
  const hist = readJSON(path.join(OUT, "ivhist.json"), null) || { keep: IV_KEEP, h: {} };
  if (!hist.h) hist.h = {};
  for (const o of ok) {
    if (!Number.isFinite(o.ivAtm)) continue;
    const arr = hist.h[o.s] || (hist.h[o.s] = []);
    const last = arr[arr.length - 1];
    // بالألف كعدد صحيح: 0.3363 → 336. الدقة كافية لرتبةٍ مئوية،
    // والكسور العشرية تضاعف حجم ملفٍ يحمل مئة ألف رقم
    const v = Math.round(o.ivAtm * 1000);
    if (last && last[0] === day) last[1] = v; else arr.push([day, v]);
    if (arr.length > IV_KEEP) arr.splice(0, arr.length - IV_KEEP);
  }
  hist.updated = now; hist.keep = IV_KEEP;

  const ivR = (sym, iv) => {
    const arr = hist.h[sym];
    return (arr && Number.isFinite(iv)) ? ivRank(arr.map(x => x[1] / 1000), iv, 20) : null;
  };

  // الملخّص: أفضل عقد لكل جانب + قراءة غلاء العقود، بلا السلاسل
  const fresh = ok.map(o => ({
    s: o.s, ar: o.ar, en: o.en, spot: o.spot, updated: o.updated,
    ivAtm: o.ivAtm, hv20: o.hv20, ivHv: o.ivHv,
    // رتبتان لا واحدة: الضمنية تحتاج تاريخاً نبنيه من اليوم، والمحقَّقة
    // متاحة الآن من شمعاتنا. عرضُ الثانية بينما الأولى تُبنى أصدق من
    // إخفاء القسم شهراً
    ivR: ivR(o.s, o.ivAtm), hvR: o.hvR || null, pc: o.pc || null, er: o.er || null,
    // أقرب استحقاق له مقاييس بنيوية: تُقرأ في القائمة بلا فتح ملف الرمز
    nx: o.exp?.[0] ? { days: o.exp[0].days, mp: o.exp[0].mp,
                       em: o.exp[0].em, pc: o.exp[0].pc } : null,
    call: o.bestCalls[0] || null, put: o.bestPuts[0] || null, n: o.n,
    // أقوى نشاط غير معتاد في سلسلة الرمز — يجعل الملخّص قابلاً للفرز عليه
    flow: o.flow || null
  }));

  // تراكمي كـ wide.json: كل تشغيل يجدّد حصّته ويدمجها فوق القديم، وإلا
  // خرج الملف بحصّة التشغيل الأخير وحدها واختفت بقية الرموز من الواجهة
  const merged = new Map(prev.map(r => [r.s, r]));
  for (const r of fresh) merged.set(r.s, r);
  const rows = [...merged.values()].sort((a, b) => (b.ivHv ?? 0) - (a.ivHv ?? 0));
  if (rows.length < prev.length)
    throw new Error(`ملخّص العقود تقلّص ${prev.length}→${rows.length} — لن نكتب`);

  /* قراءة السوق من سوق العقود نفسه — لا من الأسهم.

     نسبة البوت إلى الكول تُجمع بالأعداد لا بمتوسط النسب: متوسّطُ نسبٍ
     يعطي رمزاً حجمه مئة عقد وزنَ رمزٍ حجمه مئة ألف. */
  const agg = rows.reduce((a, x) => {
    if (x.pc) { a.cv += x.pc.cv || 0; a.pv += x.pc.pv || 0; a.co += x.pc.co || 0; a.po += x.pc.po || 0; a.nPc++; }
    if (Number.isFinite(x.ivHv)) { a.iv.push(x.ivHv); if (x.ivHv >= 1.3) a.rich++; else if (x.ivHv <= 0.8) a.cheap++; }
    if (x.flow) { a.flow++; if (x.flow.side === "call") a.flowC++; else a.flowP++; }
    return a;
  }, { cv: 0, pv: 0, co: 0, po: 0, nPc: 0, iv: [], rich: 0, cheap: 0, flow: 0, flowC: 0, flowP: 0 });
  // الوسيط لا المتوسط: رمزٌ واحد نسبته 6× يزيح المتوسط ولا يزيح الوسيط
  const median = (a) => { if (!a.length) return null; const q = [...a].sort((x, y) => x - y);
    const m = q.length >> 1; return q.length % 2 ? q[m] : (q[m - 1] + q[m]) / 2; };
  const mkt = {
    n: agg.nPc,
    pcv: agg.cv > 0 ? r2(agg.pv / agg.cv) : null,
    pco: agg.co > 0 ? r2(agg.po / agg.co) : null,
    vol: agg.cv + agg.pv, oi: agg.co + agg.po,
    ivHvMed: r2(median(agg.iv)), rich: agg.rich, cheap: agg.cheap, ivN: agg.iv.length,
    flow: agg.flow, flowC: agg.flowC, flowP: agg.flowP
  };

  bytes += writeJSON("ivhist.json", hist);
  bytes += writeJSON("options.json", {
    updated: now, count: rows.length, r: r4(r),
    band: PROB_BAND, filter: FILTER, flow: FLOW, mkt, ivKeep: IV_KEEP, rows
  });

  const prevMeta = readJSON(path.join(OUT, "meta.json"), {});
  writeJSON("meta.json", {
    ...prevMeta, optionsUpdated: now,
    optionsRun: { at: new Date(now).toISOString(), ok: ok.length, of: chosen.length,
                  failed: failed.map(f => f.s), contracts: rows.reduce((a, x) => a + x.n, 0),
                  requests: stats.requests }
  });

  const flowN = rows.filter(x => x.flow).length;
  console.log(`✔ ${ok.length} / ${chosen.length} رمزاً · ${rows.length} في الملخّص · ${fresh.reduce((a, x) => a + x.n, 0)} عقداً سائلاً · ${(bytes / 1024).toFixed(0)} ك.ب`);
  if (flowN) console.log(`  نشاط غير معتاد على ${flowN} رمزاً`);
  console.log(`  بوت/كول ${mkt.pcv ?? "—"} حجماً و${mkt.pco ?? "—"} مراكزَ · وسيط ضمني/محقَّق ${mkt.ivHvMed ?? "—"}`);
  const ivDays = Math.max(0, ...Object.values(hist.h).map(a => a.length));
  console.log(`  تاريخ التقلّب الضمني: ${Object.keys(hist.h).length} رمزاً · أطولها ${ivDays} يوماً من ${IV_KEEP}`);
  console.log(`  طلبات: ${stats.requests} · إخفاقات: ${stats.failures}`);
  return 0;
}

/* ---------- فحص ذاتي بلا شبكة ---------- */
function selfCheck() {
  console.log("▶ فحص ذاتي (بلا شبكة)\n");
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; } };
  const near = (a, b, tol, m) => { if (!(Math.abs(a - b) <= tol)) throw new Error(`${m}: ${a} ≠ ${b} (±${tol})`); };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

  t("erf يطابق قيماً مرجعية", () => {
    near(erf(0), 0, 1e-9, "erf(0)");
    near(erf(1), 0.8427007929, 1.5e-7, "erf(1)");
    near(erf(2), 0.9953222650, 1.5e-7, "erf(2)");
    near(erf(-1), -0.8427007929, 1.5e-7, "erf(-1)");
  });

  t("N(x) توزيع طبيعي تراكمي صحيح", () => {
    near(N(0), 0.5, 1e-9, "N(0)");
    near(N(1), 0.8413447461, 1e-7, "N(1)");
    near(N(-1), 0.1586552539, 1e-7, "N(-1)");
    near(N(1.96), 0.9750021049, 1e-7, "N(1.96)");
    // التناظر N(x)+N(−x)=1 بدقّة تقريب A&S نفسه (~1.5e-7) لا أدقّ
    for (const x of [0.4, 1.3, 2.7]) near(N(x) + N(-x), 1, 2e-7, `تناظر عند ${x}`);
  });

  // المرجع الكلاسيكي: S=K=100, T=1, r=5%, σ=20% → كول 10.4506، بوت 5.5735
  t("Black–Scholes يطابق المثال المرجعي", () => {
    const c = bs({ S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2, type: "call" });
    const p = bs({ S: 100, K: 100, T: 1, r: 0.05, sigma: 0.2, type: "put" });
    near(c.price, 10.4506, 1e-3, "سعر الكول");
    near(p.price, 5.5735, 1e-3, "سعر البوت");
    near(c.delta, 0.6368, 1e-3, "دلتا الكول");
    near(p.delta, -0.3632, 1e-3, "دلتا البوت");
    near(c.gamma, 0.018762, 1e-5, "جاما");
    near(c.vega / 100, 0.37524, 1e-4, "فيغا لكل 1%");
  });

  t("تكافؤ الكول والبوت محفوظ", () => {
    const a = { S: 123, K: 110, T: 0.6, r: 0.03, q: 0.01, sigma: 0.35 };
    const c = bs({ ...a, type: "call" }), p = bs({ ...a, type: "put" });
    const lhs = c.price - p.price;
    const rhs = a.S * Math.exp(-a.q * a.T) - a.K * Math.exp(-a.r * a.T);
    near(lhs, rhs, 1e-8, "C − P = S·e^{−qT} − K·e^{−rT}");
  });

  t("دلتا عند المال تقارب النصف والجاما موجبة دائماً", () => {
    const c = bs({ S: 100, K: 100, T: 1 / 365 / 24, r: 0, sigma: 0.2, type: "call" });
    near(c.delta, 0.5, 5e-3, "دلتا عند المال");
    for (const type of ["call", "put"]) {
      const g = bs({ S: 80, K: 100, T: 0.3, r: 0.04, sigma: 0.4, type }).gamma;
      if (!(g > 0)) throw new Error(`جاما ${type} = ${g}`);
    }
  });

  t("احتمال داخل المال بين صفر وواحد ومتكامل بين الجانبين", () => {
    const a = { S: 100, K: 105, T: 0.25, r: 0.04, sigma: 0.3 };
    const c = bs({ ...a, type: "call" }), p = bs({ ...a, type: "put" });
    near(c.probITM + p.probITM, 1, 1e-9, "مجموع الاحتمالين");
    if (!(c.probITM > 0 && c.probITM < 1)) throw new Error(String(c.probITM));
  });

  t("مدخلات فاسدة تعيد null لا رقماً", () => {
    eq(bs({ S: 0, K: 100, T: 1, sigma: 0.2 }), null, "سعر صفر");
    eq(bs({ S: 100, K: 100, T: 0, sigma: 0.2 }), null, "زمن صفر");
    eq(bs({ S: 100, K: 100, T: 1, sigma: 0 }), null, "تقلّب صفر");
  });

  t("liquid يرفض العقود الميتة (وضع مفتوح)", () => {
    // هذا بالضبط شكل أول عقد جاء من ياهو في الاختبار الفعلي
    eq(liquid({ openInterest: 0, bid: 0, ask: 0, impliedVolatility: 0.00001 }), false, "عقد ميت");
    eq(liquid({ openInterest: 500, bid: 0, ask: 2, impliedVolatility: 0.3 }), false, "بلا مشترٍ");
    eq(liquid({ openInterest: 10, bid: 1, ask: 1.1, impliedVolatility: 0.3 }), false, "فائدة مفتوحة ضعيفة");
    eq(liquid({ openInterest: 500, bid: 1, ask: 3, impliedVolatility: 0.3 }), false, "فرق عرض/طلب واسع");
    eq(liquid({ openInterest: 500, bid: 1, ask: 1.1, impliedVolatility: 0.3 }), true, "عقد سليم");
  });

  t("chainMode يكشف السوق المغلق من صفرية العرض والطلب", () => {
    // الشكل الحقيقي خارج الجلسة: ياهو يصفّر bid/ask/IV ويُبقي lastPrice
    const dead = { bid: 0, ask: 0, impliedVolatility: 0, lastPrice: 6.75, openInterest: 933 };
    const quoted = { bid: 6.7, ask: 6.8, impliedVolatility: 0.31, lastPrice: 6.75, openInterest: 933 };
    eq(chainMode([dead, dead, dead]), "last", "مغلق");
    eq(chainMode([quoted, quoted, quoted]), "live", "مفتوح");
    eq(chainMode([]), "last", "سلسلة فارغة");
    // بقايا عرض وطلب على عقدين من عشرين لا تجعل السلسلة لحظية — هذا
    // بالضبط ما أفرغ سلسلتَي PANW وCRM من كل عقودهما
    eq(chainMode([quoted, quoted, ...Array(18).fill(dead)]), "last", "أقلية مسعَّرة");
  });

  t("الوضع المغلق يقيس الزمن من لحظة السعر لا من الآن", () => {
    const now = Date.UTC(2026, 8, 8, 11);
    const exp = Math.floor(Date.UTC(2026, 8, 11) / 1000);
    const traded = Math.floor(Date.UTC(2026, 8, 4, 19, 59) / 1000);   // إغلاق الجمعة
    const raw = { strike: 50, bid: 0, ask: 0, impliedVolatility: 0, lastPrice: 0.6,
                  lastTradeDate: traded, openInterest: 2170, volume: 10, expiration: exp };
    const e = evaluate(raw, { spot: 50.14, r: 0.0376, q: 0, type: "call", now, mode: "last" });
    // فيرايزون سهم هادئ: تقلّبه المحقَّق ~16%، فالضمني قربه لا 80%
    if (!(e.iv > 0.12 && e.iv < 0.30)) throw new Error(`تقلّب غير معقول: ${e.iv}`);
    // والخطأ الذي أُصلح: قياس الزمن من "الآن" يضخّمه بجذر نسبة الزمنين
    const wrong = impliedVol(0.6, { S: 50.14, K: 50, T: yearsToExpiry(exp, now), r: 0.0376, type: "call" });
    if (!(wrong > e.iv * 1.4)) throw new Error(`القياس الخاطئ ${wrong} لا يفوق الصحيح ${e.iv}`);
    eq(e.days, 3, "الأيام المعروضة من الآن");
  });

  t("liquid في الوضع المغلق يشترط صفقة حديثة لا عرضاً وطلباً", () => {
    const now = Date.UTC(2026, 8, 8, 11);
    const c = (ageDays, extra = {}) => ({
      openInterest: 933, bid: 0, ask: 0, impliedVolatility: 0, lastPrice: 6.75,
      lastTradeDate: Math.floor((now - ageDays * DAY) / 1000), ...extra
    });
    eq(liquid(c(3), FILTER, "last", now), true, "صفقة الجمعة مقبولة الاثنين");
    eq(liquid(c(9), FILTER, "last", now), false, "صفقة عمرها تسعة أيام مرفوضة");
    eq(liquid(c(1, { lastPrice: 0 }), FILTER, "last", now), false, "بلا سعر");
    eq(liquid(c(1, { openInterest: 3 }), FILTER, "last", now), false, "فائدة مفتوحة ضعيفة");
  });

  t("impliedVol يعكس Black–Scholes بدقّة", () => {
    for (const a of [
      { S: 100, K: 100, T: 1, r: 0.05, q: 0, sigma: 0.2, type: "call" },
      { S: 320, K: 315, T: 0.02, r: 0.0376, q: 0.003, sigma: 0.45, type: "call" },
      { S: 80, K: 95, T: 0.5, r: 0.04, q: 0, sigma: 0.9, type: "put" }
    ]) {
      const px = bs(a).price;
      near(impliedVol(px, a), a.sigma, 1e-4, `عكس σ=${a.sigma}`);
    }
  });

  t("impliedVol يرفض ما لا يفسّره تقلّب موجب", () => {
    const a = { S: 100, K: 90, T: 0.5, r: 0.04, q: 0, type: "call" };
    eq(impliedVol(2, a), null, "سعر تحت القيمة الجوهرية");
    eq(impliedVol(99, a), null, "سعر فوق أي تقلّب معقول");
    eq(impliedVol(0, a), null, "سعر صفر");
  });

  t("evaluate يعمل في الوضع المغلق ويعلّم الصف بأنه غير لحظي", () => {
    const now = Date.UTC(2026, 8, 8, 11);
    const exp = Math.floor(Date.UTC(2026, 9, 16) / 1000);
    const raw = { strike: 315, bid: 0, ask: 0, impliedVolatility: 0,
                  lastPrice: 12.4, openInterest: 900, volume: 100, expiration: exp };
    const e = evaluate(raw, { spot: 320, r: 0.0376, q: 0, type: "call", now, mode: "last" });
    if (!e) throw new Error("أعاد null");
    eq(e.live, false, "معلَّم كغير لحظي");
    eq([e.bid, e.ask, e.spread], [null, null, null], "لا عرض ولا طلب مفبركين");
    if (!(e.iv > 0.05 && e.iv < 2)) throw new Error(`تقلّب غير معقول: ${e.iv}`);
    if (!(e.probITM > 0 && e.probITM < 1)) throw new Error(`احتمال: ${e.probITM}`);
    near(e.be, 327.4, 1e-6, "نقطة التعادل = السترايك + القسط");
  });

  t("yearsToExpiry يعطي أرضية موجبة ولا يعطي سالباً", () => {
    const now = Date.UTC(2026, 0, 10, 12);
    const later = Math.floor(Date.UTC(2026, 0, 17) / 1000);
    near(yearsToExpiry(later, now) * 365, 7.375, 0.02, "سبعة أيام");
    if (!(yearsToExpiry(Math.floor(now / 1000) - 86400 * 30, now) > 0)) throw new Error("انتهى → يجب أن يبقى موجباً");
  });

  t("pickExpiries تأخذ الأقرب ثم ما يقارب ثلاثين يوماً", () => {
    const now = Date.UTC(2026, 0, 1);
    const d = (n) => Math.floor((now + n * DAY) / 1000);
    const list = [d(-5), d(3), d(10), d(28), d(35), d(120)];
    eq(pickExpiries(list, now, 2), [d(3), d(28)], "استحقاقان");
    eq(pickExpiries(list, now, 1), [d(3)], "واحد");
    eq(pickExpiries([d(-9)], now, 2), [], "كلها منتهية");
  });

  t("استحقاق اليوم لا يسقط بعد منتصف الليل", () => {
    // 2026-09-11 ظهراً بتوقيت UTC، واستحقاق اليوم مختومٌ بمنتصف ليله
    const noon = Date.UTC(2026, 8, 11, 12);
    const today = Math.floor(Date.UTC(2026, 8, 11) / 1000);
    const next = Math.floor(Date.UTC(2026, 8, 14) / 1000);
    eq(pickExpiries([today, next], noon, 1), [today], "0DTE هو الأقرب لا التالي");
    // وبعد الإغلاق (21:00 UTC) يسقط فعلاً
    eq(pickExpiries([today, next], Date.UTC(2026, 8, 11, 21, 30), 1), [next], "بعد الإغلاق");
  });

  t("asChain يأخذ التاريخ من العقود لا من المطلوب", () => {
    const exp = Math.floor(Date.UTC(2026, 8, 11) / 1000);
    const asked = Math.floor(Date.UTC(2026, 8, 14) / 1000);
    // ياهو ردّ بسلسلة اليوم على طلب الاثنين
    eq(asChain(asked, { calls: [{ expiration: exp }], puts: [{ expiration: exp }] }).e, exp,
       "التاريخ من العقود");
    // تاريخان في الردّ الواحد لا يُصدَّقان — نُبقي المطلوب
    eq(asChain(asked, { calls: [{ expiration: exp }], puts: [{ expiration: asked }] }).e, asked,
       "ردٌّ مختلط يبقى على المطلوب");
    eq(asChain(asked, { calls: [], puts: [] }).e, asked, "ردٌّ فارغ");
  });

  t("realizedVol يقيس تقلّباً معروفاً", () => {
    // سلسلة ثابتة النمو = تقلّب صفر
    const flat = Array.from({ length: 40 }, (_, i) => 100 * Math.pow(1.001, i));
    near(realizedVol(flat, 20), 0, 1e-9, "نمو ثابت");
    eq(realizedVol([1, 2, 3], 20), null, "بيانات أقصر من النافذة");
  });

  t("atmIV يأخذ الوسيط قرب السعر لا عقداً شاذاً", () => {
    const calls = [
      { strike: 100, impliedVolatility: 0.30 },
      { strike: 101, impliedVolatility: 0.32 },
      { strike: 400, impliedVolatility: 4.9 }        // عقد بعيد شاذ
    ];
    const puts = [{ strike: 99, impliedVolatility: 0.31 }, { strike: 98, impliedVolatility: 0.33 }];
    near(atmIV(calls, puts, 100), 0.315, 1e-9, "وسيط الأربعة الأقرب");
  });

  t("divYield يوحّد مقياسَي عائد التوزيعات", () => {
    // القيمتان حقيقيتان من fundamentals.json: أبل كسر وفيرايزون مئوية
    near(divYield({ divY: 0.0034 }), 0.0034, 1e-12, "أبل كسر");
    near(divYield({ divY: 5.5842 }), 0.055842, 1e-12, "فيرايزون مئوية");
    eq([divYield({}), divYield({ divY: 0 }), divYield({ divY: -1 }), divYield(null)], [0, 0, 0, 0], "غائب أو سالب");
    eq(divYield({ divY: 90 }), 0, "عائد 90% ليس عائداً");
  });

  t("عائد التوزيعات بالمقياس الخاطئ كان يقلب التقلّب الضمني", () => {
    const a = { S: 50.14, K: 51, T: 0.0966, r: 0.0376, type: "call" };
    const right = impliedVol(1.41, { ...a, q: divYield({ divY: 5.5842 }) });
    const wrong = impliedVol(1.41, { ...a, q: 5.5842 });
    if (!(right > 0.2 && right < 0.4)) throw new Error(`الصحيح غير معقول: ${right}`);
    if (!(wrong > 1)) throw new Error(`الخاطئ يُفترض أن ينفجر: ${wrong}`);
  });

  t("flowRatio يقيس حجم اليوم مقابل المراكز القائمة", () => {
    near(flowRatio({ volume: 900, openInterest: 300 }), 3, 1e-12, "ثلاثة أضعاف");
    eq(flowRatio({ volume: 100, openInterest: 0 }), null, "بلا مراكز قائمة");
    eq(flowRatio({ volume: null, openInterest: 500 }), null, "بلا حجم");
    eq(flowRatio({}), null, "بلا حقول");
  });

  t("flowLabel يميّز غير المعتاد عن الاستثنائي", () => {
    eq(flowLabel(0.4), null, "نشاط عادي");
    eq(flowLabel(1.2).k, "high", "غير معتاد");
    eq(flowLabel(5).k, "extreme", "استثنائي");
    eq(flowLabel(null), null, "بلا قيمة");
    // الحدّان بالضبط
    eq(flowLabel(FLOW.high).k, "high", "عند الحد");
    eq(flowLabel(FLOW.extreme).k, "extreme", "عند الحد الأعلى");
  });

  t("evaluate يُرفق نسبة النشاط بالعقد", () => {
    const now = Date.UTC(2026, 8, 8, 11);
    const exp = Math.floor(Date.UTC(2026, 9, 16) / 1000);
    const e = evaluate({ strike: 315, bid: 3, ask: 3.1, impliedVolatility: 0.3,
                         lastPrice: 3.05, openInterest: 200, volume: 800, expiration: exp },
                       { spot: 320, r: 0.04, q: 0, type: "call", now, mode: "live" });
    near(e.vx, 4, 1e-9, "حجم أربعة أضعاف المراكز");
  });

  t("rank يحترم نطاق الاحتمال ويرتّب حسب التعرّض للدولار", () => {
    const mk = (probITM, eff) => ({ probITM, eff });
    const r = rank([mk(0.9, 9), mk(0.4, 1), mk(0.5, 5), mk(0.05, 99)], PROB_BAND, 3);
    eq(r.map(x => x.eff), [5, 1], "المستبعدان خارج النطاق");
  });

  t("الحركة المتوقّعة للأرباح تؤخذ من استحقاقٍ يغطّيها", () => {
    // استحقاقان: أحدهما قبل الإعلان والآخر بعده. الأول لا يسعّر الحدث.
    const exp = [{ days: 3, em: { abs: 1, pct: 1 } }, { days: 31, em: { abs: 9, pct: 9 } }];
    const pick = (dTo) => (exp.find(x => x.days >= dTo) || null);
    eq(pick(10).days, 31, "أرباحٌ بعد عشرة أيام لا يغطّيها استحقاق الثلاثة");
    eq(pick(2).days, 3, "وأرباحٌ بعد يومين يغطّيها");
    eq(pick(60), null, "وأبعدُ من كل استحقاقاتنا لا يغطّيه شيء");
  });

  t("maxPain يجد السترايك الأقل دفعاً", () => {
    // كل المراكز على كول 100 وبوت 100: الألم الأقصى عندهما معاً
    const calls = [{ strike: 90, openInterest: 0 }, { strike: 100, openInterest: 1000 }, { strike: 110, openInterest: 0 }];
    const puts  = [{ strike: 90, openInterest: 0 }, { strike: 100, openInterest: 1000 }, { strike: 110, openInterest: 0 }];
    eq(maxPain(calls, puts), 100, "التقاء الجانبين");
    // مراكز الكول كلها عند 90: كل سترايك فوقها يدفع، فالأقل هو الأدنى
    eq(maxPain([{ strike: 90, openInterest: 500 }, { strike: 100, openInterest: 0 }, { strike: 110, openInterest: 0 }],
               [{ strike: 90, openInterest: 0 }, { strike: 100, openInterest: 0 }, { strike: 110, openInterest: 0 }]),
       90, "كولٌ وحده");
    eq(maxPain([{ strike: 1, openInterest: 5 }], []), null, "سترايك واحد لا يكفي");
  });

  t("putCall يجمع الأعداد لا النسب", () => {
    const c = [{ volume: 100, openInterest: 200 }, { volume: 300, openInterest: 100 }];
    const p = [{ volume: 200, openInterest: 600 }];
    const r = putCall(c, p);
    near(r.vol, 0.5, 1e-12, "200/400");
    near(r.oi, 2, 1e-12, "600/300");
    eq(putCall([], []).vol, null, "بلا كول لا نسبة");
    // حقلٌ غائب يُعدّ صفراً لا يُسقط الصفّ
    near(putCall([{ volume: 10 }], [{ volume: 5 }]).vol, 0.5, 1e-12, "بلا مراكز قائمة");
  });

  t("walls يجد أثقل سترايك على كل جانب", () => {
    const w = walls([{ strike: 100, openInterest: 50 }, { strike: 120, openInterest: 900 }],
                    [{ strike: 80, openInterest: 700 }, { strike: 90, openInterest: 30 }]);
    eq([w.call.k, w.put.k], [120, 80], "الجداران");
    eq(walls([], []), { call: null, put: null }, "سلسلة فارغة");
  });

  t("expectedMove ستراد لا خنق", () => {
    const em = expectedMove([{ k: 100, mid: 3 }], [{ k: 100, mid: 2 }], 100);
    near(em.abs, 5, 1e-12, "مجموع القسطين");
    near(em.pct, 5, 1e-12, "نسبةً إلى السعر");
    // سترايكان مختلفان: خنقٌ لا ستراد، ورقمه لا يصف الحركة المتوقّعة
    eq(expectedMove([{ k: 105, mid: 3 }], [{ k: 95, mid: 2 }], 100), null, "بلا سترايك مشترك");
    eq(expectedMove([], [], 100), null, "سلسلة فارغة");
    // أقرب **مشترك** لا أقرب لكل جانب: بوت 101 ساقط سيولةً، فالستراد
    // عند 100 لا يُردّ لأن أقرب كولٍ 101
    eq(expectedMove([{ k: 101, mid: 3 }, { k: 100, mid: 3.5 }],
                    [{ k: 100, mid: 2.5 }, { k: 95, mid: 1 }], 100.6).k, 100, "أقرب سترايك مشترك");
    // والأقرب فعلاً حين يوجد مشتركان
    eq(expectedMove([{ k: 100, mid: 3 }, { k: 105, mid: 1 }],
                    [{ k: 100, mid: 2 }, { k: 105, mid: 6 }], 104).k, 105, "الأقرب من المشتركين");
  });

  t("gammaByStrike يعدّ ولا يطرح", () => {
    const g = gammaByStrike([{ k: 100, gamma: 0.05, oi: 100 }, { k: 105, gamma: 0.03, oi: 400 }],
                            [{ k: 100, gamma: 0.04, oi: 200 }], 100);
    eq(g.map(x => x.k), [100, 105], "مرتّب بالسترايك");
    eq([g[0].c, g[0].p], [500, 800], "الجانبان منفصلان لا محصّلة");
    eq(g[1].p, 0, "جانبٌ بلا عقود يبقى صفراً لا يُحذف");
    eq(gammaByStrike([], [], 100), null, "بلا عقود");
    eq(gammaByStrike([{ k: 100, gamma: 0.05, oi: 100 }], [], 100), null, "سترايك واحد ليس توزيعاً");
  });

  t("ivRank موضعٌ في المدى ومئينٌ في التوزيع", () => {
    const h = Array.from({ length: 30 }, (_, i) => 0.2 + i * 0.01);   // 0.20 … 0.49
    const r = ivRank(h, 0.35);
    // القيم مقرَّبة لخانتين — الرتبة مئوية ولا معنى لخانة ثالثة
    near(r.rank, (0.35 - 0.20) / (0.49 - 0.20) * 100, 0.005, "الموضع في المدى");
    near(r.pct, 15 / 30 * 100, 0.005, "المئين");
    eq(r.n, 30, "حجم العيّنة");
    // عيّنة قصيرة: نعيد العدد ولا نعيد رقماً — «يُبنى» لا «صفر»
    const short = ivRank([0.2, 0.3], 0.25);
    eq([short.rank, short.pct, short.n], [null, null, 2], "أقصر من الحد الأدنى");
    eq(ivRank(null, 0.3), null, "بلا تاريخ");
  });

  t("hvSeries نافذةٌ متدحرجة لا رقمٌ واحد", () => {
    // تقلّبٌ يتصاعد: آخر نقطة يجب أن تفوق أولاها
    const cl = [];
    for (let i = 0; i < 120; i++) cl.push(100 * (1 + 0.002 * i * Math.sin(i)));
    const ser = hvSeries(cl.map(x => Math.max(1, x)));
    if (!ser || ser.length < 12) throw new Error("سلسلة قصيرة: " + (ser && ser.length));
    if (ser.some(v => !Number.isFinite(v) || v < 0)) throw new Error("قيمة غير صالحة");
    eq(hvSeries([1, 2, 3]), null, "أقصر من النافذة");
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل`);
  process.exit(fail ? 1 : 0);
}

if (CHECK) selfCheck();
else main().catch(e => { console.error("✗ فشل التشغيل:", e.message); process.exit(1); });
