#!/usr/bin/env node
/* =====================================================================
   طبقة التحليل — تقرأ ولا تكتب في المحرّك.

   قاعدةُ هذا الملف المطلقة في هذه النسخة:

     ⛔ لا يُعدَّل وزنٌ، ولا شرطٌ، ولا منطقُ تداول، تلقائياً. أبداً.

   ما يفعله: يقارن ما توقّعه النظام بما حدث فعلاً، ويكتب `learn.json`
   نصاً يقرأه إنسان ويقرّر. ولا يستورد شيئاً من `scans.js` إلا التسميات
   — فلا يملك حتى الوصول الذي يمكّنه من التعديل.

   ولماذا التقييد: نظامٌ يعدّل أوزانه على مئتي حالة يُلاحق الضجيج ويسمّيه
   تعلُّماً. الأرشيف التاريخي نفسه احتاج 482 ألف شمعة ليقول إن حافة شرطٍ
   ‎0.5‎ نقطة. فحتى تبلغ العيّنة ما يكفي، الاقتراح نصٌّ لا فعل.

   وكل رقم مقرونٌ بمقامه: نسبةٌ بلا عدد حالات دعايةٌ لا قياس.

     node scripts/learn.mjs --out ./data
     node scripts/learn.mjs --check
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { SCANS } = require("../stocks/scans.js");
const { tfName } = require("../stocks/evaluate.js");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();

const WEEK = 7 * 86400e3;
const MIN_SAMPLE = 20;                 // أقل عيّنة تُقرأ نسبتُها
const WEEKS = 8;                       // كم أسبوعاً يُعرض

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
const r2 = (v) => (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 100) / 100;

export function median(a) {
  const s = (a || []).filter(Number.isFinite).sort((x, y) => x - y);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* نفس تصنيف `verdictOf` — يُقرأ من `out.st` المحفوظة لا يُعاد حسابه */
export function verdict(s) {
  const st = s.out && s.out.st;
  if (!st) return "unknown";
  if (st === "wait") return "wait";
  if (st === "t1" || st === "t2" || st === "t3") return s.open ? "running" : "win";
  if (st === "stop") return "loss";
  if (st === "expired") return "flat";
  if (st === "cancel") return "cancel";
  return "running";
}

/* الصفقات التي **دخلت** فقط: خطةٌ لم يُلمس دخولها لم تكن صفقة، وحسابها
   في المقام يخفض كل نسبة بلا سبب. والكريبتو خارج الإحصاء كما في الأرشيف. */
export const entered = (list) => list.filter(s =>
  s.snap && s.conv !== "long" && s.mkt !== "crypto" &&
  s.out && s.out.st !== "wait" && s.out.st !== "cancel");

/* =====================================================================
   إحصاء مجموعة — الوحدة التي يُبنى عليها كل تقسيم بعدها.
   ===================================================================== */
export function statsOf(list) {
  const closed = list.filter(s => !s.open);
  const win = closed.filter(s => verdict(s) === "win").length;
  const loss = closed.filter(s => verdict(s) === "loss").length;
  const hit = (i) => {
    const pool = list.filter(s => (s.snap.t || []).length > i);
    return pool.length ? r2(pool.filter(s => s.out.hit[i] !== null).length / pool.length * 100) : null;
  };
  return {
    n: list.length, closed: closed.length, win, loss,
    rate: (win + loss) ? r2(win / (win + loss) * 100) : null,
    t1: hit(0), t2: hit(1), t3: hit(2),
    stop: closed.length ? r2(closed.filter(s => s.out.st === "stop").length / closed.length * 100) : null,
    med: r2(median(closed.map(s => s.ret))),
    enough: closed.length >= MIN_SAMPLE
  };
}

/* التقسيم: كل مجموعة بمقامها، والمجموعات الصغيرة تُعلَن صغيرةً ولا تُخفى.
   إخفاؤها يجعل القارئ يظنّ أن ما بقي هو كل شيء. */
export function breakdown(list, keyOf) {
  const g = {};
  for (const s of list) {
    const k = keyOf(s);
    if (k === null || k === undefined) continue;
    (g[k] ||= []).push(s);
  }
  return Object.entries(g).map(([k, v]) => ({ k, ...statsOf(v) }))
    .sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1));
}

/* =====================================================================
   الأسابيع — الأحدث أولاً، وكل أسبوع بمقامه.
   ===================================================================== */
