/* =====================================================================
   إيداعات هيئة الأوراق والبورصات الأمريكية (SEC / EDGAR).

   لماذا هذا المصدر بالذات: كل ما نجلبه غيرُه **ثانوي**. خلاصات RSS تنقل
   ما كتبه صحافيٌّ عن حدث، وEDGAR هو الحدث نفسه — الشركة مُلزَمة قانوناً
   بإيداع نموذج ‎8-K‎ خلال أربعة أيام عمل من أيّ حدثٍ جوهري، وأغلبها
   يُودَع في ساعاته. قياسٌ فعلي على خلاصاتنا الحالية (2026-09-13): أحدث
   خبرٍ عمره 133 دقيقة والوسيط 28 ساعة. والإيداع يظهر في EDGAR لحظة
   قبوله.

   ولا مفتاح ولا حصّة ولا تسجيل. الشرط الوحيد ترويسة `User-Agent` تعرّف
   بالمستهلك — وهي **نفس درس مكتب إحصاءات العمل** الموثّق في `CLAUDE.md`:
   هذه الجهات لا تحجب الآلات، بل تحجب الطلب الذي لا يقول من هو. وحدّها
   عشرة طلبات في الثانية، وهو أوسع بمراتب من حاجتنا.
   ===================================================================== */

const UA = "webtrade-monitor/1.0 (ahmeed.xs64@gmail.com)";
const BASE = "https://www.sec.gov";

export const secStats = { requests: 0, failures: 0 };

/* =====================================================================
   الحدّ الأدنى بين الطلبات.

   حدّ SEC عشرة في الثانية، ونبتعد عنه إلى خمسة: الحدّ المعلن ليس هدفاً
   يُلامَس، والاقترابُ منه يجعل أيّ تقلّبٍ في زمن الشبكة يدفعنا فوقه.
   وتكلفةُ ذلك حظرُ عنوان — لا 429 عابرة.
   ===================================================================== */
const GAP = 200;
let lastAt = 0;
async function gate() {
  const wait = GAP - (Date.now() - lastAt);
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  lastAt = Date.now();
}

async function get(url, { json = false } = {}) {
  await gate();
  secStats.requests++;
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Accept-Encoding": "gzip, deflate",
      // لا `Referer` ولا `Origin`: درسٌ موثّق — إرسالهما من الخادم يجعل
      // الطلب يبدو تجاوزاً لـ CORS فيزيد الرفض لا يقلّه
      "Accept": json ? "application/json" : "application/atom+xml, application/xml, text/xml"
    }
  });
  if (!r.ok) { secStats.failures++; throw new Error(`HTTP ${r.status} — ${url.slice(0, 80)}`); }
  return json ? r.json() : r.text();
}

/* =====================================================================
   خريطة الرمز إلى CIK.

   EDGAR لا يعرف الرموز بل أرقام CIK، والملف الرسمي 10426 شركة ‎(~600 ك.ب)‎
   يتغيّر بوتيرة الإدراجات والحذف — فيُخزَّن ويُجدَّد أسبوعياً لا في كل
   تشغيل. تغطيتُه لطبقتنا الأساسية: 89 من 90 (الناقص `MMC`، وهو الرمز
   الذي لا يعطي ياهو له بيانات أصلاً — اتّفاقٌ يرجّح أن العلّة في الرمز).
   ===================================================================== */
export const MAP_TTL = 7 * 86400e3;

export async function tickerMap() {
  const j = await get(`${BASE}/files/company_tickers.json`, { json: true });
  const out = {};
  for (const x of Object.values(j)) {
    if (!x || !x.ticker || !x.cik_str) continue;
    // CIK بعشر خانات مصفوفةً بأصفار: هكذا تطلبه مسارات EDGAR، والرقم
    // الخام يعيد 404 بلا أي رسالة تشرح
    out[x.ticker] = String(x.cik_str).padStart(10, "0");
  }
  return out;
}

