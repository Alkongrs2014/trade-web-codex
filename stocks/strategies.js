/* =====================================================================
   ماسح الاستراتيجيات — تعريف الاستراتيجيات ونواة تقييمها.
   نسخة واحدة يقرأها المتصفح والخادم معاً.

   لماذا ملف مستقل وبهذا النمط: نفس سبب `scans.js` و`plan.js` بالحرف.
   الخادم يحسب الحالة ويكتبها في `strategies.json`، والمتصفح يعرضها
   ويعيد حساب ما يلزم للرسم. نسختان من نفس البوابات تتباعدان بأول
   تعديل، فيصير المحفوظ غير المعروض — وهي العلّة التي جعلت `plan.js`
   و`scans.js` و`score.js` ملفّاتٍ مشتركة، والثمن نفسه هنا.

   وملفٌّ واحد لا مجلَّدٌ بملفٍ لكل استراتيجية: عشرة ملفات تعني عشرة
   وسوم `<script>` وعشرة مدخلات في `CORE` بـ`sw.js` وعشر فرصٍ لتعارض
   اسمٍ في نطاقٍ كلاسيكي مشترك — وهي مصيدة موثّقة وقعت فعلاً
   (`pctRank` بدلالتين). الإضافة هنا صفٌّ في `STRATEGIES`.

   ---------------------------------------------------------------------
   البنية: مشغِّلٌ ثم بوابات.

   `side(c)` المشغِّل — يقرّر الجهة المرشَّحة أو `0` فتكون الاستراتيجية
   غير مفعَّلة أصلاً. ثم `gates` تقيس **قوّة التأييد لتلك الجهة**:
   كلٌّ تصوّت ‎+1‎ (تؤيّد) أو ‎−1‎ (تناقض) أو ‎0‎ (حائرة)، والنتيجة
   مجموعُها المرجَّح منقولاً من ‎−1..+1‎ إلى ‎0..100‎.

   ففَصلُ «هل ظهرت؟» عن «كم هي قويّة؟» مقصود: خلطُهما يعطي رقماً
   متوسّطاً لا يُعرف أهو إشارةٌ ضعيفة أم لا إشارة — وهما قراران
   مختلفان تماماً للمضارب.

   ---------------------------------------------------------------------
   `kind` على كل بوابة — إيقاعان بلا نسختين.

   دورة السوق (عشر دقائق) تحسب كل شيء. ودورة الأسعار (دقيقتان) تحسب
   البوابات `price` وحدها وتأخذ تصويت `ind` من الدورة السابقة كما هو.
   والدالّة **واحدة** في الحالتين (`evalGates` بـ`only`)، فلا يوجد
   مسارٌ سريع يتباعد عن المسار الكامل.

   وشرط القبول مقارنةٌ ذهبية في `check-strategies.mjs`: بنفس المدخلات
   يعطي المساران **نفس الرقم بالضبط**.

   ولماذا لا تُعاد المؤشّرات كل دقيقتين: قاعدة موثّقة — حساب RSI أو
   MACD من سعرٍ واحد بلا شمعةٍ جديدة يعطي رقماً كاذباً. فتُجمَّد
   وتُعلَن طزاجتها في الواجهة بدل أن تُزوَّر.
   ===================================================================== */

/* في Node لا تُحمَّل الملفات المشتركة عالمياً كما في المتصفح (حيث كل
   `<script>` يتشارك نطاقاً واحداً). نفس شيم `fmt` في `scans.js`. */
if (typeof DEAD_ATR === "undefined" && typeof require === "function") {
  try {
    var _S = require("./score.js"), _I = require("./indicators.js"), _P = require("./plan.js");
    globalThis.DEAD_ATR = _S.DEAD_ATR;
    globalThis.sessionVwap = _I.sessionVwap;
    globalThis.openingRange = _I.openingRange;
    globalThis.volMedian = _I.volMedian;
    globalThis.bbWidth = _I.bbWidth;
    globalThis.rankInWindow = _I.rankInWindow;
    globalThis.confirmedCandles = _I.confirmedCandles;
    globalThis.unpackK = _P.unpackK;
    globalThis.levelsFrom = _P.levelsFrom;
    globalThis.planFrom = _P.planFrom;
    globalThis.validatePlan = _P.validatePlan;
  } catch (e) { /* المتصفح لا يمرّ من هنا أصلاً */ }
}

/* عتبة التفعيل: ما دونها لا تُعرض الاستراتيجية إشارةً ولا تدخل الإجماع.
   ليست رقماً ذوقياً: ‎50‎ هي نقطة «البوابات متعادلة» في تحويل ‎−1..+1‎
   إلى ‎0..100‎، فما دون ‎55‎ تأييدٌ لا يتجاوز التعادل بهامش. */
var ACT_MIN = 55;
/* حدود الوسم — وهامشها ‎3‎ نقاط كهيستريسس `bandStable` في `score.js`،
   لنفس السبب: رقمٌ يستقرّ على الحدّ يعبره ذهاباً وإياباً، ومن يرى
   «قوي» ثم «متوسط» ثم «قوي» يقرأها إشاراتٍ متناقضة لا رقماً يهتزّ. */
var S_BANDS = [55, 70, 85];
var S_MARGIN = 3;
var S_LABEL = ["ضعيف", "متوسط", "قوي", "قوي جداً"];

function sBandOf(sc) {
  if (!Number.isFinite(sc)) return null;
  var n = 0;
  for (var i = 0; i < S_BANDS.length; i++) if (sc >= S_BANDS[i]) n++;
  return n;                                                   // 0..3
}
function sBandStable(sc, prev) {
  var now = sBandOf(sc);
  if (now === null) return null;
  if (!Number.isFinite(prev) || prev < 0 || prev > 3) return now;
  var b = prev;
  while (b < 3 && sc >= S_BANDS[b] + S_MARGIN) b++;
  while (b > 0 && sc <= S_BANDS[b - 1] - S_MARGIN) b--;
  return b;
}

/* ---------------------------------------------------------------------
   أدوات البوابات — كلُّها تحترم المنطقة الميتة.

   `cmp` هي `cmp` نفسها في `score.js` بمخرَجٍ ‎−1/0/+1‎ بدل وزنٍ موقَّع:
   فرقٌ أصغر من ‎0.15×ATR‎ لا يصوّت لأيّ جهة. وبلا هذا تنقلب البوابة
   من حركةٍ لا يراها أحد — وهي العلّة المقيسة التي جعلت أبل تتذبذب
   ‎95 → 60 → 98‎ في عشرين دقيقة.
   --------------------------------------------------------------------- */
function tolOf(atr) { return (Number.isFinite(atr) && atr > 0) ? atr * DEAD_ATR : 0; }

function cmp(a, b, atr) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;   // غائبة لا محايدة
  var d = a - b, t = tolOf(atr);
  return Math.abs(d) <= t ? 0 : (d > 0 ? 1 : -1);
}
/* بوابةٌ موقَّعة باتجاه الاستراتيجية: تؤيّد حين يوافق الفرقُ الجهة. */
function cmpD(a, b, atr, d) { var v = cmp(a, b, atr); return v === null ? null : v * d; }

/* هل يوافق رقمٌ ذو إشارة (نتيجة فريم مثلاً) اتجاهَ الاستراتيجية؟
   `flat` منطقةُ حيادٍ صريحة — نتيجةٌ قرب الصفر لا تؤيّد ولا تناقض. */
function agree(v, d, flat) {
  if (!Number.isFinite(v)) return null;
  flat = flat || 0;
  if (Math.abs(v) <= flat) return 0;
  return (v > 0 ? 1 : -1) === d ? 1 : -1;
}
/* بوابةُ نطاق: ‎+1‎ داخل المدى المفضَّل، ‎−1‎ خارجه، ‎0‎ على حافّته. */
function inRange(v, lo, hi) {
  if (!Number.isFinite(v)) return null;
  if (v >= lo && v <= hi) return 1;
  var m = (hi - lo) * 0.25;
  if (v >= lo - m && v <= hi + m) return 0;
  return -1;
}
var lastOf = function (a) { return (a && a.length) ? a[a.length - 1] : null; };

/* =====================================================================
   نواة التقييم — دالّةٌ واحدة للإيقاعين.

   `only: "price"` تعيد حساب البوابات السعرية وحدها وتأخذ تصويت
   المؤشرية من `prev.g` كما هو. وبوابةٌ مؤشرية **بلا سابقة تُسقَط**
   ولا تُعامَل محايدة: «لا نعرف» ليست «متعادلة»، وإضافتها إلى المقام
   بصفرٍ تخفض كل نتيجةٍ بلا سبب.
   ===================================================================== */
