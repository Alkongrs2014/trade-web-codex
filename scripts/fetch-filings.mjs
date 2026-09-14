/* =====================================================================
   إيداعات SEC — المصدر الأوّلي، لا نقلاً عنه.

   كل خلاصات الأخبار عندنا **ثانوية**: تنقل ما كتبه صحافيٌّ عن حدث. وهذا
   المصدر هو الحدث: الشركة مُلزَمة قانوناً بإيداع ‎8-K‎ عند أيّ تطوّر
   جوهري، و‎Form 4‎ خلال يومَي عمل من أيّ تداولٍ لمطّلع.

   قياسٌ فعلي على خلاصاتنا يوم 2026-09-13: أحدث خبرٍ عمره **133 دقيقة**
   والوسيط **28 ساعة**. والإيداع يظهر في EDGAR لحظة قبوله.

   ---------------------------------------------------------------------
   دورةٌ مستقلّة، ولماذا:

   الإيداعات تصل على مدار الساعة وبوتيرةٍ لا علاقة لها بدورة الأسعار.
   ودمجُها في `fetch-news` كان سيجعلها تتقاسم قفلاً وميزانيةً مع الترجمة
   وخلاصات RSS، وهي لا تحتاج واحدةً منهما — ولا مفتاح ولا حصّة أصلاً.

   ---------------------------------------------------------------------
   تراكميّ مثل `wide.json` و`options.json`:

   التيار يعيد أحدث مئة إيداعٍ في السوق كلّه، وحصّتُنا منها قليلة. فبلا
   دمجٍ فوق القديم يخرج الملف بما صادفه التشغيل الأخير وحده — وقد يكون
   صفراً في تشغيلٍ هادئ، فتختفي إيداعاتُ اليوم كلّها من الواجهة.

   ويُنقَّح بالعمر (30 يوماً) لا بالعدد: إيداعٌ قديم لا قيمة له، وسقفُ
   عددٍ يحذف أقدمَ إيداعٍ لشركةٍ هادئة قبل أحدثِ إيداعٍ لشركةٍ ثرثارة.
   ===================================================================== */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { tickerMap, currentFilings, form4Detail, parseForm4, itemsOf, parseAtom,
         secStats, MAP_TTL } from "./lib/sec.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const CHECK = args.includes("--check");
const OUT = (() => { const i = args.indexOf("--out"); return i >= 0 ? path.resolve(args[i + 1]) : path.join(ROOT, "out"); })();

const KEEP_DAYS = 30;
const FEED_COUNT = 100;          // يغطّي ~2.7 ساعة — ستّة عشر ضعف دورتنا
const MAX_DETAIL = 12;           // سقف طلبات تفصيل Form 4 في التشغيل الواحد

const readJSON = (p, d = null) => { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return d; } };

/* =====================================================================
   البنود بالعربية، ومعها وزنُ أهمّيتها.

   البند هو ما يجعل ‎8-K‎ مفيداً: إيداعٌ ببند ‎2.02‎ نتائجُ ربعٍ تُحرّك
   السهم في الدقائق، وببند ‎9.01‎ مرفقاتٌ لا حدثَ فيها. وعرضُهما بوسمٍ
   واحد «إيداع جديد» يمحو الفرق كلّه.

   والوزن ‎0..3‎: ‎3‎ يقلب التسعير، و‎1‎ إجراءٌ شكلي. وبند ‎4.02‎ — «لا
   يجوز الاعتماد على قوائمَ مالية سابقة» — أخطر ما يمكن أن تودعه شركة،
   ولهذا وزنُه ‎3‎ رغم ندرته.
   ===================================================================== */
