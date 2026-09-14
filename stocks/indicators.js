/* =====================================================================
   حسابات المؤشرات الفنية — نسخة واحدة يقرأها المتصفح والخادم معاً.

   كانت مكتوبة مرتين: هنا وفي `index.html` مضمَّنةً. والنسختان كانتا
   متطابقتين **بالحظّ** — فحصٌ للحرف أثبت تطابق `sma` و`ema` و`rsi`
   و`macd` و`bb`، واختلاف `atr` في الأقواس وحدها. لكن أوّل مؤشّرٍ جديد
   كان سيُكتب مرتين، وأوّل تصحيحٍ سيصيب واحدةً — فتقول القائمة رقماً
   ويقول الشارت غيره. وهي العلّة التي حذّر منها `CLAUDE.md` نفسه ووقعت
   رغم التحذير، لأن التحذير كان نصّاً ولم يكن فحصاً.

   يُحمَّل في المتصفح كسكربت كلاسيكي (‎<script src="indicators.js">‎)،
   ويُقرأ في Node عبر `module.exports` — نفس نمط `score.js` و`plan.js`.
   و`scripts/lib/indicators.mjs` غلافٌ رقيق يُعيد تصديره لمستوردي ES.
   ===================================================================== */

/* النتيجة الفنية في `score.js`. في Node تُطلب صراحةً، وفي المتصفح تكون
   عالميةً لأن السكربت الكلاسيكي يعرّف `var` على `window` — وترتيب
   الوسوم في `index.html` يضمن سبقَها. */
var _SC = (typeof module !== "undefined" && module.exports)
  ? require("./score.js")
  : (typeof window !== "undefined" ? window : globalThis);

function sma(a, p) {
  const o = new Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= p) s -= a[i - p];
    if (i >= p - 1) o[i] = s / p;
  }
  return o;
}

function ema(a, p) {
  const o = new Array(a.length).fill(null), k = 2 / (p + 1);
  if (a.length < p) return o;
  let s = 0;
  for (let i = 0; i < p; i++) s += a[i];
  o[p - 1] = s / p;
  for (let i = p; i < a.length; i++) o[i] = a[i] * k + o[i - 1] * (1 - k);
  return o;
}

function rsi(a, p = 14) {
  const o = new Array(a.length).fill(null);
  if (a.length <= p) return o;
  let g = 0, l = 0;
  for (let i = 1; i <= p; i++) { const d = a[i] - a[i - 1]; d >= 0 ? g += d : l -= d; }
  g /= p; l /= p;
  o[p] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  for (let i = p + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    g = (g * (p - 1) + (d > 0 ? d : 0)) / p;
    l = (l * (p - 1) + (d < 0 ? -d : 0)) / p;
    o[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l);
  }
  return o;
}

function macd(a, f = 12, s = 26, sg = 9) {
  const ef = ema(a, f), es = ema(a, s);
  const line = a.map((_, i) => (ef[i] !== null && es[i] !== null) ? ef[i] - es[i] : null);
  const vals = line.filter(v => v !== null);
  const sigVals = ema(vals, sg);
  const off = line.length - vals.length;
  const signal = new Array(a.length).fill(null);
  sigVals.forEach((v, i) => { if (v !== null) signal[i + off] = v; });
  const hist = line.map((v, i) => (v !== null && signal[i] !== null) ? v - signal[i] : null);
  return { line, signal, hist };
}

function bb(a, p = 20, m = 2) {
  const mid = sma(a, p);
  const up = new Array(a.length).fill(null), lo = new Array(a.length).fill(null);
  for (let i = p - 1; i < a.length; i++) {
    let v = 0;
    for (let j = i - p + 1; j <= i; j++) v += Math.pow(a[j] - mid[i], 2);
    const sd = Math.sqrt(v / p);
    up[i] = mid[i] + m * sd; lo[i] = mid[i] - m * sd;
  }
  return { mid, up, lo };
}

function atr(h, l, c, p = 14) {
  const tr = [];
  for (let i = 0; i < c.length; i++) {
    tr.push(i === 0 ? h[i] - l[i]
      : Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1])));
  }
  const o = new Array(c.length).fill(null);
  if (tr.length < p) return o;
  let s = 0;
  for (let i = 0; i < p; i++) s += tr[i];
  o[p - 1] = s / p;
  for (let i = p; i < tr.length; i++) o[i] = (o[i - 1] * (p - 1) + tr[i]) / p;
  return o;
}

const last = (a) => {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] !== null && isFinite(a[i])) return a[i];
  return null;
};

