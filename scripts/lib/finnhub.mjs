/* =====================================================================
   عميل Finnhub — مصدر الأسعار الأساسي (بديل موثوق عن Yahoo المحظور
   أحياناً من عناوين GitHub Actions). الخطة المجانية تغطي الأسعار
   اللحظية فقط، لا الشموع التاريخية — تلك تبقى من Yahoo/Stooq كمحاولة
   أفضل جهد غير معطِّلة.
   ===================================================================== */

const BASE = "https://finnhub.io/api/v1";
const TOKEN = process.env.FINNHUB_API_KEY || "";

export const fhStats = { requests: 0, failures: 0 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function fhReq(path, params, { timeout = 15000 } = {}) {
  const u = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("token", TOKEN);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    fhStats.requests++;
    const r = await fetch(u.toString(), { signal: ctl.signal });
    clearTimeout(timer);
    if (!r.ok) {
      const body = await r.text().catch(() => "");
      throw new Error(`Finnhub HTTP ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    return await r.json();
  } catch (e) {
    fhStats.failures++;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* =====================================================================
   توزيع توصيات المحللين وصفقات المطّلعين.

   نقطتان مجانيتان على خطة Finnhub المجانية (على عكس تقويمه الاقتصادي
   الذي يردّ 403). ياهو يعطينا التوصية كخلاصة واحدة ("شراء") وعدد
   المحللين، ولا يعطي التوزيع ولا صفقات المطّلعين إطلاقاً.

   لماذا يستحقان الطلب: التوزيع يفرّق بين إجماع حقيقي وانقسام حاد
   يعطيان نفس الخلاصة، وصفقات المطّلعين تُظهر ما يفعله من يعرف الشركة
   من الداخل — لا ما يقوله محلل من الخارج.
   ===================================================================== */
export async function fetchRecommendation(symbol) {
  if (!TOKEN) throw new Error("FINNHUB_API_KEY غير مضبوط");
  const j = await fhReq("/stock/recommendation", { symbol });
  if (!Array.isArray(j) || !j.length) return null;
  // الأحدث أولاً: النقطة تعيد سلسلة شهرية والقديم منها لا يصف الحاضر
  const r = j.slice().sort((a, b) => String(b.period).localeCompare(String(a.period)))[0];
  const n = (v) => Number.isFinite(v) ? v : 0;
  const total = n(r.strongBuy) + n(r.buy) + n(r.hold) + n(r.sell) + n(r.strongSell);
  if (!total) return null;
  return { period: r.period || null, n: total,
           sb: n(r.strongBuy), b: n(r.buy), h: n(r.hold), s: n(r.sell), ss: n(r.strongSell) };
}

/* صافي شراء/بيع المطّلعين خلال نافذة زمنية، بالأسهم لا بعدد الصفقات:
   مدير يبيع ألف سهم ومدير يشتري مئة ألف ليسا إشارتين متعادلتين. */
export async function fetchInsiders(symbol, { days = 180, now = Date.now() } = {}) {
  if (!TOKEN) throw new Error("FINNHUB_API_KEY غير مضبوط");
  const from = new Date(now - days * 86400e3).toISOString().slice(0, 10);
  const j = await fhReq("/stock/insider-transactions", { symbol, from });
  const rows = Array.isArray(j?.data) ? j.data : [];
  return summarizeInsiders(rows);
}

/* مفصولة عن الجلب لتكون قابلة للاختبار بلا شبكة */
export function summarizeInsiders(rows) {
  let bought = 0, sold = 0, buys = 0, sells = 0, last = null;
  for (const r of rows || []) {
    // المشتقات (منح وخيارات موظفين) ليست قراراً سوقياً — تُستبعد
    if (r.isDerivative) continue;
    const ch = Number(r.change);
    if (!Number.isFinite(ch) || ch === 0) continue;
    if (ch > 0) { bought += ch; buys++; } else { sold += -ch; sells++; }
    const d = r.transactionDate || r.filingDate;
    if (d && (!last || d > last)) last = d;
  }
  if (!buys && !sells) return null;
  const net = bought - sold;
  return { bought, sold, net, buys, sells, last,
           // النسبة تجعل الرقم مقروءاً بلا معرفة حجم الشركة
           ratio: (bought + sold) ? +(net / (bought + sold)).toFixed(3) : 0 };
}

/* ---------- دفعة أسعار — Finnhub لا يدعم عدة رموز بطلب واحد، فنطلب
   تباعاً بوتيرة تحترم حد 60 طلباً/دقيقة على الخطة المجانية.
   الشكل المُعاد مطابق تماماً لما كان يعيده Yahoo v7/finance/quote
   حتى لا نحتاج لمس بقية fetch-market.mjs. ---------- */
export async function fetchQuotesFinnhub(symbols, { pace = 1050 } = {}) {
  if (!TOKEN) throw new Error("FINNHUB_API_KEY غير مضبوط");
  const out = {};
  let firstErr = null, errCount = 0;
  for (const sym of symbols) {
    try {
      const q = await fhReq("/quote", { symbol: sym });
      if (q && Number.isFinite(q.c) && q.c > 0) {
        const chg = Number.isFinite(q.pc) && q.pc ? (q.c - q.pc) / q.pc * 100 : null;
        out[sym] = {
          symbol: sym,
          regularMarketPrice: q.c,
          regularMarketChangePercent: chg,
          regularMarketPreviousClose: Number.isFinite(q.pc) ? q.pc : null,
          marketCap: null,
          regularMarketVolume: null,
          fiftyTwoWeekHigh: null,
          fiftyTwoWeekLow: null,
          preMarketPrice: null, preMarketChangePercent: null,
          postMarketPrice: null, postMarketChangePercent: null
        };
      } else if (!firstErr) {
        firstErr = `استجابة بلا سعر صالح: ${JSON.stringify(q).slice(0, 200)}`;
      }
    } catch (e) { errCount++; if (!firstErr) firstErr = e.message; }
    await sleep(pace);
  }
  if (firstErr) console.warn(`  ⚠ Finnhub: أول خطأ من ${errCount}: ${firstErr}`);
  return Object.keys(out).length ? out : null;
}

const n = (v) => Number.isFinite(v) ? v : null;

/* ---------- بيانات أساسية — profile2 (قيمة سوقية وقطاع) + metric (مضاعفات
   ونسب) لكل رمز، بديل عن quoteSummary من Yahoo عند تعطّله. الخطة المجانية
   لا تعيد موعد الأرباح أو توصية المحللين فتبقى null هنا (تُعرض شرطة). ---------- */
export async function fetchFundamentalsFinnhub(symbols, { pace = 1050 } = {}) {
  if (!TOKEN) throw new Error("FINNHUB_API_KEY غير مضبوط");
  const out = {};
  for (const sym of symbols) {
    try {
      const [profile, metricRes] = await Promise.all([
        fhReq("/stock/profile2", { symbol: sym }),
        fhReq("/stock/metric", { symbol: sym, metric: "all" })
      ]);
      const m = metricRes?.metric || {};
      const mc = n(profile?.marketCapitalization) ? profile.marketCapitalization * 1e6 : null;
      out[sym] = {
        mc, pe: n(m.peTTM), fpe: null, pb: n(m.pbAnnual),
        eps: n(m.epsInclExtraItemsTTM) ?? n(m.epsTTM),
        divY: n(m.currentDividendYieldTTM), divRate: n(m.dividendPerShareTTM),
        beta: n(m.beta), w52h: n(m["52WeekHigh"]), w52l: n(m["52WeekLow"]),
        avgVol: n(m["10DayAverageTradingVolume"]) ? m["10DayAverageTradingVolume"] * 1e6 : null,
        shares: n(profile?.shareOutstanding) ? profile.shareOutstanding * 1e6 : null,
        margin: n(m.netProfitMarginTTM) ? m.netProfitMarginTTM / 100 : null,
        revGrow: n(m.revenueGrowthTTMYoy) ? m.revenueGrowthTTMYoy / 100 : null,
        roe: n(m.roeTTM) ? m.roeTTM / 100 : null,
        target: null, rec: null, recN: null, earnings: null,
        sector: profile?.finnhubIndustry || null, industry: profile?.finnhubIndustry || null,
        staff: null, site: profile?.weburl || null, about: null
      };
    } catch (e) { /* رمز واحد فشل — تجاهله واستمر بالباقي */ }
    await sleep(pace);
  }
  return out;
}
