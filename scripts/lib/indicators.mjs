/* =====================================================================
   حسابات المؤشرات الفنية — منقولة من تطبيق مرصد البتكوين المرجعي
   نفس المنطق يعمل في المتصفح وفي مهمة GitHub Actions، فلا تتعارض النتائج.
   ===================================================================== */

export function sma(a, p) {
  const o = new Array(a.length).fill(null);
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    s += a[i];
    if (i >= p) s -= a[i - p];
    if (i >= p - 1) o[i] = s / p;
  }
  return o;
}

export function ema(a, p) {
  const o = new Array(a.length).fill(null), k = 2 / (p + 1);
  if (a.length < p) return o;
  let s = 0;
  for (let i = 0; i < p; i++) s += a[i];
  o[p - 1] = s / p;
  for (let i = p; i < a.length; i++) o[i] = a[i] * k + o[i - 1] * (1 - k);
  return o;
}

export function rsi(a, p = 14) {
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

export function macd(a, f = 12, s = 26, sg = 9) {
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

export function bb(a, p = 20, m = 2) {
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

export function atr(h, l, c, p = 14) {
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

export const last = (a) => {
  for (let i = a.length - 1; i >= 0; i--) if (a[i] !== null && isFinite(a[i])) return a[i];
  return null;
};

/* تحليل فريم واحد -> نتيجة من -100 (هبوط قوي) إلى +100 (صعود قوي) */
/* =====================================================================
   النتيجة الفنية من قيم المؤشرات عند نقطة واحدة.

   مستقلّة عن `analyze` عمداً: الأرشيف التاريخي يحتاج النتيجة عند كل
   شمعة من آلاف الشمعات، واستدعاء `analyze` على شريحة متنامية لكل شمعة
   تكلفته تربيعية. هنا تُحسب السلاسل مرة ثم تُستدعى هذه الدالة لكل نقطة.

   والأهم: تعريف واحد للنتيجة. لو نسخ سكربت الأرشيف منطق التسجيل لديه
   لصار يقيس نتيجةً غير التي تعرضها القائمة، بلا أن يظهر الاختلاف.
   ===================================================================== */
export function scoreFrom({ px, e20, e50, e200, rsi, hist, histRising, bbMid }) {
  let sc = 0, max = 0;
  const add = (cond, w) => { max += w; sc += cond ? w : -w; };
  if (e200 !== null && e200 !== undefined) add(px > e200, 2.5);
  if (e50 !== null && e50 !== undefined && e200 !== null && e200 !== undefined) add(e50 > e200, 1.5);
  if (e20 !== null && e20 !== undefined) add(px > e20, 1.0);
  if (hist !== null && hist !== undefined) { add(hist > 0, 1.5); max += 0.5; sc += histRising ? 0.5 : -0.5; }
  if (rsi !== null && rsi !== undefined) { max += 1; sc += rsi > 55 ? 1 : (rsi < 45 ? -1 : 0); }
  if (bbMid !== null && bbMid !== undefined) add(px > bbMid, 0.5);
  return max > 0 ? Math.max(-100, Math.min(100, sc / max * 100)) : 0;
}

export function analyze(k) {
  if (!k || k.length < 30) return null;
  const c = k.map(x => x.c), h = k.map(x => x.h), l = k.map(x => x.l);
  const e20 = ema(c, 20), e50 = ema(c, 50), e200 = ema(c, 200);
  const r = rsi(c, 14), m = macd(c), b = bb(c, 20, 2), at = atr(h, l, c, 14);
  const px = c[c.length - 1];
  const E20 = last(e20), E50 = last(e50), E200 = last(e200);
  const R = last(r), H = last(m.hist), A = last(at);
  const hi = m.hist.filter(v => v !== null);
  const rising = hi.length > 1 ? hi[hi.length - 1] > hi[hi.length - 2] : false;

  const norm = scoreFrom({ px, e20: E20, e50: E50, e200: E200, rsi: R,
                           hist: H, histRising: rising, bbMid: last(b.mid) });
  return {
    score: norm, px, e20: E20, e50: E50, e200: E200, rsi: R,
    hist: H, histRising: rising, atr: A,
    bbUp: last(b.up), bbLo: last(b.lo), bbMid: last(b.mid),
    series: { e20, e50, e200 }
  };
}

export function labelOf(s) {
  if (s >= 45) return { t: "اتجاه صاعد قوي", c: "var(--up)", k: "up2" };
  if (s >= 15) return { t: "ميل صاعد", c: "var(--up)", k: "up1" };
  if (s > -15) return { t: "عرضي / غير واضح", c: "var(--neu)", k: "flat" };
  if (s > -45) return { t: "ميل هابط", c: "var(--dn)", k: "dn1" };
  return { t: "اتجاه هابط قوي", c: "var(--dn)", k: "dn2" };
}

/* أوزان الفريمات — الكبيرة أبطأ وأقل خداعاً فوزنها أعلى */
export const TF_WEIGHT = { "15m": 0.5, "1h": 1, "4h": 1.5, "1d": 2 };
export const TFS = ["15m", "1h", "4h", "1d"];
export const TF_LABEL = { "15m": "15 دقيقة", "1h": "ساعة", "4h": "4 ساعات", "1d": "يومي" };

/* النتيجة الكلية الموزونة عبر الفريمات */
export function overallScore(byTf) {
  let sum = 0, wsum = 0;
  for (const tf of TFS) {
    const a = byTf[tf];
    if (!a || !isFinite(a.score)) continue;
    sum += a.score * TF_WEIGHT[tf];
    wsum += TF_WEIGHT[tf];
  }
  return wsum ? sum / wsum : null;
}

/* تجميع شمعات 1h إلى 4h (Yahoo لا يوفّر فريم 4 ساعات) */
export function aggregate(candles, factor) {
  const out = [];
  for (let i = 0; i < candles.length; i += factor) {
    const grp = candles.slice(i, i + factor);
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