/* =====================================================================
   ADX — قوّة الاتجاه، لا جهته. وهو البعد الغائب عن النتيجة الفنية.

   النتيجة تقول «صاعد» أو «هابط»، ولا تقول **هل هناك اتجاهٌ أصلاً**.
   سهمٌ يتذبذب في نطاقٍ ضيّق قد يخرج بنتيجة ‎+60‎ لأن متوسّطاته مرتَّبة،
   ثم لا يذهب إلى أيّ مكان. ADX يفصل الاثنين: تحت ‎20‎ لا اتجاه، و
   ‎20–25‎ ناشئ، وفوق ‎25‎ قائم، وفوق ‎55‎ متطرّف وربما مُنهَك.

   وهذه هي المعلومة التي تحوّل «توافق الفريمات» من شرطٍ يُحقَّق كثيراً
   إلى شرطٍ يُحقَّق حين يعني شيئاً: توافقٌ بلا قوّة اتجاه تذبذبٌ مرتَّب.

   الحساب بطريقة Wilder الأصلية — تمهيدٌ تراكمي لا متوسّط متحرّك بسيط.
   البسيط يعطي أرقاماً أعلى بانتظام فتبدو كلّ الأسهم ذات اتجاه.
   ===================================================================== */
function adx(h, l, c, p) {
  p = p || 14;
  var n = c.length;
  var out = { adx: new Array(n).fill(null), pdi: new Array(n).fill(null), mdi: new Array(n).fill(null) };
  if (n < p * 2 + 1) return out;

  var tr = new Array(n).fill(0), pDM = new Array(n).fill(0), mDM = new Array(n).fill(0);
  for (var i = 1; i < n; i++) {
    tr[i] = Math.max(h[i] - l[i], Math.abs(h[i] - c[i - 1]), Math.abs(l[i] - c[i - 1]));
    var up = h[i] - h[i - 1], dn = l[i - 1] - l[i];
    /* الحركة الاتجاهية للجانب الأكبر وحده: يومٌ يوسّع الطرفين معاً
       (شمعةٌ مُبتلِعة) ليس يوماً اتجاهياً في أيّ جهة */
    pDM[i] = (up > dn && up > 0) ? up : 0;
    mDM[i] = (dn > up && dn > 0) ? dn : 0;
  }

  // التمهيد الأوّل مجموعٌ صريح، ثم تراكمٌ بطريقة Wilder
  var str = 0, sp = 0, sm = 0;
  for (var j = 1; j <= p; j++) { str += tr[j]; sp += pDM[j]; sm += mDM[j]; }

  var dxs = [];
  for (var t = p; t < n; t++) {
    if (t > p) {
      str = str - str / p + tr[t];
      sp  = sp  - sp  / p + pDM[t];
      sm  = sm  - sm  / p + mDM[t];
    }
    if (!(str > 0)) continue;
    var pdi = 100 * sp / str, mdi = 100 * sm / str;
    out.pdi[t] = pdi; out.mdi[t] = mdi;
    var sum = pdi + mdi;
    var dx = sum > 0 ? 100 * Math.abs(pdi - mdi) / sum : 0;
    dxs.push(dx);
    // ADX تمهيدُ DX نفسه: أوّل قيمة متوسّطُ أوّل p، ثم تراكم
    if (dxs.length === p) {
      var s2 = 0;
      for (var q = 0; q < dxs.length; q++) s2 += dxs[q];
      out.adx[t] = s2 / p;
    } else if (dxs.length > p) {
      out.adx[t] = (out.adx[t - 1] * (p - 1) + dx) / p;
    }
  }
  return out;
}

/* وصفُ قوّة الاتجاه — عتبات Wilder المعروفة، لا اختراع */
function adxLabel(v) {
  if (!Number.isFinite(v)) return { t: "—", k: "na" };
  if (v < 20) return { t: "بلا اتجاه — تذبذب", k: "chop" };
  if (v < 25) return { t: "اتجاه ناشئ", k: "weak" };
  if (v < 40) return { t: "اتجاه قائم", k: "trend" };
  if (v < 55) return { t: "اتجاه قويّ", k: "strong" };
  return { t: "اتجاه متطرّف — احذر الانعكاس", k: "extreme" };
}

/* =====================================================================
   التباعد — السعر يسجّل طرفاً جديداً والمؤشّر لا يتبعه.

   أقوى ما في التحليل الفني الكلاسيكي وأكثره تعرّضاً للتلفيق: من يرسم
   خطّين على شارت يجد تباعداً في كلّ سهم. فالتعريف هنا **آليّ وصارم**:

     ١) قمّتان (أو قاعان) **محلّيان مؤكَّدان** — أعلى من `k` شمعات على
        كلّ جانب. بلا تأكيد الجانبين تصير كلّ شمعة قمّة.
     ٢) بينهما فاصلٌ زمنيّ أدنى — قمّتان متجاورتان ضجيج.
     ٣) السعر تجاوز الطرف السابق بهامشٍ من ATR — تجاوزٌ بمليمتر ليس
        قمّةً جديدة. نفس منطق المنطقة الميتة في `score.js`.
     ٤) والمؤشّر تحرّك في الجهة المعاكسة فعلاً لا بصفر.

   والعائد يحمل **موضع** القمّتين كي ترسم الواجهة ما تدّعيه: رقمٌ يقول
   «تباعد» بلا موضعٍ يُريه لا يمكن تكذيبه.
   ===================================================================== */
