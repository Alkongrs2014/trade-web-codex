/* =====================================================================
   رياضيات عقود الخيارات — Black–Scholes بلا أي مكتبة خارجية.

   ياهو يعطي التقلّب الضمني (IV) والفائدة المفتوحة والأسعار، ولا يعطي
   الجريكس ولا احتمال انتهاء العقد داخل المال. الاثنان يُشتقّان رياضياً
   من نفس المدخلات، فلا حاجة لمصدر مدفوع.

   الخطأ هنا صامت: رقم معقول وخاطئ لا يُميَّز بالنظر. لذلك كل دالة
   مُختبَرة في `--check` مقابل قيم مرجعية معروفة.
   ===================================================================== */

/* تقريب دالة الخطأ — Abramowitz & Stegun 7.1.26، أقصى خطأ 1.5e-7.
   نحتاجها لأن جافاسكربت لا تملك erf أصلاً. */
export function erf(x) {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741,
        a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t;
  return sign * (1 - poly * Math.exp(-ax * ax));
}

/* التوزيع الطبيعي التراكمي ودالة الكثافة */
export const N = (x) => 0.5 * (1 + erf(x / Math.SQRT2));
export const phi = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

/* السنة التقويمية لا سنة التداول: IV من ياهو مُسعّرة على أساس تقويمي،
   وخلطُ الأساسين يعطي جريكس مزاحة بنسبة ثابتة تبدو معقولة. */
const YEAR_MS = 365 * 24 * 3600 * 1000;

/* العقود الأمريكية تنتهي عند إغلاق السوق (16:00 نيويورك) لا عند منتصف
   ليل تاريخ الانتهاء الذي يعطيه ياهو. الفرق يوم كامل تقريباً على عقد
   أسبوعي — وهو ما يقلب ثيتا رأساً على عقب في يومه الأخير. */
export function yearsToExpiry(expirySec, now) {
  const endMs = expirySec * 1000 + 21 * 3600 * 1000;      // ~16:00 ET بالـUTC
  return Math.max((endMs - now) / YEAR_MS, 1 / (365 * 24 * 60));   // أرضية دقيقة
}

/* =====================================================================
   Black–Scholes مع عائد توزيعات مستمر q.
   الأسعار بالدولار، σ و r و q كسور لا نسب مئوية (0.25 لا 25).
   ===================================================================== */
export function bs({ S, K, T, r = 0, q = 0, sigma, type = "call" }) {
  if (!(S > 0 && K > 0 && T > 0 && sigma > 0)) return null;
  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(S / K) + (r - q + sigma * sigma / 2) * T) / (sigma * sqrtT);
  const d2 = d1 - sigma * sqrtT;
  const dfR = Math.exp(-r * T), dfQ = Math.exp(-q * T);
  const isCall = type === "call";

  const price = isCall
    ? S * dfQ * N(d1) - K * dfR * N(d2)
    : K * dfR * N(-d2) - S * dfQ * N(-d1);

  const delta = isCall ? dfQ * N(d1) : dfQ * (N(d1) - 1);
  const gamma = dfQ * phi(d1) / (S * sigma * sqrtT);
  const vega  = S * dfQ * phi(d1) * sqrtT;               // لتغيّر σ بمقدار 1.0

  // ثيتا سنوية؛ نعرضها لاحقاً مقسومة على 365 كتآكل يومي
  const common = -S * dfQ * phi(d1) * sigma / (2 * sqrtT);
  const theta = isCall
    ? common - r * K * dfR * N(d2) + q * S * dfQ * N(d1)
    : common + r * K * dfR * N(-d2) - q * S * dfQ * N(-d1);

  // احتمال انتهاء العقد داخل المال تحت القياس المحايد للمخاطر.
  // ليس "احتمال الربح": الربح يحتاج تجاوز نقطة التعادل لا مجرّد بلوغ
  // السترايك، والفرق هو القسط المدفوع.
  const probITM = isCall ? N(d2) : N(-d2);

  return { d1, d2, price, delta, gamma, vega, theta, thetaDay: theta / 365, probITM };
}

/* =====================================================================
   استخراج التقلّب الضمني من سعر العقد — بالتنصيف.

   يلزمنا لأن ياهو **يصفّر `impliedVolatility` مع `bid`/`ask` خارج ساعات
   التداول**، ولا يبقى إلا `lastPrice`. بلا هذه الدالة تكون الميزة معطّلة
   سبع عشرة ساعة من كل يوم — وأغلب استعمالنا خارج الجلسة أصلاً.

   التنصيف لا نيوتن: فيغا تقارب الصفر عند العقود البعيدة عن المال فتنفجر
   خطوة نيوتن، بينما التنصيف يبقى مضموناً وستّون تكراراً منه رخيصة.
   ===================================================================== */