function evalGates(gates, c, d, opt) {
  opt = opt || {};
  var only = opt.only, prev = opt.prev, pm = {};
  if (prev && prev.g) for (var i = 0; i < prev.g.length; i++) pm[prev.g[i][0]] = prev.g[i][2];
  var sum = 0, max = 0, out = [];
  for (var j = 0; j < gates.length; j++) {
    var g = gates[j], vote;
    if (only && g.kind !== only) {
      if (!(g.id in pm)) continue;                 // بلا سابقة — غائبة
      vote = pm[g.id];
    } else {
      try { vote = g.v(c, d); } catch (e) { vote = null; }
    }
    if (vote === null || vote === undefined || !Number.isFinite(vote)) continue;
    max += g.w; sum += g.w * vote;
    out.push([g.id, g.w, vote]);
  }
  if (!(max > 0)) return null;
  return { sc: Math.round((sum / max + 1) / 2 * 100), g: out, w: max };
}

/* تقييم استراتيجية واحدة. تعيد دائماً كائناً — و`off` يقول لماذا لا
   تعمل بدل أن تختفي بصمت. غيابُ الاستراتيجية بلا سبب يُقرأ عطلاً،
   وهو ما يجعل «الوضع المُصغَّر» مفهوماً بدل أن يبدو خللاً. */
function evalStrategy(st, c, opt) {
  opt = opt || {};
  var base = { id: st.id, lbl: st.lbl, fam: st.fam, tf: st.tf, dir: 0, sc: null, off: null };
  var why = st.ready ? st.ready(c) : null;
  if (why) return Object.assign(base, { off: why });
  var d;
  try { d = st.side(c); } catch (e) { d = 0; }
  if (d !== 1 && d !== -1) return Object.assign(base, { off: null, quiet: true });
  var r = evalGates(st.gates, c, d, opt);
  if (!r) return Object.assign(base, { off: "لا بوابة صالحة — بياناتٌ ناقصة" });
  return Object.assign(base, {
    dir: d, sc: r.sc, g: r.g, w: r.w,
    tfUsed: st.tfOf ? st.tfOf(c) : st.tf,
    band: sBandStable(r.sc, opt.prev && opt.prev.band),
    active: r.sc >= ACT_MIN,
    lv: st.levels ? st.levels(c, d) : null
  });
}

/* =====================================================================
   سياق التقييم — يُبنى مرةً لكل رمز ويقرؤه العشرة.

   المستويات المشتقّة (VWAP، نطاق الافتتاح، الدعوم والمقاومات، سلاسل
   عرض بولنجر) تُحسب هنا لا داخل كل استراتيجية: حسابُها عشر مرات يكرّر
   العمل، والأسوأ أنه يسمح لاستراتيجيتين أن تريا VWAP مختلفَين.

   `sess` تُمرَّر ولا تُشتقّ: الخادم يعرفها من `session.mjs` والمتصفح
   من دالّته، وهذا الملف يبقى رياضياتٍ خالصة بلا استيراد بيئة.
   ===================================================================== */
function sameUtcDay(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  var x = new Date(a), y = new Date(b);
  return x.getUTCFullYear() === y.getUTCFullYear() && x.getUTCMonth() === y.getUTCMonth()
      && x.getUTCDate() === y.getUTCDate();
}

function buildCtx(o) {
  var rec = o.rec || {}, row = o.row || {}, an = rec.an || {};
  var now = Number.isFinite(o.now) ? o.now : Date.now();
  var k = {}, raw = {}, tfs = rec.tf || {};
  for (var tf in tfs) {
    var cc = tfs[tf] && tfs[tf].c;
    if (!cc || !cc.length) continue;
    raw[tf] = unpackK(cc);
    k[tf] = (tf === "4h" || typeof confirmedCandles !== "function") ? raw[tf]
      : confirmedCandles(raw[tf], tf, now, rec.mkt || row.mkt || null, o.sess || null);
  }

  var px = [o.px, row.p, an["5m"] && an["5m"].px, an["1d"] && an["1d"].px]
             .filter(Number.isFinite)[0];
  var period = rec.period || null;
  /* الفترات المحفوظة تصف **يوم جلبها** — مصيدة موثّقة. فاستعمالها في
     يومٍ تالٍ يعطي نطاق افتتاحٍ من الأمس تحت عنوان اليوم. */
  var today = !!(period && period.regular && sameUtcDay(period.regular.start, now));

  var iTf = k["5m"] ? "5m" : (k["15m"] ? "15m" : null);
  var lv = { iTf: iTf };
  if (iTf && today) {
    /* VWAP ونطاق الافتتاح يصفان الجلسة الحية، فيقرآن الخام. أما إشارات
       الاتجاه نفسها فتقرأ `k` المؤكدة أعلاه. */
    lv.vwap = sessionVwap(raw[iTf] || k[iTf], period);
    // نافذة النطاق تتبع الفريم: ‎15د‎ على ‎5د‎ تعطي ثلاث شمعات، وعلى
    // ‎15د‎ تعطي واحدة — و«نطاق» من شمعةٍ واحدة هو الشمعة نفسها.
    lv.or = openingRange(raw[iTf] || k[iTf], period, iTf === "5m" ? 15 : 30);
  }
  var base = an["4h"] || an["1d"] || null;
  lv.L = (k["1d"] && base) ? levelsFrom({
    k4h: k["4h"], k1d: k["1d"], px: px, a: base,
    w52h: row.w52h, w52l: row.w52l, now: now
  }) : null;

  // سلاسل عرض بولنجر — يحتاجها `sqzExp` ليعرف «كان منضغطاً ثم توسّع»،
  // و`an` لا تحفظ إلا القيمة الأخيرة.
  var bw = {};
  ["15m", "1h", "4h", "1d"].forEach(function (t) {
    if (!k[t] || k[t].length < 40) return;
    bw[t] = bbWidth(k[t].map(function (x) { return x.c; }), 20, 2);
  });

  return { s: rec.s || row.s, px: px, now: now, k: k, an: an, row: row,
           f: o.f || null, period: period, today: today, sess: o.sess || null,
           mkt: rec.mkt || row.mkt || null, lv: lv, bw: bw,
           tfScore: row.tfScore || null, wide: !!o.wide };
}

/* حجم الشمعة **المكتملة** الأخيرة لا الجارية: الجارية تتراكم، فمقارنة
   حجمٍ نصفِ مكتمل بوسيط شمعاتٍ كاملة تقول «الحجم ضعيف» في أول دقائق
   كل شمعة ثم «قوي» في آخرها — تذبذبٌ مصدرُه القياس لا السوق. */
function volRatio(c, tf, win) {
  var a = c.k[tf];
  if (!a || a.length < 8) return null;
  var last = a[a.length - 2];
  var med = volMedian(a.slice(0, -1), win || 20);
  if (!last || !Number.isFinite(last.v) || !(last.v > 0) || !(med > 0)) return null;
  return last.v / med;
}
/* موضع الإغلاق داخل مدى الشمعة: ‎1‎ عند القمّة و‎0‎ عند القاع. شمعةُ
   حجمٍ تغلق في منتصف مداها لا تقول جهة — الحجم وحده ليس اتجاهاً. */
function closePos(x) {
  if (!x || !Number.isFinite(x.h) || !Number.isFinite(x.l) || !(x.h > x.l)) return null;
  return (x.c - x.l) / (x.h - x.l);
}

/* أعلى وأدنى نافذةٍ سابقة — تعريفُ «المستوى» في `brk`. تُستثنى آخر
   شمعتين كي لا يقارَن السعر بقمّةٍ صنعها هو نفسه قبل دقائق. */
function donch(c, tf, n) {
  var k = c.k[tf];
  n = n || 25;
  if (!k || k.length < n + 4) return null;
  var w = k.slice(-n, -2);
  if (!w.length) return null;
  var hi = -Infinity, lo = Infinity;
  for (var i = 0; i < w.length; i++) { if (w[i].h > hi) hi = w[i].h; if (w[i].l < lo) lo = w[i].l; }
  return (hi > lo) ? { hi: hi, lo: lo } : null;
}
/* مئينُ قيمةٍ داخل نافذة — `rankInWindow` تعطي مئين **آخر** قيمة، و
   `sqzExp` يحتاج مئين أضيق عرضٍ قبل التوسّع لا مئين العرض الحالي. */
