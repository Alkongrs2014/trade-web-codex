/* =====================================================================
   الأخبار — مصادر عربية أصيلة + ترجمة العناوين الإنجليزية

   لماذا مصدران بلغتين لا مصدر واحد:
   • أخبار السوق الكلية (فائدة، تضخم، وول ستريت) تغطّيها صحف عربية
     محترفة بلغة عربية سليمة — أفضل من أي ترجمة آلية.
   • أخبار الشركة الواحدة (سهم بعينه من السبعين) لا تغطّيها الصحف
     العربية إلا نادراً، فمصدرها إنجليزي وتُترجم.

   الترجمة عبر MyMemory: مجانية بلا مفتاح لكن بحصّة يومية محدودة، فلا
   يُترجم عنوان مرتين أبداً — ذاكرة على القرص تُبقي ما تُرجم، وما زاد
   عن الحصّة يبقى إنجليزياً بعلامة ظاهرة بدل أن يختفي.
   ===================================================================== */

/* ---------- تحليل RSS بلا مكتبات ---------- */
export function parseRSS(xml, source) {
  const items = [];
  const blocks = String(xml).split(/<item[\s>]/i).slice(1);
  const pick = (b, tag) => {
    const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"));
    if (!m) return null;
    return m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
               .replace(/<[^>]+>/g, "")
               .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
               .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'")
               // الترميز العشري يظهر كثيراً في MarketWatch (&#x2019;)
               .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
               .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
               .trim() || null;
  };
  for (const b of blocks) {
    const title = pick(b, "title"), link = pick(b, "link");
    if (!title || !link) continue;
    const d = pick(b, "pubDate") || pick(b, "dc:date");
    const t = d ? Date.parse(d) : NaN;
    items.push({ title, link, src: source, t: isFinite(t) ? t : null });
  }
  return items;
}

export async function fetchRSS(url, source, lang = "en") {
  const r = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; StocksWatch/1.0)" },
    signal: AbortSignal.timeout(15000)
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return parseRSS(await r.text(), source).map(i => ({ ...i, lang }));
}

/* ---------- المصادر ----------
   عربية: تُعرض كما هي. اختيرت لأنها تصدر عن غرف أخبار اقتصادية
   محترفة وتغطّي وول ستريت لا الأسواق المحلية وحدها.
   إنجليزية: أقوى الغرف في تغطية الأسهم الأمريكية، وتُترجم عناوينها. */
export const MARKET_FEEDS = [
  ["الشرق الأوسط",  "https://aawsat.com/feed/economy",                                                    "ar"],
  ["سكاي نيوز عربية", "https://www.skynewsarabia.com/rss/business.xml",                                   "ar"],
  ["Yahoo Finance", "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US",      "en"],
  ["MarketWatch",   "https://feeds.content.dowjones.io/public/rss/mw_topstories",                         "en"],
  ["CNBC",          "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=20910258", "en"],
  ["WSJ",           "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain",                        "en"]
];
/* Seeking Alpha جُرّب وأُسقط: خلاصته تغرق في شركات دقيقة (Tyra Bio,
   KNOP) لا صلة لها بأكبر سبعين شركة أمريكية، فكانت تزاحم الأخبار
   التي تعني مستخدم هذا التطبيق. */

export const symbolFeed = (s) =>
  `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(s)}&region=US&lang=en-US`;

/* خلاصة Yahoo لرمز بعينه تحشر عناوين لا تخصّه إطلاقاً — ظهرت
   "Green Thumb Industries" في أخبار NVDA. نُبقي ما يذكر الرمز أو كلمة
   دالّة من اسم الشركة؛ وإن لم يبقَ شيء نُعيد الأصل بدل ترك السهم بلا
   أخبار — خبر بعيد أفضل من فراغ. */
const STOP = new Set(["inc", "corp", "corporation", "company", "group", "holdings",
                      "technologies", "systems", "international", "the", "and"]);

/* ما يعني مستخدم هذا التطبيق: الاقتصاد الكلي الأمريكي، أو إحدى شركاته
   السبعين. خلاصة Yahoo لمؤشر S&P تحشر شركات دقيقة (Transocean, NuScale)
   لا يتابعها التطبيق أصلاً، فكانت تزاحم ما يهمّ. */
const MACRO = /\b(fed|federal reserve|inflation|cpi|ppi|jobs|payroll|unemployment|rate cut|rate hike|interest rates?|yields?|treasur|recession|gdp|tariff|s&p ?500|nasdaq|dow jones|wall street|stock market|bull market|bear market|earnings season|vix|volatility|opec|oil prices?)\b/i;