export const ITEMS = {
  "1.01": ["اتفاقية جوهرية جديدة", 2],
  "1.02": ["إنهاء اتفاقية جوهرية", 2],
  "1.03": ["إفلاس أو حراسة قضائية", 3],
  "1.05": ["حادثة أمن معلومات جوهرية", 3],
  "2.01": ["إتمام استحواذ أو بيع أصول", 3],
  "2.02": ["نتائج مالية ربعية أو سنوية", 3],
  "2.03": ["التزام دَين جديد", 2],
  "2.04": ["تعجيل استحقاق دَين", 3],
  "2.05": ["تكاليف إعادة هيكلة", 2],
  "2.06": ["انخفاض قيمة أصول", 3],
  "3.01": ["إخلال بقواعد الإدراج", 3],
  "3.02": ["بيع أسهم غير مسجَّلة", 1],
  "3.03": ["تعديل حقوق حاملي الأسهم", 2],
  "4.01": ["تغيير مراجع الحسابات", 3],
  "4.02": ["عدم جواز الاعتماد على قوائم سابقة", 3],
  "5.01": ["تغيّر في السيطرة على الشركة", 3],
  "5.02": ["تغيير في الإدارة أو المجلس", 2],
  "5.03": ["تعديل النظام الأساسي", 1],
  "5.07": ["نتائج تصويت الجمعية العامة", 1],
  "7.01": ["إفصاح تنظيمي (Reg FD)", 2],
  "8.01": ["حدث آخر جوهري", 2],
  "9.01": ["قوائم مالية ومرفقات", 1]
};

export const itemLabel = (code) => (ITEMS[code] || [null, 1])[0] || `بند ${code}`;
export const itemWeight = (code) => (ITEMS[code] || [null, 1])[1];

/* أهمّية الإيداع = أعلى بنوده. الجمع كان يجعل إيداعاً بأربعة بنودٍ
   شكلية يتقدّم على إيداعٍ ببند ‎2.02‎ وحده — والثاني هو الذي يحرّك السعر. */
export function weightOf(items) {
  if (!items || !items.length) return 1;
  return Math.max(...items.map(itemWeight));
}

/* =====================================================================
   رموز عمليات Form 4.

   والشراء وحده هو ما يُقرأ إشارةً: البيع له عشرة أسباب مشروعة (ضرائب
   الاستحقاق، تنويع، خطّة ‎10b5-1‎ مبرمجة قبل شهور) والشراء له سببٌ واحد.
   ولهذا `sig` صحيحةٌ للشراء وحده، والمنحُ وتنفيذُ الخيارات ليست تداولاً
   أصلاً — عرضُها «شراء مطّلع» كذبٌ بحسن نيّة.
   ===================================================================== */
export const TX = {
  P: { ar: "شراء مباشر",           sig: true  },
  S: { ar: "بيع",                  sig: false },
  A: { ar: "منحة أسهم",            sig: false },
  M: { ar: "تنفيذ خيار",           sig: false },
  F: { ar: "أسهم محتجزة لضريبة",   sig: false },
  D: { ar: "تصرّف بلا مقابل",      sig: false },
  G: { ar: "هبة",                  sig: false },
  C: { ar: "تحويل أداة",           sig: false },
  X: { ar: "ممارسة حق",            sig: false }
};
export const txLabel = (c) => (TX[c] || {}).ar || (c ? `عملية ${c}` : "غير محدَّد");

/* =====================================================================
   الدمج — المفتاح رقم القبول (accession) لا الرابط ولا الزمن.

   رقم القبول معرّفٌ رسميّ فريد لكل إيداع، والرابط يتغيّر شكلُه بين
   الواجهات فيُنتج صفّين لإيداعٍ واحد. والزمن لا يصلح مفتاحاً أصلاً:
   إيداعان لشركتين في الثانية نفسها أمرٌ عادي.
   ===================================================================== */
export function merge(prev, fresh, now, keepDays = KEEP_DAYS) {
  const by = new Map();
  for (const r of (prev || [])) if (r && r.acc) by.set(r.acc, r);
  let added = 0;
  for (const r of fresh) {
    if (!r || !r.acc) continue;
    if (!by.has(r.acc)) added++;
    // الجديد يغلب: التشغيل التالي قد يكون أضاف تفصيل Form 4 لصفٍّ كان بلا تفصيل
    by.set(r.acc, { ...(by.get(r.acc) || {}), ...r });
  }
  const cut = now - keepDays * 86400e3;
  const rows = [...by.values()]
    .filter(r => !Number.isFinite(r.at) || r.at >= cut)
    .sort((a, b) => (b.at || 0) - (a.at || 0));
  return { rows, added };
}