function pctOf(arr, v, win) {
  if (!Array.isArray(arr) || !Number.isFinite(v)) return null;
  var w = arr.slice(-(win || 120)).filter(Number.isFinite);
  if (w.length < 20) return null;
  var n = 0;
  for (var i = 0; i < w.length; i++) if (w[i] <= v) n++;
  return n / w.length * 100;
}
/* =====================================================================
   الفريم الذي يعمل عليه شرطٌ ما: ‎15د‎ ثم الساعة ثم **اليومي**.

   والسقوط إلى اليومي هو ما يجعل «الوضع المُصغَّر» مفيداً بدل أن يكون
   إعلانَ عجز: كلُّ رمزٍ في الكون (510) له ملفٌّ فيه 260 شمعة يومية
   ومؤشّراتها كاملة، والطبقةُ الواسعة تنقصها الفريمات اللحظية وحدها.
   فاختراقُ نافذةٍ ودفعةُ حجمٍ وعودةٌ من حافّة بولنجر تُقاس على اليومي
   بنفس الرياضيات تماماً — وهي تعريفاتُها الكلاسيكية أصلاً.

   ⚠ والفريم المستعمل **يُعلَن في المخرَج** (`tfUsed`) وتعرضه الواجهة:
   شرطٌ يقيس ١٥ دقيقة على رمزٍ ويوماً على آخر يصف حالتين مختلفتين، وعدمُ
   قوله يجعل رقمين غير متقارنين يبدوان متقارنين. ولنفس السبب يفصل
   الأرشيف حافّة كل فريم على حِدة.
   ===================================================================== */
function sqTf(c) { return c.bw["1h"] ? "1h" : (c.bw["4h"] ? "4h" : (c.bw["1d"] ? "1d" : null)); }
function iTf15(c) { return c.k["15m"] ? "15m" : (c.k["1h"] ? "1h" : (c.k["1d"] ? "1d" : null)); }