function pivots(arr, k, kind) {
  var out = [];
  for (var i = k; i < arr.length - k; i++) {
    var v = arr[i];
    if (v === null || !Number.isFinite(v)) continue;
    var ok = true;
    for (var j = i - k; j <= i + k && ok; j++) {
      if (j === i || arr[j] === null) continue;
      if (kind === "high" ? arr[j] > v : arr[j] < v) ok = false;
    }
    if (ok) out.push(i);
  }
  return out;
}

function divergence(h, l, ind, atrSeries, opt) {
  var o = opt || {};
  var k = o.k || 3, minGap = o.minGap || 5, lookback = o.lookback || 60;
  var minMove = (o.minMove === undefined || o.minMove === null) ? 0.5 : o.minMove;
  var n = ind.length, from = Math.max(0, n - lookback), res = [];

  var kinds = ["high", "low"];
  for (var ki = 0; ki < kinds.length; ki++) {
    var kind = kinds[ki];
    var px = kind === "high" ? h : l;
    var idx = pivots(px, k, kind).filter(function (i) { return i >= from; });
    if (idx.length < 2) continue;
    // آخر قمّتين مؤكَّدتين وبينهما فاصل
    var b = idx[idx.length - 1], a = null;
    for (var t = idx.length - 2; t >= 0; t--) if (b - idx[t] >= minGap) { a = idx[t]; break; }
    if (a === null) continue;
    var ia = ind[a], ib = ind[b];
    if (!Number.isFinite(ia) || !Number.isFinite(ib)) continue;
    var tol = (Number.isFinite(atrSeries && atrSeries[b]) ? atrSeries[b] : 0) * minMove;
    var dPx = px[b] - px[a];
    if (Math.abs(dPx) <= tol) continue;                 // لم يتجاوز الطرف فعلاً
    var dInd = ib - ia;
    if (dInd === 0) continue;
    // هابط: قمّةٌ أعلى ومؤشّرٌ أدنى. صاعد: قاعٌ أدنى ومؤشّرٌ أعلى.
    var bear = kind === "high" && dPx > 0 && dInd < 0;
    var bull = kind === "low"  && dPx < 0 && dInd > 0;
    if (!bear && !bull) continue;
    res.push({ dir: bear ? -1 : 1, kind: kind, at: b, prev: a,
               px: [px[a], px[b]], ind: [ia, ib], bars: b - a });
  }
  // الأحدث أوّلاً: تباعدٌ عمره عشرون شمعة أضعف من تباعد شمعتين
  return res.sort(function (x, y) { return y.at - x.at; });
}

/* =====================================================================
   انضغاط بولنجر — تمهيدٌ للحركة لا حركة.

   عرض النطاق منسوباً إلى وسطه، ثم **رتبته** داخل نافذةٍ ماضية. الرتبة
   لا القيمة المطلقة: نطاقٌ عرضه ‎2%‎ ضيّقٌ لسهمٍ مرافق وواسعٌ لسهمٍ
   هادئ، فالمقارنة تكون مع تاريخ السهم نفسه.

   وقيمتُه أنه **يسبق** الحركة، لكنه لا يقول جهةً — فيُقرن باتجاه
   النتيجة أو بـ ‎+DI/−DI‎. وحده ليس إشارة.
   ===================================================================== */
function bbWidth(c, p, m) {
  var b = bb(c, p || 20, m || 2);
  var w = new Array(c.length).fill(null);
  for (var i = 0; i < c.length; i++)
    if (b.up[i] !== null && b.mid[i] > 0) w[i] = (b.up[i] - b.lo[i]) / b.mid[i];
  return w;
}

/* الرتبة المئوية لآخر قيمة داخل نافذة.
   الاسم `rankInWindow` لا `pctRank`: الثانية موجودة في `index.html`
   بدلالةٍ أخرى ‎(sorted, v)‎ للأساسيات، والسكربتات الكلاسيكية تتشارك
   نطاقاً واحداً — فالأخيرُ تحميلاً يغلب بلا أيّ خطأ ظاهر. كان
   `analyze` يستدعي دالّة الأساسيات ويحسب الانضغاط منها.
   الأصل — ‎0‎ = الأضيق على الإطلاق.
   المقام `length - 1` لا `length`: الرتبة نسبةُ ما دونها إلى ما عداها،
   فبقيمةٍ هي الأدنى تخرج صفراً وبالأعلى مئةً بالضبط. */