/* =====================================================================
   تيار الإيداعات الأحدث — `getcurrent` لا خلاصةٌ لكل شركة.

   الخلاصة لكل شركة 18.6 ك.ب، فتسعٌ وثمانون شركة = **1.65 ميغابايت** في
   كل دورة، وأغلب الطلبات تعود بلا جديد. أما `getcurrent` فطلبٌ واحد
   بـ74 ك.ب يحمل أحدث مئة إيداع في السوق كلّه، ونرشّحها على كوننا.

   والمئة تكفي بهامشٍ واسع: قياسٌ فعلي على آخر يوم عملٍ أظهر أن مئة
   إيداع ‎8-K‎ تغطّي **ساعتين و43 دقيقة** ومئة ‎Form 4‎ تغطّي ثلاث ساعات
   — أي ستّة عشر ضعفَ دورتنا. ولو تضاعف المعدّل عشر مرات لبقي هامش.
   ===================================================================== */
export async function currentFilings(type, count = 100) {
  const url = `${BASE}/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(type)}`
            + `&company=&dateb=&owner=include&count=${count}&output=atom`;
  return parseAtom(await get(url));
}

/* محلّل Atom بالتعبيرات النمطية لا بمحلّل XML: البنية ثابتة ومعروفة،
   وإدخالُ محلّلٍ كامل يخالف قاعدة «بلا مكتبات خارجية». وكلُّ حقلٍ
   اختياري: إيداعٌ ناقص حقلاً يُتخطّى ولا يُسقط الدفعة. */
export function parseAtom(xml) {
  const out = [];
  for (const chunk of String(xml).split("<entry>").slice(1)) {
    const e = chunk.split("</entry>")[0];
    const one = (re) => { const m = e.match(re); return m ? m[1].trim() : null; };
    const title = decode(one(/<title>([\s\S]*?)<\/title>/) || "");
    // العنوان بصيغة: "8-K - Apple Inc. (0000320193) (Filer)"
    const cik = one(/\((\d{6,10})\)/);
    const form = one(/term="([^"]+)"/) || (title.split(" - ")[0] || "").trim();
    const name = (title.match(/ - (.+?) \(\d{6,10}\)/) || [])[1] || null;
    const href = decode(one(/<filing-href>([^<]+)<\/filing-href>/)
                     || one(/href="([^"]+)"/) || "");
    const summary = decode(one(/<summary[^>]*>([\s\S]*?)<\/summary>/) || "");
    /* الملخّص يُفكّ ترميزه **وتُزال وسومه** قبل هذا السطر، فالبحث عن
       `AccNo:</b>` لا يجد شيئاً — وقع ذلك في أول فحص. نطابق على النصّ
       المجرَّد، ثم على الرابط، ثم على رقم القبول الصريح إن وُجد. */
    const acc = one(/<accession-number>([^<]+)<\/accession-number>/)
             || (summary.match(/AccNo:\s*(\d{10}-\d{2}-\d{6})/) || [])[1]
             || (href.match(/(\d{10}-\d{2}-\d{6})/) || [])[1];
    const at = one(/<updated>([^<]+)<\/updated>/);
    if (!cik || !acc) continue;
    out.push({
      cik: String(+cik).padStart(10, "0"),
      name, form, acc, href,
      at: at ? Date.parse(at) : null,
      items: itemsOf(summary)
    });
  }
  return out;
}

const decode = (s) => s
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'").replace(/&amp;/g, "&")
  .replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

/* أرقام البنود من ملخّص الإيداع. البند هو ما يجعل ‎8-K‎ مفيداً: إيداعٌ
   ببند ‎2.02‎ نتائجُ ربع، وببند ‎5.02‎ تغييرُ إدارة، وببند ‎9.01‎ مرفقاتٌ
   لا حدثَ فيها — وعرضُها كلّها بوسمٍ واحد «إيداع جديد» يضيّع المعلومة. */
export function itemsOf(summary) {
  const set = new Set();
  for (const m of String(summary).matchAll(/Item\s+(\d+\.\d+)/g)) set.add(m[1]);
  return [...set];
}

