#!/usr/bin/env node
/* =====================================================================
   فحص الواجهة — بلا شبكة وبلا متصفح.

   لماذا: خطأٌ نحوي واحد في `index.html` يُسقط **كل** الشيفرة، فتُعرض
   صفحةٌ ساكنة بلا أي رسالة في الشاشة. وقع ذلك فعلاً بعلامة اقتباس
   مفتوحة بمفردة ومغلقة بمزدوجة، وبتسلسل `\n` صار سطراً حقيقياً داخل
   تعبيرٍ نمطي. كلاهما يُكتشف في ثانية هنا، وفي دقائق بالمتصفح.

   ويفحص أيضاً ما لا يُخطئ فيه المحلّل النحوي: معرّفٌ يُنادى من الشيفرة
   ولا وجود له في الهيكل يعيد `null` بصمت، فتتوقّف بطاقةٌ عن الرسم بلا
   استثناء ظاهر.

     node scripts/check-ui.mjs
   ===================================================================== */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIR = path.join(ROOT, "stocks");
const HTML = path.join(DIR, "index.html");

let pass = 0, fail = 0;
const t = (name, fn) => {
  try { const extra = fn(); console.log(`  ✓ ${name}${extra ? " — " + extra : ""}`); pass++; }
  catch (e) { console.log(`  ✗ ${name} — ${e.message}`); fail++; }
};

console.log("▶ فحص الواجهة (بلا شبكة)\n");
const html = fs.readFileSync(HTML, "utf8");

/* ---------- ١ الشيفرة المضمّنة تُحلَّل ---------- */
const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
t("الشيفرة المضمّنة في index.html تُحلَّل", () => {
  inline.forEach((code, i) => {
    try { new Function(code); }
    catch (e) {
      // نحدّد السطر بالضمّ التصاعدي: رسالة المحرّك لا تحمل موضعاً مفيداً
      const L = code.split("\n");
      let at = 0;
      for (let n = 1; n <= L.length; n++) {
        try { new Function(L.slice(0, n).join("\n") + "\n}"); }
        catch (e2) { if (/Invalid or unexpected|Unexpected|Invalid regular/.test(e2.message)) { at = n; break; } }
      }
      throw new Error(`كتلة ${i + 1}: ${e.message}` + (at ? ` (نحو السطر ${at}: ${L[at - 1].trim().slice(0, 70)})` : ""));
    }
  });
  return `${inline.length} كتلة`;
});

/* ---------- ٢ الملفات الخارجية موجودة وتُحلَّل ---------- */
const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => m[1])
  .filter(u => !/^https?:/.test(u));
