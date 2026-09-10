#!/usr/bin/env node
/* =====================================================================
   بناء كون الرموز — أداة صيانة تُشغَّل يدوياً، لا مهمة دورية.

   تكتب `stocks/symbols.json`: تُبقي الـ90 المرشّحة الأساسية كما هي
   (بأسمائها العربية المكتوبة يدوياً)، وتضيف بقية مؤشر S&P 500 كطبقة
   `wide`، وقائمة عملات رقمية كطبقة `crypto`.

   لماذا أداة لا قائمة مكتوبة؟ كتابة 400 رمز من الذاكرة تُدخل رموزاً
   شُطبت أو غيّرت اسمها بلا أن يظهر الخطأ إلا كرمز فارغ في الواجهة.
   هنا المصدر خارجي، ثم **كل رمز يُتحقق منه فعلياً عند ياهو** قبل أن
   يدخل الملف — ما لا يردّ سعراً لا يُكتب.

   التشغيل:
     node scripts/build-universe.mjs            # يجلب القائمة ويكتب
     node scripts/build-universe.mjs --dry      # يعرض الحصيلة بلا كتابة
     node scripts/build-universe.mjs --check    # فحص ذاتي بلا شبكة
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchQuotes } from "./lib/yahoo.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CFG_PATH = path.join(ROOT, "stocks/symbols.json");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const DRY = args.includes("--dry");

const SP500_CSV =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

/* قطاعات GICS بالإنجليزية → نفس المسمّيات العربية المستعملة في الملف
   الحالي. أي قطاع لا يُطابق يوقف البناء بدل أن يمرّ كقطاع فارغ. */
const SECTORS = {
  "Information Technology": "تقنية",
  "Communication Services": "اتصالات",
  "Consumer Discretionary": "استهلاكي كمالي",
  "Consumer Staples":       "استهلاكي أساسي",
  "Financials":             "مالي",
  "Health Care":            "رعاية صحية",
  "Energy":                 "طاقة",
  "Industrials":            "صناعي",
  "Materials":              "مواد",
  "Utilities":              "مرافق",
  "Real Estate":            "عقارات"
};

/* مرشّحو الكريبتو. الأسماء العربية مكتوبة يدوياً لأن الترجمة الآلية
   تشوّه أسماء العملات. ما لا يردّ سعراً عند ياهو يسقط في التحقق. */
const CRYPTO = [
  ["BTC-USD",  "بيتكوين",        "Bitcoin"],
  ["ETH-USD",  "إيثيريوم",       "Ethereum"],
  ["XRP-USD",  "ريبل",           "XRP"],
  ["BNB-USD",  "بينانس كوين",    "BNB"],
  ["SOL-USD",  "سولانا",         "Solana"],
  ["DOGE-USD", "دوجكوين",        "Dogecoin"],
  ["ADA-USD",  "كاردانو",        "Cardano"],
  ["TRX-USD",  "ترون",           "TRON"],
  ["AVAX-USD", "أفالانش",        "Avalanche"],
  ["LINK-USD", "تشين لينك",      "Chainlink"],
  ["DOT-USD",  "بولكادوت",       "Polkadot"],
  ["LTC-USD",  "لايتكوين",       "Litecoin"],
  ["BCH-USD",  "بيتكوين كاش",    "Bitcoin Cash"],
  ["XLM-USD",  "ستيلر",          "Stellar"],
  ["UNI-USD",  "يونيسواب",       "Uniswap"],
  ["ATOM-USD", "كوزموس",         "Cosmos"],
  ["ETC-USD",  "إيثيريوم كلاسيك", "Ethereum Classic"],
  ["HBAR-USD", "هيدرا",          "Hedera"],
  ["NEAR-USD", "نير",            "NEAR Protocol"],
  ["APT-USD",  "أبتوس",          "Aptos"],
  ["ICP-USD",  "إنترنت كمبيوتر",  "Internet Computer"],
  ["FIL-USD",  "فايلكوين",       "Filecoin"],
  ["ARB-USD",  "أربيتروم",       "Arbitrum"],
  ["OP-USD",   "أوبتيميزم",      "Optimism"],
  ["SHIB-USD", "شيبا إينو",      "Shiba Inu"],
  ["POL-USD",  "بوليجون",        "Polygon"]
];

/* رموز ياهو تستعمل الشرطة حيث يستعمل المؤشر النقطة (BRK.B ← BRK-B) */
const toYahoo = (t) => t.trim().replace(/\./g, "-");

