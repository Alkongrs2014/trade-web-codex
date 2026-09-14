#!/usr/bin/env node
/* =====================================================================
   تتبّع ماسح الاستراتيجيات — الحالة الآنية والتسلسل والنتائج.

   ثلاثة مخرَجات لثلاثة أسئلة مختلفة:

     `strategies.json`    ما حال كل رمز×استراتيجية **الآن**، ومتى بدأت
                          هذه الحالة. الحقلان `at` و`px0` هما جوهر
                          الميزة: المتصفح يحسب النتيجة بنفسه من السعر
                          الحيّ، لكنه **لا يستطيع** أن يعرف متى بدأت
                          الإشارة — تلك معلومةٌ تاريخية يملكها الخادم
                          وحده لأنه رأى الدورة السابقة.

     `strat/{SYM}.json`   تسلسلُ ما تغيّر ومتى. ملفٌّ لكل رمز لا ملفٌّ
                          جامع: التسلسل يُقرأ للرمز المبحوث عنه وحده،
                          وملفٌّ جامع يعني تحميل 97 تسلسلاً لقراءة واحد.

     `strat-signals.json` / `strat-history.json`
                          السجلّ الحيّ — ما ظهر فعلاً وما آل إليه، كي
                          تُقاس موثوقية كل استراتيجية بالتراكم بدل أن
                          تُفترض.

   ---------------------------------------------------------------------
   **سكّانان منفصلان في ملفّين منفصلين.**

   إشارات الماسح لا تُكتب في `signals.json`. خلطُها بإشارات `SCANS`
   يجعل «نسبة النجاح» في شاشة السجلّ تصف سكّانَين مختلفين ويُبطل مقارنة
   الأرشيف — رقمٌ صحيحٌ حسابياً يجيب سؤالاً لم يُطرح.

   والدوالُّ مع ذلك **مشتركة**: `updateOutcome` و`guard` و`guardTotal`
   تُستورد من `track-signals.mjs` كما هي. نسختان من رياضيات النتيجة
   تجعلان السجلَّين يُقاسان بمسطرتين — وهي نفس علّة `plan.js`.

   ---------------------------------------------------------------------
   الإيقاعان: `--only-price` يعيد حساب البوابات السعرية وحدها من سعرٍ
   حيّ ومؤشّراتٍ مجمَّدة (دورة الدقيقتين)، وبدونه يُعاد كل شيء (دورة
   العشر دقائق). ونفس الدالّة في الحالتين.
   ===================================================================== */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { statusNow } from "./lib/session.mjs";
import { rp } from "./lib/round.mjs";
import { updateOutcome, guard, guardTotal, stillLive } from "./track-signals.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const S = require(path.join(ROOT, "stocks/strategies.js"));
const C = require(path.join(ROOT, "stocks/consensus.js"));
const P = require(path.join(ROOT, "stocks/plan.js"));
const E = require(path.join(ROOT, "stocks/evaluate.js"));

const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const ONLY_PRICE = args.includes("--only-price");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "data"); })();

const DAY = 86400e3;
/* التسلسل يُقصّ بالعمر لا بالعدد: سقفُ عددٍ يحذف أقدم نقطةٍ لرمزٍ هادئ
   قبل أحدثِ نقطةٍ لرمزٍ ثرثار — نفس درس تنقيح `filings.json`. */
const KEEP_DAYS = 7;
const MAX_PTS = 120;
/* عتبات تسجيل نقطةٍ في التسلسل. بلا هذه الشروط: 97 رمزاً × 10
   استراتيجيات × 144 دورة ≈ 140 ألف نقطة يومياً تصف ضجيجاً لا حدثاً.
   نفس مبدأ `trend.json` بالحرف. */
const PT_STEP = 10;                    // حركةٌ في النتيجة تستحقّ التسجيل
const HOLD_DAYS = 28;

const readJSON = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return d; } };
const num = (v) => (Number.isFinite(v) ? v : null);

