/* =====================================================================
   وسيط الأسعار اللحظية — Cloudflare Worker

   وظيفته: يحمل مفتاح API بعيداً عن المتصفح، ويخزّن النتيجة بضع ثوانٍ،
   فيبقى استهلاك باقتك ثابتاً مهما زاد عدد الزوار.

   الإعداد (مرة واحدة): راجع README.md بجانب هذا الملف.
   المتغيّرات السرّية المطلوبة في Cloudflare:
     API_KEY   مفتاحك من المزوّد
     PROVIDER  اسم المزوّد: fmp  أو  twelvedata     (الافتراضي fmp)
     ALLOW     نطاقك المسموح، مثل: https://alkongrs2014.github.io
   ===================================================================== */

const CACHE_SECONDS = 5;      // نافذة التخزين — 100 زائر = طلب واحد للمزوّد
const MAX_SYMBOLS   = 100;

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get("Origin") || "";
    const allow  = (env.ALLOW || "*").trim();
    const okOrigin = allow === "*" || allow.split(",").map(s => s.trim()).includes(origin);
    const cors = {
      "Access-Control-Allow-Origin": allow === "*" ? "*" : (okOrigin ? origin : allow.split(",")[0].trim()),
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin"
    };
    const json = (body, status = 200, extra = {}) => new Response(JSON.stringify(body), {
      status, headers: { "Content-Type": "application/json; charset=utf-8", ...cors, ...extra }
    });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET")     return json({ error: "method not allowed" }, 405);
    if (!okOrigin && allow !== "*")   return json({ error: "origin not allowed" }, 403);
    if (!env.API_KEY)                 return json({ error: "API_KEY غير مضبوط في إعدادات الـ Worker" }, 500);

    const url = new URL(request.url);
    const raw = (url.searchParams.get("symbols") || "").trim();
    if (!raw) return json({ error: "مطلوب معامل symbols" }, 400);

    // تنظيف المدخلات — لا نمرّر نصاً عشوائياً إلى المزوّد
    const symbols = [...new Set(raw.split(",")
      .map(s => s.trim().toUpperCase())
      .filter(s => /^[A-Z][A-Z0-9.\-]{0,9}$/.test(s)))].slice(0, MAX_SYMBOLS);
    if (!symbols.length) return json({ error: "لا رموز صالحة" }, 400);

    // مفتاح تخزين ثابت مبني على الرموز وحدها (لا يتضمن المفتاح السرّي)
    const cacheKey = new Request(`https://cache.local/q?s=${symbols.slice().sort().join(",")}`);
    const cache = caches.default;
    const hit = await cache.match(cacheKey);
    if (hit) {
      const body = await hit.json();
      return json({ ...body, cached: true });
    }

    const provider = (env.PROVIDER || "fmp").toLowerCase();
    try {
      const quotes = provider === "twelvedata"
        ? await fromTwelveData(symbols, env.API_KEY)
        : await fromFMP(symbols, env.API_KEY);

      const body = { updated: Date.now(), provider, count: Object.keys(quotes).length, quotes };
      const res = json(body, 200, { "Cache-Control": `public, max-age=${CACHE_SECONDS}` });
      ctx.waitUntil(cache.put(cacheKey, res.clone()));
      return res;
    } catch (e) {
      // التطبيق يرجع تلقائياً لبيانات الملفات عند أي خطأ هنا
      return json({ error: String(e.message || e) }, 502);
    }
  }
};

/* ---------- Financial Modeling Prep: كل الرموز في طلب واحد ---------- */
async function fromFMP(symbols, key) {
  const u = `https://financialmodelingprep.com/api/v3/quote/${symbols.join(",")}?apikey=${encodeURIComponent(key)}`;
  const r = await fetch(u, { cf: { cacheTtl: 0 } });
  if (!r.ok) throw new Error(`FMP HTTP ${r.status}`);
  const arr = await r.json();
  if (!Array.isArray(arr)) throw new Error(arr?.["Error Message"] || "رد غير متوقع من FMP");
  const out = {};
  for (const q of arr) {
    if (!q?.symbol || !isFinite(q.price)) continue;
    out[q.symbol] = {
      price: q.price,
      chg: isFinite(q.changesPercentage) ? q.changesPercentage : null,
      dayHigh: q.dayHigh ?? null, dayLow: q.dayLow ?? null,
      volume: q.volume ?? null, prevClose: q.previousClose ?? null
    };
  }
  return out;
}

/* ---------- Twelve Data: دفعات من 8 رموز ---------- */
async function fromTwelveData(symbols, key) {
  const out = {};
  for (let i = 0; i < symbols.length; i += 8) {
    const batch = symbols.slice(i, i + 8);
    const u = `https://api.twelvedata.com/quote?symbol=${batch.join(",")}&apikey=${encodeURIComponent(key)}`;
    const r = await fetch(u, { cf: { cacheTtl: 0 } });
    if (!r.ok) throw new Error(`TwelveData HTTP ${r.status}`);
    const j = await r.json();
    // برمز واحد يعيد الكائن مباشرة، وبعدة رموز يعيد خريطة
    const rows = (j.symbol || j.close) ? { [batch[0]]: j } : j;
    for (const [sym, q] of Object.entries(rows)) {
      const price = Number(q?.close);
      if (!isFinite(price)) continue;
      out[sym] = {
        price,
        chg: isFinite(Number(q.percent_change)) ? Number(q.percent_change) : null,
        dayHigh: Number(q.high) || null, dayLow: Number(q.low) || null,
        volume: Number(q.volume) || null, prevClose: Number(q.previous_close) || null
      };
    }
  }
  return out;
}
