#!/usr/bin/env node
/* تحليلات مشتقة بلا طلبات إضافية: قوة نسبية وبيتا وارتباط وفجوات.
   تقرأ الشمعات اليومية الموجودة وتكتب analytics.json فقط. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();
export const HZ = { 1: 21, 3: 63, 6: 126 };
export const W = { 1: 0.4, 3: 0.35, 6: 0.25 };
const WIN = 120, MIN = 132;
const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const r2 = v => Number.isFinite(v) ? Math.round(v * 100) / 100 : null;
const r3 = v => Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;

export function pctChange(a, n) {
  if (!Array.isArray(a) || a.length < n + 1) return null;
  const x = a[a.length - 1 - n], y = a[a.length - 1];
  return x > 0 && y > 0 ? (y - x) / x * 100 : null;
}
export function logReturns(a, n) {
  const out = [], from = Math.max(1, a.length - n);
  for (let i = from; i < a.length; i++) out.push(a[i] > 0 && a[i - 1] > 0 ? Math.log(a[i] / a[i - 1]) : null);
  return out;
}
function pairs(a, b) {
  const x = [], y = [], n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const av = a[a.length - n + i], bv = b[b.length - n + i];
    if (Number.isFinite(av) && Number.isFinite(bv)) { x.push(av); y.push(bv); }
  }
  return [x, y];
}
export function corr(a, b) {
  const [x, y] = pairs(a, b); if (x.length < 30) return null;
  const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
  let xy = 0, xx = 0, yy = 0;
  for (let i = 0; i < x.length; i++) { const dx = x[i] - mx, dy = y[i] - my; xy += dx * dy; xx += dx * dx; yy += dy * dy; }
  return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : null;
}
export function beta(rs, rm) {
  const [y, x] = pairs(rs, rm); if (x.length < 30) return null;
  const mx = x.reduce((s, v) => s + v, 0) / x.length, my = y.reduce((s, v) => s + v, 0) / y.length;
  let cv = 0, vr = 0;
  for (let i = 0; i < x.length; i++) { cv += (x[i] - mx) * (y[i] - my); vr += (x[i] - mx) ** 2; }
  return vr > 0 ? cv / vr : null;
}
export function median(a) {
  const q = a.filter(Number.isFinite).sort((x, y) => x - y); if (!q.length) return null;
  const m = q.length >> 1; return q.length % 2 ? q[m] : (q[m - 1] + q[m]) / 2;
}
export function pctRankOf(sorted, v) {
  if (!sorted.length || !Number.isFinite(v)) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] < v) lo = m + 1; else hi = m; }
  return r2(lo / sorted.length * 100);
}
export function gapStats(k, keep = 5) {
  if (!Array.isArray(k) || k.length < 30) return null;
  const g = [];
  for (let i = 1; i < k.length; i++) if (k[i - 1][4] > 0 && k[i][1] > 0) g.push({ t: k[i][0], v: (k[i][1] - k[i - 1][4]) / k[i - 1][4] * 100 });
  if (g.length < 20) return null;
  const abs = g.map(x => Math.abs(x.v));
  return { n: g.length, avg: r2(abs.reduce((s, v) => s + v, 0) / abs.length), med: r2(median(abs)),
    top: [...g].sort((a, b) => Math.abs(b.v) - Math.abs(a.v)).slice(0, keep).map(x => ({ t: x.t, v: r2(x.v) })) };
}

async function main() {
  const now = Date.now(), sum = readJSON(path.join(OUT, "summary.json")), wide = readJSON(path.join(OUT, "wide.json"));
  const rows = [...(sum?.rows || []), ...(wide?.rows || [])];
  if (!rows.length) throw new Error("لا بيانات نحللها");
  const cfg = readJSON(path.join(ROOT, "stocks/symbols.json"), {}), crypto = new Set((cfg.crypto || []).map(x => x.s));
  const meta = new Map(rows.map(x => [x.s, x])), series = new Map();
  for (const row of rows) {
    const k = readJSON(path.join(OUT, "sym", `${row.s}.json`))?.tf?.["1d"]?.c;
    if (Array.isArray(k) && k.length >= MIN) series.set(row.s, k);
  }
  if (!series.size) throw new Error("لا شمعات يومية كافية");

  // وسيط الكون مرجع مجاني وثابت المصدر؛ يستبعد الكريبتو حتى لا يزيح مداه السوق.
  const stocks = [...series].filter(([s]) => !crypto.has(s)), len = Math.min(...stocks.map(([, k]) => k.length));
  const market = [];
  for (let i = 0; i < len; i++) market.push(median(stocks.map(([, k]) => k[k.length - len + i][4])));
  const mkt = Object.fromEntries(Object.entries(HZ).map(([h, n]) => [h, r2(pctChange(market, n))]));
  const mlog = logReturns(market, WIN), rs = [];
  for (const [s, k] of series) {
    const c = k.map(x => x[4]), row = { s, sec: meta.get(s)?.sec || null, cx: crypto.has(s) ? 1 : undefined };
    let ok = true;
    for (const [h, n] of Object.entries(HZ)) {
      row["r" + h] = r2(pctChange(c, n)); row["x" + h] = Number.isFinite(row["r" + h]) ? r2(row["r" + h] - mkt[h]) : null;
      if (!Number.isFinite(row["r" + h])) ok = false;
    }
    if (!ok) continue;
    row.sc = r2(Object.entries(W).reduce((v, [h, w]) => v + w * row["x" + h], 0));
    row.beta = r3(beta(logReturns(c, WIN), mlog)); rs.push(row);
  }
  const rank = rs.filter(x => !x.cx).map(x => x.sc).sort((a, b) => a - b);
  for (const x of rs) x.rk = pctRankOf(rank, x.sc);
  rs.sort((a, b) => b.sc - a.sc);
  const groups = new Map();
  for (const x of rs) if (!x.cx && x.sec) (groups.get(x.sec) || groups.set(x.sec, []).get(x.sec)).push(x);
  const sectors = [...groups].map(([sec, a]) => ({ sec, n: a.length, sc: r2(median(a.map(x => x.sc))), x1: r2(median(a.map(x => x.x1))), x3: r2(median(a.map(x => x.x3))), x6: r2(median(a.map(x => x.x6))) })).sort((a, b) => b.sc - a.sc);
  const watch = (sum?.rows || []).map(x => x.s).filter(s => series.has(s)).sort(), logs = new Map(watch.map(s => [s, logReturns(series.get(s).map(x => x[4]), WIN)]));
  const tri = [], ps = [];
  for (let i = 0; i < watch.length; i++) for (let j = i + 1; j < watch.length; j++) {
    const v = corr(logs.get(watch[i]), logs.get(watch[j])); tri.push(v === null ? -128 : Math.round(v * 100));
    if (v !== null) ps.push([watch[i], watch[j], Math.round(v * 100)]);
  }
  ps.sort((a, b) => b[2] - a[2]);
  const gaps = watch.map(s => ({ s, ...gapStats(series.get(s)) })).filter(x => Number.isFinite(x.avg)).sort((a, b) => b.avg - a.avg).slice(0, 40);
  const out = { updated: now, market: "وسيط الكون", hz: HZ, w: W, corrWin: WIN, mkt, n: rs.length, rs, sectors,
    corr: { win: WIN, syms: watch, m: tri }, pairs: { high: ps.slice(0, 12), low: ps.slice(-12).reverse() }, gaps };
  const prev = readJSON(path.join(OUT, "analytics.json"));
  if (prev?.rs?.length && rs.length < prev.rs.length * 0.8) throw new Error(`التحليل تقلص ${prev.rs.length}→${rs.length}`);
  fs.writeFileSync(path.join(OUT, "analytics.json"), JSON.stringify(out));
  const pm = readJSON(path.join(OUT, "meta.json"), {});
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({ ...pm, analyticsUpdated: now, analyticsRun: { at: new Date(now).toISOString(), symbols: rs.length, pairs: ps.length, sectors: sectors.length } }));
  console.log(`✔ ${rs.length} رمزاً · ${ps.length} زوجاً · ${sectors.length} قطاعاً`);
}

function selfCheck() {
  let pass = 0, fail = 0; const t = (n, f) => { try { f(); console.log(`✓ ${n}`); pass++; } catch (e) { console.log(`✗ ${n}: ${e.message}`); fail++; } };
  const near = (a, b, z = 1e-9) => { if (Math.abs(a - b) > z) throw new Error(`${a} ≠ ${b}`); };
  t("العائد", () => near(pctChange([100, 110, 121], 2), 21));
  t("الارتباط", () => { const a = Array.from({ length: 60 }, (_, i) => Math.sin(i)); near(corr(a, a), 1); near(corr(a, a.map(x => -x)), -1); });
  t("بيتا", () => { const a = Array.from({ length: 60 }, (_, i) => Math.sin(i) / 100); near(beta(a.map(x => 2 * x), a), 2); });
  t("العوائد اللوغاريتمية", () => near(logReturns([100, 150, 100], 2).reduce((a, b) => a + b, 0), 0));
  t("الرتبة", () => near(pctRankOf([1,2,3,4,5,6,7,8,9,10], 5.5), 50));
  t("الوسيط", () => near(median([1,2,3,1000]), 2.5));
  t("الفجوات", () => { const k = Array.from({ length: 40 }, (_, i) => [i,100,101,99,100,1]); k[20][1] = 110; near(gapStats(k).top[0].v, 10); });
  console.log(`${pass} نجح · ${fail} فشل`); process.exit(fail ? 1 : 0);
}
if (CHECK) selfCheck(); else main().catch(e => { console.error("✗", e.message); process.exit(1); });