/* =====================================================================
   مفتاح الحالة ولحظة بدايتها.

   `at` تُعاد **فقط حين تتبدّل الجهة** (أو تظهر بعد غياب). النتيجة
   تتحرّك في كل دورة، فإعادةُ التأريخ عند كل حركة تجعل كل إشارةٍ
   «جديدة» أبداً — وهو عكس السؤال المطروح تماماً.

   و`px0` السعر لحظتها، ولا يُلمس بعدها: `entryQuality` تقيس كم تحرّك
   السعر **منذ الإشارة**، فتحديثُه يجعل الجواب صفراً دائماً.
   ===================================================================== */
export function stateKey(sym, id) { return sym + "|" + id; }

export function carryState(prev, r, now, px) {
  const sameDir = prev && prev.dir === r.dir;
  return {
    at: sameDir && Number.isFinite(prev.at) ? prev.at : Math.round(now / 1000),
    px0: sameDir && Number.isFinite(prev.px0) ? prev.px0 : rp(px),
    /* الوسم المثبَّت يحتاج وسمَ الدورة السابقة — والخادم وحده يملكه.
       نفس سبب حساب `band` في الخادم لا المتصفح في `score.js`. */
    band: S.sBandStable(r.sc, sameDir ? prev.band : null)
  };
}

/* =====================================================================
   نقطةٌ في التسلسل — بثلاثة شروطٍ فقط.

   تغيّرُ الجهة لا يُفقد أبداً مهما صغرت الحركة (انقلابُ الاتجاه هو
   الحدث نفسه)، وعبورُ حدّ وسمٍ يُسجَّل، وما عدا ذلك يحتاج حركةً
   تُذكر. ونفس منطق `pushTrend` في `track-signals`.
   ===================================================================== */
export function pushPoint(list, pt, prev) {
  if (!prev) { list.push(pt); return true; }
  const flip = prev.dir !== pt.dir;
  const band = prev.band !== pt.band;
  const step = Math.abs((pt.sc || 0) - (prev.sc || 0)) >= PT_STEP;
  if (!flip && !band && !step) return false;
  list.push(pt);
  return true;
}

export function trimPoints(pts, now) {
  const cut = now - KEEP_DAYS * DAY;
  const live = (pts || []).filter(p => Array.isArray(p) && p[0] * 1000 >= cut);
  return live.slice(-MAX_PTS);
}

/* =====================================================================
   لقطة الإشارة — تُكتب مرّة ولا تُلمس.

   الفصل بنيويّ لا اختياري: نظامٌ يعيد حساب توصيةٍ قديمة ببيانات اليوم
   يخرج بأرقام أجمل دائماً لأنه يحسب وقد صار المستقبل معلوماً.

   وشكلُها **نفس شكل `snap` في `track-signals`** بالضبط (`px` `e` `s`
   `dir` `t`) كي تقبلها `updateOutcome` بلا أي تحويل — دالّةٌ واحدة
   تقيس السجلَّين، فلا يُقاسان بمسطرتين.
   ===================================================================== */
export function snapFor(c, r, plan, at) {
  if (!plan || plan.bad) return null;
  const snap = {
    px: rp(c.px), e: rp(plan.entry), s: rp(plan.stop),
    atr: rp(plan.atr), dir: plan.dir,
    rr: plan.rr === null ? null : +plan.rr.toFixed(2),
    t: plan.targets.map(x => rp(x.p)),
    tpct: plan.targets.map(x => +x.pct.toFixed(2)),
    trr: plan.targets.map(x => +x.rr.toFixed(2)),
    tf: plan.atrTf, sc: r.sc, band: r.band
  };
  /* ما يُفحص يجب أن يكون ما يُكتب: البوابة تُعاد على الحقول **المقرَّبة**
     لا على الخطة قبل التقريب. وهي القاعدة التي كشفت لقطة `SHIB-USD`
     بمخاطرةٍ صفر — فحصٌ على تمثيلٍ وسيط يشهد لشيءٍ لا يصل القرص. */
  const bad = P.validatePlan({
    dir: snap.dir, entry: snap.e, stop: snap.s, atr: snap.atr,
    risk: (snap.e - snap.s) * snap.dir,
    targets: snap.t.map((p, i) => ({ p, rr: snap.trr[i] })),
    primary: snap.t.length ? { p: snap.t[snap.t.length - 1] } : null
  });
  if (bad.length) return { bad };
  return snap;
}

