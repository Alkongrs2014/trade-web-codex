#!/usr/bin/env node
/* =====================================================================
   الأحداث القوية — تقويم البنك الفدرالي الأمريكي.

   مصدران رسميان لا وسيط ينقل عنهما:
   - الفدرالي ينشر تقويمه كاملاً بصيغة JSON بلا مفتاح ولا حصّة
     (اجتماعات الفائدة ومحاضرها والكتاب البيج والشهادات).
   - مكتب إحصاءات العمل ينشر جداول التضخّم وتقرير الوظائف كصفحات HTML.

   تقويم Finnhub الاقتصادي مدفوع (403 على المفتاح المجاني)، فلا يُستعمل.

   ولذلك لا تُكتب المواعيد يدوياً في الشيفرة: تاريخ اجتماع مكتوب من
   الذاكرة يبدو صحيحاً وهو خاطئ، ولا شيء في الواجهة يكشفه.

     node scripts/fetch-events.mjs --out ./data
     node scripts/fetch-events.mjs --check
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();

const FED_URL = "https://www.federalreserve.gov/json/calendar.json";
const AHEAD_DAYS = 120;
const DAY = 86400e3;

/* =====================================================================
   مكتب إحصاءات العمل — التضخّم وتقرير الوظائف.

   يحجب الطلبات ذات الترويسة الناقصة بـ403، وكان هذا سبب اعتقادنا أن
   المصدر مغلق. الحجب ليس على الآلات بل على الطلب الذي لا يشبه المتصفح:
   مع ترويسات المتصفح الكاملة (Accept وAccept-Language وSec-Fetch-*)
   يردّ 200. لذلك لم تُكتب المواعيد يدوياً هنا أيضاً.
   ===================================================================== */
const BLS = [
  { url: "https://www.bls.gov/schedule/news_release/cpi.htm",
    ar: "مؤشر أسعار المستهلك (التضخّم)", w: 3,
    note: "أهم مقياس للتضخّم، ويحرّك توقّعات الفائدة" },
  { url: "https://www.bls.gov/schedule/news_release/empsit.htm",
    ar: "تقرير الوظائف الأمريكي", w: 3,
    note: "الوظائف المضافة ونسبة البطالة — يُنشر أول جمعة غالباً" }
];

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Upgrade-Insecure-Requests": "1"
};

/* الأنواع التي تحرّك السوق فعلاً. `Stat` نشرات إحصائية دورية بالعشرات
   شهرياً، و`Speeches` كلمات روتينية — إدراجهما يغرق الحدث المهم. */
const KEEP_TYPES = new Set(["FOMC", "Beige", "Testimony", "Board"]);

/* الوزن يقرّر ما يستحق التمييز في الواجهة. قرار الفائدة ليس ككتاب بيج. */
const RULES = [
  [/press conference/i,  { ar: "المؤتمر الصحفي لرئيس الفدرالي", w: 3 }],
  [/fomc\s*minutes/i,    { ar: "محضر اجتماع الفدرالي",          w: 2 }],
  [/fomc\s*meeting/i,    { ar: "اجتماع الفدرالي — قرار الفائدة", w: 3 }],
  [/beige\s*book/i,      { ar: "الكتاب البيج",                   w: 1 }],
  [/testimony/i,         { ar: "شهادة أمام الكونغرس",            w: 2 }],
  [/monetary policy report/i, { ar: "تقرير السياسة النقدية",     w: 2 }]
];

export function classify(title, type) {
  for (const [re, v] of RULES) if (re.test(title || "")) return v;
  if (type === "FOMC") return { ar: "حدث من الفدرالي", w: 2 };
  if (type === "Beige") return { ar: "الكتاب البيج", w: 1 };
  return { ar: title || "حدث", w: 1 };
}

/* =====================================================================
   التوقيت.

   التقويم يعطي الشهر واليوم والساعة بتوقيت نيويورك، والفرق عن UTC
   يتغيّر بالتوقيت الصيفي. تثبيت ‎-5‎ أو ‎-4‎ يزيح نصف السنة ساعةً كاملة،
   فتُعرض جلسة الثانية ظهراً في الواحدة. نحسب الفارق الفعلي لذلك اليوم.
   ===================================================================== */
