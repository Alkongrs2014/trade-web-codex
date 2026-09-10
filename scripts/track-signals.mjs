#!/usr/bin/env node
/* =====================================================================
   تتبّع الإشارات الحيّة — سجلّ ما ظهر فعلاً في التطبيق، لا ما كان يمكن
   أن يظهر.

   الأرشيف التاريخي (`backtest.mjs`) يقيس الشروط على تاريخ مُعاد بناؤه.
   هذا يقيس ما رآه المستخدم بعينه: نفس الشروط الثمانية بنفس البيانات
   التي كانت أمامه لحظتها، بما فيها الشرطان اللذان لا يمكن قياسهما
   تاريخياً (مكرر الربحية وموعد الأرباح) لأننا لا نملك تاريخ مدخلاتهما
   — لكننا نملك حاضرها، ويكفي أن نثبّته لحظة ظهوره.

   الملف تراكمي: كل تشغيل يضيف الجديد ويحدّث المفتوح ويغلق ما بلغ أفقه.
   ولهذا بوابة سلامة خاصة — انظر `guard` أدناه.

     node scripts/track-signals.mjs --out ./data
     node scripts/track-signals.mjs --check
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SCANS } = require("../stocks/scans.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();

const HOLD_DAYS = 28;                  // ~20 يوم تداول
const MAX_RECORDS = 20000;             // سقف الملف
const DAY = 86400e3;

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 100) / 100;
const r4 = (v) => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 10000) / 10000;

export function median(a) {
  const s = (a || []).filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;

/* وسائط القطاعات — نفس ما تبنيه الواجهة، فشرط «أرخص من قطاعه» يقارن
   بالمرجع نفسه في الموضعين. */
export function sectorMedians(rows, F) {
  const bySec = {};
  for (const r of rows) if (F[r.s]) (bySec[r.sec] ||= []).push(F[r.s]);
  const out = {};
  for (const [sec, list] of Object.entries(bySec)) {
    out[sec] = {
      n: list.length,
      pe: median(list.map(x => x.pe)),
      pb: median(list.map(x => x.pb)),
      roe: median(list.map(x => x.roe)),
      margin: median(list.map(x => x.margin)),
      grow: median(list.map(x => x.revGrow))
    };
  }
  return out;
}

/* =====================================================================
   بوابة سلامة خاصة بملف تراكمي.

   `data/` مستبعد من git ويُنشر إلى فرع `data` بدفعة `-f`. سجلّ الإشارات
   ملف **يتراكم عبر الشهور**: تشغيل واحد يكتب نسخة أقصر — لأن القرص
   امتلأ، أو لأن الملف قُرئ تالفاً فعاد `[]` — يدوس تاريخاً لا يُستعاد.
   لذلك: لا نكتب أقصر مما كان، إلا حين يتجاوز الملف سقفه فيُشذَّب عمداً.
   ===================================================================== */
export function guard(prevCount, nextCount, { pruning = false } = {}) {
  if (pruning) return true;
  if (nextCount >= prevCount) return true;
  throw new Error(`السجلّ يتقلّص ${prevCount} ← ${nextCount} — مرفوض`);
}

/* هل هذه الإشارة مفتوحة أصلاً لهذا الرمز؟ إشارة تبقى محقَّقة أسبوعين
   تُسجَّل مرة واحدة لا أربع عشرة. */
export const openKey = (s) => `${s.sym}|${s.scan}`;

/* تحديث إشارة مفتوحة بسعر اليوم */
export function update(sig, price, now) {
  if (!(price > 0) || !(sig.entry > 0)) return sig;
  const ret = (price - sig.entry) / sig.entry * 100;
  sig.last = r2(price);
  sig.ret = r2(ret);
  sig.mfe = r2(Math.max(sig.mfe ?? ret, ret));
  sig.mae = r2(Math.min(sig.mae ?? ret, ret));
  sig.at2 = now;
  if (now - sig.at >= HOLD_DAYS * DAY) { sig.open = false; sig.closed = now; }
  return sig;
}

/* ---------- تجميع ---------- */
export function aggregate(records) {
  const byScan = {};
  // الكريبتو مسجَّل ولا يُحصى: عملة واحدة تتحرك 30% في أسبوع تزيح وسيط
  // عشرات الإشارات السهمية. نفس الاستبعاد في الأرشيف التاريخي.
  for (const s of records) {
    if (s.mkt === "crypto") continue;
    (byScan[s.scan] ||= { open: [], done: [] })[s.open ? "open" : "done"].push(s);
  }
  const out = [];
  for (const scan of SCANS) {
    const g = byScan[scan.id];
    if (!g) continue;
    const rets = g.done.map(x => x.ret).filter(Number.isFinite);
    out.push({
      id: scan.id, lbl: scan.lbl,
      open: g.open.length, closed: g.done.length,
      med: r2(median(rets)), avg: r2(mean(rets)),
      win: rets.length ? r2(rets.filter(x => x > 0).length / rets.length * 100) : null,
      mfe: r2(mean(g.done.map(x => x.mfe).filter(Number.isFinite))),
      mae: r2(mean(g.done.map(x => x.mae).filter(Number.isFinite)))
    });
  }
  return out.sort((a, b) => (b.med ?? -99) - (a.med ?? -99));
}

