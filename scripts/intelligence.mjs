#!/usr/bin/env node
/* رادار الدقة: يدمج الفني والمالي والقوة النسبية والدليل التاريخي والخبر.
   الناتج ترتيب تفسيري لا احتمال نجاح، ولا يملك سلطة تغيير الخطة. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { financialScores, precisionScore } from "./lib/intelligence.mjs";
import { headlineSignal } from "./lib/news.mjs";

const require = createRequire(import.meta.url);
const { SCANS } = require("../stocks/scans.js");
const { levelsFrom, planDirOf, planFrom, validatePlan } = require("../stocks/plan.js");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), CHECK = args.includes("--check");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();
const read = (f, d = null) => { try { return JSON.parse(fs.readFileSync(path.join(OUT, f), "utf8")); } catch { return d; } };
const r2 = n => Number.isFinite(n) ? Math.round(n * 100) / 100 : null;

function planFor(r) {
  const rec = read(`sym/${r.s}.json`); if (!rec) return null;
  const a = rec.an?.["4h"] || rec.an?.["1d"];
  const lv = levelsFrom({ k4h: rec.tf?.["4h"]?.c, k1d: rec.tf?.["1d"]?.c,
    px: r.p, a, w52h: r.w52h, w52l: r.w52l });
  if (!lv) return null;
  const p = planFrom(lv, planDirOf(r.score));
  return p && !validatePlan(p).length ? p : null;
}

function daysToEarnings(f, now) {
  const at = f?.earnings?.at;
  return Number.isFinite(at) ? (at - now) / 864e5 : null;
}

function latestRisk(items, now) {
  let risk = 0;
  for (const it of items || []) {
    if (Number.isFinite(it.t) && now - it.t > 72 * 3600e3) continue;
    const s = Number.isFinite(it.imp) ? { imp: it.imp, tone: it.tone || 0 } : headlineSignal(it.title);
    if (s.tone < 0) risk = Math.max(risk, s.imp);
  }
  return risk;
}

export function buildIntelligence({ summary, market, fund, analytics, backtest, news }, now = Date.now()) {
  const rows = (summary?.rows || []).filter(r => !r.mkt), F = fund?.f || {};
  const fin = financialScores(rows, F), rs = new Map((analytics?.rs || []).map(x => [x.s, x]));
  const bt = new Map((backtest?.scans || []).map(x => [x.id, x]));
  const ctx = { secMed: fin.secMed }, gates = {}, candidates = [], watchlist = [];
  const countGate = a => { for (const x of a) gates[x] = (gates[x] || 0) + 1; };

  for (const r of rows) {
    const f = F[r.s], plan = planFor(r), dir = plan?.dir || planDirOf(r.score);
    const vals = Object.values(r.tfScore || {}).filter(Number.isFinite);
    const agree = vals.length ? vals.filter(v => (v >= 0 ? 1 : -1) === dir).length / vals.length : 0;
    const active = [];
    for (const s of SCANS) {
      try { if (s.test(r, f, ctx)) active.push(s); } catch { /* الحقل الناقص يرفض الشرط */ }
    }
    const evidence = active.map(s => bt.get(s.id)).filter(Boolean)
      .filter(x => Number.isFinite((x.validation?.ret?.[20]?.n >= 300 ? x.validation.edge?.[20] : x.edge?.[20])))
      .sort((a, b) => (b.validation?.ret?.[20]?.n >= 300 ? b.validation.edge?.[20] : b.edge?.[20]) - (a.validation?.ret?.[20]?.n >= 300 ? a.validation.edge?.[20] : a.edge?.[20]))[0] || null;
    const ev = evidence && evidence.validation?.ret?.[20]?.n >= 300 ? evidence.validation : evidence;
    const rank = rs.get(r.s), earnDays = daysToEarnings(f, now), newsRisk = latestRisk(news?.sym?.[r.s], now);
    const p = precisionScore({ dir, stale: !!r.stale, strength: Math.abs(r.score || 0), agree,
      rr: plan?.rr, evidence: ev && { edge: ev.edge[20], winEdge: ev.edgeWin?.[20], n: ev.ret?.[20]?.n },
      rsRank: rank?.rk, finance: fin.scores[r.s]?.total, earnDays, newsRisk, regime: market?.marketScore });
    const reasons = [...p.reject];
    if (!plan) reasons.push("لا خطة سعرية مكتملة");
    if (!p.pass && !p.reject.length) reasons.push("درجة الدليل دون 70");
    const item = { s: r.s, ar: r.ar || null, en: r.en || null, sec: r.sec || null,
      score: p.value, grade: p.grade, tech: r2(Math.abs(r.score)), agree: r2(agree * 100),
      rr: r2(plan?.rr), rs: r2(rank?.rk), fin: r2(fin.scores[r.s]?.total),
      evidence: evidence ? { id: evidence.id, lbl: evidence.lbl, edge: ev.edge[20],
        winEdge: ev.edgeWin?.[20], n: ev.ret?.[20]?.n, holdout: evidence.validation?.ret?.[20]?.n >= 300 } : null,
      plan: plan ? { entry: r2(plan.entry), stop: r2(plan.stop), target: r2(plan.target), dir } : null,
      proof: [`توافق ${Math.round(agree * 100)}%`, plan ? `عائد/مخاطرة ${r2(plan.rr)}:1` : null,
        evidence ? `حافة ${ev.edge[20] > 0 ? "+" : ""}${ev.edge[20]} نقطة` : null].filter(Boolean) };
    if (reasons.length) {
      countGate(reasons);
      if (dir === 1 && !r.stale && plan) watchlist.push({ ...item, reasons });
      continue;
    }
    candidates.push(item);
  }
  candidates.sort((a, b) => b.score - a.score);
  watchlist.sort((a, b) => (a.reasons.length - b.reasons.length) || (b.score - a.score));

  const financial = Object.entries(fin.scores).filter(([, x]) => Number.isFinite(x.total))
    .sort((a, b) => b[1].total - a[1].total).slice(0, 12)
    .map(([s, x]) => ({ s, ...Object.fromEntries(Object.entries(x).map(([k, v]) => [k, r2(v)])) }));
  const newsroom = [...(news?.market || [])].map(x => ({ ...x, ...headlineSignal(x.title) }))
    .sort((a, b) => (b.imp - a.imp) || ((b.t || 0) - (a.t || 0))).slice(0, 12);
  return { updated: now, method: "evidence-ranked-not-probability", reviewed: rows.length,
    passed: candidates.length, rejected: rows.length - candidates.length, gates,
    regime: market?.marketScore ?? null, opportunities: candidates.slice(0, 12),
    watchlist: watchlist.slice(0, 8), financial, newsroom };
}

