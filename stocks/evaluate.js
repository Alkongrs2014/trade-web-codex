/* =====================================================================
   طبقة التقييم — فوق التوصية لا داخلها.

   قاعدة الملف كله: **لا يغيّر التوصية ولا الخطة ولا نتيجةً فنية**. يقرأ
   ما حسبه المحرّك ويجيب أسئلة أخرى لم يكن يجيبها:

     · الطزاجة  — هل الإشارة حديثة أم حدثت قبل أيام؟   (المرحلة ٣)
     · جودة الدخول — الاتجاه صحيح، لكن هل الدخول الآن جيد؟ (٤)
     · الزمن المتوقّع — متى يُبلغ كل هدف تقديراً؟        (٥)
     · الآفاق  — لحظي ويومي وأسبوعي، ثلاثةٌ لا واحدة.   (١٠)

   ولماذا طبقة منفصلة: العمر ليس دليلاً على انقلاب الاتجاه. إشارةٌ عمرها
   يومان في فريم يومي ما زالت قائمة، ونفس العمر في فريم ‎15د‎ انتهى. خفضُ
   النتيجة الفنية بسبب الزمن يخلط قياسين، ويجعل الرقم الذي يقيس الاتجاه
   يقيس شيئين. فالعمر يُقال ولا يُطرح.

   نسخة واحدة للمتصفح والخادم — السجلّ يحفظ الطزاجة والزمن المتوقّع
   **كما رآهما المستخدم**، فلا تصحّ نسخة ثانية على الخادم.
   ===================================================================== */

const HOUR = 3600e3, DAY = 86400e3;

/* =====================================================================
   ١) الطزاجة — عتبة لكل فريم، لا رقم واحد للجميع.

   عمرٌ واحد يعني أشياء مختلفة: ساعتان تُهرِم إشارةَ ‎15د‎ وتُبقي اليومية
   في مهدها. والعتبات مشتقّة من طول الشمعة نفسها: الإشارة «جديدة» ما دامت
   في حدود شمعتين، و«قائمة» حتى ست شمعات، و«متأخرة» حتى عشرين، وبعدها
   «قديمة» — أي أن مرجعها الذي بُنيت عليه صار خارج النافذة.
   ===================================================================== */
const TF_BAR = { "5m": 5 * 60e3, "15m": 15 * 60e3, "1h": HOUR, "4h": 4 * HOUR, "1d": DAY, "1w": 7 * DAY };
const FRESH_BARS = { fresh: 2, live: 6, late: 20 };

function freshness(ageMs, tf) {
  const bar = TF_BAR[tf] || DAY;
  if (!Number.isFinite(ageMs) || ageMs < 0) return null;
  const bars = ageMs / bar;
  if (bars <= FRESH_BARS.fresh) return { k: "fresh", t: "جديدة", i: "🟢", c: "var(--up)", bars,
    why: `أقل من ${FRESH_BARS.fresh} شمعات ${tfName(tf)} — الإشارة ما زالت في مهدها` };
  if (bars <= FRESH_BARS.live) return { k: "live", t: "قائمة", i: "🟡", c: "var(--neu)", bars,
    why: `مضى ${Math.round(bars)} شمعات ${tfName(tf)} — قائمة لكنها لم تبقَ في مهدها` };
  if (bars <= FRESH_BARS.late) return { k: "late", t: "متأخرة", i: "🟠", c: "#d98b4f", bars,
    why: `مضى ${Math.round(bars)} شمعة ${tfName(tf)} — أغلب الحركة المنسوبة إليها وقعت` };
  return { k: "stale", t: "قديمة", i: "🔴", c: "var(--dn)", bars,
    why: `مضى ${Math.round(bars)} شمعة ${tfName(tf)} — المرجع الذي بُنيت عليه خارج النافذة` };
}

const tfName = (tf) => ({ "5m": "٥ دقائق", "15m": "١٥ دقيقة", "1h": "ساعة", "4h": "٤ ساعات", "1d": "يومية", "1w": "أسبوعية" }[tf] || tf);