t("ملفات الشيفرة المرفقة موجودة وتُحلَّل", () => {
  for (const rel of srcs) {
    const p = path.join(DIR, rel.split(/[?#]/)[0]);
    if (!fs.existsSync(p)) throw new Error(`مفقود: ${rel}`);
    try { new Function(fs.readFileSync(p, "utf8")); }
    catch (e) { throw new Error(`${rel}: ${e.message}`); }
  }
  return srcs.join(" · ");
});

/* ---------- ٣ لا معرّف مكرّر ---------- */
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
t("لا معرّف مكرّر في الهيكل", () => {
  const seen = new Set(), dup = new Set();
  for (const i of ids) { if (seen.has(i)) dup.add(i); seen.add(i); }
  if (dup.size) throw new Error([...dup].join("، "));
  return `${ids.length} معرّفاً`;
});

/* ---------- ٤ كل معرّف تناديه الشيفرة موجود ---------- */
/* المعرّفات المبنيّة وقت التشغيل (داخل innerHTML) تُستثنى: البحث على
   نصٍّ حرفي `$("#x")` وحده، وهو ما يُكتب للعناصر الثابتة. */
const all = inline.join("\n") + "\n" + srcs.map(r => fs.readFileSync(path.join(DIR, r.split(/[?#]/)[0]), "utf8")).join("\n");
const idSet = new Set(ids);
t("كل معرّف تناديه الشيفرة موجود في الهيكل", () => {
  const used = new Set();
  for (const m of all.matchAll(/\$\$?\("#([A-Za-z][\w-]*)"/g)) used.add(m[1]);
  const missing = [...used].filter(x => !idSet.has(x));
  if (missing.length) throw new Error("غير موجود: " + missing.join("، "));
  return `${used.size} معرّفاً منادى`;
});

/* ---------- ٥ التبويبات والشاشات متطابقة ---------- */
t("كل تبويب له شاشة وكل شاشة لها تبويب", () => {
  const tabs = new Set([...html.matchAll(/data-go="([^"]+)"/g)].map(m => m[1]));
  const views = new Set([...html.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]));
  views.delete("detail");                    // شاشة السهم تُفتح بالنقر لا بتبويب
  const noView = [...tabs].filter(x => !views.has(x));
  const noTab = [...views].filter(x => !tabs.has(x));
  if (noView.length) throw new Error("تبويب بلا شاشة: " + noView.join("، "));
  if (noTab.length) throw new Error("شاشة بلا تبويب: " + noTab.join("، "));
  return `${tabs.size} تبويباً`;
});

/* ---------- ٦ النواة المشتركة لا تتكرّر ---------- */
/* `plan.js` و`scans.js` و`evaluate.js` يقرأها المتصفح والخادم معاً،
   فنسخةٌ ثانية منها داخل index.html تتباعد بأول تعديل. */
t("النواة المشتركة ليست منسوخة داخل index.html", () => {
  const src = inline.join("\n"), dup = [];
  for (const fn of ["function planFrom", "function scoreFrom", "const SCANS",
                    "function overallScore", "function labelOf", "function bandOf"])
    if (src.includes(fn)) dup.push(fn);
  // بصمةُ الشيفرة لا اسمُها: نسخةُ النتيجة القديمة كانت مضمَّنةً **بلا
  // اسم** داخل `analyze`، فمرّت من هذا الفحص وهو يبحث عن الاسم وحده.
  if (/max \+= w; sc \+=/.test(src) || /add\(px > E200/.test(src))
    dup.push("منطق بوابات النتيجة");
  if (src.includes("اتجاه صاعد قوي")) dup.push("أوسمة النطاقات");
  if (/TF_WEIGHT\s*=/.test(src)) dup.push("TF_WEIGHT");
  // المؤشّرات كذلك: كانت مضمَّنةً هنا ومتطابقةً مع الخادم بالحظّ
  for (const fn of ["function ema(", "function rsi(", "function macd(",
                    "function bb(", "function atrCalc(", "function analyze(",
                    "function adx("])
    if (src.includes(fn)) dup.push(fn.replace("function ", "").replace("(", ""));
  if (dup.length) throw new Error("معرَّفة مرتين: " + dup.join("، "));
  return "score.js · indicators.js · plan.js · scans.js · evaluate.js";
});

/* ---------- ٦ب عامل الخدمة يعرف كل سكربت ---------- */
/* قائمة `CORE` في `sw.js` هي ما يُخزَّن للعمل بلا شبكة. ملفٌ جديد في
   `index.html` ولا في القائمة يعمل على الشبكة ويسقط بدونها — بصمت. */
t("عامل الخدمة يخزّن كل سكربت في الصفحة", () => {
  const sw = fs.readFileSync(path.join(DIR, "sw.js"), "utf8");
  const core = [...sw.matchAll(/"\.\/([^"]+)"/g)].map(m => m[1]);
  const miss = srcs.map(f => f.split(/[?#]/)[0]).filter(f => !core.includes(f));
  if (miss.length) throw new Error("غائب عن CORE في sw.js: " + miss.join("، "));
  // ورفعُ النسخة شرطٌ لظهور أيّ تغيير في الزيارة الأولى
  if (!/const V = "webtrade-v\d+"/.test(sw)) throw new Error("نسخة الذاكرة غير مقروءة");
  return `${core.length} مدخلاً · ${srcs.length} سكربتاً`;
});

/* ---------- ٦ج لا تعارض أسماء بين الصفحة والملفات المشتركة ---------- */
/* السكربتات الكلاسيكية تتشارك نطاقاً واحداً، فاسمٌ واحد في ملفين يعني
   أن الأخيرَ تحميلاً يغلب — **بلا أيّ خطأ**. وقع فعلاً: `pctRank` في
   `indicators.js` بدلالة ‎(series, win)‎ وفي `index.html` بدلالة
   ‎(sorted, v)‎، فصار `analyze` يحسب انضغاط بولنجر بدالّة الأساسيات. */
t("لا تعارض أسماء بين index.html والملفات المشتركة", () => {
  const decl = (src) => new Set([...src.matchAll(/^(?:function|const|let|var)\s+([A-Za-z_$][\w$]*)/gm)]
    .map(m => m[1]));
  const inlineNames = decl(inline.join("\n"));
  const clash = [];
  for (const f of srcs) {
    if (f === "config.js") continue;            // إعدادات لا منطق
    for (const n of decl(fs.readFileSync(path.join(DIR, f.split(/[?#]/)[0]), "utf8")))
      if (inlineNames.has(n)) clash.push(`${n} (${f})`);
  }
  if (clash.length) throw new Error("اسمٌ معرَّف مرتين: " + clash.join("، "));

  /* =====================================================================
     والملفات المشتركة فيما بينها كذلك — وهذه هي الثغرة التي كشفها
     `volX` فعلياً.

     كان الفحص يقارن الصفحة بكل ملف ولا يقارن الملفات ببعضها، فمرّ اسمٌ
     معرَّف في `scans.js` و`strategies.js` معاً: كلاهما `<script>`
     كلاسيكي في نطاقٍ واحد، فالأخير تحميلاً يغلب. وهنا لم يغلب بصمت بل
     رمى `Identifier 'volX' has already been declared` فأسقط **كل**
     الشيفرة — صفحةٌ ساكنة بلا رسالة، وهو ما يحدث حين يتعارض `const`
     مع `const`. ولو كان أحدهما `var` لمرّ بلا خطأ وبقيت الدالّة
     الخاطئة تعمل — وهي مصيدة `pctRank` الموثّقة بالحرف.
     ===================================================================== */
  const files = srcs.map(f => f.split(/[?#]/)[0]).filter(f => f !== "config.js");
  const names = {};
  for (const f of files) names[f] = decl(fs.readFileSync(path.join(DIR, f), "utf8"));
  const cross = [];
  for (let i = 0; i < files.length; i++)
    for (let j = i + 1; j < files.length; j++)
      for (const n of names[files[i]])
        if (names[files[j]].has(n)) cross.push(`${n} (${files[i]} ↔ ${files[j]})`);
  if (cross.length) throw new Error("اسمٌ معرَّف في ملفّين مشتركين: " + cross.join("، "));

  const total = files.reduce((a, f) => a + names[f].size, 0);
  return `${srcs.length} ملفاً · ${inlineNames.size} اسماً في الصفحة · ${total} في الملفات المشتركة`;
});

/* ---------- ٧ لا مسار خارجي غير الخطوط ---------- */
t("لا اعتماد خارجي غير خطوط جوجل", () => {
  const ext = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1])
    // روابط `preconnect` بلا مسار، فالشرطة الأخيرة لا تلزم
    .filter(u => !/^https:\/\/fonts\.(googleapis|gstatic)\.com(\/|$)/.test(u))
    // العنوان القانوني metadata يصف الصفحة ولا يُحمّل اعتماداً منها.
    .filter(u => !/^https:\/\/alkongrs2014\.github\.io\/trade-web-codex\//.test(u));
  if (ext.length) throw new Error(ext.join(" · "));
  return "الخطوط وحدها";
});

/* ---------- ١١ قائمة منع النشر لا تحجب ملفاً تقرؤه الواجهة ----------
   `publish()` يستبعد حالةَ الخادم من الدفعة. والخطر أن يُستبعَد يوماً ملفٌ
   **تقرؤه** الواجهة: لا خطأ في أي فحص، ولا شيء محلياً — والموقع المنشور
   وحده يرى 404 فيسقط قسمٌ كامل بصمت. فالقائمتان تُقابلان هنا. */
t("لا ملف تنشره الواجهةُ وهو ممنوع من النشر", () => {
  const run = fs.readFileSync(path.join(ROOT, "local", "run.mjs"), "utf8");
  const m = run.match(/NO_PUBLISH\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) throw new Error("لم أجد NO_PUBLISH في local/run.mjs");
  const denied = [...m[1].matchAll(/"([^"]+)"/g)].map(x => x[1]);
  if (!denied.length) throw new Error("قائمة المنع فارغة");

  // ما تطلبه الواجهة فعلاً: الصفحة وعامل الخدمة معاً
  const sw = fs.readFileSync(path.join(DIR, "sw.js"), "utf8");
  const wanted = new Set([...(html + sw).matchAll(/([A-Za-z0-9_-]+\.json)/g)].map(x => x[1]));
  const clash = denied.filter(d => wanted.has(d));
  if (clash.length) throw new Error(`ممنوعٌ من النشر وتقرؤه الواجهة: ${clash.join(" · ")}`);
  return `${denied.length} ممنوعاً · ${wanted.size} ملفاً تطلبه الواجهة`;
});

/* =====================================================================
   `conv` يُفحص بالصدق لا بمساواة قيمةٍ بعينها.

   الحقل يوسم سجلاً لا يصف ما يُعرض اليوم، وقيمُه تتكاثر: كانت `"long"`
   وحدها، ثم `"dir"` (سجلٌّ بُني بسياسة اتجاهٍ سابقة) ثم `"gone"` (شرطٌ
   أُزيل من `SCANS`). وكلُّ فحصٍ يسأل «هل يساوي long؟» يمرّر الجديدتين
   **بلا خطأ ولا أثر ظاهر** — يظهر رقمٌ في إحصاء السجل لا يصف شيئاً
   يُعرض. قِيس قبل الإصلاح: 24 من 37 صفقة مغلقة محسوبة كانت مُحوَّلة.

   وهي نفس عائلة «الصفر صالح فالفحص بـ`null` لا بالصدق» و«`undefined`
   تعني ‎+1‎ فلا تُفحص بالصدق»: حقلٌ مجموعةُ قيمه مفتوحة لا يُفحص بواحدةٍ
   منها. فيُمنع النمط عند جذره بدل انتظار القيمة الرابعة.
   ===================================================================== */
t("`conv` لا يُفحص بمساواة قيمةٍ نصّية", () => {
  const files = ["index.html", "scans.js", "plan.js", "evaluate.js"]
    .map(f => [f, path.join(DIR, f)])
    .concat([["track-signals.mjs", path.join(ROOT, "scripts", "track-signals.mjs")]])
    .filter(([, f]) => fs.existsSync(f));
  const bad = [];
  for (const [name, f] of files) {
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;      // تعليقٌ يشرح المصيدة ليس وقوعاً فيها
      // الإسناد (`conv = "dir"`) مشروع؛ المقارنة وحدها هي الممنوعة
      if (/\.conv\s*[!=]==\s*["'`]/.test(line)) bad.push(`${name}:${i + 1}`);
    });
  }
  if (bad.length) throw new Error(`مقارنةٌ بقيمة نصّية: ${bad.join(" · ")}`);
  return `${files.length} ملفاً`;
});

/* =====================================================================
   اتجاه الخطة المفروض لا يناقض اتجاه الشرط ولا وسمَه.

   `planDir` يفرض اتجاه الخطة و`dir` يعلن اتجاه الشرط، وتناقضُهما يعني
   خطةَ بيعٍ تحت وسمٍ فيه ‎▲‎ — وهو الخلل الذي بُني الحارس له أصلاً.
   ويُفحص **الوسم** لا الحقل وحده: الوسم هو ما يقرؤه المستخدم، وحقلان
   متّسقان تحت وسمٍ مناقض لهما يعطيان نفس الشاشة المتناقضة.
   ===================================================================== */
t("`planDir` لا يناقض اتجاه الشرط ولا وسمَه", () => {
  const { SCANS } = createRequire(import.meta.url)(path.join(DIR, "scans.js"));
  const bad = [];
  for (const sc of SCANS) {
    if (sc.planDir !== 1 && sc.planDir !== -1) continue;
    const sd = sc.dir === -1 ? -1 : 1;       // غياب `dir` يعني ‎+1‎
    if (sc.planDir !== sd) bad.push(`${sc.id}: planDir=${sc.planDir} وdir=${sd}`);
    if (sc.planDir === 1 && /▼/.test(sc.lbl)) bad.push(`${sc.id}: يُفرض شراءً ووسمُه ▼`);
    if (sc.planDir === -1 && /▲/.test(sc.lbl)) bad.push(`${sc.id}: يُفرض بيعاً ووسمُه ▲`);
  }
  if (bad.length) throw new Error(bad.join(" · "));
  return `${SCANS.filter(x => x.planDir === 1 || x.planDir === -1).length} شرطاً يفرض اتجاه خطته من ${SCANS.length}`;
});


console.log(`\n${fail ? "✗" : "✔"} ${pass} نجح · ${fail} فشل`);
process.exit(fail ? 1 : 0);