/* =====================================================================
   تفصيل Form 4 — من اشترى وكم وبأيّ سعر.

   هنا تكون الإفادة حقيقية: «أودع مطّلعٌ نموذجاً» لا تفيد، أمّا «الرئيس
   التنفيذي اشترى 40 ألف سهم بسعر السوق» فتفيد. والشراء وحده هو ما يُقرأ
   إشارةً: البيع له عشرة أسباب مشروعة (ضرائب الاستحقاق، تنويع، خطّة
   ‎10b5-1‎ مبرمجة قبل شهور) والشراء له سببٌ واحد.

   والتفصيل يحتاج طلبين لكل إيداع (فهرس المجلّد ثم المستند)، فلا يُطلب
   إلا لرموز كوننا — وهي صفرٌ إلى خمسة في الدورة الواحدة.

   ---------------------------------------------------------------------
   لماذا **كل** العمليات لا أوّلها:

   الإيداع الواحد قد يحمل عشرات العمليات. إيداعُ الرئيس التنفيذي لـ CRWD
   حمل **ستّة عشر** بلوكاً في مستندٍ من 35 ألف حرف. وقراءةُ الأولى وحدها
   تجعل الوسم عرضةً للصدفة: إيداعٌ فيه شراءُ 40 ألف سهم وحجزُ 300 سهم
   لضريبةٍ يُقرأ «حجز ضريبة» إن كان الحجز أوّلاً.

   فتُقرأ العمليات كلّها، ويُجمَع لكل رمزِ عمليةٍ عددُ أسهمه ومتوسّطُ
   سعره **مرجَّحاً بالأسهم**، ويكون رمزُ الإيداع هو صاحبُ أكبر عدد أسهم.
   والمتوسّط البسيط كان سيعطي عمليةً من عشرة أسهم وزنَ عمليةٍ من مليون.
   ===================================================================== */
export async function form4Detail(href) {
  const dir = href.replace(/\/[^/]+$/, "");
  const idx = await get(`${dir}/index.json`, { json: true });
  const items = (idx?.directory?.item || []).map(x => x.name);
  // `R\d+.xml` ملفاتُ عرضٍ مولَّدة لا المستند الأصلي
  const doc = items.find(n => /\.xml$/i.test(n) && !/^R\d+\.xml$/i.test(n));
  if (!doc) throw new Error("لا مستند XML في المجلّد");
  const xml = await get(`${dir}/${doc}`);
  return parseForm4(xml);
}

/* =====================================================================
   قراءةُ عنصرٍ واحد — والمصيدة التي كلّفت تشخيصاً.

   النمط الأوّل كان ‎`<tag(?:[ >][^>]*)?>`‎ ليقبل الوسم بسماته. و`[^>]*`
   بعد `[ >]` **تبتلع العنصر كاملاً**: عند `<transactionCode>S</transactionCode>`
   يطابق `[ >]` قوسَ الإغلاق، ثم `[^>]*` تمتدّ على `S</transactionCode`،
   ثم يطابق `>` قوسَ الإغلاق الثاني — فيصير «وسم الفتح» هو العنصر كلّه،
   ويبحث ما بعده عن `</transactionCode>` **التالي** في العملية التالية.

   وهذا الخطأ **لا يظهر في مستندٍ فيه عملية واحدة**: لا يوجد إغلاقٌ ثانٍ
   فيفشل المسار الطامع ويرتدّ المحلّل إلى المطابقة الصحيحة. فمرّ على
   إيداعَين من أربعة (‎4715‎ و‎3391‎ حرفاً) وسقط في الاثنين الكبيرين
   (‎35486‎ و‎6829‎) — ونجاحُ نصف العيّنة أخطر من فشلها كلّها.

   والحلّ أن السمات تلزمها **مسافة** قبلها: `(?:\s[^>]*)?`. فعند
   `<transactionCode>` لا مسافة فتُهمَل المجموعة ويُطابق `>` مباشرةً،
   وعند `<transactionCoding>` لا مسافة ولا قوس إغلاق فلا مطابقة أصلاً.
   ===================================================================== */
const TAG_OPEN = (tag) => "<" + tag + "(?:\\s[^>]*)?>";