/* الفريم الذي تنتمي إليه إشارةُ شرطٍ ما. الشروط ليست كلها على فريم واحد:
   «توافق الفريمات» يشمل الأربعة فأبطأها هو الحاكم (اليومي)، و«حجم غير
   معتاد» حدثٌ يوميّ، و«أرباح خلال أسبوع» موعدٌ لا إشارة سعرية. */
const SCAN_TF = { align: "1d", alignDn: "1d", high52: "1d", low52: "1d",
                  vol: "1d", oversold: "1d", cheap: "1w", earn: "1d" };
const scanTF = (id) => SCAN_TF[id] || "1d";

/* =====================================================================
   ٢) جودة الدخول — الاتجاه شيء، وموضع السعر منه شيء آخر.

   سهمٌ «صاعد قوي» تحرّك ‎2.5×ATR‎ منذ الإشارة ليس فرصةً سيئة، لكنه ليس
   نفس الفرصة: الوقف صار أبعد والهدف أقرب، والعائد مقابل المخاطرة الذي
   كان ‎3:1‎ صار ‎1.2:1‎. القياس بـATR لا بالنسبة المئوية، لأن 3% في سهم
   مداه اليومي 1% حركةٌ هائلة، وفي بيتكوين حركةُ ساعة.

   المقياسان:
     · `moved` كم ATR تحرّك السعر من سعر الإشارة في اتجاهها.
     · `used`  كم من المسافة إلى الهدف الأول استُهلك.
   ===================================================================== */
function entryQuality({ px, sigPx, atr, dir, target, stop, fresh }) {
  if (!Number.isFinite(px) || !Number.isFinite(sigPx) || !Number.isFinite(atr) || atr <= 0) return null;
  if (dir !== 1 && dir !== -1) return null;

  const moved = (px - sigPx) * dir / atr;             // بمضاعفات المدى اليومي
  const used = (Number.isFinite(target) && Math.abs(target - sigPx) > 0)
    ? (px - sigPx) * dir / ((target - sigPx) * dir) : null;

  // ضُرب الوقف فعلاً: لا كلام عن دخول بعد ذلك
  if (Number.isFinite(stop) && (px - stop) * dir <= 0)
    return { k: "gone", t: "انتهت الفرصة", c: "var(--dn)", moved, used,
             act: "ضُرب الوقف — الخطة انتهت، ولا يُبنى دخولٌ على خطة ساقطة" };
  // بُلغ الهدف: انتهت بالنجاح لا بالفشل، والدخول الآن دخولٌ متأخر جداً
  if (used !== null && used >= 1)
    return { k: "gone", t: "انتهت الفرصة", c: "var(--mut)", moved, used,
             act: "بُلغ الهدف الأول — ما بعده حركةٌ لم تحسبها هذه الخطة" };

  if (fresh && fresh.k === "stale")
    return { k: "late", t: "متأخر", c: "#d98b4f", moved, used,
             act: "الإشارة قديمة بمقياس فريمها — انتظر إشارة جديدة لا سعراً أفضل" };

  if (moved <= 0.25) return { k: "good", t: "مناسب للدخول", c: "var(--up)", moved, used,
    act: "السعر قريب من سعر الإشارة — نفس العائد مقابل المخاطرة الذي حُسب" };
  if (moved <= 1) return { k: "ok", t: "مقبول", c: "var(--neu)", moved, used,
    act: "تحرّك أقل من مدى يوم — الخطة قائمة والعائد أقل قليلاً مما حُسب" };
  if (moved <= 2) return { k: "wait", t: "انتظر تراجعاً", c: "#d98b4f", moved, used,
    act: "تحرّك أكثر من مدى يوم — الدخول الآن يجعل الوقف بعيداً والعائد ضعيفاً" };
  return { k: "late", t: "متأخر", c: "var(--dn)", moved, used,
    act: "تحرّك أكثر من مدى يومين — أغلب حركة الإشارة وقعت قبل أن تراها" };
}