/* =====================================================================
   التشغيل
   ===================================================================== */
export function runOnce({ out = OUT, now = Date.now(), onlyPrice = false, quotes = null } = {}) {
  const summary = readJSON(path.join(out, "summary.json"));
  if (!summary || !Array.isArray(summary.rows) || !summary.rows.length)
    throw new Error("لا summary.json — لا يُكتب فوق بياناتٍ سليمة");

  /* والطبقة الواسعة كذلك: كلُّ رمزٍ فيها له ملفٌّ بـ260 شمعة يومية،
     فالاستراتيجيات اليومية تعمل عليه. وبدونها يبقى 414 رمزاً بلا
     لحظةِ بدءٍ مسجَّلة — والواجهة تقول «منذ هذه الدورة» أبداً، وهو
     أسوأ سؤالٍ يمكن أن يُترك بلا جواب في هذه الميزة.
     وصفوفها تُقرأ للسعر و52 أسبوعاً وحدها؛ التحليل من ملف الرمز. */
  const wide = readJSON(path.join(out, "wide.json"), { rows: [] });
  const seen = new Set(summary.rows.map(r => r.s));
  const all = summary.rows.concat((wide.rows || []).filter(r => r && !seen.has(r.s)));

  const prevFile = readJSON(path.join(out, "strategies.json"), { rows: [] });
  const prevBy = {};
  for (const r of prevFile.rows || []) prevBy[stateKey(r.s, r.st)] = r;

  const edgeFile = readJSON(path.join(out, "strategy-edge.json"));
  const edge = {};
  for (const r of (edgeFile && edgeFile.rows) || []) edge[r.id] = r;

  const openPrev = readJSON(path.join(out, "strat-signals.json"), { records: [] });
  const histPrev = readJSON(path.join(out, "strat-history.json"), { records: [] });
  const prevTotal = (openPrev.records || []).length + (histPrev.records || []).length;

  const rows = [], trends = {}, live = (openPrev.records || []).slice();
  const liveBy = {};
  for (const s of live) liveBy[stateKey(s.sym, s.strat)] = s;

  let added = 0, symbols = 0, skipped = 0;
  for (const row of all) {
    const rec = readJSON(path.join(out, "sym", `${row.s}.json`));
    if (!rec) { skipped++; continue; }
    const px = num(quotes && quotes[row.s]) ?? num(row.p);
    if (!(px > 0)) { skipped++; continue; }
    symbols++;

    const sess = statusNow(rec.period, now).state;
    const c = S.buildCtx({ rec, row, now, px, sess });
    const opt = onlyPrice ? { only: "price" } : {};

    for (const st of S.STRATEGIES) {
      const key = stateKey(row.s, st.id);
      const prev = prevBy[key];
      const r = S.evalStrategy(st, c, Object.assign({ prev }, opt));
      if (!r.dir || !Number.isFinite(r.sc)) continue;       // لم يتفعّل أو متعذّر

      const carried = carryState(prev, r, now, px);
      const plan = S.planFor(c, r);
      const lv = (plan && !plan.bad) ? {
        e: rp(plan.entry), s: rp(plan.stop), atr: rp(plan.atr),
        t: plan.targets.map(x => rp(x.p)),
        rr: plan.rr === null ? null : +plan.rr.toFixed(2), tf: plan.atrTf
      } : null;

      rows.push({
        s: row.s, st: st.id, dir: r.dir, sc: r.sc, band: carried.band,
        at: carried.at, px0: carried.px0, act: !!r.active,
        g: r.g, lv, pAt: Math.round(now / 1000)
      });

      // ----- التسلسل -----
      const pt = [Math.round(now / 1000), st.id, r.dir, r.sc, rp(px)];
      const tl = (trends[row.s] ||= []);
      pushPoint(tl, { t: pt[0], id: st.id, dir: r.dir, sc: r.sc, band: carried.band, raw: pt },
                prev ? { dir: prev.dir, sc: prev.sc, band: prev.band } : null);

      // ----- السجلّ الحيّ: تُسجَّل الإشارة حين **تبدأ** وهي نشطة -----
      const isNew = !prev || prev.dir !== r.dir;
      if (isNew && r.active && !liveBy[key]) {
        const snap = snapFor(c, r, plan, carried.at);
        if (snap && !snap.bad) {
          const sig = { sym: row.s, strat: st.id, at: now, dir: r.dir,
                        sc: r.sc, band: carried.band, mkt: rec.mkt || null,
                        regime: C.marketRegime(c.an), snap, open: true,
                        out: { st: "wait", hit: snap.t.map(() => null), stopAt: null, enterAt: null } };
          live.push(sig); liveBy[key] = sig; added++;
        }
      }
    }
  }

  if (!symbols) throw new Error("لم يُقرأ رمزٌ واحد — لا يُكتب فوق بياناتٍ سليمة");

  // ----- تحديث النتائج لكل ما هو مفتوح -----
  const pxBy = {};
  for (const row of all) pxBy[row.s] = num(quotes && quotes[row.s]) ?? num(row.p);
  let closed = 0;
  for (const sig of live) {
    const p = pxBy[sig.sym];
    if (!(p > 0)) continue;
    updateOutcome(sig, p, now, "a");
    sig.last = rp(p);
  }
  const stillOpen = live.filter(s => s.open);
  const newlyClosed = live.filter(s => !s.open);
  closed = newlyClosed.length;
  const history = (histPrev.records || []).concat(newlyClosed);

  /* البوابة على **المجموع** لا على أحد الملفّين: نقلُ سجلٍّ من المفتوح
     إلى التاريخ تقلّصٌ مشروع في الأول، وضياعُه تقلّصٌ في المجموع —
     والثاني وحده خلل. */
  const nextTotal = stillOpen.length + history.length;
  const g = guardTotal(prevTotal, nextTotal, { pruning: false });
  if (g && g.stop) throw new Error(`بوابة السلامة: المجموع ${prevTotal} ← ${nextTotal}`);

  /* بوابةٌ على عدد الرموز لا النقاط — النقاط تتقلّص بالتشذيب كل تشغيل
     فلا تصلح مقياساً (درسٌ موثّق من `trend.json`). */
  const prevSyms = fs.existsSync(path.join(out, "strat"))
    ? fs.readdirSync(path.join(out, "strat")).filter(f => f.endsWith(".json")).length : 0;
  const nextSyms = Object.keys(trends).length;

  return { rows, trends, stillOpen, history, now,
           stats: { symbols, skipped, rows: rows.length, added, closed,
                    trendSyms: nextSyms, prevSyms, onlyPrice } };
}

