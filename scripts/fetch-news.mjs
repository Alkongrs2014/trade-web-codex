#!/usr/bin/env node
/* =====================================================================
   مهمة الأخبار — منفصلة عن المهمة اليومية عمداً.

   كانت الأخبار تُجلب مع الأساسيات مرة في اليوم، فيظهر في التطبيق
   عنوان عمره ساعات على أنه "الآن". الأساسيات تتغيّر مرة كل ربع سنة
   والأخبار كل دقائق — دورتان مختلفتان لا تجتمعان في مهمة واحدة.

     node scripts/fetch-news.mjs --out ./data
     node scripts/fetch-news.mjs --check     فحص ذاتي بلا شبكة
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseRSS, fetchRSS, MARKET_FEEDS, symbolFeed, relevantTo, rankMarket,
  translateTitles, pruneCache, trKey, trStats
} from "./lib/news.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "stocks/symbols.json"), "utf8"));

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
function writeJSON(rel, obj) {
  const p = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
  return Buffer.byteLength(JSON.stringify(obj));
}

async function pool(items, size, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(size, items.length) }, async () => {
    while (i < items.length) {
      const k = i++;
      try { out[k] = { ok: true, value: await fn(items[k]) }; }
      catch (e) { out[k] = { ok: false, error: e.message }; }
    }
  }));
  return out;
}

/* ---------- التشغيل ---------- */
async function main() {
  const now = Date.now();
  fs.mkdirSync(OUT, { recursive: true });
  console.log("▶ الأخبار …");

  // 1) أخبار السوق من كل المصادر
  const market = [];
  let arCount = 0;
  for (const [src, url, lang] of MARKET_FEEDS) {
    try {
      const items = (await fetchRSS(url, src, lang)).slice(0, lang === "ar" ? 14 : 10);
      market.push(...items);
      if (lang === "ar") arCount += items.length;
      console.log(`  ✓ ${src} (${items.length})`);
    } catch (e) { console.warn(`  ⚠ ${src}: ${e.message}`); }
  }

  // 2) أخبار كل سهم — الترتيب اليومي يحدد الرموز، وإلا أعلى الملف
  const ranking = readJSON(path.join(OUT, "ranking.json"));
  const top = ranking?.top?.length ? ranking.top : cfg.symbols.slice(0, cfg.top).map(s => s.s);
  const byS = Object.fromEntries(cfg.symbols.map(m => [m.s, m]));
  const perSymbol = {};
  const res = await pool(top, 5, async (s) => ({
    s, items: relevantTo(await fetchRSS(symbolFeed(s), "Yahoo Finance", "en"), byS[s] || { s }).slice(0, 6)
  }));
  let symOk = 0;
  for (const r of res) if (r.ok && r.value.items.length) { perSymbol[r.value.s] = r.value.items; symOk++; }
  console.log(`  ✓ أخبار الأسهم: ${symOk} / ${top.length}`);

  // 3) إزالة التكرار والترتيب زمنياً
  const seen = new Set();
  const uniq = market.filter(n => { const k = trKey(n.title); if (seen.has(k)) return false; seen.add(k); return true; });
  const marketDedup = rankMarket(uniq, cfg.symbols, 36);

  // 4) الترجمة — أخبار السوق أولاً لأنها الواجهة الأولى، ثم أخبار الأسهم
  const cache = readJSON(path.join(OUT, "i18n.json"), {}) || {};
  await translateTitles(marketDedup, cache, { budget: 30, symbols: cfg.symbols });
  const symItems = Object.values(perSymbol).flat();
  await translateTitles(symItems, cache, { budget: 30, symbols: cfg.symbols });
  console.log(`  ✓ ترجمة: ${trStats.new} جديدة · ${trStats.hit} من الذاكرة · ${trStats.failed} فشلت${trStats.quota ? " · نفدت الحصّة" : ""}`);

  // 5) الكتابة — بوابة السلامة: لا نكتب فراغاً فوق أخبار سليمة
  if (!marketDedup.length && !symOk) {
    if (readJSON(path.join(OUT, "news.json"))) {
      console.warn("  ⚠ لا أخبار من أي مصدر — أبقينا الملف السابق");
      return 0;
    }
    throw new Error("لا أخبار من أي مصدر ولا ملف سابق");
  }

  writeJSON("i18n.json", pruneCache(cache));
  const bytes = writeJSON("news.json", {
    updated: now, market: marketDedup, sym: perSymbol,
    arabic: arCount, translated: marketDedup.filter(n => n.ar).length
  });

  const prevMeta = readJSON(path.join(OUT, "meta.json"), {});
  writeJSON("meta.json", {
    ...prevMeta,
    newsUpdated: now,
    newsRun: {
      at: new Date(now).toISOString(),
      market: marketDedup.length, arabic: arCount, symbols: symOk,
      translated: trStats.new, cached: trStats.hit, quota: trStats.quota
    }
  });

  const freshest = marketDedup.filter(n => n.t).map(n => (now - n.t) / 60000).sort((a, b) => a - b)[0];
  console.log(`✔ ${marketDedup.length} خبر سوق (${arCount} عربي أصيل) · ${symOk} سهماً · ${(bytes / 1024).toFixed(0)} ك.ب`);
  if (isFinite(freshest)) console.log(`  أحدث خبر عمره ${freshest.toFixed(0)} دقيقة`);
  return 0;
}