function rankInWindow(series, win) {
  var a = [];
  for (var i = Math.max(0, series.length - (win || 120)); i < series.length; i++)
    if (Number.isFinite(series[i])) a.push(series[i]);
  if (a.length < 20) return null;
  var cur = a[a.length - 1], below = 0;
  for (var j = 0; j < a.length; j++) if (a[j] < cur) below++;
  return below / (a.length - 1) * 100;
}

/* =====================================================================
   تحليل فريم واحد.

   `adx` و`squeeze` و`div` **إضافاتٌ لا تمسّ `score`**: تعريفُ النتيجة
   في `score.js`، وتغييرُه يُبطل الأرشيف والسجلّ معاً. فقوّة الاتجاه
   والتباعد والانضغاط تُعرَض وتُستعمل في الشروط، ولا تُدمج في الرقم.
   فصلٌ مقصود: رقمٌ واحد يحمل ستّ معلومات لا يمكن تكذيبه في أيّها.
   ===================================================================== */
/* =====================================================================
   مؤشّرات الحجم — الحقل الوحيد الذي نملكه ولا نستعمله.

   كل مؤشّراتنا حتى الآن سعريّة بحتة: المتوسطات وRSI وMACD وبولنجر وADX
   كلّها دوالٌّ في السعر وحده. والحجم محفوظٌ في كل شمعة منذ اليوم الأول
   ولا يقرؤه إلا شرطٌ واحد («حجم غير معتاد») يقارنه بمتوسّطه.

   وهو يجيب سؤالاً لا يجيبه السعر: **من يحرّك الحركة**. صعودٌ بحجمٍ
   متناقص وصعودٌ بحجمٍ متزايد يبدوان واحداً على الشارت ويعنيان نقيضين.

   ثلاثة، وكلٌّ يجيب سؤالاً مختلفاً:
   • OBV — التراكم: يجمع حجم اليوم الصاعد ويطرح الهابط. اتجاهه مقابل
     اتجاه السعر هو المعلومة، لا قيمته المطلقة (وهي بلا وحدة).
   • MFI — «RSI مرجَّحٌ بالحجم»: نطاقه ‎0..100‎ كـRSI، والفرق أنه يزن كل
     يوم بقيمة ما تُدووِل فيه. تشبّعٌ عند ‎80/20‎ بحجمٍ حقيقي خلفه.
   • الستوكاستك — موضع الإغلاق داخل مدى النافذة: يقول «أين أغلق ضمن ما
     تحرّكه»، وهو أسرع من RSI فيلتقط الانعطاف قبله ويُخطئ أكثر منه.
   ===================================================================== */
function obv(c, v) {
  var out = [0];
  for (var i = 1; i < c.length; i++) {
    var d = (!Number.isFinite(c[i]) || !Number.isFinite(c[i - 1])) ? 0
          : c[i] > c[i - 1] ? (v[i] || 0) : c[i] < c[i - 1] ? -(v[i] || 0) : 0;
    out.push(out[i - 1] + d);
  }
  return out;
}

function mfi(h, l, c, v, p) {
  p = p || 14;
  var tp = [], out = new Array(c.length).fill(null);
  for (var i = 0; i < c.length; i++) tp.push((h[i] + l[i] + c[i]) / 3);
  for (var j = p; j < c.length; j++) {
    var pos = 0, neg = 0;
    for (var m = j - p + 1; m <= j; m++) {
      var flow = tp[m] * (v[m] || 0);
      if (!Number.isFinite(flow)) continue;
      if (tp[m] > tp[m - 1]) pos += flow; else if (tp[m] < tp[m - 1]) neg += flow;
    }
    // بلا تدفّق سالب لا نسبة — و‎100‎ هنا صحيحة لا افتراض
    out[j] = neg === 0 ? (pos > 0 ? 100 : null) : 100 - 100 / (1 + pos / neg);
  }
  return out;
}