/* ---------- التشغيل ---------- */
async function main() {
  const now = Date.now();
  fs.mkdirSync(OUT, { recursive: true });
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "stocks/symbols.json"), "utf8"));

  /* الكون كلّه لا الطبقة الأساسية وحدها: التيار يأتي مجّاناً في الطلب
     نفسه، وترشيحُه على 90 رمزاً بدل 504 يرمي إيداعاتٍ عندنا بياناتُها. */
  const ours = new Map();
  for (const x of [...cfg.symbols, ...cfg.wide]) ours.set(x.s, x);

  // خريطة CIK تُخزَّن وتُجدَّد أسبوعياً — 600 ك.ب لا تُطلب كل عشر دقائق
  const mapPath = path.join(OUT, "cik.json");
  let cache = readJSON(mapPath);
  if (!cache || !cache.map || (now - (cache.updated || 0)) > MAP_TTL) {
    try {
      const map = await tickerMap();
      cache = { updated: now, map };
      fs.writeFileSync(mapPath, JSON.stringify(cache));
      console.log(`  ✓ خريطة CIK: ${Object.keys(map).length} رمزاً`);
    } catch (e) {
      if (!cache) throw new Error(`خريطة CIK لم تصل ولا نسخة محفوظة: ${e.message}`);
      console.warn(`  ⚠ خريطة CIK لم تُجدَّد (${e.message}) — نستعمل المحفوظة`);
    }
  }

  // CIK -> رمز، للرموز التي نعرفها وحدها
  const cikToSym = new Map();
  let noCik = [];
  for (const s of ours.keys()) {
    const c = cache.map[s];
    if (c) cikToSym.set(c, s); else noCik.push(s);
  }
  console.log(`  ${cikToSym.size} رمزاً له CIK · ${noCik.length} بلا` +
              (noCik.length && noCik.length <= 8 ? ` (${noCik.join(" ")})` : ""));

  const fresh = [], errors = [];
  let seen = 0;

  for (const form of ["8-K", "4"]) {
    let list;
    try { list = await currentFilings(form, FEED_COUNT); }
    catch (e) { errors.push(`${form}: ${e.message}`); continue; }
    seen += list.length;
    const mine = list.filter(r => cikToSym.has(r.cik));
    console.log(`  ${form}: ${list.length} إيداعاً في التيار · ${mine.length} من كوننا`);

    for (const r of mine) {
      const sym = cikToSym.get(r.cik);
      const row = { acc: r.acc, s: sym, form: r.form || form, at: r.at, href: r.href,
                    name: r.name, items: r.items };
      if (r.items && r.items.length) row.w = weightOf(r.items);
      fresh.push(row);
    }
  }

  /* تفصيل Form 4 لرموزنا وحدها: طلبان لكل إيداع، وهي صفرٌ إلى خمسة في
     الدورة. والسقف موجود لأن يوم إعلانِ منحٍ جماعية قد يودع فيه عشرون
     مسؤولاً في ساعة — فلا نستهلك الدورة كلها في مطاردتها. */
  const need = fresh.filter(r => /^4/.test(r.form)).slice(0, MAX_DETAIL);
  let detailed = 0;
  for (const r of need) {
    try {
      const d = await form4Detail(r.href);
      /* الرمز من المستند لا من الخريطة حين يتوفّر: شركةٌ لها أكثر من
         فئة أسهم تودع بـ CIK واحد، والمستند يقول أيَّ فئة. */
      /* `n` و`legs` يُحفظان حين يحمل الإيداع أكثر من عملية أو أكثر من
         رمز: إيداعُ الرئيس التنفيذي لـ CRWD حمل ستّة عشر بلوكاً مجموعُها
         20,000 سهم، وقراءةُ أوّلها كانت تقول 4,400 — رقمٌ صحيح لعمليةٍ
         وخاطئ للإيداع. وحين تكون عمليةً واحدة لا يُحفظ شيء: الملف يُقرأ
         في كل فتحة للأخبار. */
      r.tx = { who: d.who, role: d.role, code: d.code, shares: d.shares,
               price: d.price, date: d.date, sig: !!(TX[d.code] || {}).sig,
               ...(d.n > 1 ? { n: d.n } : {}),
               ...((d.legs || []).length > 1 ? { legs: d.legs } : {}) };
      if (d.sym && ours.has(d.sym)) r.s = d.sym;
      detailed++;
    } catch (e) { errors.push(`تفصيل ${r.s}/${r.acc}: ${e.message}`); }
  }

  /* بوابة السلامة: صفرٌ من التيار كلّه يعني خللاً في الشبكة أو حظراً، لا
     سوقاً هادئة — ففي أهدأ ساعة تودع شركاتٌ أمريكية شيئاً. ولا نكتب فوق
     ما هو سليم. وحصّتُنا من التيار قد تكون صفراً بحقّ (عطلة نهاية أسبوع)
     فلا تُشترط. */
  if (!seen) throw new Error(`لم يصل أي إيداع من التيار — ${errors.join(" | ") || "بلا خطأ مُبلَّغ"}`);

  const prev = readJSON(path.join(OUT, "filings.json"));
  const { rows, added } = merge(prev?.rows, fresh, now);

  // بوابة ثانية: التقلّص المفاجئ يعني خطأ دمجٍ لا تنقيحاً. التنقيح
  // بالعمر يُسقط 30 يوماً فقط، فلا يُنقص أكثر من نصف الملف في تشغيل.
  const before = (prev?.rows || []).length;
  if (before > 20 && rows.length < before * 0.5)
    throw new Error(`تقلّص من ${before} إلى ${rows.length} — لن نكتب`);

  const out = {
    updated: now, count: rows.length,
    note: "إيداعات SEC — المصدر الأوّلي. 8-K حدثٌ جوهري، Form 4 تداول مطّلع.",
    rows
  };
  fs.writeFileSync(path.join(OUT, "filings.json"), JSON.stringify(out));
  const size = fs.statSync(path.join(OUT, "filings.json")).size;

  const sig = rows.filter(r => r.tx && r.tx.sig).length;
  const heavy = rows.filter(r => r.w === 3).length;
  console.log(`✔ ${rows.length} إيداعاً (+${added} جديد · ${detailed} مُفصَّل) · ` +
              `${heavy} بوزن ثقيل · ${sig} شراء مطّلع · ${(size / 1024).toFixed(1)} ك.ب`);
  console.log(`  طلبات: ${secStats.requests} · إخفاقات: ${secStats.failures}`);
  if (errors.length) console.warn(`  ⚠ ${errors.length} خطأ: ${errors.slice(0, 3).join(" | ")}`);

  const metaPath = path.join(OUT, "meta.json");
  const meta = readJSON(metaPath, {});
  fs.writeFileSync(metaPath, JSON.stringify({
    ...meta,
    filingsUpdated: now,
    filingsRun: { at: new Date(now).toISOString(), rows: rows.length, added,
                  detailed, requests: secStats.requests,
                  ...(errors.length ? { errors: errors.slice(0, 5) } : {}) }
  }));
}