export function writeOut(res, out = OUT) {
  const { rows, trends, stillOpen, history, now, stats } = res;
  fs.mkdirSync(path.join(out, "strat"), { recursive: true });

  fs.writeFileSync(path.join(out, "strategies.json"), JSON.stringify({
    updated: now, priceAt: now, count: rows.length,
    actMin: S.ACT_MIN, bands: S.S_BANDS, labels: S.S_LABEL,
    strategies: S.STRATEGIES.map(s => ({ id: s.id, lbl: s.lbl, fam: s.fam, tf: s.tf, why: s.why, src: s.src })),
    fams: C.REGIMES ? S.FAMS : S.FAMS,
    rows
  }));

  for (const [sym, pts] of Object.entries(trends)) {
    const f = path.join(out, "strat", `${sym}.json`);
    const prev = readJSON(f, { tl: [] });
    const tl = trimPoints((prev.tl || []).concat(pts.map(p => p.raw)), now);
    fs.writeFileSync(f, JSON.stringify({ s: sym, updated: now, keepDays: KEEP_DAYS, tl }));
  }

  fs.writeFileSync(path.join(out, "strat-signals.json"), JSON.stringify({
    updated: now, holdDays: HOLD_DAYS, count: stillOpen.length, records: stillOpen }));
  fs.writeFileSync(path.join(out, "strat-history.json"), JSON.stringify({
    updated: now, count: history.length, records: history }));
  return stats;
}