const innerAll = (xml, tag) => {
  const re = new RegExp(TAG_OPEN(tag) + "([\\s\\S]*?)</" + tag + ">", "g");
  return [...String(xml).matchAll(re)].map(m => m[1]);
};
const innerOne = (xml, tag) => {
  const a = innerAll(xml, tag);
  return a.length ? a[0] : null;
};

/* بعض الحقول ملفوفةٌ بـ`<value>` (وبجانبها `<footnoteId>` أحياناً)
   وبعضها نصٌّ مباشر. فنقرأ العنصر ثم نأخذ `<value>` إن وُجد وإلا نصَّه. */
function fieldOf(xml, tag) {
  const body = innerOne(xml, tag);
  if (body === null) return null;
  const v = body.match(/<value>([^<]*)<\/value>/);
  const out = decode(v ? v[1] : body.replace(/<[^>]+>/g, " "));
  return out === "" ? null : out;
}

const numOf = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

export function parseForm4(xml) {
  const text = String(xml);
  const one = (re) => { const m = text.match(re); return m ? decode(m[1]) : null; };

  const titles = [...text.matchAll(/<officerTitle>([^<]*)</g)].map(m => decode(m[1])).filter(Boolean);
  const flag = (tag) => new RegExp(TAG_OPEN(tag) + "\\s*(?:1|true)\\s*</" + tag + ">", "i").test(text);
  const isDir = flag("isDirector"), isOff = flag("isOfficer"), isTen = flag("isTenPercentOwner");

  /* العمليات غير المشتقّة وحدها: المشتقّة خياراتٌ ووحداتٌ مقيّدة، وعدُّ
     أسهمها مع الأسهم العادية يخلط أداتين — وحدةٌ مقيّدة لم تُستحقّ بعد
     ليست سهماً مملوكاً. */
  const blocks = innerAll(text, "nonDerivativeTransaction");
  const byCode = new Map();
  let n = 0, lastDate = null;
  for (const b of blocks) {
    const code = fieldOf(b, "transactionCode");
    const sh = numOf(fieldOf(b, "transactionShares"));
    const px = numOf(fieldOf(b, "transactionPricePerShare"));
    const dt = fieldOf(b, "transactionDate");
    if (!code) continue;
    n++;
    if (dt && (!lastDate || dt > lastDate)) lastDate = dt;
    const e = byCode.get(code) || { shares: 0, notional: 0, priced: 0, n: 0 };
    e.n++;
    if (Number.isFinite(sh)) {
      e.shares += sh;
      // السعر مرجَّحٌ بالأسهم: المتوسّط البسيط يعطي عمليةً من عشرة أسهم
      // وزنَ عمليةٍ من مليون
      if (Number.isFinite(px)) { e.notional += sh * px; e.priced += sh; }
    }
    byCode.set(code, e);
  }

  // رمز الإيداع صاحبُ أكبر عدد أسهم، وعند التساوي أكبر عددِ عمليات
  let code = null, best = null;
  for (const [c, e] of byCode) {
    if (!best || e.shares > best.shares || (e.shares === best.shares && e.n > best.n)) { code = c; best = e; }
  }

  const legs = [...byCode.entries()].map(([c, e]) => ({
    code: c, n: e.n, shares: e.shares || null,
    price: e.priced > 0 ? e.notional / e.priced : null
  })).sort((a, b) => (b.shares || 0) - (a.shares || 0));

  return {
    sym: one(/<issuerTradingSymbol>([^<]+)</),
    who: one(/<rptOwnerName>([^<]+)</),
    role: titles[0] || (isDir ? "عضو مجلس" : isTen ? "مالك فوق 10%" : isOff ? "مسؤول تنفيذي" : null),
    code,                                    // P شراء · S بيع · A منحة · M تنفيذ خيار · F حجز ضريبة
    shares: best ? (best.shares || null) : null,
    price: best && best.priced > 0 ? best.notional / best.priced : null,
    date: lastDate,
    n,                                       // عدد العمليات في الإيداع
    legs                                     // التفصيل حين تكون أكثر من رمز
  };
}

