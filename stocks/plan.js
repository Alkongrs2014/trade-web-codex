/* =====================================================================
   نواة خطة الصفقة — نسخة واحدة يقرأها المتصفح والخادم معاً.

   لماذا ملف مستقل: السجلّ (`history.json`) يحفظ الخطة **كما رآها
   المستخدم** لحظة الإشارة، والخادم هو من يكتبه. لو عاشت الرياضيات في
   `index.html` وحدها لاحتاج الخادم نسخةً ثانية — ونسختان من نفس الحساب
   تتباعدان بأول تعديل، فيصير السجلّ يقول إن الهدف كان 106 والمستخدم رأى
   112. وهي نفس علّة `scans.js` بالضبط، ونفس الحلّ.

   يُحمَّل في المتصفح كسكربت كلاسيكي (‎<script src="plan.js">‎)، ويُقرأ
   في Node عبر `module.exports`. لا وحدات ES ولا مُجمِّع.

   الملف **نقيّ**: أرقام تدخل وأرقام تخرج، بلا `state` ولا DOM ولا قراءة
   ملفات. من يريد استعماله يجمع المدخلات بنفسه — `levelsInputs` في
   المتصفح من `state`، و`planInputsFor` في الخادم من ملفات `data/`.
   ===================================================================== */

/* الشمعات تُحفظ مضغوطة `[t,o,h,l,c,v]` والزمن بالثواني. بلا الفكّ:
   `Cannot read properties of undefined (reading 'toFixed')` — مصيدة
   موثّقة، ولهذا الفكّ هنا لا عند كل مستهلك. */
function unpackK(arr) {
  return (Array.isArray(arr) && Array.isArray(arr[0]))
    ? arr.map(a => ({ t: a[0] * 1000, o: a[1], h: a[2], l: a[3], c: a[4], v: a[5] }))
    : (arr || []);
}

/* =====================================================================
   المستويات — مصدرٌ واحد يخدم العرضَ والخطة.

   لو حسبتها الخطة بنفسها لاختلف الدعم المعروض في الجدول عن الدعم
   المستعمل في الخطة: رقمان مختلفان لنفس الشيء في نفس الشاشة.

   `a` هو مخرَج `analyze` للفريم الأساس (‎4h‎ إن كفت شمعاته، وإلا اليومي)
   — يأتي محسوباً من `an` في ملف الرمز على الخادم، ومن `analyze` في
   المتصفح. لا يُعاد حسابه هنا كي لا تصير الأرقام ثلاث نسخ.
   ===================================================================== */