export function weekly(list, now) {
  const out = [];
  for (let i = 0; i < WEEKS; i++) {
    const hi = now - i * WEEK, lo = hi - WEEK;
    const g = list.filter(s => s.at > lo && s.at <= hi);
    if (!g.length && i > 0) continue;
    const st = statsOf(g);
    out.push({ label: i === 0 ? "آخر سبعة أيام" : `قبل ${i} أسبوع`,
               from: lo, to: hi, ...st });
  }
  return out;
}

/* =====================================================================
   الاستنتاجات والاقتراحات — نصٌّ يقرأه إنسان.

   لا يُكتب استنتاجٌ عن مجموعة دون `MIN_SAMPLE`: «الهبوط أفضل بـ40%» على
   ثلاث صفقات جملةٌ تُقرأ حقيقةً وهي ضجيج.
   ===================================================================== */
export function findingsOf({ dirs, scans, tfs, hz, stopped }) {
  const f = [], sug = [];
  const big = (x) => x.enough;

  const up = dirs.find(x => +x.k === 1), dn = dirs.find(x => +x.k === -1);
  if (up && dn && big(up) && big(dn) && up.rate !== null && dn.rate !== null) {
    const d = up.rate - dn.rate;
    f.push({ t: "الصعود مقابل الهبوط", good: Math.abs(d) < 10,
      d: `صعود ${up.rate}% على ${up.closed} صفقة · هبوط ${dn.rate}% على ${dn.closed}`,
      v: `${d > 0 ? "+" : ""}${r2(d)} نقطة` });
    if (Math.abs(d) >= 10) sug.push(
      `اتجاه واحد يتفوّق بفارق ${r2(Math.abs(d))} نقطة (${d > 0 ? "الصعود" : "الهبوط"}). ` +
      `يستحق النظر في سبب ذلك قبل أي تعديل: قد يكون وصفاً لسوق هذه الفترة لا خللاً في الشرط.`);
  }

  const ranked = scans.filter(big);
  if (ranked.length >= 2) {
    const b = ranked[0], w = ranked[ranked.length - 1];
    f.push({ t: "أفضل شرط", good: true, d: `${b.lbl} — ${b.closed} صفقة مغلقة`, v: `${b.rate}%` });
    f.push({ t: "أضعف شرط", good: false, d: `${w.lbl} — ${w.closed} صفقة مغلقة`, v: `${w.rate}%` });
    if (b.rate !== null && w.rate !== null && b.rate - w.rate >= 20) sug.push(
      `الفارق بين أفضل شرط وأضعفه ${r2(b.rate - w.rate)} نقطة. ` +
      `لا تُخفِ الأضعف — سجّل ملاحظته وراقبه: شرطٌ يُخفى لضعفه يعود بأرقامٍ لا مرجع لها.`);
  }

  const goodTf = tfs.filter(big).sort((a, b) => (b.rate ?? -1) - (a.rate ?? -1))[0];
  if (goodTf) f.push({ t: "أنجح فريم مرجعي", good: true,
    d: `${tfName(goodTf.k)} — ${goodTf.closed} صفقة`, v: `${goodTf.rate}%` });

  const hzBig = hz.filter(big);
  if (hzBig.length >= 2) {
    const best = hzBig[0];
    f.push({ t: "أنجح أفق", good: true, d: `${best.k} — ${best.closed} صفقة`, v: `${best.rate}%` });
  }

  if (stopped.n >= MIN_SAMPLE) {
    f.push({ t: "ظروف ضرب الوقف", good: false,
      d: `وسيط مسافة الوقف ${stopped.stopPct}% من الدخول · وسيط مدى اليوم ${stopped.atrPct}%`,
      v: `${stopped.n} حالة` });
    if (Number.isFinite(stopped.stopPct) && Number.isFinite(stopped.atrPct) && stopped.stopPct < stopped.atrPct)
      sug.push(`في الصفقات التي ضُرب وقفها كان الوقف أقرب من مدى اليوم الواحد ` +
        `(${stopped.stopPct}% مقابل ${stopped.atrPct}%) — أي داخل التذبذب الطبيعي. ` +
        `يستحق فحص حدّ ATR الأدنى في الخطة.`);
  }

  const fake = scans.filter(x => big(x) && x.t1 !== null && x.t1 < 30);
  for (const x of fake) sug.push(
    `«${x.lbl}» بلغ هدفه الأول في ${x.t1}% من ${x.n} صفقة دخلت. ` +
    `نسبةٌ كهذه تعني أن أهدافه أبعد من حركته المعتادة، لا أن الشرط خاطئ بالضرورة.`);

  return { findings: f, suggestions: sug };
}

