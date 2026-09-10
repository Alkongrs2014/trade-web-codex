#!/usr/bin/env node
/* =====================================================================
   تحديث الأسعار وحدها — الحلقة السريعة.

   لماذا مهمة منفصلة: التشغيل الكامل يعيد جلب شمعات السبعين على ثلاثة
   فريمات، وهو ما يستغرق دقائق ويثقل المصدر. لكن ما يتغيّر كل دقيقة هو
   السعر لا الشمعة المكتملة. فصلُ الاثنين يجعل السعر يتحدّث كل دقيقتين
   بينما تبقى الشمعات والمؤشرات على دورتها العشرية.

   الحد الفعلي: Finnhub المجاني ستون طلباً في الدقيقة، وسبعون رمزاً
   تحتاج ~75 ثانية. فأسرع دورة واقعية دقيقتان لا دقيقة واحدة.

   لا تُحسب هنا أي مؤشرات: النتيجة الفنية وATR وRSI تبقى كما كتبها
   fetch-market. تحديث السعر بلا تحديث الشمعة لا يغيّرها فعلاً، وحسابها
   من سعر واحد يعطي رقماً كاذباً.

     node scripts/fetch-quotes.mjs --out ./data
     node scripts/fetch-quotes.mjs --check
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchQuotesFinnhub, fhStats } from "./lib/finnhub.mjs";
import { fetchQuotes } from "./lib/yahoo.mjs";
import { statusNow } from "./lib/session.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "stocks/symbols.json"), "utf8"));
const PREFER_YAHOO = process.env.PREFER_YAHOO === "1";

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const writeJSON = (rel, o) => fs.writeFileSync(path.join(OUT, rel), JSON.stringify(o));
const num = (v) => (typeof v === "number" && isFinite(v)) ? v : null;
const r2 = (v) => v === null ? null : Math.round(v * 100) / 100;
/* تقريب الأسعار بالأرقام المعنوية لا بالخانات العشرية: أصل بسعر
   0.0000051 (شيبا إينو) يصير صفراً بالتقريب إلى أربع خانات. نفس
   الدالة في fetch-market.mjs — أي اختلاف بينهما يجعل السعر يقفز بين
   دورة الأسعار ودورة الشمعات. */
const rp = (v) => {
  if (v === null || v === undefined || !Number.isFinite(v)) return null;
  if (v === 0) return 0;
  return Math.abs(v) >= 1 ? Math.round(v * 10000) / 10000 : Number(v.toPrecision(6));
};

/* يُعاد حسابه من نسب التغيّر الجديدة. الاتساع والنتيجة الفنية لا،
   لأنهما من الشمعات التي لم تتغيّر. */
export function recompute(rows, prevMarket) {
  // الكريبتو خارج إحصاء السوق الأمريكي — مداه اليومي أوسع بمراتب فيحتل
  // قائمتَي الرابحين والخاسرين ويزيح متوسطات القطاعات. نفس الاستبعاد في
  // fetch-market، وأي اختلاف بينهما يجعل القوائم تقفز بين الدورتين.
  // Number.isFinite لا isFinite: العالمية تحوّل null إلى صفر فتعتبره
  // "تغيّر 0%"، فيدخل سهم بلا سعر في متوسط قطاعه ويجرّه نحو الصفر
  const withChg = rows.filter(r => r.mkt !== "crypto" && Number.isFinite(r.chg));

  const bySector = {};
  for (const r of withChg) {
    (bySector[r.sec] ||= { sec: r.sec, n: 0, sum: 0 });
    bySector[r.sec].n++; bySector[r.sec].sum += r.chg;
  }
  const sectors = Object.values(bySector)
    .map(x => ({ sec: x.sec, n: x.n, avg: r2(x.sum / x.n) }))
    .sort((a, b) => b.avg - a.avg);

  const mv = (dir) => withChg.slice()
    .sort((a, b) => dir * ((b.chg ?? 0) - (a.chg ?? 0)))
    .slice(0, 5)
    .map(r => ({ s: r.s, ar: r.ar, chg: r.chg, p: r.p }));

  return { ...prevMarket, sectors, gainers: mv(1), losers: mv(-1) };
}

/* المؤشرات العامة: Finnhub المجاني يرفض رموزها (^GSPC) ويقبل صناديق
   ETF التي تتبعها. نأخذ نسبة التغيّر من الصندوق ونترك المستوى كما كان
   بدل عرض سعر الصندوق موهماً أنه مستوى المؤشر. */
export function refreshIndices(prevIdx, quotes, cfgIdx = []) {
  // market.json لا يحفظ حقل proxy إلا حين يُستعمل فعلاً، فالاعتماد عليه
  // وحده كان يترك المؤشرات مجمّدة على قيم آخر تشغيل كامل
  const proxyOf = Object.fromEntries(cfgIdx.filter(i => i.proxy).map(i => [i.s, i.proxy]));
  return (prevIdx || []).map(ix => {
    const proxy = ix.proxy || proxyOf[ix.s] || null;
    let p = num(quotes[ix.s]?.regularMarketPrice);
    let chg = num(quotes[ix.s]?.regularMarketChangePercent);
    let viaProxy = false;
    if (chg === null && proxy) {
      const pc = num(quotes[proxy]?.regularMarketChangePercent);
      if (pc !== null) { chg = pc; viaProxy = true; }
    }
    if (p === null && chg === null) return ix;              // لا جديد — أبقِ القديم
    return { ...ix, p: p === null ? ix.p : r2(p), chg: chg === null ? ix.chg : r2(chg),
             ...(viaProxy ? { proxy } : {}) };
  });
}