var STRATEGIES = [

/* ===== ١) كسر نطاق الافتتاح ======================================== */
{ id: "orb", lbl: "كسر نطاق الافتتاح", fam: "session", tf: "5m", src: "intraday",
  why: "أول خمس عشرة دقيقة من الجلسة ترسم نطاقاً يحمل معظم سيولة الافتتاح، والخروج منه بوضوح يُقرأ قراراً. لا يعمل إلا داخل الجلسة الرسمية وبعد اكتمال النطاق — ونطاقٌ قيد التكوّن لا يُكسَر.",
  ready: function (c) {
    if (!c.lv.iTf) return "لا فريم لحظي لهذا الرمز (الوضع المُصغَّر)";
    if (c.sess !== "REGULAR") return "خارج الجلسة الرسمية — لا نطاق افتتاح";
    if (!c.today) return "فترات الجلسة المحفوظة تصف يوماً سابقاً";
    if (!c.lv.or) return "شمعات الافتتاح لم تصل بعد";
    if (!c.lv.or.complete) return "نطاق الافتتاح ما زال يتكوّن";
    return null;
  },
  side: function (c) {
    var a = c.an[c.lv.iTf], or = c.lv.or;
    if (!a || !or) return 0;
    var t = tolOf(a.atr);
    return c.px > or.hi + t ? 1 : (c.px < or.lo - t ? -1 : 0);
  },
  gates: [
    { id: "orClear", lbl: "وضوح الكسر", w: 2.0, kind: "price", v: function (c, d) {
        var a = c.an[c.lv.iTf], or = c.lv.or;
        if (!a || !or || !(a.atr > 0)) return null;
        var x = (c.px - (d > 0 ? or.hi : or.lo)) * d / a.atr;
        return x >= 0.4 ? 1 : (x >= 0.2 ? 0 : -1); } },
    { id: "orChase", lbl: "لم يفت الكسر", w: 1.5, kind: "price", v: function (c, d) {
        var a = c.an[c.lv.iTf], or = c.lv.or;
        if (!a || !or || !(a.atr > 0)) return null;
        var x = (c.px - (d > 0 ? or.hi : or.lo)) * d / a.atr;
        return x <= 1.5 ? 1 : (x <= 2.5 ? 0 : -1); } },
    { id: "vwapSide", lbl: "الجهة الصحيحة من VWAP", w: 2.0, kind: "price", v: function (c, d) {
        var a = c.an[c.lv.iTf];
        return (c.lv.vwap && a) ? cmpD(c.px, c.lv.vwap.vwap, a.atr, d) : null; } },
    { id: "orWidth", lbl: "اتّساع نطاق معقول", w: 1.0, kind: "ind", v: function (c) {
        var a = c.an[c.lv.iTf], or = c.lv.or;
        if (!a || !or || !(a.atr > 0)) return null;
        return inRange((or.hi - or.lo) / a.atr, 0.8, 5); } },
    { id: "volConf", lbl: "حجم مؤكِّد", w: 1.5, kind: "ind", v: function (c) {
        var x = volRatio(c, c.lv.iTf, 20);
        return x === null ? null : (x >= 1.3 ? 1 : (x >= 0.8 ? 0 : -1)); } },
    { id: "h1Trend", lbl: "موافقة فريم الساعة", w: 1.0, kind: "ind", v: function (c, d) {
        return c.an["1h"] ? agree(c.an["1h"].score, d, 15) : null; } },
    { id: "dayTrend", lbl: "موافقة الاتجاه اليومي", w: 1.0, kind: "ind", v: function (c, d) {
        return c.an["1d"] ? agree(c.an["1d"].score, d, 15) : null; } }
  ],
  levels: function (c) {
    var e = [{ p: c.lv.or.hi, n: "قمّة نطاق الافتتاح" }, { p: c.lv.or.lo, n: "قاع نطاق الافتتاح" }];
    if (c.lv.vwap) e.push({ p: c.lv.vwap.vwap, n: "VWAP الجلسة" });
    return { atrTf: iTf15(c) || c.lv.iTf, extra: e }; } },

/* ===== ٢) استعادة VWAP ============================================= */
{ id: "vwapRec", lbl: "استعادة VWAP", fam: "session", tf: "5m", src: "intraday",
  why: "VWAP متوسّط سعر الجلسة مرجّحاً بالحجم — سعرُ تعادلِ من دخلوا اليوم. وعبورُه رجوعاً بعد أن كان السعر في الجهة الأخرى تحوّلٌ في ميزان الجلسة. والشرط عبورٌ فعلي لا بقاءٌ في الجهة: شمعةٌ من الستّ الأخيرة على الجهة المقابلة.",
  ready: function (c) {
    if (!c.lv.iTf) return "لا فريم لحظي لهذا الرمز (الوضع المُصغَّر)";
    if (c.sess !== "REGULAR") return "خارج الجلسة الرسمية — لا VWAP جلسة";
    if (!c.today) return "فترات الجلسة المحفوظة تصف يوماً سابقاً";
    if (!c.lv.vwap) return "لا حجم في شمعات الجلسة — وVWAP بلا حجم رقمٌ ملفّق";
    return null;
  },
  side: function (c) {
    var a = c.an[c.lv.iTf], vw = c.lv.vwap, k = c.k[c.lv.iTf];
    if (!a || !vw || !k) return 0;
    var t = tolOf(a.atr), r = k.slice(-6);
    if (c.px > vw.vwap + t && r.some(function (x) { return x.c < vw.vwap; })) return 1;
    if (c.px < vw.vwap - t && r.some(function (x) { return x.c > vw.vwap; })) return -1;
    return 0;
  },
  gates: [
    { id: "vwDist", lbl: "قريب من VWAP", w: 2.0, kind: "price", v: function (c, d) {
        var a = c.an[c.lv.iTf];
        if (!a || !(a.atr > 0) || !c.lv.vwap) return null;
        var x = (c.px - c.lv.vwap.vwap) * d / a.atr;
        return x <= 1 ? 1 : (x <= 2 ? 0 : -1); } },
    { id: "vwBand", lbl: "داخل شريط الانحراف", w: 1.5, kind: "price", v: function (c, d) {
        var vw = c.lv.vwap, a = c.an[c.lv.iTf];
        if (!vw || !a) return null;
        // خارج ‎±1σ‎ في جهة الحركة امتدادٌ لا استعادة
        return cmpD(d > 0 ? vw.upper : vw.lower, c.px, a.atr, d); } },
    { id: "vwTrend", lbl: "المتوسّط القصير في الجهة", w: 1.5, kind: "ind", v: function (c, d) {
        var a = c.an[c.lv.iTf];
        return (a && c.lv.vwap) ? cmpD(a.e20, c.lv.vwap.vwap, a.atr, d) : null; } },
    { id: "volConf", lbl: "حجم مؤكِّد", w: 1.5, kind: "ind", v: function (c) {
        var x = volRatio(c, c.lv.iTf, 20);
        return x === null ? null : (x >= 1.2 ? 1 : (x >= 0.7 ? 0 : -1)); } },
    { id: "h1Trend", lbl: "موافقة فريم الساعة", w: 1.5, kind: "ind", v: function (c, d) {
        return c.an["1h"] ? agree(c.an["1h"].score, d, 15) : null; } },
    { id: "rsiRoom", lbl: "متّسع في RSI", w: 1.0, kind: "ind", v: function (c, d) {
        var a = c.an[c.lv.iTf];
        if (!a || !Number.isFinite(a.rsi)) return null;
        var r = d > 0 ? a.rsi : 100 - a.rsi;
        return r <= 65 ? 1 : (r <= 75 ? 0 : -1); } },
    { id: "dayTrend", lbl: "موافقة الاتجاه اليومي", w: 1.0, kind: "ind", v: function (c, d) {
        return c.an["1d"] ? agree(c.an["1d"].score, d, 15) : null; } }
  ],
  levels: function (c) {
    var vw = c.lv.vwap;
    return { atrTf: iTf15(c) || c.lv.iTf, extra: [{ p: vw.vwap, n: "VWAP الجلسة" },
      { p: vw.upper, n: "VWAP فوق الانحراف" }, { p: vw.lower, n: "VWAP تحت الانحراف" }] }; } },

/* ===== ٣) اختراق مستوى بحجم ======================================= */
{ id: "brk", lbl: "اختراق مستوى بحجم", fam: "trend", tf: "15m", src: "both",
  tfOf: iTf15,
  why: "خروج السعر من أعلى أو أدنى نافذةٍ سابقة بوضوح وبحجمٍ يفوق وسيطه. الاختراق بلا حجم غالباً يُردّ، فالحجم بوابةٌ ثقيلة هنا لا زينة. وعائلةُ الاستمرار حافّتها سالبة في أرشيف هذا الكون — تُعرض بحافّتها مكتوبةً ولا تُجمَّل.",
  ready: function (c) {
    if (!iTf15(c)) return "لا فريم لحظي لهذا الرمز (الوضع المُصغَّر)";
    return null; },
  side: function (c) {
    var tf = iTf15(c), a = c.an[tf], dn = donch(c, tf, 25);
    if (!a || !dn) return 0;
    var t = tolOf(a.atr);
    return c.px > dn.hi + t ? 1 : (c.px < dn.lo - t ? -1 : 0);
  },
  gates: [
    { id: "brkClear", lbl: "وضوح الاختراق", w: 2.5, kind: "price", v: function (c, d) {
        var tf = iTf15(c), a = c.an[tf], dn = donch(c, tf, 25);
        if (!a || !dn || !(a.atr > 0)) return null;
        var x = (c.px - (d > 0 ? dn.hi : dn.lo)) * d / a.atr;
        return x >= 0.35 ? 1 : (x >= 0.18 ? 0 : -1); } },
    { id: "brkChase", lbl: "لم يفت الاختراق", w: 1.5, kind: "price", v: function (c, d) {
        var tf = iTf15(c), a = c.an[tf], dn = donch(c, tf, 25);
        if (!a || !dn || !(a.atr > 0)) return null;
        var x = (c.px - (d > 0 ? dn.hi : dn.lo)) * d / a.atr;
        return x <= 1.8 ? 1 : (x <= 3 ? 0 : -1); } },
    { id: "brkVol", lbl: "حجم الاختراق", w: 2.0, kind: "ind", v: function (c) {
        var x = volRatio(c, iTf15(c), 20);
        return x === null ? null : (x >= 1.5 ? 1 : (x >= 1 ? 0 : -1)); } },
    { id: "brkClose", lbl: "إغلاق في طرف الشمعة", w: 1.5, kind: "ind", v: function (c, d) {
        var k = c.k[iTf15(c)];
        if (!k || k.length < 3) return null;
        var p = closePos(k[k.length - 2]);
        if (p === null) return null;
        var s = d > 0 ? p : 1 - p;
        return s >= 0.7 ? 1 : (s >= 0.45 ? 0 : -1); } },
    { id: "trendAgree", lbl: "موافقة فريم الساعة", w: 1.5, kind: "ind", v: function (c, d) {
        return c.an["1h"] ? agree(c.an["1h"].score, d, 15) : null; } },
    { id: "adxOn", lbl: "اتجاه قائم", w: 1.0, kind: "ind", v: function (c) {
        var a = c.an["1h"] || c.an["1d"];
        if (!a || !Number.isFinite(a.adx)) return null;
        return a.adx >= 22 ? 1 : (a.adx >= 16 ? 0 : -1); } },
    { id: "notBlowoff", lbl: "لا استنزاف في RSI", w: 1.0, kind: "ind", v: function (c, d) {
        var a = c.an["1h"] || c.an["1d"];
        if (!a || !Number.isFinite(a.rsi)) return null;
        var r = d > 0 ? a.rsi : 100 - a.rsi;
        return r <= 72 ? 1 : (r <= 80 ? 0 : -1); } }
  ],
  levels: function (c) {
    var tf = iTf15(c), dn = donch(c, tf, 25);
    return { atrTf: tf, extra: dn ? [{ p: dn.hi, n: "قمّة النافذة" }, { p: dn.lo, n: "قاع النافذة" }] : [] }; } },

/* ===== ٤) ارتداد داخل اتجاه ======================================== */
{ id: "pbTrend", lbl: "ارتداد داخل اتجاه", fam: "revert", tf: "1h", src: "both",
  why: "الاتجاه الأمّ على ٤ ساعات قائم (السعر فوق متوسّط 200 والخمسين فوقه)، بينما تراجع السعر على فريم الساعة تحت متوسّط 20 بنصف مدى شمعته على الأقل وRSI في منطقةٍ وسطى: تراجعٌ داخل اتجاه لا انكسارٌ له. والمخاطرة أن الاتجاه قد يكون في طريقه للانكسار فعلاً.\n\nنظيرُه اليومي `ارتداد صاعد` مقيسٌ في الأرشيف بحافّةٍ منعدمة (‎−0.04‎ على 38,497 حالة) — يحلّ مشكلة الرؤية ولا يدّعي حافة. وهذه النسخة **ثنائية الجهة** بخلافه: الصعود في اتجاهٍ هابط راسخ حالةٌ لم يقسها الأرشيف اليومي قط، فتُقاس هنا من جديد ولا تُفترض.",
  ready: function (c) {
    if (!c.an["1h"]) return "لا فريم ساعة لهذا الرمز (الوضع المُصغَّر)";
    if (!c.an["4h"] && !c.an["1d"]) return "لا فريم أكبر يحدّد الاتجاه الأمّ";
    return null; },
  side: function (c) {
    var h = c.an["1h"], f = c.an["4h"] || c.an["1d"];
    if (!h || !f) return 0;
    if (!Number.isFinite(f.e200) || !Number.isFinite(f.e50) || !Number.isFinite(f.px)) return 0;
    if (!Number.isFinite(h.e20) || !(h.atr > 0) || !Number.isFinite(h.rsi)) return 0;
    var dip = Math.max(tolOf(h.atr), h.atr * 0.5);
    if (f.px > f.e200 && f.e50 > f.e200 && c.px < h.e20 - dip && h.rsi >= 30 && h.rsi < 55) return 1;
    if (f.px < f.e200 && f.e50 < f.e200 && c.px > h.e20 + dip && h.rsi <= 70 && h.rsi > 45) return -1;
    return 0;
  },
  gates: [
    { id: "motherTrend", lbl: "قوّة الاتجاه الأمّ", w: 2.5, kind: "ind", v: function (c, d) {
        var f = c.an["4h"] || c.an["1d"];
        return f ? agree(f.score, d, 15) : null; } },
    { id: "dipDepth", lbl: "عمق التراجع معقول", w: 2.0, kind: "price", v: function (c, d) {
        var h = c.an["1h"];
        if (!h || !(h.atr > 0) || !Number.isFinite(h.e20)) return null;
        return inRange((h.e20 - c.px) * d / h.atr, 0.5, 2.5); } },
    { id: "holdsE50", lbl: "ما زال خلف متوسّط 50", w: 1.5, kind: "price", v: function (c, d) {
        var h = c.an["1h"];
        return h ? cmpD(c.px, h.e50, h.atr, d) : null; } },
    { id: "rsiZone", lbl: "RSI في منطقة الارتداد", w: 1.5, kind: "ind", v: function (c, d) {
        var h = c.an["1h"];
        if (!h || !Number.isFinite(h.rsi)) return null;
        var r = d > 0 ? h.rsi : 100 - h.rsi;
        return inRange(r, 32, 50); } },
    { id: "stochTurn", lbl: "الستوكاستك ينعطف", w: 1.0, kind: "ind", v: function (c, d) {
        var h = c.an["1h"];
        if (!h || !Number.isFinite(h.stochK) || !Number.isFinite(h.stochD)) return null;
        return (h.stochK - h.stochD) * d > 0 ? 1 : -1; } },
    { id: "volDry", lbl: "حجم التراجع خفيف", w: 1.0, kind: "ind", v: function (c) {
        // تراجعٌ صحّي يأتي بحجمٍ أقلّ من حجم الاتجاه: بيعٌ بلا إلحاح
        var x = volRatio(c, "1h", 20);
        return x === null ? null : (x <= 1.1 ? 1 : (x <= 1.6 ? 0 : -1)); } },
    { id: "dayTrend", lbl: "موافقة الاتجاه اليومي", w: 1.0, kind: "ind", v: function (c, d) {
        return c.an["1d"] ? agree(c.an["1d"].score, d, 15) : null; } }
  ],
  levels: function (c) {
    var h = c.an["1h"], e = [];
    if (h && Number.isFinite(h.e20)) e.push({ p: h.e20, n: "متوسّط 20 (ساعة)" });
    if (h && Number.isFinite(h.e50)) e.push({ p: h.e50, n: "متوسّط 50 (ساعة)" });
    return { atrTf: "1h", extra: e }; } },

/* ===== ٥) عودة من حافة بولنجر ===================================== */
{ id: "meanRev", lbl: "عودة من حافة بولنجر", fam: "revert", tf: "15m", src: "both",
  tfOf: iTf15,
  why: "السعر خارج حافة بولنجر بوضوح مع تشبّعٍ في RSI وتدفّق الأموال. وأهمّ بوابةٍ فيه هي **غياب اتجاهٍ قوي**: العودة إلى المتوسّط تعمل في النطاق وتُسحق في الاتجاه، فـADX المرتفع يقلب البوابة إلى مناقِضة بدل أن يُهمَل.",
  ready: function (c) {
    if (!iTf15(c)) return "لا فريم لحظي لهذا الرمز (الوضع المُصغَّر)";
    return null; },
  side: function (c) {
    var a = c.an[iTf15(c)];
    if (!a || !Number.isFinite(a.bbLo) || !Number.isFinite(a.bbUp)) return 0;
    var t = tolOf(a.atr);
    if (c.px < a.bbLo - t) return 1;
    if (c.px > a.bbUp + t) return -1;
    return 0;
  },
  gates: [
    { id: "noTrend", lbl: "لا اتجاه قوي يسحقه", w: 2.5, kind: "ind", v: function (c) {
        var a = c.an[iTf15(c)] || c.an["1h"];
        if (!a || !Number.isFinite(a.adx)) return null;
        return a.adx < 22 ? 1 : (a.adx < 28 ? 0 : -1); } },
    { id: "bbExt", lbl: "امتدادٌ لا سقوطٌ حرّ", w: 2.0, kind: "price", v: function (c, d) {
        var a = c.an[iTf15(c)];
        if (!a || !(a.atr > 0)) return null;
        var edge = d > 0 ? a.bbLo : a.bbUp;
        return inRange((edge - c.px) * d / a.atr, 0.1, 1.5); } },
    { id: "rsiExt", lbl: "تشبّع في RSI", w: 1.5, kind: "ind", v: function (c, d) {
        var a = c.an[iTf15(c)];
        if (!a || !Number.isFinite(a.rsi)) return null;
        var r = d > 0 ? a.rsi : 100 - a.rsi;
        return r <= 30 ? 1 : (r <= 40 ? 0 : -1); } },
    { id: "mfiExt", lbl: "تشبّع في تدفّق الأموال", w: 1.5, kind: "ind", v: function (c, d) {
        var a = c.an[iTf15(c)];
        if (!a || !Number.isFinite(a.mfi)) return null;   // بلا حجم لا MFI
        var m = d > 0 ? a.mfi : 100 - a.mfi;
        return m <= 25 ? 1 : (m <= 40 ? 0 : -1); } },
    { id: "midRoom", lbl: "متّسع حتى وسط النطاق", w: 1.0, kind: "price", v: function (c, d) {
        var a = c.an[iTf15(c)];
        if (!a || !(a.atr > 0) || !Number.isFinite(a.bbMid)) return null;
        return (a.bbMid - c.px) * d / a.atr >= 0.5 ? 1 : 0; } },
    { id: "notCrash", lbl: "اليومي لا ينهار", w: 1.5, kind: "ind", v: function (c, d) {
        // العودة إلى المتوسّط ضدّ انهيارٍ يوميّ هي إمساك السكّين
        var a = c.an["1d"];
        if (!a || !Number.isFinite(a.score)) return null;
        return a.score * d >= -15 ? 1 : (a.score * d >= -45 ? 0 : -1); } }
  ],
  levels: function (c) {
    var a = c.an[iTf15(c)], e = [];
    if (a) {
      if (Number.isFinite(a.bbMid)) e.push({ p: a.bbMid, n: "وسط بولنجر" });
      if (Number.isFinite(a.bbLo)) e.push({ p: a.bbLo, n: "حافة بولنجر السفلى" });
      if (Number.isFinite(a.bbUp)) e.push({ p: a.bbUp, n: "حافة بولنجر العليا" });
    }
    return { atrTf: iTf15(c), extra: e }; } },

/* ===== ٦) توسّع بعد انضغاط ======================================== */
{ id: "sqzExp", lbl: "توسّع بعد انضغاط", fam: "vol", tf: "1h", src: "both",
  tfOf: sqTf,
  why: "عرض بولنجر كان في أضيق مئينه ثم اتّسع، والسعر خرج من مدى فترة الانضغاط.\n\nوهو **بناءٌ مختلف** عن شرط `انضغاط قبل الحركة` الذي سقط بالقياس (‎−0.48‎): ذاك كان يأخذ جهته من الميل الصاعد فيرث سلبيّة الميل — أي أن رقمه كان يقيس الميل لا الانضغاط. وهذا يأخذ جهته من **الكسر نفسه**، فهي فرضيةٌ أخرى تُقاس من جديد ولا تُفترض.",
  ready: function (c) {
    if (!sqTf(c)) return "لا سلسلة عرض بولنجر كافية";
    return null; },
  side: function (c) {
    var tf = sqTf(c), w = c.bw[tf], a = c.an[tf], k = c.k[tf];
    if (!w || !a || !k || w.length < 40) return 0;
    var cur = lastOf(w), pre = w.slice(-13, -1).filter(Number.isFinite);
    if (!Number.isFinite(cur) || pre.length < 6) return 0;
    var minR = Math.min.apply(null, pre);
    if (!(cur > minR * 1.25)) return 0;                     // لم يتوسّع بعد
    var win = k.slice(-13, -1), hi = -Infinity, lo = Infinity;
    for (var i = 0; i < win.length; i++) { if (win[i].h > hi) hi = win[i].h; if (win[i].l < lo) lo = win[i].l; }
    if (!(hi > lo)) return 0;
    var t = tolOf(a.atr);
    return c.px > hi + t ? 1 : (c.px < lo - t ? -1 : 0);
  },
  gates: [
    { id: "wasTight", lbl: "كان منضغطاً فعلاً", w: 2.5, kind: "ind", v: function (c) {
        var tf = sqTf(c), w = c.bw[tf];
        if (!w) return null;
        var pre = w.slice(-13, -1).filter(Number.isFinite);
        if (pre.length < 6) return null;
        var p = pctOf(w, Math.min.apply(null, pre), 120);
        if (p === null) return null;
        return p <= 15 ? 1 : (p <= 30 ? 0 : -1); } },
    { id: "expRatio", lbl: "قوّة التوسّع", w: 2.0, kind: "ind", v: function (c) {
        var tf = c.bw["1h"] ? "1h" : "4h", w = c.bw[tf];
        if (!w) return null;
        var cur = lastOf(w), pre = w.slice(-13, -1).filter(Number.isFinite);
        if (!Number.isFinite(cur) || pre.length < 6) return null;
        var x = cur / Math.min.apply(null, pre);
        return x >= 1.6 ? 1 : (x >= 1.3 ? 0 : -1); } },
    { id: "brkClear", lbl: "وضوح الخروج من المدى", w: 2.0, kind: "price", v: function (c, d) {
        var tf = sqTf(c), a = c.an[tf], k = c.k[tf];
        if (!a || !k || !(a.atr > 0)) return null;
        var win = k.slice(-13, -1), hi = -Infinity, lo = Infinity;
        for (var i = 0; i < win.length; i++) { if (win[i].h > hi) hi = win[i].h; if (win[i].l < lo) lo = win[i].l; }
        if (!(hi > lo)) return null;
        var x = (c.px - (d > 0 ? hi : lo)) * d / a.atr;
        return x >= 0.3 ? 1 : (x >= 0.15 ? 0 : -1); } },
    { id: "volConf", lbl: "حجم مؤكِّد", w: 1.5, kind: "ind", v: function (c) {
        var x = volRatio(c, sqTf(c), 20);
        return x === null ? null : (x >= 1.3 ? 1 : (x >= 0.9 ? 0 : -1)); } },
    { id: "adxRise", lbl: "قوّة اتجاه ناشئة", w: 1.0, kind: "ind", v: function (c) {
        var a = c.an[sqTf(c)];
        if (!a || !Number.isFinite(a.adx)) return null;
        return a.adx >= 20 ? 1 : (a.adx >= 14 ? 0 : -1); } },
    { id: "dayTrend", lbl: "موافقة الاتجاه اليومي", w: 1.0, kind: "ind", v: function (c, d) {
        return c.an["1d"] ? agree(c.an["1d"].score, d, 15) : null; } }
  ],
  levels: function (c) {
    var tf = sqTf(c), k = c.k[tf], e = [];
    if (k) {
      var win = k.slice(-13, -1), hi = -Infinity, lo = Infinity;
      for (var i = 0; i < win.length; i++) { if (win[i].h > hi) hi = win[i].h; if (win[i].l < lo) lo = win[i].l; }
      if (hi > lo) e = [{ p: hi, n: "قمّة فترة الانضغاط" }, { p: lo, n: "قاع فترة الانضغاط" }];
    }
    return { atrTf: tf, extra: e }; } },

/* ===== ٧) تباعد لحظي ============================================== */
{ id: "rsiDiv", lbl: "تباعد لحظي", fam: "revert", tf: "1h", src: "both",
  tfOf: function (c) { return ["1h", "15m", "1d"].filter(function (t) { return c.an[t] && c.an[t].div; })[0] || "1d"; },
  why: "قاعٌ أدنى في السعر وقاعٌ أعلى في RSI (أو العكس): الدافع يفقد قوّته قبل أن ينعكس السعر. نظيرُه اليومي أقوى شرطٍ في الأرشيف كلّه (حافة ‎+1.01‎ على 4,114 حالة).\n\nوبوابةُ الاتجاه هنا **مقلوبةٌ عمداً**: الأرشيف قاس أن حافّة التباعد الصاعد ترتفع من ‎+1.01‎ إلى ‎+1.97‎ حين يكون اتجاه السهم هابطاً قوياً — إشارةُ ارتدادٍ لا معنى لها إلا حيث يوجد ما يُرتدّ عنه. فمكافأةُ موافقة الاتجاه هنا كانت ستعاقب أفضل الحالات.",
  /* «لا تباعد الآن» ليست «لا يمكن قياس التباعد»: الأولى حالةُ سوقٍ
     عادية تُقال «لم يتفعّل»، والثانية نقصُ بيانات يُقال `off`. وخلطُهما
     يجعل الرمز السليم يبدو ناقصاً في بطاقة الوضع المُصغَّر. */
  ready: function (c) {
    if (!["1h", "15m", "1d"].some(function (t) { return c.an[t]; }))
      return "لا فريم يحمل مؤشّرات (الوضع المُصغَّر)";
    return null; },
  side: function (c) {
    var tf = ["1h", "15m", "1d"].filter(function (t) { return c.an[t] && c.an[t].div; })[0];
    if (!tf) return 0;
    var dv = c.an[tf].div;
    return (dv && (dv.dir === 1 || dv.dir === -1)) ? dv.dir : 0;
  },
  gates: [
    { id: "divFresh", lbl: "التباعد حديث", w: 2.0, kind: "ind", v: function (c) {
        var tf = ["1h", "15m", "1d"].filter(function (t) { return c.an[t] && c.an[t].div; })[0];
        if (!tf) return null;
        var b = c.an[tf].div.bars;
        if (!Number.isFinite(b)) return null;
        return b <= 8 ? 1 : (b <= 16 ? 0 : -1); } },
    { id: "counterTrend", lbl: "اتجاهٌ مضادّ يُرتدّ عنه", w: 2.0, kind: "ind", v: function (c, d) {
        // مقلوبةٌ عمداً — انظر `why`: التباعد يُدفَع حيث الاتجاه ضدّه
        var a = c.an["1d"];
        return a ? agree(a.score, -d, 15) : null; } },
    { id: "rsiZone", lbl: "RSI في منطقة الانعكاس", w: 1.5, kind: "ind", v: function (c, d) {
        var a = c.an["1h"] || c.an["1d"];
        if (!a || !Number.isFinite(a.rsi)) return null;
        var r = d > 0 ? a.rsi : 100 - a.rsi;
        return r <= 45 ? 1 : (r <= 58 ? 0 : -1); } },
    { id: "atLevel", lbl: "عند مستوىً حقيقي", w: 1.5, kind: "price", v: function (c, d) {
        var L = c.lv.L;
        if (!L || !(L.atr > 0)) return null;
        var pool = d > 0 ? L.supAll : L.resAll;
        if (!pool || !pool.length) return null;
        var gap = Math.abs(c.px - pool[0].p) / L.atr;
        return gap <= 1 ? 1 : (gap <= 2 ? 0 : -1); } },
    { id: "volConf", lbl: "حجم مؤكِّد", w: 1.0, kind: "ind", v: function (c) {
        var x = volRatio(c, iTf15(c) || "1d", 20);
        return x === null ? null : (x >= 1.2 ? 1 : (x >= 0.7 ? 0 : -1)); } },
    { id: "obvBack", lbl: "التراكم يوافق", w: 1.0, kind: "ind", v: function (c, d) {
        var a = c.an["1d"] || c.an["1h"];
        if (!a || !Number.isFinite(a.obvSlope)) return null;   // بلا حجم لا OBV
        return agree(a.obvSlope, d, 0); } }
  ],
  levels: function (c) { return { atrTf: c.an["1h"] ? "1h" : "1d", extra: [] }; } },

/* ===== ٨) دفعة حجم موجَّهة ======================================== */
{ id: "volSpike", lbl: "دفعة حجم موجَّهة", fam: "vol", tf: "15m", src: "both",
  tfOf: iTf15,
  why: "شمعةٌ مكتملة بحجمٍ يفوق وسيط عشرين شمعة بمرّتين ونصف، وإغلاقها في طرف مداها فتقول جهة. والحجم وحده ليس اتجاهاً — شمعةُ حجمٍ تغلق في منتصف مداها تصف صراعاً لا قراراً، ولذلك موضع الإغلاق شرطٌ في المشغِّل لا بوابةٌ فيه.\n\nونظيرُه اليومي `حجم غير معتاد` مفروضُ الاتجاه بقرارٍ صريح في `scans.js` مع تحفّظٍ مسجَّل. هنا الجهة تأتي من الشمعة نفسها لا بفرض.",
  ready: function (c) {
    if (!iTf15(c)) return "لا فريم لحظي لهذا الرمز (الوضع المُصغَّر)";
    return null; },
  side: function (c) {
    var tf = iTf15(c), k = c.k[tf];
    if (!k || k.length < 12) return 0;
    var x = volRatio(c, tf, 20);
    if (!(x >= 2.5)) return 0;
    var p = closePos(k[k.length - 2]);
    if (p === null) return 0;
    return p >= 0.7 ? 1 : (p <= 0.3 ? -1 : 0);
  },
  gates: [
    { id: "spikeSize", lbl: "حجم الدفعة", w: 2.0, kind: "ind", v: function (c) {
        var x = volRatio(c, iTf15(c), 20);
        return x === null ? null : (x >= 4 ? 1 : (x >= 2.5 ? 0 : -1)); } },
    { id: "closeStrong", lbl: "إغلاق حاسم", w: 2.0, kind: "ind", v: function (c, d) {
        var k = c.k[iTf15(c)];
        if (!k || k.length < 3) return null;
        var p = closePos(k[k.length - 2]);
        if (p === null) return null;
        var s = d > 0 ? p : 1 - p;
        return s >= 0.8 ? 1 : (s >= 0.65 ? 0 : -1); } },
    { id: "follow", lbl: "السعر لم يرتدّ", w: 2.0, kind: "price", v: function (c, d) {
        // متابعةٌ حقيقية: السعر ما زال خلف منتصف شمعة الدفعة
        var k = c.k[iTf15(c)];
        if (!k || k.length < 3) return null;
        var b = k[k.length - 2], a = c.an[iTf15(c)];
        if (!b || !a) return null;
        return cmpD(c.px, (b.h + b.l) / 2, a.atr, d); } },
    { id: "dayTrend", lbl: "موافقة الاتجاه اليومي", w: 1.0, kind: "ind", v: function (c, d) {
        return c.an["1d"] ? agree(c.an["1d"].score, d, 15) : null; } },
    { id: "not52", lbl: "لا يصطدم بحدّ السنة", w: 1.0, kind: "price", v: function (c, d) {
        var r = c.row, L = c.lv.L;
        if (!r || !L || !(L.atr > 0)) return null;
        var wall = d > 0 ? r.w52h : r.w52l;
        if (!Number.isFinite(wall)) return null;
        var gap = (wall - c.px) * d / L.atr;
        return gap >= 2 ? 1 : (gap >= 0.5 ? 0 : -1); } },
    { id: "rsiRoom", lbl: "متّسع في RSI", w: 1.0, kind: "ind", v: function (c, d) {
        var a = c.an[iTf15(c)];
        if (!a || !Number.isFinite(a.rsi)) return null;
        var r = d > 0 ? a.rsi : 100 - a.rsi;
        return r <= 70 ? 1 : (r <= 80 ? 0 : -1); } }
  ],
  levels: function (c) {
    var k = c.k[iTf15(c)], e = [];
    if (k && k.length >= 3) {
      var b = k[k.length - 2];
      e = [{ p: b.h, n: "قمّة شمعة الدفعة" }, { p: b.l, n: "قاع شمعة الدفعة" }];
    }
    return { atrTf: iTf15(c), extra: e }; } },

/* ===== ٩) زخم MACD متوافق ========================================= */
{ id: "momo", lbl: "زخم MACD متوافق", fam: "trend", tf: "1h", src: "both",
  why: "هيستوغرام MACD في نفس الجهة على فريمَي ١٥ دقيقة والساعة، وميلُه على الساعة يزيد.\n\nعائلةُ استمرار — والأرشيف على 482 ألف شمعة قاس أن هذا الكون **يدفع على الارتداد ويعاقب على الاستمرار**، فالمتوقَّع أن تخرج حافّته سالبة. يبقى معروضاً بحافّته مكتوبةً: حذفُه لأن قياسه سيّئ إخفاءٌ للقياس، وعرضُه بلا رقمه كذبٌ بالصمت.",
  ready: function (c) {
    if (!c.an["1h"] || !c.an["15m"]) return "يحتاج فريمَي الساعة و١٥ دقيقة (الوضع المُصغَّر)";
    return null; },
  side: function (c) {
    var h = c.an["1h"], m = c.an["15m"];
    if (!h || !m || !Number.isFinite(h.hist) || !Number.isFinite(m.hist)) return 0;
    if (h.hist > 0 && m.hist > 0 && h.histRising === true) return 1;
    if (h.hist < 0 && m.hist < 0 && h.histRising === false) return -1;
    return 0;
  },
  gates: [
    { id: "histSize", lbl: "قوّة الزخم", w: 1.5, kind: "ind", v: function (c) {
        var h = c.an["1h"];
        if (!h || !Number.isFinite(h.hist) || !(h.atr > 0)) return null;
        var x = Math.abs(h.hist) / h.atr;
        return x >= 0.25 ? 1 : (x >= 0.1 ? 0 : -1); } },
    { id: "rsiSide", lbl: "RSI في الجهة", w: 1.5, kind: "ind", v: function (c, d) {
        var h = c.an["1h"];
        if (!h || !Number.isFinite(h.rsi)) return null;
        var r = d > 0 ? h.rsi : 100 - h.rsi;
        return r >= 55 ? 1 : (r >= 45 ? 0 : -1); } },
    { id: "aboveE20", lbl: "خلف متوسّط 20", w: 1.5, kind: "price", v: function (c, d) {
        var h = c.an["1h"];
        return h ? cmpD(c.px, h.e20, h.atr, d) : null; } },
    { id: "aboveE50", lbl: "خلف متوسّط 50", w: 1.0, kind: "price", v: function (c, d) {
        var h = c.an["1h"];
        return h ? cmpD(c.px, h.e50, h.atr, d) : null; } },
    { id: "dayTrend", lbl: "موافقة الاتجاه اليومي", w: 1.5, kind: "ind", v: function (c, d) {
        return c.an["1d"] ? agree(c.an["1d"].score, d, 15) : null; } },
    { id: "adxOn", lbl: "اتجاه قائم", w: 1.0, kind: "ind", v: function (c) {
        var h = c.an["1h"];
        if (!h || !Number.isFinite(h.adx)) return null;
        return h.adx >= 22 ? 1 : (h.adx >= 16 ? 0 : -1); } },
    { id: "notExtended", lbl: "لم يبتعد عن متوسّطه", w: 1.0, kind: "price", v: function (c, d) {
        var h = c.an["1h"];
        if (!h || !(h.atr > 0) || !Number.isFinite(h.e20)) return null;
        return (c.px - h.e20) * d / h.atr <= 2.5 ? 1 : -1; } }
  ],
  levels: function (c) {
    var h = c.an["1h"], e = [];
    if (h && Number.isFinite(h.e20)) e.push({ p: h.e20, n: "متوسّط 20 (ساعة)" });
    return { atrTf: "1h", extra: e }; } },

/* ===== ١٠) توافق الفريمات الخمسة ================================== */
{ id: "tfAlign", lbl: "توافق الفريمات الخمسة", fam: "trend", tf: "1d", src: "both",
  why: "الفريمات الخمسة (٥د، ١٥د، ساعة، ٤ ساعات، يومي) في جهةٍ واحدة معاً. التوافق أندر من أي إشارة منفردة وأصعب على الضجيج أن يفتعله — لكنه يعني أيضاً أن الحركة بدأت وأن الدخول لم يعد مبكراً.\n\nونظيرُه رباعيَّ الفريمات مقيسٌ في الأرشيف بحافّةٍ **سالبة**: ‎−0.28‎ صعوداً على 55,022 حالة و‎−0.42‎ هبوطاً على 36,802. وهو أكثرُ الشروط تحقُّقاً وأسوأُها حافّةً — يُعرض بذلك مكتوباً.",
  ready: function (c) {
    var miss = ["5m", "15m", "1h", "4h", "1d"].filter(function (t) {
      return !(c.an[t] && Number.isFinite(c.an[t].score)); });
    if (miss.length) return "فريماتٌ غائبة: " + miss.join("، ") + " (الوضع المُصغَّر)";
    return null; },
  side: function (c) {
    var v = ["5m", "15m", "1h", "4h", "1d"].map(function (t) { return c.an[t].score; });
    if (v.every(function (x) { return x > 15; })) return 1;
    if (v.every(function (x) { return x < -15; })) return -1;
    return 0;
  },
  gates: [
    /* المشغِّل يشترط تجاوز ‎15‎ على الخمسة، فبوابةُ «هل يوافق؟» كانت
       ستعيد ‎+1‎ دائماً ولا تفرّق بين توافقٍ هشّ وآخر راسخ. فالبوابات
       تقيس **المقدار** لا الجهة. */
    { id: "f5", lbl: "قوّة فريم ٥د", w: 0.5, kind: "ind", v: function (c, d) {
        var a = c.an["5m"]; return a ? (a.score * d >= 45 ? 1 : (a.score * d >= 25 ? 0 : -1)) : null; } },
    { id: "f15", lbl: "قوّة فريم ١٥د", w: 1.0, kind: "ind", v: function (c, d) {
        var a = c.an["15m"]; return a ? (a.score * d >= 45 ? 1 : (a.score * d >= 25 ? 0 : -1)) : null; } },
    { id: "f1h", lbl: "قوّة فريم الساعة", w: 1.5, kind: "ind", v: function (c, d) {
        var a = c.an["1h"]; return a ? (a.score * d >= 45 ? 1 : (a.score * d >= 25 ? 0 : -1)) : null; } },
    { id: "f4h", lbl: "قوّة فريم ٤ ساعات", w: 2.0, kind: "ind", v: function (c, d) {
        var a = c.an["4h"]; return a ? (a.score * d >= 45 ? 1 : (a.score * d >= 25 ? 0 : -1)) : null; } },
    { id: "f1d", lbl: "قوّة الفريم اليومي", w: 2.5, kind: "ind", v: function (c, d) {
        var a = c.an["1d"]; return a ? (a.score * d >= 45 ? 1 : (a.score * d >= 25 ? 0 : -1)) : null; } },
    { id: "adxOn", lbl: "اتجاه قائم", w: 1.0, kind: "ind", v: function (c) {
        var a = c.an["1d"];
        if (!a || !Number.isFinite(a.adx)) return null;
        return a.adx >= 22 ? 1 : (a.adx >= 16 ? 0 : -1); } },
    { id: "notExtended", lbl: "لم يبتعد عن متوسّطه", w: 1.5, kind: "price", v: function (c, d) {
        var h = c.an["1h"];
        if (!h || !(h.atr > 0) || !Number.isFinite(h.e20)) return null;
        return (c.px - h.e20) * d / h.atr <= 2 ? 1 : (((c.px - h.e20) * d / h.atr <= 3.5) ? 0 : -1); } }
  ],
  levels: function (c) { return { atrTf: "1d", extra: [] }; } }

];