export function rankMarket(items, symbols, want = 36) {
  const tickers = symbols.map(m => m.s);
  const names = symbols.map(m => String(m.en || "").split(/[^A-Za-z]+/)
    .filter(w => w.length > 4 && !STOP.has(w.toLowerCase()))[0]).filter(Boolean);

  const score = (it) => {
    if (it.lang === "ar") return 3;                    // مصادر عربية منتقاة أصلاً
    const t = it.title;
    if (tickers.some(s => new RegExp(`(^|[^A-Za-z])${s}([^A-Za-z]|$)`).test(t))) return 3;
    if (names.some(n => t.toLowerCase().includes(n.toLowerCase()))) return 3;
    if (MACRO.test(t)) return 2;
    return 0;
  };

  const scored = items.map(it => ({ it, sc: score(it) }));
  const keep = scored.filter(x => x.sc > 0);
  // لو قصّ الفلتر أكثر من اللازم نُكمل بالمستبعَد بدل تقديم قائمة هزيلة
  const rest = scored.filter(x => x.sc === 0);
  const out = keep.concat(rest.slice(0, Math.max(0, want - keep.length)));
  return out.sort((a, b) => (b.it.t ?? 0) - (a.it.t ?? 0)).slice(0, want).map(x => x.it);
}
export function relevantTo(items, meta) {
  const words = String(meta.en || "").split(/[^A-Za-z]+/)
    .filter(w => w.length > 3 && !STOP.has(w.toLowerCase()));
  const tick = new RegExp(`(^|[^A-Za-z])${meta.s}([^A-Za-z]|$)`);
  const hit = items.filter(i =>
    tick.test(i.title) || words.some(w => i.title.toLowerCase().includes(w.toLowerCase())));
  return hit.length ? hit : items;
}

/* =====================================================================
   الترجمة
   ===================================================================== */

/* أسماء الشركات أسوأ ما تفسده الترجمة الآلية: "Applied Materials" تصير
   "المواد المطبقة" و"Broadcom" تُترجم حرفياً. نحميها برمز قبل الإرسال
   ثم نضع مكانها الاسم العربي المعتمد في symbols.json — فنكسب دقة
   الاسم واتساقه مع بقية التطبيق في خطوة واحدة. */
function buildNameMap(symbols) {
  const pairs = [];
  for (const m of symbols || []) {
    if (m.en && m.ar) pairs.push([m.en, m.ar]);
    // "Alphabet (Google)" في العربية يقابله "Alphabet" و"Google" معاً
    const paren = String(m.ar || "").match(/\(([^)]+)\)/);
    if (paren) pairs.push([paren[1], m.ar]);
  }
  // الأطول أولاً حتى لا يبتلع "Applied" اسم "Applied Materials"
  return pairs.sort((a, b) => b[0].length - a[0].length);
}

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function protect(title, nameMap) {
  const kept = [];
  let out = title;
  for (const [en, ar] of nameMap) {
    const re = new RegExp(`(^|[^\\p{L}])${esc(en)}([^\\p{L}]|$)`, "iu");
    if (!re.test(out)) continue;
    const tok = `[[${kept.length}]]`;
    kept.push(ar);
    out = out.replace(re, (_, a, b) => a + tok + b);
  }
  return { text: out, kept };
}

function restore(text, kept) {
  let out = String(text);
  kept.forEach((ar, i) => {
    // الترجمة قد تعبث بالأقواس أو تضيف مسافات داخلها
    out = out.replace(new RegExp(`\\[\\s*\\[\\s*${i}\\s*\\]\\s*\\]`, "g"), ar);
  });
  return out.replace(/\[\[\d+\]\]/g, "").replace(/\s{2,}/g, " ").trim();
}

/* أخطاء متكرّرة لا تُصلحها الحماية: كلمات مالية لها معنى شائع آخر.
   تُطبَّق فقط حين تظهر الكلمة الإنجليزية في الأصل، حتى لا نغيّر نصاً
   كان صحيحاً. */
