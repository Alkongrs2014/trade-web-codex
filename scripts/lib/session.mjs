/* =====================================================================
   حالة جلسة السوق — مشتركة بين مهمة الشمعات ومهمة الأسعار السريعة.

   نُسخة واحدة لا نسختان: لو حسبت كل مهمة الحالة بمنطقها الخاص لاختلفت
   الترويسة بين تشغيل وتشغيل بلا سبب ظاهر، تماماً كما هو الحال مع
   indicators.mjs بين الخادم والمتصفح.
   ===================================================================== */

/* الفترات الحقيقية لا يوفّرها غير Yahoo، فحين تصل تُقدَّم على التقدير */
export function marketStatus(period, now) {
  if (!period?.regular) return { state: "UNKNOWN", ar: "غير معروف", next: null };
  const { pre, regular, post } = period;
  if (regular.start <= now && now < regular.end)
    return { state: "REGULAR", ar: "السوق مفتوح", next: regular.end, nextAr: "يغلق بعد" };
  if (pre && pre.start <= now && now < regular.start)
    return { state: "PRE", ar: "ما قبل الافتتاح", next: regular.start, nextAr: "يفتتح بعد" };
  if (post && regular.end <= now && now < post.end)
    return { state: "POST", ar: "بعد الإغلاق", next: post.end, nextAr: "تنتهي الجلسة بعد" };
  return { state: "CLOSED", ar: "السوق مغلق", next: now < regular.start ? regular.start : null, nextAr: "يفتتح بعد" };
}

/* التقدير بساعات نيويورك — يُستعمل حين لا تصل الفترات، أو حين تكون
   الفترات المحفوظة من يوم مضى فلا تصف اليوم الجاري. */
export function approxMarketStatus(now) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", hour12: false,
    weekday: "short", hour: "2-digit", minute: "2-digit"
  }).formatToParts(now);
  const get = (t) => parts.find(p => p.type === t)?.value;
  const weekday = get("weekday");
  const mins = Number(get("hour")) * 60 + Number(get("minute"));
  if (weekday === "Sat" || weekday === "Sun" || mins < 4 * 60)
    return { state: "CLOSED", ar: "السوق مغلق", next: null, nextAr: "يفتتح بعد" };
  if (mins < 9 * 60 + 30) return { state: "PRE", ar: "ما قبل الافتتاح", next: null, nextAr: "يفتتح بعد" };
  if (mins < 16 * 60) return { state: "REGULAR", ar: "السوق مفتوح", next: null, nextAr: "يغلق بعد" };
  if (mins < 20 * 60) return { state: "POST", ar: "بعد الإغلاق", next: null, nextAr: "تنتهي الجلسة بعد" };
  return { state: "CLOSED", ar: "السوق مغلق", next: null, nextAr: "يفتتح بعد" };
}

/* الكريبتو يتداول بلا انقطاع: لا افتتاح ولا إغلاق ولا عطلة نهاية أسبوع.
   تمريره على منطق ساعات نيويورك يجعله "مغلقاً" ليل السبت وهو يتحرك. */
export const CRYPTO_STATUS = { state: "OPEN24", ar: "مفتوح ٢٤/٧", next: null, nextAr: "" };

/* المدخل الموحّد: أعطِ سوق الرمز فتحصل على حالته الصحيحة */
export function statusFor(mkt, period, now) {
  return mkt === "crypto" ? { ...CRYPTO_STATUS } : statusNow(period, now);
}

/* الفترات المحفوظة تصف يوم جلبها. استعمالها في اليوم التالي يعطي
   "بعد الإغلاق" بينما السوق مفتوح فعلاً، لأن كل مقارنات النافذة تقع
   خلف now. فإن لم تعد فترات اليوم تشمل الوقت الحالي نرجع للتقدير. */
export function statusNow(period, now) {
  const st = marketStatus(period, now);
  if (st.state === "UNKNOWN") return approxMarketStatus(now);
  const end = period?.post?.end ?? period?.regular?.end;
  const start = period?.pre?.start ?? period?.regular?.start;
  if (!isFinite(end) || !isFinite(start) || now > end || now < start - 86400000)
    return approxMarketStatus(now);
  return st;
}