/* العائلات — عناقيدُ مترابطة لا أسماءٌ زخرفية.

   شرطُ «التوافق الاستثنائي» يشترط عائلتين متمايزتين، ولو كانت كل
   استراتيجية عائلةً بنفسها لصار الشرط بلا معنى: ثلاث نكهاتٍ من فكرةٍ
   واحدة تتّفق دائماً، فاتّفاقها ليس تأكيداً بل تكراراً. فالتقسيم على
   **ما تقيسه** لا على اسمها. */
var FAMS = { session: "جلسة", trend: "استمرار", revert: "ارتداد", vol: "تقلّب وحجم" };

/* =====================================================================
   دمج مستويات الاستراتيجية في مجمّع `levelsFrom` — لا استبدالُه.

   البديهيّ أن تحسب كل استراتيجية دخولَها ووقفَها بنفسها، وهو خطأ
   مزدوج: يخترع مستوياتٍ لا وجود لها، ويجعل عشر نسخٍ من رياضيات الخطة
   تتباعد بأول تعديل. فالمستوى الخاص (حافة نطاق الافتتاح، VWAP) يُحقَن
   في المجمّع ثم تتولّى `planFrom` القائمة كل ما بعده — نفس الدرس الذي
   جعل المسار الثاني في `planPair` يغيّر **سطر الدخول وحده**.
   ===================================================================== */
