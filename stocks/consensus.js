/* =====================================================================
   محرّك الإجماع — من عشر قراءاتٍ مستقلّة إلى قراءةٍ واحدة.
   نسخة واحدة يقرأها المتصفح والخادم معاً (نمط `scans.js`/`plan.js`).

   المشكلة التي يحلّها: عشرُ استراتيجيات تقول عشرة أشياء، ومتوسّطُها
   الساذج يضيّع أهمّ ما فيها. أربعُ إشاراتٍ شراء وثلاثُ بيع ليست
   «شراءٌ ضعيف» بل **لا صفقة** — والمتوسّط الحسابي يخرج بشراءٍ ضعيف
   ويُقرأ توصية.

   ولذلك ثلاث قواعد بُني عليها هذا الملف:

   ١. **التعارض يُفحص قبل الاتجاه.** إن تجاوزت كتلة الأقلية حدَّها
      فالمخرَج `mixed` مهما كان الفارق العددي — ولا تُعرض خطة.
   ٢. **الوزن مقيسٌ أو محايد، ولا شيء بينهما.** استراتيجيةٌ بلا عيّنة
      كافية وزنها ‎1.0‎ **مع وسمٍ ظاهر** «لم تُقَس». ولا يُخترع لها وزنٌ
      من الحدس: نظامٌ يرجّح بالحدس يبدو ذكياً ويقيس اقتناعَ كاتبه.
   ٣. **الثقة ليست احتمالاً.** تُسمّى ثقة وتُشتقّ من الاتفاق وعدد
      المقيس منها وتنوّع عائلاتها — ولا تُعرض كنسبة نجاح أبداً.
   ===================================================================== */

/* =====================================================================
   حالة السوق للرمز — تُقاس من حقولٍ موجودة لا من حدس.

   الترتيب مقصود: الانضغاط أخصُّ الحالات فيُفحص أولاً (عرض بولنجر في
   أضيق مئينه يصف حالةً واحدة لا لبس فيها)، ثم قوّة الاتجاه، ثم
   التوسّع بلا اتجاه، ثم النطاق. و«مختلط» ليست حالةً بل اعترافٌ بأن
   الحقول لا تصف حالةً واضحة — وهي أصدق من إلحاق الرمز بأقرب وسم.
   ===================================================================== */
var REGIMES = {
  squeeze:   { t: "انضغاط",  d: "التقلّب في أضيق مئينه — تمهيدٌ لحركةٍ بلا جهةٍ معلومة" },
  trend:     { t: "اتجاه",   d: "قوّة اتجاه قائمة — الاستمرار أرجح من الانعكاس" },
  expansion: { t: "توسّع",   d: "تقلّبٌ عالٍ بلا اتجاه واضح — حركةٌ واسعة في الجهتين" },
  range:     { t: "نطاق",    d: "لا قوّة اتجاه — السعر يتردّد بين حدّين" },
  mixed:     { t: "مختلط",   d: "الحقول لا تصف حالةً واضحة" }
};

function marketRegime(an) {
  var a = (an && (an["1d"] || an["4h"])) || null;
  if (!a) return null;
  var adx = Number.isFinite(a.adx) ? a.adx : null;
  var sq = Number.isFinite(a.squeeze) ? a.squeeze : null;   // مئين عرض بولنجر 0..100
  if (adx === null && sq === null) return null;
  if (sq !== null && sq <= 20) return "squeeze";
  if (adx !== null && adx >= 25) return "trend";
  if (sq !== null && sq >= 80) return "expansion";
  if (adx !== null && adx < 18) return "range";
  return "mixed";
}