export function impliedVol(price, { S, K, T, r = 0, q = 0, type = "call" }) {
  if (!(price > 0 && S > 0 && K > 0 && T > 0)) return null;
  // القيمة الجوهرية حدٌّ أدنى للسعر؛ ما دونها لا يقابله أي تقلّب موجب
  const intrinsic = type === "call"
    ? Math.max(0, S * Math.exp(-q * T) - K * Math.exp(-r * T))
    : Math.max(0, K * Math.exp(-r * T) - S * Math.exp(-q * T));
  if (price <= intrinsic + 1e-8) return null;

  let lo = 0.005, hi = 5;
  const at = (s) => bs({ S, K, T, r, q, sigma: s, type }).price;
  if (at(hi) < price) return null;                 // سعر فوق ما يفسّره أي تقلّب
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (at(mid) < price) lo = mid; else hi = mid;
  }
  const v = (lo + hi) / 2;
  return (v > 0.006 && v < 4.99) ? v : null;       // ملامسة الحدّ = لا حلّ
}

/* =====================================================================
   ترشيح العقود الميتة.

   البيانات الخام مليئة بعقود لا تُتداول: أول عقد جلبناه في الاختبار كان
   openInterest صفراً وbid/ask صفرين وIV = 0.00001. أي جريك يُحسب منه
   عدد بلا معنى، وأي ترتيب يضعه في المقدمة لأن "رخصه" وهمي.

   وضعان لأن المصدر نفسه يتغيّر بتغيّر حالة السوق:
   - `live` والسوق مفتوح: عرض وطلب حقيقيان، فنشترط ضيق الفرق.
   - `last` والسوق مغلق: لا عرض ولا طلب، فنشترط بدلهما أن تكون آخر صفقة
     من الجلسة الأخيرة لا من أسبوع مضى.
   ===================================================================== */
export const FILTER = {
  minOI: 50,          // فائدة مفتوحة تحتها لا سوق فعلياً
  minBid: 0.05,       // عقد بلا مشترٍ لا يمكن الخروج منه
  maxSpread: 0.25,    // فرق العرض والطلب نسبةً إلى وسطهما
  minIV: 0.02, maxIV: 5.0,
  maxLastAgeDays: 4   // جمعة → اثنين، أو عطلة بينهما
};

export function liquid(c, f = FILTER, mode = "live", now = Date.now()) {
  const oi = num(c.openInterest);
  if (oi === null || oi < f.minOI) return false;

  if (mode === "last") {
    const last = num(c.lastPrice), lt = num(c.lastTradeDate);
    if (last === null || last < f.minBid) return false;
    if (lt === null) return false;
    // سعر آخر صفقة عمرها أيام مع سعر سهم اليوم يعطي تقلّباً ضمنياً كاذباً
    return (now - lt * 1000) <= f.maxLastAgeDays * 86400e3;
  }

  const bid = num(c.bid), ask = num(c.ask), iv = num(c.impliedVolatility);
  if (bid === null || bid < f.minBid) return false;
  if (ask === null || ask <= bid) return false;
  if (iv === null || iv < f.minIV || iv > f.maxIV) return false;
  return spread(bid, ask) <= f.maxSpread;
}

/* هل في السلسلة عرض وطلب فعليان؟ يحدّد الوضع بلا تخمين ساعات السوق.

   الأغلبية لا "أيٌّ منها": عقدان أو ثلاثة بقيت لهما بقايا عرض وطلب من
   الجلسة الماضية كانا يقلبان السلسلة كلها إلى الوضع اللحظي، فيرفض
   المرشّح الصارم كل ما عداهما وتخرج السلسلة بصفر عقود مع تقلّب ضمني
   مأخوذ من حقل مصفَّر — وهو ما حدث فعلاً مع PANW وCRM. */
export function chainMode(contracts, minShare = 0.2) {
  if (!contracts.length) return "last";
  const quoted = contracts.filter(c => num(c.bid) > 0 && num(c.ask) > 0
                                       && num(c.impliedVolatility) > 0.02).length;
  return (quoted / contracts.length) >= minShare ? "live" : "last";
}

export const spread = (bid, ask) => (ask - bid) / ((ask + bid) / 2);
const num = (v) => (typeof v === "number" && Number.isFinite(v)) ? v : null;

/* =====================================================================
   النشاط غير المعتاد — حجم اليوم مقابل المراكز القائمة.

   الفائدة المفتوحة عدد العقود القائمة من الأمس، والحجم عدد ما تُدووِل
   اليوم. حين يتجاوز الحجمُ الفائدةَ المفتوحة فمعناه أن أغلب تداول اليوم
   **مراكز جديدة** لا إغلاق قديمة: مالٌ يدخل الآن، لا يخرج.

   وهذا كل ما يقوله الرقم. لا يقول من اشترى ولا لماذا ولا إن كان محقاً،
   ولا يميّز شراء المضارب من تحوّط صندوق. من يسمّيه "تدفّق ذكي" يضيف
   إلى البيانات ما ليس فيها.
   ===================================================================== */
export function flowRatio(c) {
  const v = num(c.volume), oi = num(c.openInterest);
  if (v === null || oi === null || oi <= 0) return null;
  return v / oi;
}

/* `minDays`: عقدٌ يبقى له يوم واحد حجمُه يفوق مراكزه القائمة بطبيعته،
   لأن المراكز تُغلق قبل الانتهاء. بلا هذا الحد تتصدّر القائمةَ عقودُ
   الغد دائماً — تحيّز بنيوي لا إشارة. */