function stoch(h, l, c, p, sm) {
  p = p || 14; sm = sm || 3;
  var kArr = new Array(c.length).fill(null);
  for (var i = p - 1; i < c.length; i++) {
    var hh = -Infinity, ll = Infinity;
    for (var j = i - p + 1; j <= i; j++) {
      if (h[j] > hh) hh = h[j];
      if (l[j] < ll) ll = l[j];
    }
    // مدىً صفريّ (سلسلة مجمّدة) لا يُقسم عليه — ولا يُملأ بخمسين
    kArr[i] = (hh - ll) > 0 ? (c[i] - ll) / (hh - ll) * 100 : null;
  }
  /* ‎%D‎ بحلقةٍ صريحة لا بـ`sma`: تلك مجموعٌ متدحرج، وأوّل `NaN` يدخله
     يبقى فيه إلى آخر السلسلة — فتخرج ‎%D‎ فارغةً كلّها بينما ‎%K‎ سليمة.
     وقع فعلاً وظهر في الواجهة كخانةٍ ناقصة بلا خطأ ولا استثناء. */
  var dArr = new Array(c.length).fill(null);
  for (var t = 0; t < kArr.length; t++) {
    if (t < sm - 1) continue;
    var s2 = 0, cnt = 0;
    for (var u = t - sm + 1; u <= t; u++) if (Number.isFinite(kArr[u])) { s2 += kArr[u]; cnt++; }
    if (cnt === sm) dArr[t] = s2 / sm;
  }
  return { k: kArr, d: dArr };
}

/* =====================================================================
   مستوى أكثر الأسعار تداولاً (POC) — الدعم الذي لا تراه المتوسطات.

   المستويات عندنا كلّها مشتقّةٌ من **نقاط**: قمّةٌ سابقة، قاعٌ سابق،
   بيفوت، متوسّط. وكلّها تصف لحظةً واحدة. أما أكثر سعرٍ تبادل عنده
   الناس فيصف **أين تراكمت المراكز فعلاً** — وهو السعر الذي يجد عنده
   الكثيرون أنفسهم متعادلين فيبيعون، أو مقتنعين فيشترون.

   والحساب على نافذةٍ محدودة: توزيعُ سنتين يصف سوقاً لم يعد قائماً.
   ===================================================================== */
function volumeProfile(k, bins, win) {
  bins = bins || 24; win = win || 120;
  var s = k.slice(-win).filter(function (x) { return Number.isFinite(x.c) && Number.isFinite(x.h); });
  if (s.length < 20) return null;
  var lo = Math.min.apply(null, s.map(function (x) { return x.l; }));
  var hi = Math.max.apply(null, s.map(function (x) { return x.h; }));
  if (!(hi > lo)) return null;
  var step = (hi - lo) / bins, buckets = new Array(bins).fill(0);
  for (var i = 0; i < s.length; i++) {
    // الحجم يُوزَّع على مدى الشمعة لا يُكدَّس عند إغلاقها: شمعةٌ مداها
    // ‎5%‎ تُدووِل على طول مداها، ونسبُ كلّه إلى نقطةٍ واحدة يخترع قمّة
    var a = Math.max(0, Math.min(bins - 1, Math.floor((s[i].l - lo) / step)));
    var b = Math.max(0, Math.min(bins - 1, Math.floor((s[i].h - lo) / step)));
    var share = (s[i].v || 0) / (b - a + 1);
    for (var j = a; j <= b; j++) buckets[j] += share;
  }
  var top = 0;
  for (var n = 1; n < bins; n++) if (buckets[n] > buckets[top]) top = n;
  var total = buckets.reduce(function (x, y) { return x + y; }, 0);
  if (!(total > 0)) return null;
  return { poc: lo + step * (top + 0.5), lo: lo, hi: hi,
           share: buckets[top] / total * 100, bins: buckets, step: step, base: lo };
}

