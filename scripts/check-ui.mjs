#!/usr/bin/env node
/* فحص واجهة ساكن: النحو، المعرّفات، التبويبات، والاعتماديات. */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."), DIR = path.join(ROOT, "stocks"), HTML = path.join(DIR, "index.html");
let pass = 0, fail = 0;
const t = (name, fn) => { try { const x = fn(); console.log(`✓ ${name}${x ? " — " + x : ""}`); pass++; } catch (e) { console.log(`✗ ${name} — ${e.message}`); fail++; } };
const html = fs.readFileSync(HTML, "utf8");
const inline = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m => m[1]);
t("الشيفرة المضمّنة تُحلّل", () => { inline.forEach(code => new Function(code)); return `${inline.length} كتلة`; });
const srcs = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map(m => m[1]).filter(x => !/^https?:/.test(x));
const diskSrc = rel => rel.split(/[?#]/, 1)[0];
t("ملفات الشيفرة موجودة وتُحلّل", () => { for (const rel of srcs) { const p = path.join(DIR, diskSrc(rel)); if (!fs.existsSync(p)) throw new Error(`مفقود ${rel}`); new Function(fs.readFileSync(p, "utf8")); } return srcs.join(" · "); });
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(m => m[1]);
t("لا معرّف مكرر", () => { const seen = new Set(), dup = new Set(); for (const id of ids) { if (seen.has(id)) dup.add(id); seen.add(id); } if (dup.size) throw new Error([...dup].join("، ")); return `${ids.length} معرّفاً`; });
const all = inline.join("\n") + srcs.map(x => fs.readFileSync(path.join(DIR, diskSrc(x)), "utf8")).join("\n"), idSet = new Set(ids);
t("كل معرّف منادى موجود", () => { const used = new Set(); for (const m of all.matchAll(/\$\$?\("#([A-Za-z][\w-]*)"/g)) used.add(m[1]); const missing = [...used].filter(x => !idSet.has(x)); if (missing.length) throw new Error(missing.join("، ")); return `${used.size} معرّفاً`; });
t("التبويبات والشاشات متطابقة", () => { const tabs = new Set([...html.matchAll(/data-go="([^"]+)"/g)].map(m => m[1])), views = new Set([...html.matchAll(/data-view="([^"]+)"/g)].map(m => m[1])); views.delete("detail"); const bad = [...tabs].filter(x => !views.has(x)).concat([...views].filter(x => !tabs.has(x))); if (bad.length) throw new Error(bad.join("، ")); return `${tabs.size} تبويباً`; });
t("النواة المشتركة غير منسوخة", () => { for (const fn of ["function planFrom", "function scoreFrom", "const SCANS"]) if (inline.join("\n").includes(fn)) throw new Error(fn); return "plan · scans · evaluate"; });
t("لا اعتماد برمجي خارجي", () => { const ext = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => m[1]).filter(u => !/^https:\/\/fonts\.(googleapis|gstatic)\.com(\/|$)/.test(u) && !/alkongrs2014\.github\.io/.test(u)); if (ext.length) throw new Error(ext.join(" · ")); return "صفر"; });
console.log(`${pass} نجح · ${fail} فشل`); process.exit(fail ? 1 : 0);