export function tzOffset(tz, ts) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hour12: false, year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit"
  }).formatToParts(ts).map(x => [x.type, x.value]));
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
  return asUTC - ts;
}

export function etToUTC(y, mo, d, hh = 12, mm = 0) {
  let ts = Date.UTC(y, mo - 1, d, hh, mm);
  // تكرارَان يكفيان: التصحيح الأول يقارب، والثاني يضبط ما يقع على حدّ
  // التحوّل الصيفي نفسه
  for (let i = 0; i < 2; i++) ts = Date.UTC(y, mo - 1, d, hh, mm) - tzOffset("America/New_York", ts);
  return ts;
}

/* "2:00 p.m." → [14, 0] · "10:30 a.m." → [10, 30] · بلا وقت → منتصف النهار */
export function parseTime(t) {
  const m = /(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m/i.exec(String(t || ""));
  if (!m) return [12, 0];
  let h = +m[1] % 12;
  if (/p/i.test(m[3])) h += 12;
  return [h, +(m[2] || 0)];
}

/* الوصف يصل مُرمَّزاً بـHTML مضاعف الترميز (&lt;p&gt;) — ننزع الوسوم
   ونفكّ الكيانات لنعرض جملة نظيفة لا شيفرة. */
export function cleanText(s) {
  if (!s) return null;
  const un = (x) => x.replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&#10;/g, " ").replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  return un(un(String(s))).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() || null;
}

/* =====================================================================
   تعريب التفاصيل.

   الوصف يصل بالإنجليزية وصيغه محدودة ومتكرّرة، فنترجمها بقواعد صريحة
   لا بمترجم آلي: مترجم `news.mjs` يشوّه أسماء الأشهر والأرقام، والملفات
   كلها عربية فلا يصحّ أن تبقى هذه وحدها إنجليزية.
   ما لا تعرفه القواعد يسقط بدل أن يُعرض بلغة أخرى.
   ===================================================================== */
const MONTHS_AR = {
  january: "يناير", february: "فبراير", march: "مارس", april: "أبريل",
  may: "مايو", june: "يونيو", july: "يوليو", august: "أغسطس",
  september: "سبتمبر", october: "أكتوبر", november: "نوفمبر", december: "ديسمبر"
};

/* "September 15 - 16" → "15–16 سبتمبر" · "December 9" → "9 ديسمبر" */
function arDate(s) {
  const m = /([A-Za-z]+)\s+(\d{1,2})(?:\s*[-–]\s*(\d{1,2}))?/.exec(s || "");
  if (!m) return null;
  const mo = MONTHS_AR[m[1].toLowerCase()];
  if (!mo) return null;
  return m[3] ? `${m[2]}–${m[3]} ${mo}` : `${m[2]} ${mo}`;
}

export function arNote(desc) {
  const s = cleanText(desc);
  if (!s) return null;
  const parts = [];
  const two = /two-day meeting,?\s*(.+?)(?:$|\s{2,}|Press)/i.exec(s);
  if (two) { const d = arDate(two[1]); parts.push(d ? `اجتماع يومين ${d}` : "اجتماع يومين"); }
  const of = /meeting of\s+(.+)/i.exec(s);
  if (!two && of) { const d = arDate(of[1]); if (d) parts.push(`عن اجتماع ${d}`); }
  if (/press conference/i.test(s)) parts.push("مع مؤتمر صحفي");
  return parts.length ? parts.join(" · ") : null;
}

/* حقل `days` قد يكون "16" أو "3, 10, 17, 24" لحدث متكرّر */
export const splitDays = (d) => String(d ?? "").split(",")
  .map(x => parseInt(x.trim(), 10)).filter(n => Number.isInteger(n) && n >= 1 && n <= 31);

export function toEvents(raw, now, aheadDays = AHEAD_DAYS) {
  const out = [];
  for (const e of raw || []) {
    if (!KEEP_TYPES.has(e.type)) continue;
    const m = /^(\d{4})-(\d{2})$/.exec(String(e.month || ""));
    if (!m) continue;
    const [hh, mm] = parseTime(e.time);
    for (const d of splitDays(e.days)) {
      const at = etToUTC(+m[1], +m[2], d, hh, mm);
      if (at < now - DAY || at > now + aheadDays * DAY) continue;
      const c = classify(e.title, e.type);
      out.push({ at, ar: c.ar, w: c.w, note: arNote(e.description), link: e.link || null });
    }
  }
  // إزالة التكرار: الاجتماع ومؤتمره الصحفي حدثان منفصلان في نفس اليوم،
  // لكن العنوان نفسه لا يتكرّر مرتين في الوقت نفسه
  const seen = new Set();
  return out.filter(e => {
    const k = `${e.at}|${e.ar}`;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  }).sort((a, b) => a.at - b.at);
}

/* =====================================================================
   قراءة جدول BLS.

   صفوف الجدول: "August 2026 | Sep. 11, 2026 | 08:30 AM" — الشهر المرجعي
   ثم تاريخ النشر ثم وقته. نحن نريد الثاني والثالث؛ الأول يفيد كوصف
   ("عن شهر أغسطس") لأن السوق يتحرك على البيانات لا على تاريخ صدورها.
   ===================================================================== */
const MONTH_NUM = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12
};