function levelsFrom({ k4h, k1d, px, a, w52h, w52l }) {
  const k = unpackK(k4h), d = unpackK(k1d);
  const base = k && k.length > 20 ? k : d;
  if (!base || !base.length) return null;
  const P0 = Number.isFinite(px) ? px : base[base.length - 1].c;
  if (!Number.isFinite(P0)) return null;
  const levels = [];

  if (d && d.length > 2) {
    const y = d[d.length - 2];
    const P = (y.h + y.l + y.c) / 3;
    levels.push({ p: 2 * P - y.l, n: "بيفوت R1" });
    levels.push({ p: P + (y.h - y.l), n: "بيفوت R2" });
    levels.push({ p: 2 * P - y.h, n: "بيفوت S1" });
    levels.push({ p: P - (y.h - y.l), n: "بيفوت S2" });
    levels.push({ p: P, n: "نقطة الارتكاز" });
  }
  const win = base.slice(-120);
  for (let i = 3; i < win.length - 3; i++) {
    if (win.slice(i - 3, i + 4).every(c => c.h <= win[i].h)) levels.push({ p: win[i].h, n: "قمة سابقة" });
    if (win.slice(i - 3, i + 4).every(c => c.l >= win[i].l)) levels.push({ p: win[i].l, n: "قاع سابق" });
  }
  if (a && a.e200) levels.push({ p: a.e200, n: "متوسط EMA 200" });
  if (a && a.e50)  levels.push({ p: a.e50,  n: "متوسط EMA 50" });
  if (Number.isFinite(w52h)) levels.push({ p: w52h, n: "قمة 52 أسبوعاً" });
  if (Number.isFinite(w52l)) levels.push({ p: w52l, n: "قاع 52 أسبوعاً" });

  levels.sort((x, y) => x.p - y.p);
  const merged = [];
  levels.forEach(l => {
    const m = merged[merged.length - 1];
    if (m && Math.abs(l.p - m.p) / m.p < 0.004) {
      m.names.add(l.n); m.ps.push(l.p);
      m.p = m.ps.reduce((x, y) => x + y, 0) / m.ps.length;
    } else merged.push({ p: l.p, ps: [l.p], names: new Set([l.n]) });
  });

  // ثلاثة للعرض، وستة لخطة الصفقة: الخطة تحتاج مدى أوسع كي تجد هدفاً
  // يستحق المخاطرة، وأول مقاومة بعد السعر غالباً تعطي عائداً = الخطر
  const above = merged.filter(l => l.p > P0);
  const below = merged.filter(l => l.p < P0);
  return {
    px: P0, atr: (a && a.atr) || null,
    res: above.slice(0, 3).reverse(),
    sup: below.slice(-3).reverse(),
    resAll: above.slice(0, 6),          // من الأقرب إلى الأبعد
    supAll: below.slice(-6).reverse()   // من الأقرب إلى الأبعد
  };
}

/* الاتجاه من إشارة النتيجة الفنية بنفس حدود `labelOf`: ما تحت ‎−15‎ هبوط،
   وما فوقه — والمحايد معه — يبقى شراءً. المحايد لا تُخفى خطته: إخفاؤها
   لكل سهم عرضي يُفرغ الخطة من أكثر الأسهم في أكثر الأوقات. */
function planDirOf(score) {
  return (Number.isFinite(score) && score < -15) ? -1 : 1;
}

/* =====================================================================
   الخطة — **موقَّعة باتجاه** في مسار حسابي واحد لا فرعين.

   نسختان من نفس الرياضيات، واحدة للشراء وأخرى للبيع، تتباعدان بأول
   تعديل فيصير الرقم في شاشة غير الرقم في شاشة أخرى. وقبل هذا التوقيع
   كانت الدالة شراءً دائماً بلا أن تسأل عن الاتجاه: سهمٌ نتيجته ‎−97‎
   تُبنى له أهداف **فوق** سعره لأنها تُشتق من المقاومات ولا شيء يقلبها.
   ===================================================================== */