/* =====================================================================
   الأوزان — من القياس وحده.

   `REGIME_W` غير موجودة كجدولٍ مكتوبٍ بالحدس عمداً: الوزن حسب الحالة
   يُشتقّ من عمود `byRegime` في `strategy-edge.json`، وهو **فارقُ حافّة
   الاستراتيجية في هذه الحالة عن حافّتها العامة**. فالسؤال المطروح
   ليس «أيّ استراتيجية تليق بالنطاق؟» — ذاك حدس — بل «هل قِيس أن هذه
   تعمل في النطاق أفضل من عادتها؟».

   ونقطةُ التوسّع المستقبلية هنا بالضبط: `weightFor(id, o)` تأخذ `o`
   فيه `regime` اليوم، ويمكن أن يحمل غداً `sym` و`sec` و`vol` بلا
   تغيير أيّ مستهلك — يكفي أن يحمل `edge` أعمدةً أخرى.
   ===================================================================== */
var W_MIN = 0.4, W_MAX = 1.8;
var clampW = function (x) { return Math.max(W_MIN, Math.min(W_MAX, x)); };

/* الحافّة (بنقاط الأرشيف) وزناً. `0` حافّةً ⇒ `1.0` وزناً، فالمحايد
   هو الحياد بالضبط لا تفضيلٌ خفيّ. */
function edgeWeight(e) {
  return Number.isFinite(e) ? clampW(1 + e / 2) : 1;
}

function weightFor(id, o) {
  o = o || {};
  var row = o.edge && o.edge[id];
  var w = 1, measured = false, note = "لم تُقَس بعد";
  if (row && Number.isFinite(row.edge)) {
    w = edgeWeight(row.edge);
    measured = true;
    note = "حافّة مقيسة " + (row.edge > 0 ? "+" : "") + row.edge.toFixed(2) +
           " على " + (row.n || 0) + " إشارة";
  }
  var reg = null;
  if (row && row.byRegime && o.regime && Number.isFinite(row.byRegime[o.regime])) {
    /* الفارقُ عن حافّتها العامة لا الحافّة المطلقة: استراتيجيةٌ حافّتها
       ‎−0.3‎ عموماً و‎−0.1‎ في النطاق **أفضل من عادتها** هناك، ووزنُها
       بالمطلق كان سيعاقبها مرّتين على نفس الشيء. */
    reg = row.byRegime[o.regime] - (row.edge || 0);
    w *= clampW(1 + reg / 2);
    note += " · في حالة «" + (REGIMES[o.regime] ? REGIMES[o.regime].t : o.regime) + "» " +
            (reg > 0 ? "أفضل" : "أسوأ") + " من عادتها";
  }
  return { w: clampW(w), measured: measured, note: note, reg: reg,
           n: (row && row.n) || 0, src: (row && row.src) || null };
}

/* =====================================================================
   الإجماع.

   الكتلة = الوزن المقيس × القناعة. فاستراتيجيةٌ نتيجتها ‎95‎ تزن أكثر
   من أخرى نتيجتها ‎57‎ وإن تساوى وزناهما — والعدُّ المجرَّد («‎7 من 9‎»)
   يسوّي بينهما. ويُعرض العدُّ كذلك لأنه مفهومٌ فوراً، لكنه لا يقرّر.
   ===================================================================== */
var MIX_SHARE = 0.35;        // كتلةُ أقلّيةٍ فوقها ⇒ لا صفقة
var CONF_HI = 0.78, CONF_MD = 0.62;