export function parseBLS(html, meta, now, aheadDays = AHEAD_DAYS) {
  const text = String(html)
    .replace(/<[^>]+>/g, "\t")            // الوسوم فواصل خلايا، لا تُحذف بلا أثر
    .replace(/&nbsp;/g, " ")
    .replace(/[ \t]+/g, "\t");
  const out = [];
  // "Sep. 11, 2026" ثم بعدها بقليل "08:30 AM"
  const re = /([A-Z][a-z]{2})\.?\s+(\d{1,2}),\s+(\d{4})[\s\t]*(\d{1,2}):(\d{2})\s*([AP])M/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const mo = MONTH_NUM[m[1].toLowerCase()];
    if (!mo) continue;
    let hh = (+m[4]) % 12;
    if (m[6] === "P") hh += 12;
    const at = etToUTC(+m[3], mo, +m[2], hh, +m[5]);
    if (at < now - DAY || at > now + aheadDays * DAY) continue;
    out.push({ at, ar: meta.ar, w: meta.w, note: meta.note, link: meta.url });
  }
  return out;
}

async function fetchBLS(now) {
  const out = [];
  for (const b of BLS) {
    try {
      const r = await fetch(b.url, { headers: BROWSER_HEADERS });
      if (!r.ok) throw new Error(`ردّ ${r.status}`);
      const rows = parseBLS(await r.text(), b, now);
      if (!rows.length) console.warn(`  ⚠ ${b.ar}: لا مواعيد داخل النافذة`);
      out.push(...rows);
    } catch (e) {
      // سقوط BLS لا يُسقط التقويم كله — أحداث الفدرالي تكفي وحدها
      console.warn(`  ⚠ ${b.ar}: ${e.message}`);
    }
  }
  return out;
}

async function main() {
  const now = Date.now();
  console.log("▶ تقويم الفدرالي …");
  const res = await fetch(FED_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; webtrade/1.0)" }
  });
  if (!res.ok) throw new Error(`الفدرالي ردّ ${res.status}`);
  // الملف يبدأ بعلامة ترتيب البايتات، وJSON.parse لا يقبلها
  const j = JSON.parse((await res.text()).replace(/^﻿/, ""));
  const fed = toEvents(j.events, now);
  console.log(`  ✓ الفدرالي: ${fed.length}`);

  console.log("▶ مكتب إحصاءات العمل …");
  const bls = await fetchBLS(now);
  console.log(`  ✓ التضخّم والوظائف: ${bls.length}`);

  const events = [...fed, ...bls].sort((a, b) => a.at - b.at);
  if (!events.length) throw new Error("لا أحداث قادمة — لن نكتب ملفاً فارغاً");

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "events.json"),
    JSON.stringify({ updated: now, sources: ["federalreserve.gov", "bls.gov"],
                     count: events.length, events }));

  const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };
  const prevMeta = readJSON(path.join(OUT, "meta.json"), {});
  fs.writeFileSync(path.join(OUT, "meta.json"), JSON.stringify({
    ...prevMeta, eventsUpdated: now,
    eventsRun: { at: new Date(now).toISOString(), count: events.length,
                 fed: fed.length, bls: bls.length }
  }));

  console.log(`✔ ${events.length} حدثاً خلال ${AHEAD_DAYS} يوماً`);
  for (const e of events.slice(0, 6))
    console.log(`  ${new Date(e.at).toISOString().slice(0, 16).replace("T", " ")} · ${e.ar}`);
  return 0;
}