const FIXUPS = [
  [/\bstocks?\b/i,        [[/المخزونات/g, "الأسهم"], [/مخزونات/g, "أسهم"],
                           [/المخزون/g, "السهم"],    [/مخزون/g, "سهم"]]],
  [/\bfed\b|federal reserve/i, [[/التغذية/g, "الفدرالي"], [/الاحتياطي الفدرالي/g, "الفدرالي"]]],
  [/\byields?\b/i,        [[/غلات/g, "عوائد"], [/الغلة/g, "العائد"], [/العائدات/g, "العوائد"]]],
  [/\bshares?\b/i,        [[/الحصص/g, "الأسهم"], [/حصص/g, "أسهم"]]],
  [/\brall(y|ies|ied)\b/i, [[/التجمع/g, "الصعود"], [/تجمع/g, "صعود"]]],
  [/\bearnings\b/i,       [[/المكاسب/g, "الأرباح"], [/مكاسب/g, "أرباح"]]],
  // "bear/bull market" حرفياً = "سوق الدب/الثور"، ولا يقولها متحدث بالعربية
  [/\bbear market\b/i,    [[/سوق الدببة/g, "السوق الهابطة"], [/سوق الدب/g, "السوق الهابطة"],
                           [/السوق الدب/g, "السوق الهابطة"]]],
  [/\bbull market\b/i,    [[/سوق الثيران/g, "السوق الصاعدة"], [/سوق الثور/g, "السوق الصاعدة"],
                           [/السوق الثور/g, "السوق الصاعدة"]]],
  // "Jobs" في سياق التوظيف تُقرأ اسم علم فتصير "جوبز"
  [/\bjobs\b/i,           [[/جوبز/g, "الوظائف"]]],
  [/\bpayrolls?\b/i,      [[/كشوف المرتبات/g, "الوظائف"], [/كشوف الرواتب/g, "الوظائف"]]],
  [/\bETFs?\b/,           [[/صناديق الاستثمار المتداولة/g, "صناديق المؤشرات"],
                           [/الصناديق المتداولة في البورصة/g, "صناديق المؤشرات"]]],
  [/\bcrash/i,            [[/الأعطال/g, "الانهيار"], [/أعطال/g, "انهيار"], [/تحطم/g, "انهيار"]]],
  [/\bguidance\b|\bguided\b/i, [[/استرشد/g, "توقّع"], [/إرشاد/g, "توجيه"]]],
  [/\bupgrade[ds]?\b/i,   [[/ترقية/g, "رفع التصنيف"]]],
  [/\bdowngrade[ds]?\b/i, [[/خفض الرتبة/g, "خفض التصنيف"], [/تخفيض الرتبة/g, "خفض التصنيف"]]],
  [/\bbuyback\b|\brepurchase\b/i, [[/إعادة الشراء/g, "إعادة شراء الأسهم"]]],
  [/\btreasur(y|ies)\b/i, [[/الخزينة/g, "الخزانة"]]]
];

function applyFixups(en, ar) {
  let out = ar;
  for (const [when, subs] of FIXUPS)
    if (when.test(en)) for (const [from, to] of subs) out = out.replace(from, to);
  return out;
}

/* مفتاح الذاكرة: العنوان نفسه بعد تطبيع المسافات. لا نحتاج تجزئة —
   الملف صغير والمقارنة النصية أوضح عند فحصه بالعين. */
export const trKey = (s) => String(s).replace(/\s+/g, " ").trim().toLowerCase();

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const trStats = { hit: 0, new: 0, failed: 0, quota: false };

async function translateOne(text) {
  const u = new URL("https://api.mymemory.translated.net/get");
  u.searchParams.set("q", text);
  u.searchParams.set("langpair", "en|ar");
  const r = await fetch(u, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  const out = j?.responseData?.translatedText;
  if (!out) throw new Error("استجابة بلا ترجمة");
  // الحصّة تُستنفد فيعيد الخدمة نصاً تحذيرياً بحالة 200، لا خطأ
  if (/MYMEMORY WARNING|QUOTA|ALL AVAILABLE FREE/i.test(out)) {
    trStats.quota = true;
    throw new Error("نفدت الحصّة اليومية للترجمة");
  }
  return out;
}

/* يترجم ما لم يُترجم من قبل فقط، وبسقف لكل تشغيل. الباقي يبقى
   إنجليزياً ويُترجم في تشغيل لاحق — التدرّج أفضل من الفشل الكامل. */
export async function translateTitles(items, cache, { budget = 40, symbols = [] } = {}) {
  const nameMap = buildNameMap(symbols);
  let spent = 0;

  for (const it of items) {
    if (it.lang === "ar") continue;
    const k = trKey(it.title);
    if (cache[k]) { it.ar = cache[k]; trStats.hit++; continue; }
    if (spent >= budget || trStats.quota) continue;

    const { text, kept } = protect(it.title, nameMap);
    try {
      spent++;
      const raw = await translateOne(text);
      const ar = applyFixups(it.title, restore(raw, kept));
      // ترجمة تعيد النص الإنجليزي كما هو ليست ترجمة
      if (ar && ar !== text && /[؀-ۿ]/.test(ar)) {
        cache[k] = ar; it.ar = ar; trStats.new++;
      } else trStats.failed++;
    } catch (e) {
      trStats.failed++;
      if (trStats.quota) break;                 // لا فائدة من المتابعة
    }
    await sleep(350);                           // خدمة مجانية — لا نزاحمها
  }
  return items;
}

/* الذاكرة تكبر بلا حد لو تُركت. نُبقي الأحدث فقط: العناوين القديمة
   لن تعود في أي خلاصة. */
export function pruneCache(cache, keep = 4000) {
  const keys = Object.keys(cache);
  if (keys.length <= keep) return cache;
  const out = {};
  for (const k of keys.slice(-keep)) out[k] = cache[k];
  return out;
}