/* ---------- الفحص الذاتي ---------- */
function selfCheck() {
  let pass = 0, fail = 0;
  const t = (name, fn) => {
    try { const r = fn(); console.log(`  ✓ ${name}${r ? ` — ${r}` : ""}`); pass++; }
    catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; }
  };
  const eq = (a, b, m) => {
    const A = JSON.stringify(a), B = JSON.stringify(b);
    if (A !== B) throw new Error(`${m}: ${A} ≠ ${B}`);
  };
  console.log("▶ فحص إيداعات SEC (بلا شبكة)\n");

  t("parseAtom يقرأ مدخلة 8-K كاملة", () => {
    const xml = `<feed><entry>
      <title>8-K - Apple Inc. (0000320193) (Filer)</title>
      <summary type="html">&lt;b&gt;Filed:&lt;/b&gt; 2026-09-11 &lt;b&gt;AccNo:&lt;/b&gt; 0001140361-26-035325
        &lt;br&gt;Item 2.02: Results of Operations&lt;br&gt;Item 9.01: Exhibits</summary>
      <updated>2026-09-11T17:29:31-04:00</updated>
      <category scheme="x" label="form type" term="8-K"/>
      <link rel="alternate" href="https://www.sec.gov/Archives/edgar/data/320193/x/y-index.htm"/>
      </entry></feed>`;
    const [r] = parseAtom(xml);
    eq(r.cik, "0000320193", "CIK مصفوف بأصفار");
    eq(r.form, "8-K", "النوع");
    eq(r.acc, "0001140361-26-035325", "رقم القبول");
    eq(r.items, ["2.02", "9.01"], "البنود");
    eq(r.name, "Apple Inc.", "اسم الشركة");
    if (!r.at) throw new Error("الزمن لم يُقرأ");
    return `${r.items.length} بنداً`;
  });

  t("مدخلة بلا رقم قبول تُتخطّى ولا تُسقط الدفعة", () => {
    const xml = `<feed><entry><title>8-K - X (0000000123) (Filer)</title></entry>
      <entry><title>8-K - Y (0000000456) (Filer)</title>
      <summary>AccNo: 0000000456-26-000001</summary></entry></feed>`;
    eq(parseAtom(xml).length, 1, "الناقصة وحدها تسقط");
  });

  t("أهمّية الإيداع أعلى بنوده لا مجموعها", () => {
    // أربعة بنودٍ شكلية لا تتقدّم على بند نتائج واحد
    eq(weightOf(["9.01", "5.03", "5.07", "3.02"]), 1, "الشكلية تبقى 1");
    eq(weightOf(["9.01", "2.02"]), 3, "النتائج ترفعه إلى 3");
    eq(weightOf([]), 1, "بلا بنود");
    eq(weightOf(["4.02"]), 3, "عدم الاعتماد على قوائم سابقة أخطرها");
  });

  t("البنود تُقرأ من نصّ الملخّص بأيّ ترتيب وبلا تكرار", () => {
    eq(itemsOf("Item 5.02: x  Item 2.02: y  Item 5.02: z"), ["5.02", "2.02"], "بلا تكرار");
    eq(itemsOf("لا بنود هنا"), [], "نصّ بلا بنود");
  });

  t("الشراء وحده إشارة — المنح وتنفيذ الخيار ليست تداولاً", () => {
    eq(TX.P.sig, true, "P شراء");
    for (const c of ["S", "A", "M", "F", "G", "C", "X", "D"])
      if (TX[c].sig) throw new Error(`${c} لا يجوز أن يكون إشارة`);
    eq(txLabel("P"), "شراء مباشر", "الوسم");
    eq(txLabel("Z"), "عملية Z", "رمزٌ غير معروف يُقال كما هو لا يُخفى");
  });

  t("الدمج يوحّد برقم القبول ويُبقي الأحدث", () => {
    const now = 2000 * 86400e3;
    const prev = [{ acc: "A", s: "AAPL", at: now - 1000 }];
    const { rows, added } = merge(prev, [{ acc: "A", s: "AAPL", at: now - 1000, w: 3 },
                                         { acc: "B", s: "MSFT", at: now }], now);
    eq(added, 1, "جديدٌ واحد");
    eq(rows.length, 2, "بلا تكرار");
    eq(rows[0].acc, "B", "الأحدث أولاً");
    eq(rows.find(r => r.acc === "A").w, 3, "الحقل الجديد يُدمج فوق القديم");
  });

  t("التنقيح بالعمر يُسقط ما تجاوز 30 يوماً ويُبقي ما بلا زمن", () => {
    const now = 2000 * 86400e3;
    const { rows } = merge([{ acc: "قديم", at: now - 40 * 86400e3 },
                            { acc: "حديث", at: now - 5 * 86400e3 },
                            { acc: "بلا زمن", at: null }], [], now);
    eq(rows.map(r => r.acc).sort(), ["بلا زمن", "حديث"], "القديم وحده يسقط");
  });

  t("وسم البند بالعربية، وبندٌ غير معروف يُقال برقمه", () => {
    eq(itemLabel("2.02"), "نتائج مالية ربعية أو سنوية", "معروف");
    eq(itemLabel("9.99"), "بند 9.99", "غير معروف لا يُخفى");
    // كل بندٍ معرَّف له وسمٌ ووزنٌ في المدى
    for (const [k, v] of Object.entries(ITEMS)) {
      if (!v[0] || typeof v[0] !== "string") throw new Error(`${k} بلا وسم`);
      if (!(v[1] >= 1 && v[1] <= 3)) throw new Error(`${k} وزنه خارج 1..3`);
    }
    return `${Object.keys(ITEMS).length} بنداً`;
  });

  /* هذا الفحص موجود بسبب خللٍ حقيقي: نمطُ وسم الفتح كان يبتلع العنصر
     كاملاً فيُقرأ الحقل من **العملية التالية**. وكان ينجح في المستند ذي
     العملية الواحدة ويسقط في متعدّد العمليات — فمرّ على نصف العيّنة،
     ونجاحُ نصفها أخطر من فشلها كلّها. ولهذا المستند التجريبي هنا
     **متعدّد العمليات بالضرورة**. */
  const F4 = (legs, extra) => `<ownershipDocument>
    <issuer><issuerTradingSymbol>TEST</issuerTradingSymbol></issuer>
    <reportingOwner><reportingOwnerId><rptOwnerName>فلان الفلاني</rptOwnerName></rptOwnerId>
      <reportingOwnerRelationship><isOfficer>1</isOfficer>
        <officerTitle>CFO &amp; Treasurer</officerTitle></reportingOwnerRelationship></reportingOwner>
    ${extra || ""}
    ${legs.map(([code, sh, px, dt]) => `<nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>${dt}</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType>
        <transactionCode>${code}</transactionCode>
        <equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>${sh}</value><footnoteId id="F1"/></transactionShares>
        <transactionPricePerShare><value>${px}</value></transactionPricePerShare>
      </transactionAmounts></nonDerivativeTransaction>`).join("")}
    </ownershipDocument>`;

  t("Form 4 لا يقرأ حقلاً من العملية التالية في مستندٍ متعدّد", () => {
    const d = parseForm4(F4([["P", 1000, 10, "2026-09-01"],
                             ["S", 200, 11, "2026-09-02"],
                             ["F", 50, 12, "2026-09-03"]]));
    eq(d.n, 3, "عدد العمليات");
    eq(d.code, "P", "الرمز صاحبُ أكبر عدد أسهم");
    eq(d.shares, 1000, "أسهم الرمز الغالب");
    eq(d.date, "2026-09-03", "أحدث تاريخ");
    eq(d.sym, "TEST", "رمز المُصدر");
    eq(d.role, "CFO & Treasurer", "المسمّى مفكوك الترميز");
    eq(d.legs.map(l => l.code), ["P", "S", "F"], "الأرجل مرتّبة بالأسهم");
    return "3 عمليات";
  });

  t("الرمز الغالب بالأسهم لا بالترتيب", () => {
    // الحجز الضريبي أوّلاً وشراءٌ كبير بعده: قراءةُ الأولى كانت ستقول «حجز ضريبة»
    const d = parseForm4(F4([["F", 300, 50, "2026-09-01"],
                             ["P", 40000, 51, "2026-09-01"]]));
    eq([d.code, d.shares], ["P", 40000], "الشراء الكبير يغلب");
  });

  t("متوسّط السعر مرجَّحٌ بالأسهم لا بسيط", () => {
    // 100 سهم بـ10 و900 بـ20 -> 19 لا 15
    const d = parseForm4(F4([["S", 100, 10, "2026-09-01"], ["S", 900, 20, "2026-09-01"]]));
    eq(d.shares, 1000, "المجموع");
    eq(Math.round(d.price * 100) / 100, 19, "المرجَّح");
  });

  t("العمليات المشتقّة لا تُعدّ مع الأسهم العادية", () => {
    const deriv = `<derivativeTransaction>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>99999</value></transactionShares>
      </transactionAmounts></derivativeTransaction>`;
    const d = parseForm4(F4([["P", 100, 5, "2026-09-01"]], deriv));
    eq([d.n, d.shares], [1, 100], "العادية وحدها");
  });

  t("مستندٌ بعملية واحدة يعمل كذلك — لا نُصلح الكبير ونكسر الصغير", () => {
    const d = parseForm4(F4([["S", 200000, 28.23, "2026-09-10"]]));
    eq([d.code, d.shares, d.price, d.n], ["S", 200000, 28.23, 1], "الواحدة");
  });

  t("مستندٌ بلا عمليات لا يُسقط القراءة", () => {
    const d = parseForm4(F4([]));
    eq([d.code, d.shares, d.price, d.n], [null, null, null, 0], "فارغٌ بلا استثناء");
    eq(d.sym, "TEST", "بقية الحقول تُقرأ");
  });

  console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل`);
  process.exit(fail ? 1 : 0);
}

if (CHECK) selfCheck();
else main().catch(e => { console.error(`✗ ${e.message}`); process.exit(1); });

