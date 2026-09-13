/* طبقة ذكاء القرار: توحّد مقاييس غير متجانسة إلى رتب قابلة للمقارنة.
   لا تغيّر المؤشرات أو خطة الصفقة؛ تقرأها وتقرر إن كان الدليل كافياً
   لعرض الفرصة في «وضع الدقة». */

const finite = Number.isFinite;
export const intelMedian = (a) => {
  const v = (a || []).filter(finite).sort((x, y) => x - y);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};

export function intelRank(a, x, inverse = false) {
  const v = (a || []).filter(finite).sort((m, n) => m - n);
  if (!finite(x) || v.length < 2) return null;
  let below = 0;
  while (below < v.length && v[below] < x) below++;
  const p = below / (v.length - 1) * 100;
  return Math.max(0, Math.min(100, inverse ? 100 - p : p));
}

const avg = (a) => {
  const v = a.filter(finite);
  return v.length ? v.reduce((x, y) => x + y, 0) / v.length : null;
};

export function financialScores(rows, fundamentals) {
  const F = fundamentals || {}, clean = (rows || []).filter(r => F[r.s] && !r.mkt);
  const bySec = {};
  for (const r of clean) (bySec[r.sec || "—"] ||= []).push(F[r.s]);
  const secMed = {};
  for (const [sec, list] of Object.entries(bySec)) secMed[sec] = {
    n: list.length,
    pe: intelMedian(list.map(f => f.pe)), fpe: intelMedian(list.map(f => f.fpe)),
    pb: intelMedian(list.map(f => f.pb)), roe: intelMedian(list.map(f => f.roe)),
    margin: intelMedian(list.map(f => f.margin)), grow: intelMedian(list.map(f => f.revGrow))
  };

  const groups = {};
  for (const r of clean) {
    const sec = r.sec || "—";
    if (!groups[sec]) groups[sec] = { pe: [], fpe: [], pb: [], roe: [], margin: [], grow: [] };
    const f = F[r.s], g = groups[sec];
    for (const k of Object.keys(g)) if (finite(f[k === "grow" ? "revGrow" : k])) g[k].push(f[k === "grow" ? "revGrow" : k]);
  }

  const scores = {};
  for (const r of clean) {
    const f = F[r.s], g = groups[r.sec || "—"];
    const quality = avg([intelRank(g.roe, f.roe), intelRank(g.margin, f.margin)]);
    const growth = intelRank(g.grow, f.revGrow);
    const value = avg([intelRank(g.pe, f.pe, true), intelRank(g.fpe, f.fpe, true), intelRank(g.pb, f.pb, true)]);
    const dist = f.recDist;
    const analyst = dist && dist.n ? Math.max(0, Math.min(100, ((dist.sb || 0) * 2 + (dist.b || 0) - (dist.s || 0) - (dist.ss || 0) * 2) / (dist.n * 2) * 100 + 50)) : null;
    const insider = f.insider && finite(f.insider.ratio) ? Math.max(0, Math.min(100, 50 + f.insider.ratio * 35)) : null;
    const sentiment = avg([analyst, insider]);
    const parts = { quality, growth, value, sentiment };
    const weighted = [[quality, .35], [growth, .25], [value, .25], [sentiment, .15]].filter(x => finite(x[0]));
    const total = weighted.length ? weighted.reduce((s, x) => s + x[0] * x[1], 0) / weighted.reduce((s, x) => s + x[1], 0) : null;
    scores[r.s] = { total, ...parts, coverage: weighted.length / 4 };
  }
  return { scores, secMed };
}

const clamp = (n) => Math.max(0, Math.min(100, n));
export function precisionScore(x) {
  const reject = [];
  if (x.dir !== 1) reject.push("وضع الدقة مخصص للشراء دون البيع المكشوف");
  if (x.stale) reject.push("الشموع قديمة");
  if (!finite(x.strength) || x.strength < 25) reject.push("الاتجاه أضعف من البوابة");
  if (!finite(x.agree) || x.agree < .75) reject.push("الفريمات غير متوافقة");
  if (!finite(x.rr) || x.rr < 2) reject.push("العائد/المخاطرة دون 2:1");
  if (!x.evidence || !(x.evidence.edge > 0) || !(x.evidence.n >= 500)) reject.push("لا حافة تاريخية موجبة بعينة كافية");
  if (finite(x.earnDays) && x.earnDays >= 0 && x.earnDays <= 3) reject.push("إعلان أرباح خلال 3 أيام");
  if (x.newsRisk >= 3) reject.push("خبر سلبي عالي الأثر");
  if (finite(x.regime) && x.regime < -35) reject.push("السوق يعاكس الشراء بقوة");

  const evidence = x.evidence ? clamp(50 + (x.evidence.edge || 0) * 12 + (x.evidence.winEdge || 0) * 4) : 0;
  const relative = finite(x.rsRank) ? x.rsRank : 50;
  const finance = finite(x.finance) ? x.finance : 50;
  let value = clamp((x.strength || 0) * .22 + (x.agree || 0) * 100 * .18 + Math.min(100, (x.rr || 0) / 4 * 100) * .14 + relative * .12 + finance * .14 + evidence * .20);
  if (finite(x.earnDays) && x.earnDays <= 7) value -= 8;
  if (x.newsRisk === 2) value -= 5;
  value = Math.round(clamp(value));
  const grade = value >= 85 ? "A+" : value >= 78 ? "A" : value >= 70 ? "B+" : "مراقبة";
  return { value, grade, pass: reject.length === 0 && value >= 70, reject, evidence };
}
