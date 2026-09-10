#!/usr/bin/env node
/* =====================================================================
   المهمة اليومية: ترتيب أكبر 70 شركة بالقيمة السوقية الفعلية،
   البيانات الأساسية لكل شركة، مواعيد إعلان الأرباح، وترتيب الأعلى قيمة.

     node scripts/fetch-daily.mjs --out ./out
     node scripts/fetch-daily.mjs --check
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchSummary, fetchQuotes, pool, stats, num } from "./lib/yahoo.mjs";
import { fetchFundamentalsFinnhub, fetchRecommendation, fetchInsiders,
         summarizeInsiders, fhStats } from "./lib/finnhub.mjs";

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();

const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "stocks/symbols.json"), "utf8"));
const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
function writeJSON(rel, obj) {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}

const REC_AR = {
  strong_buy: "شراء قوي", buy: "شراء", hold: "تثبيت",
  sell: "بيع", strong_sell: "بيع قوي", underperform: "أداء أقل", outperform: "أداء أعلى"
};

/* ---------- استخراج البيانات الأساسية من quoteSummary ---------- */
export function extractFundamentals(res) {
  const sd = res?.summaryDetail || {}, ks = res?.defaultKeyStatistics || {},
        ap = res?.assetProfile || {}, ce = res?.calendarEvents || {},
        pr = res?.price || {}, fd = res?.financialData || {};

  // موعد الأرباح: Yahoo يعيد مصفوفة (أحياناً نطاقاً تقديرياً)
  let earnings = null;
  const ed = ce?.earnings?.earningsDate;
  if (Array.isArray(ed) && ed.length) {
    const t = num(ed[0]);
    if (t) earnings = { at: t * 1000, estimated: ed.length > 1 };
  }

  return {
    mc:      num(pr.marketCap) ?? num(sd.marketCap),
    pe:      num(sd.trailingPE),
    fpe:     num(sd.forwardPE),
    pb:      num(ks.priceToBook),
    eps:     num(ks.trailingEps),
    divY:    num(sd.dividendYield),          // نسبة عشرية أو مئوية حسب Yahoo — تُطبَّع عند العرض
    divRate: num(sd.dividendRate),
    beta:    num(sd.beta),
    w52h:    num(sd.fiftyTwoWeekHigh),
    w52l:    num(sd.fiftyTwoWeekLow),
    avgVol:  num(sd.averageVolume),
    shares:  num(ks.sharesOutstanding),
    margin:  num(fd.profitMargins) ?? num(ks.profitMargins),
    revGrow: num(fd.revenueGrowth),
    roe:     num(fd.returnOnEquity),
    target:  num(fd.targetMeanPrice),
    rec:     fd.recommendationKey ? (REC_AR[fd.recommendationKey] || fd.recommendationKey) : null,
    recN:    num(fd.numberOfAnalystOpinions),
    earnings,
    sector:  ap.sector || null,
    industry: ap.industry || null,
    staff:   num(ap.fullTimeEmployees),
    site:    ap.website || null,
    about:   ap.longBusinessSummary ? String(ap.longBusinessSummary).slice(0, 600) : null
  };
}