/* ---------- فحص ذاتي بلا شبكة ---------- */
function selfCheck() {
  console.log("▶ فحص ذاتي (بلا شبكة)\n");
  let pass = 0, fail = 0;
  const t = (name, fn) => { try { fn(); console.log(`  ✓ ${name}`); pass++; } catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; } };
  const eq = (a, b, m) => { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${m}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`); };

  t("parseTime يقرأ صيغ الفدرالي", () => {
    eq(parseTime("2:00 p.m."), [14, 0], "بعد الظهر");
    eq(parseTime("10:30 a.m."), [10, 30], "صباحاً");
    eq(parseTime("12:00 p.m."), [12, 0], "الظهر");
    eq(parseTime("12:00 a.m."), [0, 0], "منتصف الليل");
    eq(parseTime(null), [12, 0], "بلا وقت");
  });

  t("etToUTC يحترم التوقيت الصيفي في الاتجاهين", () => {
    // 16 سبتمبر صيفي (EDT = UTC-4): الثانية ظهراً = 18:00 UTC
    eq(new Date(etToUTC(2026, 9, 16, 14, 0)).toISOString(), "2026-09-16T18:00:00.000Z", "صيفي");
    // 28 يناير شتوي (EST = UTC-5): الثانية ظهراً = 19:00 UTC
    eq(new Date(etToUTC(2026, 1, 28, 14, 0)).toISOString(), "2026-01-28T19:00:00.000Z", "شتوي");
  });

  t("splitDays يفكّ اليوم المفرد والقائمة", () => {
    eq(splitDays("16"), [16], "مفرد");
    eq(splitDays("3, 10, 17, 24"), [3, 10, 17, 24], "قائمة");
    eq(splitDays(""), [], "فارغ");
    eq(splitDays("0, 32, x"), [], "قيم غير صالحة");
  });

  t("cleanText يفكّ الترميز المضاعف وينزع الوسوم", () => {
    eq(cleanText("&lt;p&gt;Two-day meeting, September 15 - 16&lt;/p&gt;"),
       "Two-day meeting, September 15 - 16", "وصف اجتماع");
    eq(cleanText("&lt;p&gt;A&lt;br /&gt;&#10;B&lt;/p&gt;"), "A B", "أسطر");
    eq(cleanText(null), null, "فارغ");
  });

  t("classify يميّز قرار الفائدة عن الكتاب البيج", () => {
    eq(classify("FOMC Meeting", "FOMC").w, 3, "الاجتماع أعلى وزناً");
    eq(classify("FOMC Press Conference", "FOMC").w, 3, "المؤتمر");
    eq(classify("FOMC Minutes", "FOMC").w, 2, "المحضر");
    eq(classify("Beige Book", "Beige").w, 1, "الكتاب البيج");
    eq(classify("FOMC Meeting", "FOMC").ar, "اجتماع الفدرالي — قرار الفائدة", "الاسم العربي");
  });

  t("arNote يعرّب الصيغ المتكرّرة ويُسقط ما لا يعرفه", () => {
    eq(arNote("&lt;p&gt;Two-day meeting, September 15 - 16&lt;/p&gt;"), "اجتماع يومين 15–16 سبتمبر", "اجتماع يومين");
    eq(arNote("&lt;p&gt;Two-day meeting, October 27 - 28&lt;/p&gt;&#10;&lt;p&gt;Press Conference&lt;/p&gt;"),
       "اجتماع يومين 27–28 أكتوبر · مع مؤتمر صحفي", "اجتماع ومؤتمر");
    eq(arNote("&lt;p&gt;Meeting of September 15-16&lt;/p&gt;"), "عن اجتماع 15–16 سبتمبر", "محضر");
    eq(arNote("Some unmapped English text"), null, "ما لا يُعرف يسقط");
    eq(arNote(null), null, "فارغ");
  });

  t("toEvents يرشّح النوع والنافذة الزمنية", () => {
    const now = Date.UTC(2026, 8, 8);
    const raw = [
      { type: "FOMC", title: "FOMC Meeting", time: "2:00 p.m.", month: "2026-09", days: "16" },
      { type: "Stat", title: "H.4.1", time: "4:30 p.m.", month: "2026-09", days: "3, 10, 17" },
      { type: "Speeches", title: "Speech - Governor", time: "8:30 a.m.", month: "2026-09", days: "20" },
      { type: "FOMC", title: "FOMC Meeting", time: "2:00 p.m.", month: "2019-01", days: "30" },
      { type: "Beige", title: "Beige Book", time: "2:00 p.m.", month: "2027-06", days: "1" }
    ];
    const ev = toEvents(raw, now);
    eq(ev.length, 1, "واحد فقط داخل النافذة والأنواع");
    eq(ev[0].ar, "اجتماع الفدرالي — قرار الفائدة", "الاسم");
  });

  t("toEvents يوسّع الأيام المتعدّدة ويحذف التكرار", () => {
    const now = Date.UTC(2026, 8, 8);
    const raw = [
      { type: "Testimony", title: "Testimony", time: "10:00 a.m.", month: "2026-09", days: "20, 21" },
      { type: "Testimony", title: "Testimony", time: "10:00 a.m.", month: "2026-09", days: "20" }
    ];
    const ev = toEvents(raw, now);
    eq(ev.length, 2, "يومان بلا تكرار");
    eq(ev.map(e => new Date(e.at).toISOString().slice(0, 10)), ["2026-09-20", "2026-09-21"], "مرتّبة");
  });

  t("parseBLS يقرأ صفوف الجدول الرسمي", () => {
    const now = Date.UTC(2026, 8, 8);
    // الشكل الحقيقي من صفحة BLS: شهر مرجعي ثم تاريخ نشر ثم وقت
    const html = `<tr><td>July 2026</td><td>Aug. 12, 2026</td><td>08:30 AM</td></tr>
                  <tr><td>August 2026</td><td>Sep. 11, 2026</td><td>08:30 AM</td></tr>
                  <tr><td>September 2026</td><td>Oct. 14, 2026</td><td>08:30 AM</td></tr>`;
    const r = parseBLS(html, { ar: "التضخّم", w: 3, note: "x", url: "u" }, now);
    eq(r.length, 2, "الماضي يسقط");
    // 8:30 صباحاً بتوقيت نيويورك صيفاً = 12:30 UTC
    eq(new Date(r[0].at).toISOString(), "2026-09-11T12:30:00.000Z", "أول موعد");
    eq(r[0].ar, "التضخّم", "الاسم");
  });

  t("parseBLS يحترم التوقيت الشتوي أيضاً", () => {
    const now = Date.UTC(2026, 10, 1);
    const html = `<td>November 2026</td><td>Dec. 10, 2026</td><td>08:30 AM</td>`;
    const r = parseBLS(html, { ar: "x", w: 3 }, now);
    // شتاءً EST = UTC-5 فيصير 13:30 لا 12:30
    eq(new Date(r[0].at).toISOString(), "2026-12-10T13:30:00.000Z", "شتوي");
  });

  t("parseBLS يعيد قائمة فارغة لصفحة بلا جدول", () => {
    eq(parseBLS("<html><body>no table here</body></html>", { ar: "x", w: 1 }, Date.now()), [], "بلا مواعيد");
  });

  t("toEvents يتجاهل الشهر المشوّه بدل أن يرمي", () => {
    eq(toEvents([{ type: "FOMC", title: "x", month: "غير صالح", days: "1" }], Date.now()), [], "شهر تالف");
    eq(toEvents(null, Date.now()), [], "مدخل فارغ");
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل`);
  process.exit(fail ? 1 : 0);
}

if (CHECK) selfCheck();
else main().catch(e => { console.error("✗ فشل التشغيل:", e.message); process.exit(1); });