async function main() {
  const now = Date.now();
  const summary = readJSON(path.join(OUT, "summary.json"));
  const market = readJSON(path.join(OUT, "market.json"));
  if (!summary?.rows?.length || !market)
    throw new Error("لا يوجد ملخّص سابق — شغّل fetch-market.mjs أولاً");
  if (!PREFER_YAHOO && !process.env.FINNHUB_API_KEY)
    throw new Error("FINNHUB_API_KEY غير مضبوط — لا مصدر أسعار سريع بدونه");

  const syms = summary.rows.map(r => r.s);
  // رموز المؤشرات (‎^GSPC‎) يرفضها Finnhub المجاني دائماً، وكل طلب مرفوض
  // يستهلك من حصّة الستين في الدقيقة ويطيل الدورة بلا مقابل. نطلب
  // صناديقها البديلة وحدها.
  const extra = cfg.indices.map(i => i.proxy).filter(Boolean);

  // الطبقة الواسعة تُسعَّر مع دفعات Yahoo وحدها: 414 رمزاً إضافياً تكلّف
  // أحد عشر طلباً هناك، بينما تكلّف Finnhub 414 طلباً — سبع دقائق تكسر
  // دورة الدقيقتين. سحابياً تبقى أسعارها من جلبها اليومي.
  const wide = PREFER_YAHOO ? readJSON(path.join(OUT, "wide.json")) : null;
  const wideSyms = wide?.rows?.map(r => r.s) || [];
  console.log(`▶ أسعار ${syms.length} رمزاً${wideSyms.length ? ` + ${wideSyms.length} في الطبقة الواسعة` : ""} …`);

  // ترتيب المصدر يتبع مكان التشغيل: Yahoo يجمع 40 رمزاً في الطلب، وFinnhub
  // طلبٌ لكل رمز. محلياً Yahoo أولاً، وسحابياً Finnhub لأن Yahoo محظور.
  const want = [...syms, ...wideSyms, ...extra];
  let quotes = null, src = "";
  const tryQuotes = async (label, fn) => {
    if (quotes) return;
    try { quotes = await fn(); if (quotes) src = label; }
    catch (e) { console.warn(`  ⚠ ${label}: ${e.message}`); }
  };
  if (PREFER_YAHOO) {
    await tryQuotes("Yahoo", () => fetchQuotes(want));
    await tryQuotes("Finnhub", () => fetchQuotesFinnhub([...syms, ...extra], { pace: 1050 }));
  } else {
    await tryQuotes("Finnhub", () => fetchQuotesFinnhub([...syms, ...extra], { pace: 1050 }));
    await tryQuotes("Yahoo", () => fetchQuotes(want));
  }
  if (!quotes) throw new Error("لم يصل أي سعر — لن نكتب فوق بيانات سليمة");
  console.log(`  المصدر: ${src}`);

  const applyQuotes = (rows) => {
    let n = 0;
    for (const r of rows) {
      const q = quotes[r.s];
      if (!q) continue;
      const p = num(q.regularMarketPrice);
      if (p === null || p <= 0) continue;
      r.p = rp(p);
      const c = num(q.regularMarketChangePercent);
      if (c !== null) r.chg = r2(c);
      n++;
    }
    return n;
  };

  const hit = applyQuotes(summary.rows);
  // بوابة السلامة: تحديث جزئي جداً يعني عطلاً في المصدر لا سوقاً هادئاً
  if (hit < syms.length * 0.5)
    throw new Error(`${hit} من ${syms.length} فقط وصلت — مرفوض`);

  summary.updated = now;
  writeJSON("summary.json", summary);

  // الطبقة الواسعة: السعر وحده. `u` عمر الشمعات لا عمر السعر، فلا يُمس —
  // لمسه هنا يجعل fetch-market يظنّ يوميّها حديثاً فلا يجدّده أبداً.
  let wideHit = 0;
  if (wide?.rows?.length) {
    wideHit = applyQuotes(wide.rows);
    wide.updated = now;
    writeJSON("wide.json", wide);
  }

  const m2 = recompute(summary.rows, market);
  m2.indices = refreshIndices(market.indices, quotes, cfg.indices);
  // الفترات المحفوظة تصف يوم جلبها؛ استعمالها في اليوم التالي كان يبقي
  // الحالة "بعد الإغلاق" والسوق مفتوح
  m2.status = statusNow(market.period, now);
  m2.updated = now;
  writeJSON("market.json", m2);

  const prevMeta = readJSON(path.join(OUT, "meta.json"), {});
  writeJSON("meta.json", {
    ...prevMeta, marketUpdated: now,
    quotesRun: { at: new Date(now).toISOString(), ok: hit, of: syms.length, src,
                 wide: wideHit, wideOf: wideSyms.length, requests: fhStats.requests }
  });

  console.log(`✔ ${hit} / ${syms.length} سعراً${wideSyms.length ? ` · الواسعة ${wideHit} / ${wideSyms.length}` : ""}`);
  console.log("  الشمعات والمؤشرات الفنية لم تُمَس — تلك دورة fetch-market");
  return 0;
}

