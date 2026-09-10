/* =====================================================================
   عميل Twelve Data — مصدر الشموع.
   السبب: Yahoo يحظر عناوين رينرات GitHub (429 على كل طلب حتى عبر curl،
   ونجاحه أحياناً مجرد حظ عنوان IP لا يُبنى عليه)، وشموع Finnhub تحتاج
   اشتراكاً مدفوعاً (403 على المفتاح المجاني). خطة Twelve Data المجانية
   تعطي 800 طلب يومياً و8 في الدقيقة — تكفي 210 طلبات لتحديث الفريمات
   الثلاثة لكل الرموز السبعين مرة كل يوم.
   ===================================================================== */

const BASE = "https://api.twelvedata.com";
const TOKEN = process.env.TWELVEDATA_API_KEY || "";

export const tdStats = { requests: 0, failures: 0, credits: 0 };
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

export const hasTwelveData = () => Boolean(TOKEN);

/* خريطة أسماء الفريمات عندنا إلى ما يفهمه Twelve Data */
const INTERVAL = { "15m": "15min", "1h": "1h", "1d": "1day" };

/* رموز بنقطة أو شرطة: Twelve Data يستخدم BRK.B لا BRK-B */
const tdSymbol = (s) => s.replace("-", ".");

/* ---------- شموع رمز واحد ----------
   يعيد نفس شكل fetchChart في yahoo.mjs: { candles: [{t,o,h,l,c,v}] }
   مرتّبة تصاعدياً بالوقت (Twelve Data يعيدها تنازلياً). */
export async function fetchCandlesTD(symbol, tf, { outputsize = 260, timeout = 20000 } = {}) {
  if (!TOKEN) throw new Error("TWELVEDATA_API_KEY غير مضبوط");
  const interval = INTERVAL[tf];
  if (!interval) throw new Error(`فريم غير مدعوم: ${tf}`);

  const u = new URL(`${BASE}/time_series`);
  u.searchParams.set("symbol", tdSymbol(symbol));
  u.searchParams.set("interval", interval);
  u.searchParams.set("outputsize", String(outputsize));
  u.searchParams.set("order", "ASC");
  u.searchParams.set("timezone", "UTC");
  u.searchParams.set("apikey", TOKEN);

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    tdStats.requests++;
    const r = await fetch(u.toString(), { signal: ctl.signal });
    if (!r.ok) throw new Error(`Twelve Data HTTP ${r.status}`);
    const j = await r.json();
    // الأخطاء تصل برمز 200 وجسم فيه status:"error" — لا نعدّها نجاحاً
    if (j?.status === "error") throw new Error(`TD: ${j.message || "خطأ غير معروف"}`);
    const values = j?.values;
    if (!Array.isArray(values) || !values.length) throw new Error("TD: بلا شمعات");

    const candles = [];
    for (const v of values) {
      const o = Number(v.open), h = Number(v.high), l = Number(v.low), c = Number(v.close);
      // نتخطى الشمعة الناقصة بدل تلفيق رقم — نفس سلوك عميل Yahoo
      if ([o, h, l, c].some(x => !Number.isFinite(x))) continue;
      const t = new Date(v.datetime.includes(" ") ? v.datetime.replace(" ", "T") + "Z"
                                                  : v.datetime + "T00:00:00Z").getTime();
      if (!Number.isFinite(t)) continue;
      candles.push({ t, o, h, l, c, v: Number(v.volume) || 0 });
    }
    if (!candles.length) throw new Error("TD: بلا شمعات صالحة");
    candles.sort((a, b) => a.t - b.t);
    tdStats.credits++;
    return { candles, meta: { source: "twelvedata" } };
  } catch (e) {
    tdStats.failures++;
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- وتيرة تحترم حد 8 طلبات في الدقيقة على الخطة المجانية ----------
   نترك هامشاً (7.5/دقيقة) لأن تجاوز الحد يعيد رفضاً يهدر الرصيد. */
export const TD_PACE_MS = 8000;
export const tdSleep = () => sleep(TD_PACE_MS);