function withLevels(L, extra, px) {
  if (!L) return null;
  var add = (extra || []).filter(function (e) {
    return e && Number.isFinite(e.p) && e.p > 0 && Number.isFinite(px);
  }).map(function (e) { return { p: e.p, n: e.n, names: [e.n] }; });
  if (!add.length) return L;
  // تقاربٌ أقلّ من ‎0.4%‎ مستوىً واحد — نفس عتبة `levelsFrom`. وبلا هذا
  // تخرج الخطة بهدفين على نفس السعر تقريباً فيبدوان هدفين وهما واحد.
  var dedup = function (arr) {
    var out = [];
    arr.forEach(function (l) {
      var m = out[out.length - 1];
      if (m && Math.abs(l.p - m.p) / m.p < 0.004) return;
      out.push(l);
    });
    return out;
  };
  var above = dedup(L.resAll.concat(add.filter(function (e) { return e.p > px; }))
                            .sort(function (a, b) { return a.p - b.p; }));
  var below = dedup(L.supAll.concat(add.filter(function (e) { return e.p < px; }))
                            .sort(function (a, b) { return b.p - a.p; }));
  return { px: L.px, atr: L.atr, res: L.res, sup: L.sup,
           resAll: above.slice(0, 7), supAll: below.slice(0, 7) };
}