/* ---------- فحص ذاتي بلا شبكة ---------- */
function selfCheck() {
  let pass = 0, fail = 0;
  const t = (n, fn) => { try { fn(); console.log(`  ✓ ${n}`); pass++; } catch (e) { console.log(`  ✗ ${n} — ${e.message}`); fail++; } };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

  console.log("\n▶ فحص ذاتي (بلا شبكة)\n");

  t("recompute يعيد حساب القطاعات من التغيّر الجديد", () => {
    const rows = [
      { s: "A", ar: "أ", sec: "تقنية", chg: 2, p: 10 },
      { s: "B", ar: "ب", sec: "تقنية", chg: 4, p: 20 },
      { s: "C", ar: "ج", sec: "مالي",  chg: -1, p: 30 }
    ];
    const m = recompute(rows, { breadth: { up: 9 }, marketScore: 42 });
    eq(m.sectors[0], { sec: "تقنية", n: 2, avg: 3 }, "متوسط التقنية");
    eq(m.sectors[1].avg, -1, "المالي");
    eq(m.gainers[0].s, "B", "الأعلى");
    eq(m.losers[0].s, "C", "الأدنى");
    // الاتساع والنتيجة من الشمعات لا من السعر، فيجب أن يمرّا كما هما
    eq(m.breadth, { up: 9 }, "الاتساع محفوظ");
    eq(m.marketScore, 42, "النتيجة محفوظة");
  });

  t("recompute يتجاهل الصفوف بلا تغيّر", () => {
    const m = recompute([{ s: "A", sec: "x", chg: null, p: 1 }, { s: "B", sec: "x", chg: 5, p: 2 }], {});
    eq(m.sectors[0], { sec: "x", n: 1, avg: 5 }, "واحد فقط");
  });

  t("recompute يستبعد الكريبتو من إحصاء السوق الأمريكي", () => {
    const m = recompute([
      { s: "AAPL", sec: "تقنية", chg: 1, p: 100 },
      { s: "BTC-USD", sec: "كريبتو", mkt: "crypto", chg: 40, p: 90000 }
    ], {});
    eq(m.sectors.map(x => x.sec), ["تقنية"], "قطاع واحد");
    eq(m.gainers.map(x => x.s), ["AAPL"], "بيتكوين لا يتصدّر الرابحين");
  });

  t("refreshIndices يستعمل الصندوق البديل للنسبة ويُبقي المستوى", () => {
    const prev = [{ s: "^GSPC", ar: "إس آند بي", p: 7000, chg: 0.5, proxy: "SPY" }];
    const out = refreshIndices(prev, { SPY: { regularMarketChangePercent: 1.25 } });
    eq(out[0].chg, 1.25, "النسبة من الصندوق");
    eq(out[0].p, 7000, "المستوى لم يُستبدل بسعر الصندوق");
  });

  t("refreshIndices يُبقي القديم حين لا يصل شيء", () => {
    const prev = [{ s: "^VIX", p: 15.5, chg: -2 }];
    eq(refreshIndices(prev, {}), prev, "بلا تغيير");
  });

  t("refreshIndices يجد البديل من الإعدادات لا من الملف المحفوظ", () => {
    // market.json لا يحفظ proxy إلا حين استُعمل، فبدونه كانت المؤشرات تتجمّد
    const prev = [{ s: "^DJI", ar: "داو", p: 53000, chg: 0.4 }];
    const out = refreshIndices(prev, { DIA: { regularMarketChangePercent: -0.9 } },
                               [{ s: "^DJI", proxy: "DIA" }]);
    eq(out[0].chg, -0.9, "تحدّثت النسبة");
    eq(out[0].p, 53000, "المستوى كما هو");
  });

  t("statusNow يتجاهل فترات يوم مضى", () => {
    const day = 86400000;
    const now = Date.UTC(2026, 8, 4, 16, 0);            // جمعة 12 ظهراً بنيويورك
    const old = { regular: { start: now - day - 3600e3, end: now - day + 3600e3 } };
    eq(statusNow(old, now).state, "REGULAR", "رجع للتقدير فوجد السوق مفتوحاً");
    const today = { regular: { start: now - 3600e3, end: now + 3600e3 } };
    eq(statusNow(today, now).state, "REGULAR", "الفترات الحالية تُستعمل كما هي");
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل\n`);
  return fail ? 1 : 0;
}

if (args.includes("--check")) process.exit(selfCheck());
else main().then(c => process.exit(c)).catch(e => { console.error(`\n✗ ${e.message}`); process.exit(1); });