/* ---------- التشغيل ---------- */
async function main() {
  const now = Date.now();
  fs.mkdirSync(OUT, { recursive: true });
  const universe = cfg.symbols;
  console.log(`▶ المهمة اليومية على ${universe.length} رمزاً …`);

  // 1) البيانات الأساسية
  const results = await pool(universe, 4, async (m) => {
    const res = await fetchSummary(m.s);
    return { s: m.s, f: extractFundamentals(res) };
  });

  const fundamentals = {};
  const failed = [];
  results.forEach((r, i) => {
    if (r.ok && r.value.f) fundamentals[r.value.s] = r.value.f;
    else { failed.push(universe[i].s); }
  });
  console.log(`  ✓ بيانات أساسية: ${Object.keys(fundamentals).length} / ${universe.length}`);
  if (failed.length) console.warn(`  ⚠ فشل: ${failed.join(", ")}`);

  // 1ب) Finnhub بديلاً لكل رمز فشل عند Yahoo (حظر 429 غالباً من عناوين GitHub Actions)
  if (failed.length && process.env.FINNHUB_API_KEY) {
    console.log(`  … نجرّب Finnhub لـ ${failed.length} رمزاً فشلت عند Yahoo`);
    try {
      const fh = await fetchFundamentalsFinnhub(failed);
      let got = 0;
      for (const [s, f] of Object.entries(fh)) { fundamentals[s] = f; got++; }
      console.log(`  ✓ Finnhub بديل: ${got} / ${failed.length}`);
    } catch (e) { console.warn(`  ⚠ Finnhub بديل فشل: ${e.message}`); }
  }

  // 1ج) توزيع التوصيات وصفقات المطّلعين — مجانيان عند Finnhub وغائبان
  // عند ياهو. طلبان لكل رمز بحدّ 60/دقيقة، فنسلسل بوتيرة تحترمه.
  // فشلهما لا يوقف المهمة: هما إضافة على البطاقة لا أساس لها.
  if (process.env.FINNHUB_API_KEY) {
    const syms = Object.keys(fundamentals);
    console.log(`  … توصيات ومطّلعون لـ ${syms.length} رمزاً`);
    let recN = 0, insN = 0, err = null;
    for (const s of syms) {
      try { const r = await fetchRecommendation(s); if (r) { fundamentals[s].recDist = r; recN++; } }
      catch (e) { err ||= e.message; }
      await sleep(1050);
      try { const i = await fetchInsiders(s); if (i) { fundamentals[s].insider = i; insN++; } }
      catch (e) { err ||= e.message; }
      await sleep(1050);
    }
    console.log(`  ✓ توزيع التوصيات ${recN} · مطّلعون ${insN}${err ? ` (أول خطأ: ${err})` : ""}`);
  }

  // 2) القيمة السوقية — نكمل الناقص من دفعة الأسعار
  const mc = {};
  for (const [s, f] of Object.entries(fundamentals)) if (f.mc) mc[s] = f.mc;
  const missing = universe.filter(u => !mc[u.s]).map(u => u.s);
  if (missing.length) {
    console.log(`  … ${missing.length} رمزاً بلا قيمة سوقية، نجرّب دفعة الأسعار`);
    try {
      const q = await fetchQuotes(missing);
      for (const [s, v] of Object.entries(q || {})) { const m = num(v.marketCap); if (m) mc[s] = m; }
    } catch (e) { console.warn(`  ⚠ ${e.message}`); }
  }

  // 3) الترتيب — أعلى 70 بالقيمة السوقية
  const prevRank = readJSON(path.join(OUT, "ranking.json"));
  const ranked = universe.map(u => u.s).filter(s => mc[s]).sort((a, b) => mc[b] - mc[a]);
  let top;
  if (ranked.length >= cfg.top) {
    top = ranked.slice(0, cfg.top);
  } else if (prevRank?.top?.length) {
    console.warn(`  ⚠ ${ranked.length} رمزاً فقط له قيمة سوقية — نُبقي ترتيب الأمس`);
    top = prevRank.top;
  } else {
    console.warn(`  ⚠ ترتيب غير مكتمل — نستخدم ترتيب الملف المبدئي`);
    top = universe.slice(0, cfg.top).map(u => u.s);
  }
  const entered = prevRank?.top ? top.filter(s => !prevRank.top.includes(s)) : [];
  const exited  = prevRank?.top ? prevRank.top.filter(s => !top.includes(s)) : [];
  if (entered.length || exited.length)
    console.log(`  ↻ دخل: ${entered.join(", ") || "—"} · خرج: ${exited.join(", ") || "—"}`);

  writeJSON("ranking.json", { updated: now, top, mc, entered, exited });
  writeJSON("fundamentals.json", { updated: now, count: Object.keys(fundamentals).length, f: fundamentals });

  // الأخبار انتقلت إلى scripts/fetch-news.mjs: دورتها دقائق لا يوم،
  // فبقاؤها هنا كان يجعل عناوين عمرها ساعات تظهر على أنها "الآن".

  const prevMeta = readJSON(path.join(OUT, "meta.json"), {});
  writeJSON("meta.json", {
    ...prevMeta,
    dailyUpdated: now,
    dailyRun: {
      at: new Date(now).toISOString(),
      fundamentals: Object.keys(fundamentals).length,
      failed, ranked: ranked.length, entered, exited,
      requests: stats.requests, retries: stats.retries, sources: stats.sources
    }
  });

  console.log(`✔ اكتملت المهمة اليومية · أعلى 70: ${top.slice(0, 5).join(", ")} …`);
}