function analyze(k) {
  if (!k || k.length < 30) return null;
  var c = k.map(function (x) { return x.c; });
  var h = k.map(function (x) { return x.h; });
  var l = k.map(function (x) { return x.l; });
  var e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
  var r = rsi(c, 14), m = macd(c), b = bb(c, 20, 2), at = atr(h, l, c, 14);
  var px = c[c.length - 1];
  var E20 = last(e20), E50 = last(e50), E200 = last(e200);
  var R = last(r), H = last(m.hist), A = last(at);
  var hi = m.hist.filter(function (v) { return v !== null; });
  // القيمة السابقة تُمرَّر لا الرايةُ وحدها: `scoreFrom` تحتاجها لتطبيق
  // المنطقة الميتة على الميل أيضاً — فرقٌ في الخانة الرابعة كان يقلبه
  var hPrev = hi.length > 1 ? hi[hi.length - 2] : null;
  var rising = hi.length > 1 ? hi[hi.length - 1] > hi[hi.length - 2] : false;

  var norm = _SC.scoreFrom({ px: px, e20: E20, e50: E50, e200: E200, rsi: R,
                             hist: H, histPrev: hPrev, histRising: rising,
                             bbMid: last(b.mid), atr: A });

  var ax = adx(h, l, c, 14);
  var w = bbWidth(c, 20, 2);
  /* التباعد على RSI: أكثر المؤشّرات استعمالاً له، ونطاقه محدود (0..100)
     فالمقارنة بين نقطتين فيه ذاتُ معنى بلا تطبيع. وعلى MACD hist تخرج
     أرقامٌ بمقياس السعر فيلزم تطبيعها — تعقيدٌ بلا مقابل هنا. */
  var dv = divergence(h, l, r, at, { lookback: 60 });

  /* الحجم قد يكون غائباً كلّه (Twelve Data وStooq لا يعطيانه، و
     `Math.round(x.v || 0)` تصفّره) — فمؤشّرات الحجم تسقط كلّها بدل أن
     تخرج أصفاراً تُقرأ «لا تراكم». الفرق بين «صفر» و«لا نعرف» هو نفس
     قاعدة «اعرض ‎—‎ لا رقماً ملفّقاً». */
  var v = k.map(function (x) { return x.v || 0; });
  var hasVol = v.filter(function (x) { return x > 0; }).length >= Math.min(30, k.length * 0.5);
  var mf = hasVol ? mfi(h, l, c, v, 14) : [];
  var sk = stoch(h, l, c, 14, 3);
  var vp = hasVol ? volumeProfile(k, 24, 120) : null;
  var obvSlope = null, obvDiv = null;
  if (hasVol && c.length > 25) {
    var ob = obv(c, v), n = ob.length;
    var d0 = ob[n - 21], d1 = ob[n - 1];
    var scale = Math.max(1, Math.abs(d0) || 1);
    obvSlope = (d1 - d0) / scale * 100;
    var pxSlope = (c[n - 1] - c[n - 21]) / c[n - 21] * 100;
    /* التباعد لا يُعلن إلا حين تتعارض **الإشارتان** فعلاً وبحركةٍ ذات
       شأن: سعرٌ صعد ‎1%‎ وتراكمٌ نزل ‎1%‎ ضجيجٌ لا تباعد. */
    if (Number.isFinite(pxSlope) && Math.abs(pxSlope) > 2 && Math.abs(obvSlope) > 5
        && Math.sign(pxSlope) !== Math.sign(obvSlope))
      obvDiv = pxSlope > 0 ? -1 : 1;      // سعرٌ صاعد بلا تراكم = سلبي
  }

  return {
    score: norm, px: px, e20: E20, e50: E50, e200: E200, rsi: R,
    hist: H, histPrev: hPrev, histRising: rising, atr: A,
    bbUp: last(b.up), bbLo: last(b.lo), bbMid: last(b.mid),
    adx: last(ax.adx), pdi: last(ax.pdi), mdi: last(ax.mdi),
    bbw: last(w), squeeze: rankInWindow(w, 120),
    div: dv.length ? { dir: dv[0].dir, bars: dv[0].bars, kind: dv[0].kind } : null,
    mfi: last(mf), stochK: last(sk.k), stochD: last(sk.d),
    /* اتجاه OBV لا قيمته: الرقم بلا وحدة ولا معنى له منفرداً، وإنما
       ميلُه على عشرين شمعة مقارَناً بميل السعر. و`obvDiv` حين يختلفان:
       سعرٌ يصنع قمّةً أعلى وتراكمٌ لا يتبعه. */
    obvSlope: obvSlope, obvDiv: obvDiv,
    poc: vp ? { p: vp.poc, share: vp.share } : null,
    series: { e20: e20, e50: e50, e200: e200 }
  };
}
/* =====================================================================
   الشموع المؤكَّدة — الاتجاه لا يُحسب من شمعة ما زالت تتكوّن.

   ياهو قد يعيد لفريم الساعة شمعتين في الفتحة نفسها: شمعة 19:30
   المتداولة، ثم لقطة 19:31 بحجم صفر. كما أن شمعة 15د الجارية يتغيّر
   إغلاقها وحجمها كل دقيقة. تمريرهما إلى EMA/MACD كان يقلب بوابةً كاملة
   كل دقيقتين مع حركة سعر لا تُرى. نثبت شبكة الزمن، نختار أعلى حجم عند
   التكرار، ثم نستبعد الفتحة التي لم يكتمل زمنها بعد.

   اليومي الأمريكي حالة خاصة: شمعة الجلسة تنتهي عند الإغلاق لا بعد 24
   ساعة من طابع الافتتاح. لذلك تُستبعد شمعة اليوم في PRE/REGULAR وتُقبل
   بعد الإغلاق. الكريبتو يبقى على 24 ساعة فعلية. */