function consensusOf(res, o) {
  o = o || {};
  var act = (res || []).filter(function (r) { return r.dir && r.active && Number.isFinite(r.sc); });
  var off = (res || []).filter(function (r) { return r.off; });
  var base = { dir: 0, k: "none", t: "لا إشارة", up: 0, dn: 0, n: 0,
               nUp: 0, nDn: 0, nQuiet: (res || []).length - act.length - off.length,
               nOff: off.length, items: [], fams: [], conf: null, measured: 0,
               regime: o.regime || null, sc: null };
  if (!act.length) return base;

  var up = 0, dn = 0, items = [], measured = 0;
  for (var i = 0; i < act.length; i++) {
    var r = act[i], w = weightFor(r.id, o);
    var mass = w.w * (r.sc / 100);
    if (r.dir > 0) up += mass; else dn += mass;
    if (w.measured) measured++;
    items.push({ id: r.id, lbl: r.lbl, fam: r.fam, dir: r.dir, sc: r.sc,
                 w: w.w, mass: mass, measured: w.measured, note: w.note });
  }
  // الترتيب بالكتلة لا بالنتيجة: هذا هو الترتيب الذي يصف أثرها الفعلي
  items.sort(function (a, b) { return b.mass - a.mass; });

  var total = up + dn;
  var nUp = act.filter(function (r) { return r.dir > 0; }).length;
  var nDn = act.length - nUp;
  var maj = up >= dn ? 1 : -1;
  var majM = Math.max(up, dn), minM = Math.min(up, dn);
  var agree = total > 0 ? majM / total : 0;
  var fams = [];
  items.forEach(function (x) { if (x.dir === maj && fams.indexOf(x.fam) < 0) fams.push(x.fam); });

  var out = Object.assign({}, base, {
    up: up, dn: dn, n: act.length, nUp: nUp, nDn: nDn,
    items: items, fams: fams, agree: agree, measured: measured,
    /* مفتاح الترتيب: الكتلة المرجَّحة للأغلبية. تنمو بعدد المتّفقين
       وقوّتهم معاً، بخلاف `sc` وهي **متوسّط** قناعتهم فلا تنمو بالعدد
       — وترتيبٌ بالمتوسّط يضع إشارةً واحدة بـ‎95‎ فوق ثلاثٍ بـ‎85‎. */
    mass: majM,
    // النتيجة المجمّعة: متوسّطُ قناعةِ الأغلبية مرجّحاً بأوزانها
    sc: Math.round(majM / (items.filter(function (x) { return x.dir === maj; })
                                .reduce(function (s, x) { return s + x.w; }, 0) || 1) * 100)
  });

  /* التعارض قبل الاتجاه — ولا خطة معه. «‎4‎ شراء و‎3‎ بيع» ليست شراءً
     ضعيفاً: هي حالةٌ يعرف فيها النظام أنه لا يعرف. */
  if (total > 0 && minM / total > MIX_SHARE) {
    return Object.assign(out, { dir: 0, k: "mixed", t: "متعارض — لا صفقة",
      why: "كتلةُ الجهة المخالفة " + Math.round(minM / total * 100) +
           "% من الإجماع، وفوق " + Math.round(MIX_SHARE * 100) + "% لا تُعطى جهة" });
  }

  /* =====================================================================
     الثقة تحتاج **اتّساعاً** لا نسبةَ اتفاقٍ وحدها.

     استراتيجيةٌ واحدة تتّفق مع نفسها تعطي ‎100%‎ اتفاقاً — وهو رقمٌ
     صحيح حسابياً وكاذبٌ دلالةً. قِيس على الكون: `KO` بإشارةٍ منفردة
     كانت تتصدّر القائمة بـ«اتفاق ‎100%‎» فوق رمزٍ اتّفقت عليه ثلاث
     استراتيجيات من عائلتين. فالعدد وتنوّع العائلات شرطان في الثقة،
     والإشارة المنفردة تُسمّى منفردة ولا تُسمّى إجماعاً.
     ===================================================================== */
  var solo = act.length === 1;
  var conf = (agree >= CONF_HI && fams.length >= 2 && act.length >= 3) ? "high"
           : ((agree >= CONF_MD && act.length >= 2) ? "med" : "low");
  /* الثقة تنخفض حين لا يكون المقيسُ منها شيئاً: إجماعُ عشرِ
     استراتيجياتٍ لم تُقَس واحدةٌ منها ليس دليلاً قوياً، بل عشرَ آراء. */
  if (measured === 0 && conf === "high") conf = "med";

  return Object.assign(out, {
    dir: maj, k: solo ? "solo" : (maj > 0 ? "up" : "dn"), solo: solo,
    t: (maj > 0 ? "شراء" : "بيع") + " — " +
       (solo ? "إشارة منفردة" : conf === "high" ? "توافق قوي"
        : conf === "med" ? "توافق متوسط" : "توافق ضعيف"),
    conf: conf,
    confT: conf === "high" ? "عالية" : conf === "med" ? "متوسطة" : "منخفضة",
    why: nUp + " شراء · " + nDn + " بيع · " + out.nQuiet + " لم تتفعّل" +
         (out.nOff ? " · " + out.nOff + " متعذّرة" : "") +
         (solo ? " — استراتيجيةٌ واحدة لا إجماع" : "")
  });
}