async function main() {
  const input = { summary: read("summary.json"), market: read("market.json"), fund: read("fundamentals.json"),
    analytics: read("analytics.json"), backtest: read("backtest.json"), news: read("news.json") };
  if (!input.summary?.rows?.length) throw new Error("لا ملخص سوق صالح");
  const out = buildIntelligence(input);
  fs.writeFileSync(path.join(OUT, "intelligence.json"), JSON.stringify(out));
  console.log(`✔ رادار الدقة: ${out.passed} اجتازت من ${out.reviewed} · رُفض ${out.rejected}`);
  return 0;
}

function selfCheck() {
  let pass = 0, fail = 0; const t = (n, f) => { try { f(); console.log(`✓ ${n}`); pass++; } catch (e) { console.log(`✗ ${n}: ${e.message}`); fail++; } };
  t("الرتب المالية قطاعية", () => { const x = financialScores([{s:"A",sec:"س"},{s:"B",sec:"س"}], {A:{pe:10,fpe:9,pb:1,roe:.3,margin:.2,revGrow:.2},B:{pe:30,fpe:28,pb:5,roe:.1,margin:.05,revGrow:0}}); if (!(x.scores.A.total > x.scores.B.total)) throw new Error("الترتيب معكوس"); });
  t("الخبر عالي الأثر يُصنف", () => { const x = headlineSignal("Company cuts guidance after earnings miss"); if (x.imp !== 3 || x.tone !== -1) throw new Error(JSON.stringify(x)); });
  t("بوابة الدقة ترفض بلا دليل", () => { const x = precisionScore({dir:1,stale:false,strength:70,agree:1,rr:3,rsRank:80,finance:80,regime:10,newsRisk:0}); if (x.pass || !x.reject.length) throw new Error("مرّت بلا دليل"); });
  t("بوابة الدقة تمرر الدليل المكتمل", () => { const x = precisionScore({dir:1,stale:false,strength:80,agree:1,rr:4,rsRank:90,finance:85,regime:10,newsRisk:0,evidence:{edge:.7,winEdge:3,n:10000}}); if (!x.pass || x.value < 70) throw new Error(JSON.stringify(x)); });
  console.log(`${pass} نجح · ${fail} فشل`); return fail ? 1 : 0;
}

if (CHECK) process.exit(selfCheck());
else main().then(c => process.exit(c)).catch(e => { console.error("✗", e.message); process.exit(1); });