function confirmedCandles(candles, tf, now, mkt, session) {
  if (!Array.isArray(candles) || !candles.length) return [];
  now = Number.isFinite(now) ? now : Date.now();
  var dur = { "5m": 300000, "15m": 900000, "1h": 3600000, "4h": 14400000, "1d": 86400000 }[tf];
  var clean = candles.filter(function (x) {
    return x && Number.isFinite(x.t) && Number.isFinite(x.o) && Number.isFinite(x.h)
      && Number.isFinite(x.l) && Number.isFinite(x.c) && x.h >= x.l;
  }).slice().sort(function (a, b) { return a.t - b.t; });
  if (!dur || !clean.length) return clean;

  /* شبكة الفريم من أكثر إزاحة زمنية تكراراً. 13:30 و14:30 (توقيت صيفي)
     كلاهما على إزاحة نصف الساعة لفريم الساعة، بينما 19:31 شاذة. */
  if (tf !== "1d") {
    var freq = {}, minute = 60000;
    clean.forEach(function (x) {
      var off = Math.round((((x.t % dur) + dur) % dur) / minute) * minute;
      if (off >= dur) off = 0;
      freq[off] = (freq[off] || 0) + 1;
    });
    var mode = +Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; })[0];
    var slots = {};
    clean.forEach(function (x) {
      var off = ((x.t % dur) + dur) % dur;
      var dist = Math.min(Math.abs(off - mode), dur - Math.abs(off - mode));
      if (dist > 15000) return;                 // طابع خارج الشبكة بأكثر من 15ث
      var key = Math.round((x.t - mode) / dur);
      var old = slots[key];
      /* الحجم الحقيقي يغلب لقطة الحجم الصفري؛ وعند التعادل الأحدث أدق. */
      if (!old || (x.v || 0) > (old.v || 0) || ((x.v || 0) === (old.v || 0) && x.t > old.t)) slots[key] = x;
    });
    clean = Object.values(slots).sort(function (a, b) { return a.t - b.t; });
  }

  if (tf === "1d" && mkt !== "crypto") {
    if (session === "PRE" || session === "REGULAR") {
      var day = function (t) {
        try { return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t)); }
        catch (_) { return new Date(t).toISOString().slice(0, 10); }
      };
      if (clean.length && day(clean[clean.length - 1].t) === day(now)) clean.pop();
    }
    return clean;
  }
  return clean.filter(function (x) { return x.t + dur <= now - 5000; });
}

/* تجميع 4h مثبت داخل كل يوم UTC. التجميع القديم بدأ من أول عنصر في
   المصفوفة؛ وحين تحرّكت نافذة Yahoo ساعةً واحدة تغيّرت حدود **كل**
   شموع 4h دفعةً واحدة. إعادة البدء مع كل يوم تجعل إضافة/حذف يوم قديم
   عاجزة عن إعادة تشكيل التاريخ الحديث. */
function aggregate(candles, factor) {
  const out = [];
  const days = [];
  let key = null, day = null;
  (candles || []).slice().sort((a, b) => a.t - b.t).forEach(x => {
    const k = new Date(x.t).toISOString().slice(0, 10);
    if (k !== key) { key = k; day = []; days.push(day); }
    day.push(x);
  });
  for (const bars of days) for (let i = 0; i < bars.length; i += factor) {
    const grp = bars.slice(i, i + factor);
    if (!grp.length) continue;
    out.push({
      t: grp[0].t,
      o: grp[0].o,
      h: Math.max(...grp.map(x => x.h)),
      l: Math.min(...grp.map(x => x.l)),
      c: grp[grp.length - 1].c,
      v: grp.reduce((a, x) => a + (x.v || 0), 0)
    });
  }
  return out;
}

/* =====================================================================
   VWAP الجلسة — متوسّط السعر مرجَّحاً بالحجم منذ افتتاح الجلسة.

   ليس مؤشّراً متدحرجاً كبقيّة ما في هذا الملف: يبدأ من الصفر عند كل
   افتتاح، فمرجعه `period.regular` لا عددُ شمعات. ولذلك يأخذ `period`
   صراحةً بدل أن يشتقّ يوماً من الطوابع — الاشتقاق يخطئ في العطلات
   ونصف الجلسات، و`period` يعطيه ياهو مقيساً.

   **ويعود `null` حين يكون مجموع الحجم صفراً.** Twelve Data وStooq لا
   يعطيان حجماً و`Math.round(x.v || 0)` تصفّره — وVWAP بحجمٍ صفر متوسّطٌ
   حسابيّ يحمل اسم VWAP، أي رقمٌ ملفّق يبدو صحيحاً. نفس القاعدة التي
   تُسقط OBV وMFI عند غياب الحجم: «اعرض ‎—‎ لا رقماً ملفّقاً».

   والانحراف مرجَّحٌ بالحجم كذلك (لا حسابيّاً): الشريطان يصفان أين
   تُدووِل فعلاً، فحسابهما بوزنٍ متساوٍ يناقض الوزن الذي بُني عليه
   المركز نفسه.
   ===================================================================== */