/* =====================================================================
   التوافق الاستثنائي — أربعة شروط مجتمعة.

   وأهمّها **عائلتان متمايزتان**: ثلاث نكهاتٍ من فكرةٍ واحدة تتّفق
   دائماً، فاتّفاقُها تكرارٌ لا تأكيد. ولولا هذا الشرط لكان أسهلَ ما
   في النظام أن يُشعل «توافقاً استثنائياً» كلما اتّفق الزخم مع
   الاختراق مع توافق الفريمات — وثلاثتها تقيس الاستمرار نفسه.

   والطزاجة شرطٌ كذلك: توافقٌ تامّ على حركةٍ وقعت قبل ثلاث ساعات
   معلومةٌ تاريخية لا فرصة.
   ===================================================================== */
var HOT_AGREE = 0.70, HOT_FAMS = 2, HOT_EQ = 60;

function confluenceOf(cons, res) {
  if (!cons || !cons.dir || cons.k === "mixed") return null;
  if (!(cons.agree >= HOT_AGREE)) return null;
  if (!(cons.fams.length >= HOT_FAMS)) return null;
  var side = (res || []).filter(function (r) { return r.dir === cons.dir && r.active; });
  var fresh = side.filter(function (r) { return r.st === "NEW" || r.st === "FRESH"; });
  if (!fresh.length) return null;
  var eqs = side.map(function (r) { return r.eq; }).filter(Number.isFinite);
  var bestEq = eqs.length ? Math.max.apply(null, eqs) : null;
  if (!(bestEq >= HOT_EQ)) return null;
  return {
    hot: true, dir: cons.dir, agree: cons.agree, fams: cons.fams.slice(), eq: bestEq,
    why: cons.n + " استراتيجيات من " + cons.fams.length + " عائلات متمايزة تتّفق، " +
         "وأحدثُها " + (fresh.length) + " إشارة طازجة، وأفضل جودة دخول " + Math.round(bestEq)
  };
}

/* =====================================================================
   المقارنة بمحرّك الفرص — تأكيدٌ أو تعارض.

   المحرّكان يقيسان شيئين مختلفين: الفرص تسأل «هل تحقّق شرطٌ معروف
   الحافّة؟» والماسح يسأل «كم طريقةً مستقلّة ترى نفس الجهة الآن؟».
   واتّفاقُهما معلومة، واختلافُهما معلومةٌ أهمّ — ولذلك يُقال ولا
   يُحسم أحدهما على الآخر: ليس لدينا قياسٌ يقول أيُّهما أصدق.
   ===================================================================== */
function compareEngines(scanDir, cons) {
  if (!cons || !cons.dir || cons.k === "mixed") return null;
  if (scanDir !== 1 && scanDir !== -1) return null;
  if (scanDir === cons.dir)
    return { k: "agree", t: "تأكيد", c: "var(--up)",
             why: "محرّك الفرص والماسح يشيران إلى نفس الجهة" };
  return { k: "clash", t: "تعارض", c: "var(--dn)",
           why: "محرّك الفرص يشير إلى " + (scanDir > 0 ? "صعود" : "هبوط") +
                " والماسح إلى " + (cons.dir > 0 ? "صعود" : "هبوط") +
                " — لا قياس عندنا يقول أيّهما أصدق، فاقرأ الاثنين" };
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    REGIMES: REGIMES, marketRegime: marketRegime,
    edgeWeight: edgeWeight, weightFor: weightFor, W_MIN: W_MIN, W_MAX: W_MAX,
    consensusOf: consensusOf, confluenceOf: confluenceOf, compareEngines: compareEngines,
    MIX_SHARE: MIX_SHARE, HOT_AGREE: HOT_AGREE, HOT_FAMS: HOT_FAMS, HOT_EQ: HOT_EQ
  };
}