export const FLOW = { high: 1, extreme: 3, minDays: 7 };

export function flowLabel(vx) {
  if (!Number.isFinite(vx)) return null;
  if (vx >= FLOW.extreme) return { k: "extreme", ar: "نشاط استثنائي" };
  if (vx >= FLOW.high) return { k: "high", ar: "نشاط غير معتاد" };
  return null;
}

/* =====================================================================
   تقييم عقد واحد: جريكس + نقطة التعادل + كفاءة التعرّض.

   `mid` لا `lastPrice`: آخر صفقة قد تكون قبل أيام على سعر لم يعد قائماً،
   ووسط العرض والطلب هو ما يُنفَّذ عنده فعلاً تقريباً.
   ===================================================================== */
export function evaluate(c, { spot, r, q, type, now, mode = "live" }) {
  const bid = num(c.bid), ask = num(c.ask);
  const K = num(c.strike);
  if (K === null) return null;

  // السوق مغلق: لا عرض ولا طلب ولا IV من المصدر. نأخذ سعر آخر صفقة
  // ونستخرج التقلّب الضمني منه بأنفسنا.
  const live = mode === "live" && bid !== null && ask !== null && bid > 0 && ask > 0;

  // **الزمن يُقاس من لحظة السعر لا من الآن.** سعرُ عقدٍ نُفِّذ يوم الجمعة
  // مع زمنٍ متبقٍّ محسوب يوم الثلاثاء يخلط لحظتين: العقد كان أمامه سبعة
  // أيام لا ثلاثة، فيُنسب فارق الزمن كلّه إلى التقلّب ويُضخَّم بجذر
  // النسبة (√(7/3) ≈ 1.5×). هكذا خرج تقلّب VZ الضمني 117%.
  const asOf = (!live && num(c.lastTradeDate) !== null) ? c.lastTradeDate * 1000 : now;
  const T = yearsToExpiry(c.expiration, asOf);

  const mid = live ? (bid + ask) / 2 : num(c.lastPrice);
  if (mid === null || mid <= 0) return null;
  const iv = live ? num(c.impliedVolatility) : impliedVol(mid, { S: spot, K, T, r, q, type });
  if (iv === null || iv <= 0) return null;

  const g = bs({ S: spot, K, T, r, q, sigma: iv, type });
  if (!g) return null;

  // نقطة التعادل عند الانتهاء: ما يجب أن يبلغه السهم كي لا يخسر المشتري
  const be = type === "call" ? K + mid : K - mid;

  return {
    k: K,
    exp: c.expiration,
    // الأيام المتبقية تُعرض من الآن — هذا ما يهمّ القارئ — بينما التسعير
    // أعلاه يُحسب من لحظة السعر. رقمان مختلفان عمداً لا سهواً.
    days: Math.round(yearsToExpiry(c.expiration, now) * 365),
    bid: live ? bid : null, ask: live ? ask : null, mid: r2(mid),
    // `live: false` = السعر من آخر صفقة والتقلّب مستخرج لا مصدريّ.
    // الواجهة تعرض هذا صراحةً بدل إيهام المستخدم بتسعير لحظي.
    live,
    oi: num(c.openInterest), vol: num(c.volume) ?? 0,
    iv: r4(iv), spread: live ? r4(spread(bid, ask)) : null,
    delta: r4(g.delta), gamma: r4(g.gamma),
    theta: r2(g.thetaDay), vega: r2(g.vega / 100),      // فيغا لكل 1% تقلّب
    probITM: r4(g.probITM),
    be: r2(be),
    beMove: r2((be - spot) / spot * 100),               // بُعد التعادل عن السعر %
    // التعرّض لكل دولار مدفوع: دلتا العقد (×100 سهم) على كلفته.
    // معيار معلن وبسيط، لا "نتيجة ذكاء اصطناعي" مبهمة.
    eff: r4(Math.abs(g.delta) * 100 / (mid * 100)),
    // نشاط اليوم مقابل المراكز القائمة — انظر `flow` أدناه
    vx: r4(flowRatio(c))
  };
}

const r2 = (v) => v === null ? null : Math.round(v * 100) / 100;
const r4 = (v) => v === null ? null : Math.round(v * 10000) / 10000;

/* =====================================================================
   اختيار أفضل العقود.

   القاعدة معلنة: من بين العقود السائلة، نُبقي ما احتمال انتهائه داخل
   المال ضمن نطاق معقول — تحت الحد الأدنى تذكرة يانصيب، وفوق الأعلى
   عقدٌ عميق داخل المال ثمنه سعر السهم بلا رافعة تُذكر — ثم نرتّب حسب
   التعرّض لكل دولار.
   ===================================================================== */
export const PROB_BAND = { lo: 0.25, hi: 0.65 };

export function rank(evaluated, band = PROB_BAND, limit = 5) {
  return evaluated
    .filter(e => e && e.probITM >= band.lo && e.probITM <= band.hi)
    .sort((a, b) => b.eff - a.eff)
    .slice(0, limit);
}