async function main() {
  const now = Date.now();
  const summary = readJSON(path.join(OUT, "summary.json"));
  if (!summary?.rows?.length) throw new Error("لا ملخّص — شغّل fetch-market.mjs أولاً");
  const F = readJSON(path.join(OUT, "fundamentals.json"))?.f || {};

  // نتتبّع **ما يراه المستخدم بالضبط**، والكريبتو يظهر في ماسح الفرص،
  // فاستبعاده هنا يجعل السجلّ يصف قائمة غير التي أمامه. نسجّله ونضع
  // عليه علامة `mkt`، ويخرج من الإحصاء وحده — كما في الأرشيف التاريخي،
  // لأن مداه اليومي أوسع بمراتب فيزيح أي وسيط يشاركه.
  const rows = summary.rows;
  const stocks = rows.filter(r => r.mkt !== "crypto");
  const ctx = { secMed: sectorMedians(stocks, F) };
  const price = Object.fromEntries(rows.map(r => [r.s, r.p]));

  const prev = readJSON(path.join(OUT, "signals.json"));
  const records = Array.isArray(prev?.records) ? prev.records : [];
  const prevCount = records.length;

  // ١) حدّث المفتوحة بسعر اليوم
  let closedNow = 0;
  for (const sig of records) {
    if (!sig.open) continue;
    const p = price[sig.sym];
    if (p === undefined) continue;
    const before = sig.open;
    update(sig, p, now);
    if (before && !sig.open) closedNow++;
  }

  // ٢) سجّل الجديد
  const openNow = new Set(records.filter(s => s.open).map(openKey));
  let added = 0;
  for (const r of rows) {
    const f = F[r.s] || null;
    for (const scan of SCANS) {
      let hit = false;
      try { hit = !!scan.test(r, f, ctx); } catch { hit = false; }
      if (!hit) continue;
      const key = `${r.s}|${scan.id}`;
      if (openNow.has(key)) continue;
      if (!(r.p > 0)) continue;
      records.push({
        sym: r.s, scan: scan.id, at: now, at2: now,
        entry: r2(r.p), last: r2(r.p), ret: 0, mfe: 0, mae: 0,
        atr: r4(r.atr), open: true, ...(r.mkt ? { mkt: r.mkt } : {})
      });
      openNow.add(key);
      added++;
    }
  }

  // ٣) تشذيب مقصود عند تجاوز السقف — الأقدم المغلق أولاً
  let pruning = false;
  if (records.length > MAX_RECORDS) {
    pruning = true;
    records.sort((a, b) => (a.open === b.open) ? a.at - b.at : (a.open ? 1 : -1));
    records.splice(0, records.length - MAX_RECORDS);
  }

  guard(prevCount, records.length, { pruning });

  records.sort((a, b) => b.at - a.at);
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "signals.json"),
    JSON.stringify({ updated: now, holdDays: HOLD_DAYS, count: records.length, records }));

  const scans = aggregate(records);
  fs.writeFileSync(path.join(OUT, "archive.json"),
    JSON.stringify({ updated: now, holdDays: HOLD_DAYS,
                     open: records.filter(s => s.open).length,
                     closed: records.filter(s => !s.open).length, scans }));

  const prevMeta = readJSON(path.join(OUT, "meta.json"), {});
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
    ...prevMeta, signalsUpdated: now,
    signalsRun: { at: new Date(now).toISOString(), total: records.length, added, closed: closedNow }
  }));

  console.log(`✔ ${records.length} إشارة (+${added} جديدة · ${closedNow} أُغلقت اليوم)`);
  for (const s of scans)
    console.log(`  ${s.lbl}: ${s.open} مفتوحة · ${s.closed} مغلقة${s.closed ? ` · وسيط ${s.med}% · موجب ${s.win}%` : ""}`);
  return 0;
}