/* =====================================================================
   ٣) الزمن المتوقّع لكل هدف — تقدير معلَن لا وعد.

   الأساس: المسافة إلى الهدف مقسومةً على ما يقطعه السهم في الشمعة عادةً
   (ATR)، فيخرج **عدد الشمعات** المتوقّع. ثم يُعدَّل بالزخم: سهمٌ فريماته
   متوافقة يقطع مسافته أسرع من سهمٍ فريماته متعارضة.

   ولا نخترع رقماً حين لا يُحتمل: بلا ATR، أو بمسافة تحتاج أكثر من ستين
   شمعة، أو بفريمات متعارضة تماماً — تُعاد `null` وتقول الواجهة «غير
   واضح». المدى المعروض نطاقٌ (‎×0.6‎ إلى ‎×1.8‎) لا رقمٌ واحد، لأن التقدير
   الواحد يُقرأ وعداً.
   ===================================================================== */
function etaFor({ from, target, atr, dir, atrTf, tfScore }) {
  if (!Number.isFinite(from) || !Number.isFinite(target)) return null;
  if (!Number.isFinite(atr) || atr <= 0) return null;
  const dist = (target - from) * dir;
  if (!(dist > 0)) return null;

  // معامل الزخم: توافق الفريمات يُسرّع، وتعارضها يُبطئ. الحدّ ‎0.6–1.6‎
  // كي لا يصير المعامل هو التقدير كله.
  let mom = 1;
  const vals = Object.values(tfScore || {}).filter(Number.isFinite);
  if (vals.length) {
    const agree = vals.filter(v => (v > 0 ? 1 : -1) === dir).length / vals.length;
    const power = vals.reduce((a, b) => a + Math.abs(b), 0) / vals.length / 100;
    mom = Math.max(0.6, Math.min(1.6, 0.7 + agree * 0.6 + power * 0.3));
    // فريمات متعارضة تماماً: لا زخم يُعتمد عليه فلا تقدير
    if (agree <= 0.25) return null;
  }

  const bars = dist / atr / mom;
  if (!(bars > 0) || bars > 60) return null;          // أبعد من أن يُقدَّر

  /* ⚠ طول الشمعة يجب أن يكون **شمعةَ ATR نفسه** لا فريمَ الإشارة. القسمة
     تعطي «عدد شمعات ATR»، فضربها بطول شمعةٍ أخرى خلطُ وحدتين: ATR اليومي
     مع شمعة أسبوعية أخرج زمناً سبعة أمثال الصحيح — تقديرُ 93 يوماً لهدفٍ
     على بُعد 26%، وهو ما ظهر فعلاً في أول لقطة لشرط «أرخص من قطاعه». */
  const bar = TF_BAR[atrTf] || DAY;
  return { bars, lo: bars * 0.6 * bar, hi: bars * 1.8 * bar, mom };
}

/* المدة كنطاق مقروء. الوحدة تُختار من حجم المدة نفسها: «0.04 يوم» رقم
   صحيح لا يُقرأ، و«ساعة» تُقرأ. */
function spanText(lo, hi) {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return "غير واضح";
  const u = (ms) => ms / HOUR;
  const a = u(lo), b = u(hi);
  if (b < 1) return "أقل من ساعة";
  if (b <= 8) return `${Math.max(1, Math.round(a))}–${Math.round(b)} ساعة`;
  const ad = lo / DAY, bd = hi / DAY;
  if (bd <= 1.5) return "خلال يوم";
  if (bd <= 30) return `${Math.max(1, Math.round(ad))}–${Math.round(bd)} يوم`;
  return `${Math.round(ad / 7)}–${Math.round(bd / 7)} أسبوع`;
}

/* =====================================================================
   ٤) الآفاق الثلاثة — نتيجةٌ لكل مدى، لا نتيجةٌ واحدة تُخاصم نفسها.

   سهمٌ هابطٌ على ‎15د‎ وصاعدٌ على اليومي ليس تناقضاً بل وصفٌ صحيح لحالتين
   مختلفتين، والنتيجة المرجّحة الواحدة تخفي ذلك: متوسطُ ‎−80‎ و‎+80‎ صفرٌ
   يقول «عرضي» عن سهم لا شيء فيه عرضي.

   الوزن داخل الأفق من `TF_WEIGHT` نفسه المستعمل في النتيجة الكلية، فلا
   يختلف ترجيحان في التطبيق. والأسبوعي يُشتق من اليومي حين لا يوجد فريم
   أسبوعي مخزَّن — ويُقال ذلك في `note` بدل الإيهام بفريم لا نملكه.
   ===================================================================== */