/* =====================================================================
   خطةُ استراتيجية — `planFrom` نفسها، بمستوياتٍ مُحقَنة وATR فريمِها.

   و`atrTf` **فريم الصفقة لا فريم المشغِّل**، وهما مختلفان عمداً: نطاق
   الافتتاح يُكتشف على شمعة ‎5د‎ (ATR أبل فيها ‎0.44‎ دولار)، لكن
   الصفقة تُحمل ساعاتٍ إلى يومين — ووقفٌ على بُعد ‎0.13%‎ يُضرب
   بالتذبذب الطبيعي قبل أن يصحّ التحليل أو يخطئ. فيُكتشف بالسريع
   ويُقاس بالأبطأ.

   وهو نفسه يُمرَّر إلى `etaFor` بعدها: القسمة تعطي «عدد شمعات ATR»،
   فضربُها بطول شمعةٍ أخرى خلطُ وحدتين — مصيدة موثّقة أخرجت تقدير 93
   يوماً لهدفٍ على بُعد ‎26%‎.
   ===================================================================== */
function planFor(c, r) {
  if (!r || (r.dir !== 1 && r.dir !== -1) || !r.lv) return null;
  var atrTf = r.lv.atrTf, a = c.an[atrTf];
  var atr = a && a.atr;
  if (!(atr > 0)) return null;
  var m = withLevels(c.lv.L, r.lv.extra, c.px);
  if (!m) return null;
  var p = planFrom({ px: c.px, atr: atr, resAll: m.resAll, supAll: m.supAll }, r.dir);
  if (!p) return null;
  /* البوابة تُقرأ ولا تُصلَح: خطةٌ أهدافها في الجهة الخاطئة كذبٌ يبدو
     موثوقاً لأنه ظاهرٌ برقم، وعرضُها أسوأ من ألّا تُعرض خطة. */
  var bad = validatePlan(p);
  if (bad.length) return { bad: bad, dir: r.dir };
  p.atrTf = atrTf;
  return p;
}