/* ---------- فحص ذاتي بلا شبكة ---------- */
function selfCheck() {
  console.log("▶ فحص ذاتي (بلا شبكة)\n");
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; } };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
  const throws = (fn, m) => { let ok = false; try { fn(); } catch { ok = true; } if (!ok) throw new Error(`${m}: لم يرمِ`); };

  t("البوابة ترفض تقلّص السجلّ وتسمح بالتشذيب المقصود", () => {
    eq(guard(10, 12), true, "نموّ");
    eq(guard(10, 10), true, "ثبات");
    throws(() => guard(10, 3), "تقلّص");
    eq(guard(10, 3, { pruning: true }), true, "تشذيب معلن");
    // الحالة التي تُتلف التاريخ: ملف قُرئ تالفاً فعاد فارغاً
    throws(() => guard(5000, 0), "ملف فارغ");
  });

  t("update يتتبّع أقصى ربح وأقصى تراجع لا آخر سعر فقط", () => {
    const now = 1_700_000_000_000;
    const s = { sym: "X", scan: "a", at: now, entry: 100, open: true };
    update(s, 110, now + DAY);
    update(s, 90, now + 2 * DAY);
    update(s, 105, now + 3 * DAY);
    eq([s.ret, s.mfe, s.mae], [5, 10, -10], "الرحلة كاملة");
    eq(s.open, true, "ما زالت مفتوحة");
  });

  t("update يغلق الإشارة عند بلوغ أفق الاحتفاظ", () => {
    const now = 1_700_000_000_000;
    const s = { sym: "X", scan: "a", at: now, entry: 100, open: true };
    update(s, 101, now + (HOLD_DAYS - 1) * DAY);
    eq(s.open, true, "قبل الأفق");
    update(s, 102, now + HOLD_DAYS * DAY);
    eq(s.open, false, "عند الأفق");
    if (!s.closed) throw new Error("بلا وقت إغلاق");
  });

  t("update يتجاهل الأسعار الفاسدة بدل أن يكتب صفراً", () => {
    const s = { sym: "X", scan: "a", at: 1, entry: 100, open: true, ret: 5, mfe: 5, mae: 0 };
    update(s, 0, 2); update(s, null, 3); update(s, NaN, 4);
    eq([s.ret, s.mfe, s.mae], [5, 5, 0], "بلا تغيير");
  });

  t("openKey يمنع تكرار نفس الإشارة للرمز نفسه", () => {
    eq(openKey({ sym: "AAPL", scan: "vol" }), "AAPL|vol", "المفتاح");
    if (openKey({ sym: "AAPL", scan: "vol" }) === openKey({ sym: "AAPL", scan: "align" }))
      throw new Error("شرطان مختلفان بمفتاح واحد");
  });

  t("sectorMedians تطابق وسيط القطاع لا متوسطه", () => {
    const rows = [{ s: "A", sec: "تقنية" }, { s: "B", sec: "تقنية" }, { s: "C", sec: "تقنية" }];
    const F = { A: { pe: 10 }, B: { pe: 20 }, C: { pe: 300 } };
    eq(sectorMedians(rows, F)["تقنية"].pe, 20, "الوسيط لا المتوسط (110)");
  });

  t("median يتجاهل غير الأرقام ولا يحوّلها إلى أصفار", () => {
    eq(median([1, null, 3, undefined, NaN]), 2, "وسيط الصالح");
    eq(median([]), null, "فارغ");
  });

  t("aggregate يفصل المفتوح عن المغلق ويحصي المغلق وحده", () => {
    const rec = [
      { scan: "vol", open: true, ret: 99, mfe: 99, mae: 0 },
      { scan: "vol", open: false, ret: 4, mfe: 6, mae: -2 },
      { scan: "vol", open: false, ret: -2, mfe: 1, mae: -5 }
    ];
    const g = aggregate(rec).find(x => x.id === "vol");
    eq([g.open, g.closed], [1, 2], "التقسيم");
    eq(g.med, 1, "وسيط المغلق فقط");
    eq(g.win, 50, "نسبة الموجب");
  });

  t("aggregate يسجّل الكريبتو ولا يحصيه", () => {
    const rec = [
      { scan: "vol", open: false, ret: 3, mfe: 4, mae: -1 },
      { scan: "vol", open: false, ret: 300, mfe: 300, mae: 0, mkt: "crypto" }
    ];
    const g = aggregate(rec).find(x => x.id === "vol");
    eq([g.closed, g.med], [1, 3], "العملة خارج الإحصاء");
  });

  t("SCANS الثمانية كلها قابلة للتتبّع الحيّ", () => {
    if (SCANS.length !== 8) throw new Error(String(SCANS.length));
    // التتبّع الحيّ يستعمل `test` لا `btTest`، فيشمل حتى ما لا يُقاس تاريخياً
    for (const s of SCANS) if (typeof s.test !== "function") throw new Error(`${s.id}`);
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل`);
  process.exit(fail ? 1 : 0);
}

if (CHECK) selfCheck();
else main().catch(e => { console.error("✗ فشل التشغيل:", e.message); process.exit(1); });