function planFrom({ px, atr, resAll, supAll }, d) {
  if (!Number.isFinite(px) || px <= 0) return null;
  if (!Number.isFinite(atr) || atr <= 0) return null;
  if (d !== 1 && d !== -1) return null;
  const res = resAll || [], sup = supAll || [];

  // الحاجز في جهة الرجوع: دعمٌ يُشترى عنده في الصعود، ومقاومةٌ يُباع عندها
  // في الهبوط. وحاجزٌ يبعد 12% ليس منطقة دخول بل انتظارٌ قد لا ينتهي.
  const back = (d > 0 ? sup : res)[0] || null;
  const farBack = back !== null && Math.abs(px - back.p) / px > 0.12;
  const brk = (back !== null && !farBack) ? back.p : null;
  const entry = brk !== null ? brk : px;
  const entryIsNow = entry === px;

  // الوقف خلف الحاجز بنصف ATR، وبحدٍّ أدنى ATR كامل خلف الدخول: الوقف
  // الملاصق للحاجز يُضرب بالتذبذب الطبيعي حتى لو صحّ التحليل.
  const stop = d > 0
    ? Math.min(entry - atr * 0.5, entry - atr, brk !== null ? brk - atr * 0.5 : Infinity)
    : Math.max(entry + atr * 0.5, entry + atr, brk !== null ? brk + atr * 0.5 : -Infinity);

  const risk = (entry - stop) * d;     // موجب في الاتجاهين معاً
  if (!(risk > 0)) return null;

  // أهداف متعددة لا هدف واحد. أخذُ أول حاجز بعد ATR يجعل العائد مساوياً
  // للخطر دائماً (خرجت النسبة ~1:1 لكل سهم جرّبناه)، فتصير الخطة عديمة
  // الفائدة. نعرض المتاح بنسبه ونترك الاختيار ظاهراً.
  const pool = d > 0 ? res : sup;      // كلاهما مرتَّب من الأقرب إلى الأبعد
  const targets = pool
    .filter(l => (l.p - entry) * d >= atr)
    .slice(0, 3)
    .map(l => ({ p: l.p, rr: (l.p - entry) * d / risk, pct: (l.p - entry) * d / entry * 100,
                 name: (l.names ? [...l.names][0] : l.n) || (d > 0 ? "مقاومة" : "دعم") }));
  const skippedNear = !!(pool.length && (pool[0].p - entry) * d < atr);

  // الهدف الأساسي أول ما يبلغ 2:1، وإلا فأبعد المتاح مع قول ذلك صراحةً
  const primary = targets.find(t => t.rr >= 2) || targets[targets.length - 1] || null;
  const meets2 = !!(primary && primary.rr >= 2);

  return { dir: d, px, entry, entryIsNow, stop, atr, risk, targets, primary, meets2, skippedNear,
           target: primary ? primary.p : null,
           rr: primary ? primary.rr : null,
           targetPct: primary ? primary.pct : null,
           stopPct: risk / entry * 100,
           atrPct: atr / entry * 100 };
}

/* =====================================================================
   بوابة الاتجاه — تُقرأ الخطة قبل عرضها أو حفظها.

   لا تُصلح شيئاً: تقول ما اختلّ وتردّ الخطة. خطةٌ أهدافها في الجهة
   الخاطئة كذبٌ يبدو موثوقاً لأنه ظاهر برقم — وعرضُها أسوأ من ألّا تُعرض
   خطة. هي قاعدة «اعرض ‎—‎ لا رقماً ملفّقاً» مطبَّقة على خطة كاملة.
   ===================================================================== */
function validatePlan(p) {
  if (!p) return ["لا خطة"];
  const bad = [], d = p.dir;
  if (d !== 1 && d !== -1) { bad.push("اتجاه غير معروف"); return bad; }

  // `Number.isFinite` لا `isFinite` العالمية: هذه تحوّل null إلى صفر فتقبله
  [["الدخول", p.entry], ["الوقف", p.stop], ["المخاطرة", p.risk], ["المدى", p.atr]]
    .forEach(([k, v]) => { if (!Number.isFinite(v)) bad.push(k + " ليس رقماً"); });
  if (!(p.risk > 0)) bad.push("المخاطرة غير موجبة");
  if ((p.stop - p.entry) * d >= 0) bad.push("الوقف في جهة الهدف لا خلفَ الدخول");

  let prev = p.entry;
  (p.targets || []).forEach((t, i) => {
    if (!Number.isFinite(t.p) || !Number.isFinite(t.rr)) { bad.push(`الهدف ${i + 1} ليس رقماً`); return; }
    if ((t.p - p.entry) * d <= 0) bad.push(`الهدف ${i + 1} في الجهة الخاطئة من الدخول`);
    else if (i > 0 && (t.p - prev) * d < 0) bad.push(`الهدف ${i + 1} أقرب من الذي قبله`);
    prev = t.p;
  });
  if (p.primary && (p.primary.p - p.entry) * d <= 0) bad.push("الهدف الأساسي في الجهة الخاطئة");
  return bad;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { unpackK, levelsFrom, planDirOf, planFrom, validatePlan };
}