/* ---------- فحص ذاتي بلا شبكة ---------- */
function selfCheck() {
  let pass = 0, fail = 0;
  const t = (name, fn) => {
    try { fn(); console.log(`  ✓ ${name}`); pass++; }
    catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; }
  };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

  console.log("\n▶ فحص ذاتي (بلا شبكة)\n");

  t("parseRSS يستخرج العناوين ويفك CDATA", () => {
    const xml = `<rss><channel>
      <item><title><![CDATA[Big &amp; Bold]]></title><link>http://a</link><pubDate>Tue, 01 Sep 2026 10:00:00 GMT</pubDate></item>
      <item><title>Plain</title><link>http://b</link></item>
    </channel></rss>`;
    const items = parseRSS(xml, "T");
    eq(items.length, 2, "عدد");
    eq(items[0].title, "Big & Bold", "CDATA و&amp;");
    eq(items[1].t, null, "بلا تاريخ");
  });

  t("parseRSS يفك الترميز السداسي", () => {
    const xml = `<rss><item><title>Trump&#x2019;s week</title><link>http://a</link></item></rss>`;
    eq(parseRSS(xml, "T")[0].title, "Trump’s week", "&#x2019;");
  });

  t("parseRSS يتحمّل XML تالفاً", () => {
    eq(parseRSS("", "T").length, 0, "فارغ");
    eq(parseRSS("<html>not rss</html>", "T").length, 0, "ليس RSS");
  });

  t("المصادر تضم عربية وإنجليزية", () => {
    const langs = new Set(MARKET_FEEDS.map(f => f[2]));
    if (!langs.has("ar") || !langs.has("en")) throw new Error("ينقص لسان");
    for (const [n, u] of MARKET_FEEDS) if (!/^https:\/\//.test(u)) throw new Error(`${n} ليس https`);
  });

  t("rankMarket يُقصي الشركات الدقيقة ويُبقي الكلّي وشركاتنا", () => {
    const syms = [{ s: "NVDA", en: "NVIDIA", ar: "إنفيديا" }, { s: "TSLA", en: "Tesla", ar: "تسلا" }];
    const items = [
      { title: "Transocean (RIG) up 16% since last earnings", lang: "en", t: 9 },
      { title: "Fed rate cut odds jump after jobs report",     lang: "en", t: 8 },
      { title: "NVIDIA guides higher for fiscal 2028",         lang: "en", t: 7 },
      { title: "وول ستريت تتراجع",                              lang: "ar", t: 6 }
    ];
    const out = rankMarket(items, syms, 3).map(x => x.title);
    if (out.some(t => /Transocean/.test(t))) throw new Error("لم يُقصَ الدقيق");
    if (out.length !== 3) throw new Error("عدد غير متوقع: " + out.length);
    eq(out[0], "Fed rate cut odds jump after jobs report", "الأحدث أولاً داخل المُبقى");
  });

  t("rankMarket لا يُفرّغ القائمة حين لا يطابق شيء", () => {
    const items = [{ title: "Foo Corp rises", lang: "en", t: 1 }, { title: "Bar Ltd falls", lang: "en", t: 2 }];
    eq(rankMarket(items, [], 5).length, 2, "أعاد الكل بدل الفراغ");
  });

  t("relevantTo يُبقي ما يخصّ الرمز فقط", () => {
    const items = [{ title: "Green Thumb Industries hits a rough patch" }, { title: "NVIDIA beats estimates" }];
    const out = relevantTo(items, { s: "NVDA", en: "NVIDIA" });
    eq(out.length, 1, "واحد فقط");
    eq(out[0].title, "NVIDIA beats estimates", "الصحيح");
    // ولا يترك السهم بلا أخبار إطلاقاً
    eq(relevantTo([{ title: "totally unrelated" }], { s: "AAPL", en: "Apple" }).length, 1, "رجوع للأصل");
  });

  t("trKey يوحّد المسافات وحالة الأحرف", () => {
    eq(trKey("  Big   NEWS "), trKey("big news"), "تطبيع");
  });

  t("pruneCache يُبقي الأحدث فقط", () => {
    const c = {}; for (let i = 0; i < 10; i++) c["k" + i] = "v" + i;
    const p = pruneCache(c, 3);
    eq(Object.keys(p), ["k7", "k8", "k9"], "الأحدث");
    eq(Object.keys(pruneCache(c, 50)).length, 10, "أقل من الحد يبقى كما هو");
  });

  t("العربي لا يُترجم ولا يستهلك الحصّة", async () => {
    const items = [{ title: "وول ستريت تصعد", lang: "ar" }];
    translateTitles(items, {}, { budget: 0 });
    if (items[0].ar) throw new Error("تُرجم عربي");
  });

  t("الذاكرة تُستخدم بلا شبكة", async () => {
    const items = [{ title: "Stocks Rise", lang: "en" }];
    const cache = { [trKey("Stocks Rise")]: "الأسهم ترتفع" };
    const before = trStats.hit;
    await translateTitles(items, cache, { budget: 0 });
    eq(items[0].ar, "الأسهم ترتفع", "من الذاكرة");
    if (trStats.hit !== before + 1) throw new Error("لم يُحسب كإصابة");
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل\n`);
  return fail ? 1 : 0;
}

if (args.includes("--check")) process.exit(selfCheck());
else main().then(c => process.exit(c)).catch(e => { console.error(`\n✗ ${e.message}`); process.exit(1); });