/* تقييم الكون كلّه لرمزٍ واحد. تُعاد العشرة دائماً — العاملة بنتيجتها
   والمتوقّفة بسببها — لأن اختفاء استراتيجيةٍ بلا سبب يُقرأ عطلاً، وهو
   بالضبط ما يجعل «الوضع المُصغَّر» مفهوماً بدل أن يبدو خللاً. */
function evalAll(c, prevBy) {
  prevBy = prevBy || {};
  return STRATEGIES.map(function (st) {
    return evalStrategy(st, c, { prev: prevBy[st.id] });
  });
}

var STRAT_BY_ID = {};
for (var _i = 0; _i < STRATEGIES.length; _i++) STRAT_BY_ID[STRATEGIES[_i].id] = STRATEGIES[_i];

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    STRATEGIES: STRATEGIES, STRAT_BY_ID: STRAT_BY_ID, FAMS: FAMS,
    ACT_MIN: ACT_MIN, S_BANDS: S_BANDS, S_MARGIN: S_MARGIN, S_LABEL: S_LABEL,
    sBandOf: sBandOf, sBandStable: sBandStable,
    tolOf: tolOf, cmp: cmp, cmpD: cmpD, agree: agree, inRange: inRange,
    evalGates: evalGates, evalStrategy: evalStrategy, evalAll: evalAll,
    buildCtx: buildCtx, sameUtcDay: sameUtcDay, volRatio: volRatio, closePos: closePos,
    donch: donch, pctOf: pctOf, iTf15: iTf15, sqTf: sqTf,
    withLevels: withLevels, planFor: planFor
  };
}