/* مُحلّل CSV صغير يحترم الحقول المقتبسة — عناوين المقار فيها فواصل */
function parseCSV(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else if (c !== "\r") field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows.filter(r => r.length > 1);
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
  const core = new Set(cfg.symbols.map(s => s.s));
  console.log(`▶ الكون الحالي: ${cfg.symbols.length} مرشّحاً أساسياً`);

  console.log("  جلب قائمة S&P 500 …");
  const res = await fetch(SP500_CSV);
  if (!res.ok) throw new Error(`تعذّر جلب القائمة: ${res.status}`);
  const rows = parseCSV(await res.text());
  const head = rows.shift();
  const iSym = head.indexOf("Symbol"), iName = head.indexOf("Security"), iSec = head.indexOf("GICS Sector");
  if (iSym < 0 || iName < 0 || iSec < 0) throw new Error("تغيّرت أعمدة الملف المصدر");

  const candidates = [];
  for (const r of rows) {
    const s = toYahoo(r[iSym]);
    if (core.has(s)) continue;                  // الأساسية لها أسماؤها العربية
    const sec = SECTORS[r[iSec].trim()];
    if (!sec) throw new Error(`قطاع غير معروف: "${r[iSec]}" (${s})`);
    candidates.push({ s, en: r[iName].trim(), sec });
  }
  console.log(`  مرشّحو الطبقة الواسعة: ${candidates.length}`);

  // التحقق: دفعة أسعار واحدة لكل 40 رمزاً — أرخص بكثير من طلب شارت لكل رمز
  const all = [...candidates.map(c => c.s), ...CRYPTO.map(c => c[0])];
  console.log(`  التحقق من ${all.length} رمزاً عند ياهو …`);
  const quotes = await fetchQuotes(all);
  if (!quotes) throw new Error("لم تصل أي أسعار — لن نكتب فوق ملف سليم");

  const alive = (s) => Number.isFinite(quotes[s]?.regularMarketPrice);
  const wide = candidates.filter(c => alive(c.s));
  const dropped = candidates.filter(c => !alive(c.s)).map(c => c.s);
  // `mkt` صريح لا استنتاج من اسم القطاع: الواجهة والخادم يفرزان عليه،
  // ومقارنة نصّ عربي لتقرير سوق الرمز تنكسر بأول تغيير في التسمية.
  const crypto = CRYPTO.filter(([s]) => alive(s)).map(([s, ar, en]) => ({ s, ar, en, sec: "كريبتو", mkt: "crypto" }));
  const noCrypto = CRYPTO.filter(([s]) => !alive(s)).map(c => c[0]);

  if (dropped.length) console.log(`  ⚠ سقط ${dropped.length} رمزاً بلا سعر: ${dropped.join(", ")}`);
  if (noCrypto.length) console.log(`  ⚠ عملات بلا سعر: ${noCrypto.join(", ")}`);
  // نجاح جزئي كبير يعني خللاً في الشبكة لا رموزاً ميتة — لا نكتب حينها
  if (wide.length < candidates.length * 0.8)
    throw new Error(`نجح ${wide.length} من ${candidates.length} فقط — يبدو خللاً في الشبكة لا في الرموز`);

  const out = {
    note: cfg.note,
    top: cfg.top,
    symbols: cfg.symbols,
    wide,
    crypto,
    indices: cfg.indices
  };
  console.log(`\n  الأساسية ${out.symbols.length} · الواسعة ${wide.length} · الكريبتو ${crypto.length}`);
  console.log(`  الإجمالي: ${out.symbols.length + wide.length + crypto.length} رمزاً`);

  if (DRY) { console.log("\n(--dry: لم يُكتب شيء)"); return; }
  fs.writeFileSync(CFG_PATH, JSON.stringify(out));
  console.log(`\n✔ كُتب ${CFG_PATH}`);
}

/* ---------- فحص ذاتي بلا شبكة ---------- */
function selfCheck() {
  console.log("▶ فحص ذاتي (بلا شبكة)\n");
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; } };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

  t("toYahoo يحوّل النقطة إلى شرطة", () => {
    eq([toYahoo("BRK.B"), toYahoo("BF.B"), toYahoo("AAPL")], ["BRK-B", "BF-B", "AAPL"], "toYahoo");
  });

  t("parseCSV يحترم الفواصل داخل الاقتباس", () => {
    const r = parseCSV('Symbol,Security,Loc\nMMM,3M,"Saint Paul, Minnesota"\n');
    eq(r.length, 2, "صفّان");
    eq(r[1], ["MMM", "3M", "Saint Paul, Minnesota"], "الحقل المقتبس حقل واحد");
  });

  t("parseCSV يحترم الاقتباس المهروب داخل الحقل", () => {
    eq(parseCSV('a,b\n1,"say ""hi"""\n')[1], ["1", 'say "hi"'], "اقتباس مهروب");
  });

  t("خريطة القطاعات تغطي قطاعات GICS الأحد عشر", () => {
    eq(Object.keys(SECTORS).length, 11, "عدد القطاعات");
    for (const v of Object.values(SECTORS)) if (!v) throw new Error("قطاع بلا اسم عربي");
  });

  t("رموز الكريبتو فريدة ولها أسماء عربية", () => {
    const seen = new Set();
    for (const [s, ar, en] of CRYPTO) {
      if (!s.endsWith("-USD")) throw new Error(`${s} ليس بالدولار`);
      if (!ar || !en) throw new Error(`${s} بلا اسم`);
      if (seen.has(s)) throw new Error(`${s} مكرّر`);
      seen.add(s);
    }
  });

  t("الملف الحالي ما زال يقرأ ومرشّحوه 90", () => {
    const cfg = JSON.parse(fs.readFileSync(CFG_PATH, "utf8"));
    if (cfg.symbols.length !== 90) throw new Error(`${cfg.symbols.length} مرشّحاً`);
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل`);
  process.exit(fail ? 1 : 0);
}

if (CHECK) selfCheck();
else main().catch(e => { console.error("✗ فشل البناء:", e.message); process.exit(1); });