/* ---------- فحص ذاتي بلا شبكة ---------- */
function selfCheck() {
  console.log("▶ فحص ذاتي للمهمة اليومية (بلا شبكة)\n");
  let pass = 0, fail = 0;
  const t = (n, fn) => { try { fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n} — ${e.message}`); fail++; } };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

  t("extractFundamentals يقرأ صيغة Yahoo المتداخلة", () => {
    const f = extractFundamentals({
      summaryDetail: { trailingPE: { raw: 31.2 }, dividendYield: { raw: 0.0044 }, fiftyTwoWeekHigh: { raw: 260 }, fiftyTwoWeekLow: { raw: 164 } },
      defaultKeyStatistics: { trailingEps: { raw: 7.1 }, sharesOutstanding: { raw: 1.5e10 } },
      price: { marketCap: { raw: 3.9e12 } },
      financialData: { recommendationKey: "buy", targetMeanPrice: { raw: 275 }, numberOfAnalystOpinions: { raw: 42 } },
      calendarEvents: { earnings: { earningsDate: [{ raw: 1767225600 }, { raw: 1767398400 }] } },
      assetProfile: { sector: "Technology", fullTimeEmployees: 164000 }
    });
    eq([f.pe, f.eps, f.mc, f.w52h, f.rec, f.target], [31.2, 7.1, 3.9e12, 260, "شراء", 275], "حقول");
    eq(f.earnings, { at: 1767225600000, estimated: true }, "موعد الأرباح");
    eq(f.staff, 164000, "الموظفون");
  });

  t("extractFundamentals يعيد null لا أصفاراً عند غياب الحقول", () => {
    const f = extractFundamentals({});
    for (const k of ["pe", "eps", "mc", "divY", "target", "earnings", "sector"])
      if (f[k] !== null) throw new Error(`${k} = ${JSON.stringify(f[k])} بدل null`);
  });

  t("summarizeInsiders يستبعد المشتقات ويحسب الصافي بالأسهم", () => {
    const rows = [
      { change: 100000, isDerivative: false, transactionDate: "2026-08-01" },
      { change: -1000,  isDerivative: false, transactionDate: "2026-08-20" },
      { change: 500000, isDerivative: true,  transactionDate: "2026-08-25" },  // منحة موظف
      { change: 0,      isDerivative: false, transactionDate: "2026-08-26" }
    ];
    const r = summarizeInsiders(rows);
    eq([r.bought, r.sold, r.net, r.buys, r.sells], [100000, 1000, 99000, 1, 1], "الصافي بالأسهم");
    eq(r.last, "2026-08-20", "آخر صفقة غير مشتقّة");
  });

  t("summarizeInsiders يعيد null لا أصفاراً حين لا صفقات", () => {
    eq(summarizeInsiders([]), null, "فارغ");
    eq(summarizeInsiders(null), null, "غائب");
    eq(summarizeInsiders([{ change: 9, isDerivative: true }]), null, "مشتقات فقط");
  });

  t("منطق الترتيب يختار الأعلى قيمة سوقية", () => {
    const mc = { A: 300, B: 100, C: 500, D: 50 };
    const ranked = ["A", "B", "C", "D"].filter(s => mc[s]).sort((a, b) => mc[b] - mc[a]);
    eq(ranked.slice(0, 3), ["C", "A", "B"], "الترتيب تنازلي");
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل`);
  process.exit(fail ? 1 : 0);
}

if (CHECK) selfCheck();
else main().catch(e => { console.error("✗ فشل التشغيل:", e.message); process.exit(1); });