async function main() {
  const now = Date.now();
  const sig = readJSON(path.join(OUT, "signals.json"));
  const hst = readJSON(path.join(OUT, "history.json"));
  const open = Array.isArray(sig?.records) ? sig.records : [];
  const closed = Array.isArray(hst?.records) ? hst.records : [];
  const all = open.concat(closed);
  if (!all.length) throw new Error("لا سجلّ — شغّل track-signals.mjs أولاً");

  const list = entered(all);
  const lbl = (id) => { const x = SCANS.find(y => y.id === id); return x ? x.lbl : id; };

  const dirs = breakdown(list, s => (s.snap.dir === -1 ? -1 : 1));
  const scans = breakdown(list, s => s.scan).map(x => ({ ...x, lbl: lbl(x.k) }));
  const tfs = breakdown(list, s => s.snap.tf || "1d");
  // الأفق يُنسب بأقوى نتيجةٍ في لقطته: هو الأفق الذي كانت الإشارة تصفه
  const hz = breakdown(list, s => {
    const h = s.snap.hz || {};
    const best = Object.entries(h).filter(([, v]) => Number.isFinite(v))
      .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))[0];
    return best ? ({ scalp: "لحظي", swing: "يومي", pos: "أسبوعي" })[best[0]] : null;
  });

  const stops = list.filter(s => s.out.st === "stop" && s.snap);
  const stopped = {
    n: stops.length,
    stopPct: r2(median(stops.map(s => Math.abs(s.snap.e - s.snap.s) / s.snap.e * 100))),
    atrPct: r2(median(stops.map(s => s.snap.atr / s.snap.e * 100)))
  };

  const { findings, suggestions } = findingsOf({ dirs, scans, tfs, hz, stopped });
  const out = {
    updated: now, minSample: MIN_SAMPLE, total: list.length,
    // تصريحٌ في الملف نفسه لا في التوثيق وحده
    authority: "read-only", appliesChanges: false,
    weeks: weekly(list, now),
    dirs, scans, tfs, hz, stopped, findings, suggestions,
    note: "طبقة قراءة. لا تعدّل وزناً ولا شرطاً ولا منطق تداول."
  };

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "learn.json"), JSON.stringify(out));
  const prevMeta = readJSON(path.join(OUT, "meta.json"), {});
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
    ...prevMeta, learnUpdated: now,
    learnRun: { at: new Date(now).toISOString(), entered: list.length,
                findings: findings.length, suggestions: suggestions.length }
  }));

  const w = out.weeks[0];
  console.log(`✔ ${list.length} صفقة دخلت · ${findings.length} استنتاجاً · ${suggestions.length} اقتراحاً`);
  console.log(`  آخر سبعة أيام: ${w.n} إشارة · ${w.closed} مغلقة${
    w.enough ? ` · نجاح ${w.rate}%` : " (عيّنة أصغر من أن تُقرأ)"}`);
  for (const s of suggestions) console.log(`  · ${s}`);
  return 0;
}