function sessionVwap(k, period) {
  if (!Array.isArray(k) || !period || !period.regular) return null;
  var s0 = period.regular.start, s1 = period.regular.end;
  if (!Number.isFinite(s0) || !Number.isFinite(s1)) return null;
  var tps = [], vs = [], pv = 0, vol = 0;
  for (var i = 0; i < k.length; i++) {
    var x = k[i];
    if (!Number.isFinite(x.t) || x.t < s0 || x.t > s1) continue;
    if (!Number.isFinite(x.h) || !Number.isFinite(x.l) || !Number.isFinite(x.c)) continue;
    var v = x.v || 0;
    if (!(v > 0)) continue;                 // شمعةٌ بلا تداول لا تحمل وزناً
    var tp = (x.h + x.l + x.c) / 3;
    tps.push(tp); vs.push(v); pv += tp * v; vol += v;
  }
  if (!(vol > 0) || tps.length < 2) return null;
  var vwap = pv / vol, acc = 0;
  for (var j = 0; j < tps.length; j++) acc += vs[j] * (tps[j] - vwap) * (tps[j] - vwap);
  var sd = Math.sqrt(acc / vol);
  if (!Number.isFinite(vwap) || !Number.isFinite(sd)) return null;
  return { vwap: vwap, sd: sd, upper: vwap + sd, lower: vwap - sd, bars: tps.length };
}

/* =====================================================================
   نطاق الافتتاح — أعلى وأدنى أول دقائق من الجلسة الرسمية.

   `complete` هو الحقل المهمّ: النطاق قيد التكوّن ليس نطاقاً، وكسرُه
   قبل اكتماله يكسر شيئاً لم يُرسَم بعد. فتُعاد الراية ويقرّر المستهلك
   الانسحاب — لا يُخترع نطاقٌ من شمعةٍ واحدة.

   ويعود `null` حين لا تقع أيّ شمعة داخل النافذة: قبل الافتتاح، أو
   حين يصف `period` يوماً سابقاً (وهي مصيدة موثّقة — الفترات المحفوظة
   تصف يوم جلبها).
   ===================================================================== */
function openingRange(k, period, minutes) {
  minutes = minutes || 15;
  if (!Array.isArray(k) || !period || !period.regular) return null;
  var s0 = period.regular.start;
  if (!Number.isFinite(s0)) return null;
  var s1 = s0 + minutes * 60000;
  var hi = -Infinity, lo = Infinity, n = 0, lastT = 0;
  for (var i = 0; i < k.length; i++) {
    var x = k[i];
    if (!Number.isFinite(x.t) || x.t < s0 || x.t >= s1) continue;
    if (!Number.isFinite(x.h) || !Number.isFinite(x.l)) continue;
    if (x.h > hi) hi = x.h;
    if (x.l < lo) lo = x.l;
    if (x.t > lastT) lastT = x.t;
    n++;
  }
  if (!n || !(hi > lo)) return null;
  /* مكتملٌ حين توجد شمعةٌ بعد نهاية النافذة — لا حين «مضى الوقت»:
     السلسلة قد تتأخّر دورةً كاملة، فالحكم بالبيانات لا بالساعة. */
  var after = false;
  for (var j = 0; j < k.length; j++) if (Number.isFinite(k[j].t) && k[j].t >= s1) { after = true; break; }
  return { hi: hi, lo: lo, mid: (hi + lo) / 2, bars: n, complete: after };
}

/* وسيط الحجم على نافذة — لا متوسّطه. الدفعة الشاذّة ترفع المتوسّط الذي
   تُقاس به فتخفي نفسها؛ الوسيط لا يتحرّك بها. ونفس مبدأ «بالوسيط لا
   المتوسط» المطبَّق في إحصاء السوق والأرشيف. */
function volMedian(k, win) {
  win = win || 20;
  if (!Array.isArray(k) || k.length < 2) return null;
  var v = [];
  for (var i = Math.max(0, k.length - win - 1); i < k.length - 1; i++) {
    var x = k[i] && k[i].v;
    if (Number.isFinite(x) && x > 0) v.push(x);
  }
  if (v.length < 5) return null;
  v.sort(function (a, b) { return a - b; });
  var m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { sma: sma, ema: ema, rsi: rsi, macd: macd, bb: bb, atr: atr,
                     last: last, adx: adx, adxLabel: adxLabel, pivots: pivots,
                     divergence: divergence, bbWidth: bbWidth, rankInWindow: rankInWindow,
                     obv: obv, mfi: mfi, stoch: stoch, volumeProfile: volumeProfile,
                     sessionVwap: sessionVwap, openingRange: openingRange,
                     volMedian: volMedian,
                     analyze: analyze, aggregate: aggregate, confirmedCandles: confirmedCandles };
}