const HORIZONS = [
  { id: "scalp", t: "لحظي", sub: "دقائق إلى ساعات", tfs: { "15m": 2, "1h": 1 },   tf: "15m" },
  { id: "swing", t: "يومي", sub: "ساعات إلى أيام",   tfs: { "1h": 1, "4h": 1.5, "1d": 1 }, tf: "4h" },
  { id: "pos",   t: "أسبوعي", sub: "أيام إلى أسابيع", tfs: { "4h": 1, "1d": 2 },  tf: "1d",
    note: "من اليومي و٤ ساعات — لا نخزّن فريماً أسبوعياً" }
];

function horizonsOf(tfScore) {
  const t = tfScore || {};
  return HORIZONS.map(h => {
    let sum = 0, w = 0;
    for (const [tf, weight] of Object.entries(h.tfs)) {
      if (!Number.isFinite(t[tf])) continue;
      sum += t[tf] * weight; w += weight;
    }
    const score = w > 0 ? sum / w : null;
    return { ...h, score, dir: score === null ? null : planDirOf2(score),
             missing: Object.keys(h.tfs).filter(tf => !Number.isFinite(t[tf])) };
  });
}

/* =====================================================================
   ٥) جودة الدخول كرقم — ‎0..100‎ مشتقٌّ من `entryQuality` لا موازٍ لها.

   الوسم («مناسب»/«انتظر تراجعاً») يكفي بطاقةً واحدة ولا يكفي ترتيباً:
   عشر استراتيجيات كلُّها «مقبول» لا تُرتَّب. والرقم يُشتقّ من **نفس**
   `moved` و`used` اللذين بُني عليهما الوسم، فلا يقولان شيئين مختلفين
   عن نفس الحالة — وهي علّة «نسختان من نفس الرياضيات» مطبَّقةً على
   مقياسين بدل ملفّين.

   ثلاثة مكوّنات معلنة، ويُعاد تفصيلها كي يكون الرقم مفسَّراً:
     · `mv` كم بقي من مدى الحركة قبل أن يصير الدخول متأخراً (‎2×ATR‎).
     · `us` كم بقي من المسافة إلى الهدف الأول.
     · `fr` طزاجة الإشارة بمقياس فريمها.

   و`moved` السالب يُقصّ عند الصفر: سعرٌ تحرّك **ضدّ** الإشارة دخولُه
   أرخص، لكنه لا يجعل الفرصة أفضل من فرصةٍ لم تتحرّك — ومكافأتُه
   تجعل أسوأ الإشارات أعلاها ترتيباً.
   ===================================================================== */
const FRESH_W = { fresh: 1, live: 0.85, late: 0.6, stale: 0.3 };

function entryScore(eq, fresh) {
  if (!eq) return null;
  if (eq.k === "gone") return { v: 0, mv: 0, us: 0, fr: 0, why: eq.act };
  const clamp = (x) => Math.max(0, Math.min(1, x));
  const mv = clamp(1 - Math.max(0, eq.moved) / 2);
  const us = Number.isFinite(eq.used) ? clamp(1 - eq.used) : 1;
  const fr = (fresh && FRESH_W[fresh.k]) || 0.6;
  const v = Math.round(100 * (0.45 * mv + 0.35 * us + 0.20 * fr));
  return { v: v, mv: mv, us: us, fr: fr, why: eq.act };
}

/* =====================================================================
   ٦) حالة الإشارة — ستّ حالات من مقياسين موجودين، لا مقياسٌ ثالث.

   الطزاجة تقول «كم مضى» وجودةُ الدخول تقول «كم تحرّك»، وهما سؤالان
   مختلفان يلتقيان في سؤالٍ واحد يطرحه المضارب: **هل أدخل الآن؟**
   إشارةٌ عمرها شمعتان تحرّك فيها السهم ‎2.5×ATR‎ ليست «طازجة» بأي
   معنى مفيد — والعمر وحده كان سيقول إنها كذلك.

   والترتيب مقصود: النافية أولاً. فما انتهى لا يُسمّى جديداً مهما كان
   عمره، وما امتدّ لا يُسمّى قائماً.
   ===================================================================== */