/* =====================================================================
   الفحص الذاتي
   ===================================================================== */
function selfTest() {
  let pass = 0, fail = 0;
  const t = (n, fn) => { try { fn(); console.log(`  ✓ ${n}`); pass++; }
                         catch (e) { console.log(`  ✗ ${n} — ${e.message}`); fail++; } };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b))
    throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };
  const ok = (c, m) => { if (!c) throw new Error(m); };

  console.log("\n▶ فحص تتبّع الاستراتيجيات (بلا شبكة)\n");

  t("لحظة البدء تُعاد عند تبدّل الجهة وحده", () => {
    const now = 1789400000000;
    const first = carryState(null, { dir: 1, sc: 70 }, now, 100);
    eq(first.at, Math.round(now / 1000), "أول ظهور يؤرَّخ الآن");
    eq(first.px0, 100, "والسعر يُثبَّت");
    // نفس الجهة بنتيجةٍ أخرى: التأريخ والسعر لا يُلمسان
    const same = carryState({ dir: 1, at: 1000, px0: 100, band: 1 }, { dir: 1, sc: 95 }, now, 130);
    eq(same.at, 1000, "الاستمرار لا يُعيد التأريخ");
    eq(same.px0, 100, "ولا يُحدّث سعر الإشارة");
    // تبدّل الجهة: كلاهما يُعاد
    const flip = carryState({ dir: 1, at: 1000, px0: 100, band: 1 }, { dir: -1, sc: 70 }, now, 130);
    eq(flip.at, Math.round(now / 1000), "الانقلاب يؤرَّخ من جديد");
    eq(flip.px0, 130, "والسعر يُعاد تثبيته");
  });

  t("نقطة التسلسل تُسجَّل بثلاثة شروطٍ لا بكل دورة", () => {
    const L = [];
    ok(pushPoint(L, { dir: 1, sc: 60, band: 1 }, null), "أول نقطة تُسجَّل");
    ok(!pushPoint(L, { dir: 1, sc: 63, band: 1 }, { dir: 1, sc: 60, band: 1 }), "حركةٌ صغيرة تُهمَل");
    ok(pushPoint(L, { dir: 1, sc: 75, band: 1 }, { dir: 1, sc: 60, band: 1 }), "حركةٌ تُذكر تُسجَّل");
    ok(pushPoint(L, { dir: 1, sc: 61, band: 2 }, { dir: 1, sc: 60, band: 1 }), "عبور وسمٍ يُسجَّل ولو بنقطة");
    // انقلابُ الجهة لا يُفقد أبداً مهما صغرت الحركة
    ok(pushPoint(L, { dir: -1, sc: 60, band: 1 }, { dir: 1, sc: 60, band: 1 }), "الانقلاب لا يُفقد");
  });

  t("التشذيب بالعمر لا بالعدد", () => {
    const now = 1789400000000;
    const old = [Math.round((now - 9 * DAY) / 1000), "orb", 1, 70, 100];
    const fresh = [Math.round((now - 1 * DAY) / 1000), "orb", 1, 70, 100];
    eq(trimPoints([old, fresh], now).length, 1, "القديمة تُقصّ");
    eq(trimPoints([old, fresh], now)[0][0], fresh[0], "والباقية هي الحديثة");
    const many = Array.from({ length: 300 }, (_, i) => [Math.round((now - 3600e3) / 1000) + i, "orb", 1, 70, 100]);
    eq(trimPoints(many, now).length, MAX_PTS, "والسقف يحدّ العدد");
  });

  t("اللقطة تُرفض حين ينكسر معناها بعد التقريب", () => {
    const c = { px: 0.00000529 };
    const r = { sc: 80, band: 2 };
    // خطةٌ فرقُها أصغر من دقّة التقريب -> يجب أن تُرفض لا أن تُكتب صفراً
    const flat = { dir: 1, entry: 0.00000529, stop: 0.000005289999, atr: 1e-12,
                   rr: 2, targets: [{ p: 0.0000053, pct: 1, rr: 2 }], atrTf: "15m" };
    const snap = snapFor(c, r, flat);
    ok(!snap || snap.bad, "لقطةٌ بمخاطرةٍ منعدمة يجب أن تُرفض");
    // وخطةٌ سليمة على سعرٍ رخيص تمرّ بمعناها محفوظاً
    const good = { dir: 1, entry: 0.0000053, stop: 0.0000049, atr: 0.0000004,
                   rr: 2, targets: [{ p: 0.0000061, pct: 15, rr: 2 }], atrTf: "15m" };
    const s2 = snapFor(c, r, good);
    ok(s2 && !s2.bad, "الخطة السليمة تمرّ");
    ok(s2.e - s2.s > 0, "والفرق يبقى موجباً بعد التقريب");
  });

  t("اللقطة بشكلٍ تقبله updateOutcome بلا تحويل", () => {
    const plan = { dir: 1, entry: 100, stop: 98, atr: 2, rr: 2,
                   targets: [{ p: 104, pct: 4, rr: 2 }, { p: 106, pct: 6, rr: 3 }], atrTf: "1h" };
    const snap = snapFor({ px: 100 }, { sc: 80, band: 2 }, plan);
    ok(snap && !snap.bad, "لقطة سليمة");
    const sig = { sym: "X", strat: "orb", at: Date.now(), snap, open: true,
                  out: { st: "wait", hit: [null, null], stopAt: null, enterAt: null } };
    updateOutcome(sig, 100, Date.now(), "a");
    eq(sig.out.st, "open", "الدخول عند السعر يفتحها");
    updateOutcome(sig, 104, Date.now(), "a");
    eq(sig.out.st, "t1", "الهدف الأول يُسجَّل");
    updateOutcome(sig, 97, Date.now(), "a");
    eq(sig.out.st, "stop", "والوقف يغلقها");
    eq(sig.open, false, "وتخرج من المفتوحات");
    // والمنتهية لا تُحدَّث بعدها
    updateOutcome(sig, 106, Date.now(), "a");
    eq(sig.out.st, "stop", "المنتهية لا تعود رابحة");
  });

  t("السكّانان منفصلان — لا يُكتب في signals.json", () => {
    const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
    ok(!/writeFileSync\([^)]*"signals\.json"/.test(src), "لا كتابة في signals.json");
    ok(!/writeFileSync\([^)]*"history\.json"/.test(src), "لا كتابة في history.json");
    ok(/strat-signals\.json/.test(src) && /strat-history\.json/.test(src), "ملفّان خاصّان");
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل\n`);
  process.exit(fail ? 1 : 0);
}

if (CHECK) selfTest();
else {
  const now = Date.now();
  const res = runOnce({ out: OUT, now, onlyPrice: ONLY_PRICE });
  const stats = writeOut(res, OUT);
  console.log(`▶ الاستراتيجيات${ONLY_PRICE ? " (سعرية فقط)" : ""}: ` +
    `${stats.rows} صفّاً على ${stats.symbols} رمزاً · ` +
    `${stats.added} إشارة جديدة · ${stats.closed} أُغلقت · ` +
    `${stats.trendSyms} تسلسلاً` + (stats.skipped ? ` · ${stats.skipped} تُخطّي` : ""));
}