/* ---------- فحص ذاتي بلا شبكة ---------- */
function selfCheck() {
  console.log("▶ فحص ذاتي (بلا شبكة)\n");
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; } };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

  const T0 = 1_700_000_000_000;
  const mk = (o = {}) => ({ sym: "X", scan: "align", at: T0, open: false, ret: 3,
    snap: { e: 100, s: 97, atr: 3, dir: 1, t: [104, 110], tf: "1d", hz: { scalp: 10, swing: 60, pos: 20 } },
    out: { st: "t2", hit: [T0 + 1, T0 + 2], stopAt: null, enterAt: T0 }, ...o });

  t("entered يستبعد المنتظرة والملغاة والكريبتو وما قبل توقيع الاتجاه", () => {
    const list = [mk(), mk({ out: { st: "wait", hit: [null, null], stopAt: null, enterAt: null } }),
      mk({ out: { st: "cancel", hit: [null, null], stopAt: null, enterAt: null } }),
      mk({ mkt: "crypto" }), mk({ conv: "long" }), mk({ snap: null })];
    eq(entered(list).length, 1, "واحدة فقط تدخل الإحصاء");
  });

  t("statsOf لا يعدّ المفتوحة رابحة ولا يحسبها في المقام", () => {
    const st = statsOf([mk(), mk({ open: true, out: { st: "t1", hit: [T0+1, null], stopAt: null, enterAt: T0 } }),
      mk({ ret: -3, out: { st: "stop", hit: [null, null], stopAt: T0+9, enterAt: T0 } })]);
    eq([st.n, st.closed, st.win, st.loss], [3, 2, 1, 1], "التقسيم");
    eq(st.rate, 50, "النسبة على المغلقة");
    eq(st.stop, 50, "نسبة الوقف");
  });

  t("statsOf يعلن العيّنة الصغيرة صغيرةً", () => {
    eq(statsOf([mk()]).enough, false, "واحدة لا تكفي");
    eq(statsOf(Array.from({ length: MIN_SAMPLE }, () => mk())).enough, true, "العيّنة كافية");
  });

  t("نسبة الهدف الثالث لا تحاسب خطةً بهدفين", () => {
    const st = statsOf([mk()]);
    eq(st.t3, null, "لا مقام للثالث");
    eq(st.t2, 100, "مقام الثاني موجود");
  });

  t("breakdown يقسم بمقامٍ لكل مجموعة ويرتّب بالنسبة", () => {
    const g = breakdown([mk(), mk(), mk({ snap: { ...mk().snap, dir: -1 }, ret: -2,
      out: { st: "stop", hit: [null, null], stopAt: T0+9, enterAt: T0 } })], s => s.snap.dir);
    eq(g.length, 2, "مجموعتان");
    eq(g[0].k, "1", "الأفضل أولاً");
    eq([g[0].n, g[1].n], [2, 1], "كل مجموعة بمقامها");
  });

  t("weekly يعطي الأحدث أولاً ولا يبتلع صفقات خارج النافذة", () => {
    const now = T0 + 10 * 86400e3;
    const w = weekly([mk({ at: now - 86400e3 }), mk({ at: now - 9 * 86400e3 })], now);
    eq(w[0].n, 1, "هذا الأسبوع");
    if (!w.some(x => x.n === 1 && x.from < now - 7 * 86400e3)) throw new Error("الأسبوع السابق غائب");
  });

  t("لا استنتاج عن مجموعة أصغر من العيّنة الدنيا", () => {
    const small = breakdown([mk(), mk({ snap: { ...mk().snap, dir: -1 } })], s => s.snap.dir);
    const { findings, suggestions } = findingsOf({ dirs: small, scans: [], tfs: [], hz: [], stopped: { n: 0 } });
    eq(findings.length, 0, "بلا استنتاج على عيّنة صغيرة");
    eq(suggestions.length, 0, "وبلا اقتراح");
  });

  t("الطبقة تعلن أنها بلا سلطة، ولا تستورد ما يمكّنها من التعديل", () => {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    // لا كتابة إلا في مخرَجها ووصفِ تشغيلها
    const writes = [...src.matchAll(/writeFileSync\(path\.join\(OUT, "([^"]+)"/g)].map(m => m[1]);
    eq(writes.sort(), ["learn.json", "meta.json"], "لا يكتب إلا مخرَجه");
    // ‎=(?!=)‎ إسنادٌ لا مقارنة: بلا هذا القيد كان الشرط يُمسك
    // ‎s.snap.dir === -1‎ نفسها ويسمّيها تعديلاً
    if (/(SCANS\s*\[[^\]]*\]|\.dir|\.test|\.btTest|TF_WEIGHT\s*\[[^\]]*\])\s*=(?!=)/.test(src))
      throw new Error("إسنادٌ إلى تعريف شرط أو وزن");
    // ولا استيراد لما يحسب توصية أو خطة — طبقةُ قراءة لا تحتاجه
    if (/require\(["']\.\.\/stocks\/plan\.js|lib\/indicators/.test(src))
      throw new Error("استيرادُ محرّك التوصية");
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل`);
  process.exit(fail ? 1 : 0);
}

if (CHECK) selfCheck();
else main().catch(e => { console.error("✗ فشل التشغيل:", e.message); process.exit(1); });