const STATUS = {
  NEW:      { k: "NEW",      t: "جديدة",      c: "var(--up)" },
  FRESH:    { k: "FRESH",    t: "طازجة",      c: "var(--up)" },
  ACTIVE:   { k: "ACTIVE",   t: "قائمة",      c: "var(--neu)" },
  LATE:     { k: "LATE",     t: "متأخرة",     c: "#d98b4f" },
  EXTENDED: { k: "EXTENDED", t: "امتدّت",     c: "#d98b4f" },
  EXPIRED:  { k: "EXPIRED",  t: "انتهت",      c: "var(--dn)" }
};

function signalStatus(fresh, eq, ageMs, tf) {
  if (!fresh) return null;
  const bar = TF_BAR[tf] || DAY;
  const why = (t, d) => ({ ...t, why: d });

  if ((eq && eq.k === "gone") || fresh.k === "stale")
    return why(STATUS.EXPIRED, (eq && eq.k === "gone") ? eq.act : fresh.why);
  if (eq && eq.k === "late")
    return why(STATUS.EXTENDED, "تحرّك أكثر من مدى يومين منذ الإشارة — الحركة وقعت");
  if (fresh.k === "late" || (eq && eq.k === "wait"))
    return why(STATUS.LATE, (eq && eq.k === "wait") ? eq.act : fresh.why);
  if (Number.isFinite(ageMs) && ageMs < bar)
    return why(STATUS.NEW, `ظهرت داخل شمعة ${tfName(tf)} الجارية`);
  if (fresh.k === "fresh") return why(STATUS.FRESH, fresh.why);
  return why(STATUS.ACTIVE, fresh.why);
}

/* درجة اكتمال فرصة PRO. ليست احتمال نجاح؛ تجمع توافق الفريمات وقوة
   الاتجاه والعائد/المخاطرة وطزاجة البيانات والنشاط، مع خصم خطر الأرباح. */
function opportunityQuality({ score, tfScore, dir, rr, stale = false,
                              volRatio = null, earnDays = null }) {
  const vals = Object.values(tfScore || {}).filter(Number.isFinite);
  const side = dir === -1 ? -1 : 1;
  const agree = vals.length ? vals.filter(v => (v >= 0 ? 1 : -1) === side).length / vals.length : 0;
  const alignment = Math.round(agree * 30);
  const strength = Math.round(Math.min(1, Math.abs(Number(score) || 0) / 80) * 25);
  const reward = Number.isFinite(rr) && rr > 0 ? Math.round(Math.min(1, rr / 3) * 25) : 0;
  const fresh = stale ? 0 : 10;
  const activity = Number.isFinite(volRatio) && volRatio > 0
    ? Math.round(Math.min(1, volRatio / 2) * 10) : 4;
  const eventPenalty = Number.isFinite(earnDays) && earnDays >= 0 && earnDays <= 7 ? 12 : 0;
  const value = Math.max(0, Math.min(100, alignment + strength + reward + fresh + activity - eventPenalty));
  const grade = value >= 80 ? "ممتازة" : value >= 65 ? "قوية" : value >= 50 ? "متوازنة" : "حذرة";
  return {
    value, grade, agree, eventPenalty,
    parts: { alignment, strength, reward, fresh, activity },
    why: `توافق ${Math.round(agree * 100)}% · اتجاه ${strength}/25 · عائد ${reward}/25 · بيانات ${fresh}/10 · نشاط ${activity}/10${eventPenalty ? ` · خصم أرباح ${eventPenalty}` : ""}`
  };
}

/* نفس حدّ `planDirOf` في `plan.js`، مكرَّرٌ هنا لأن `evaluate.js` لا
   يعتمد على `plan.js` — والحدّ رقمٌ واحد لا منطق، وربطُ الملفين لأجله
   يجعل ترتيب تحميل السكربتات شرطاً على العمل. */
const planDirOf2 = (score) => (Number.isFinite(score) && score < -15) ? -1 : 1;

if (typeof module !== "undefined" && module.exports) {
  module.exports = { freshness, tfName, scanTF, SCAN_TF, TF_BAR, FRESH_BARS,
                     entryQuality, entryScore, signalStatus, STATUS, FRESH_W,
                     etaFor, spanText, horizonsOf, HORIZONS, opportunityQuality };
}
