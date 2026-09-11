import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { opportunityQuality } = require("../stocks/evaluate.js");

let passed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`✓ ${name}`); }
  catch (e) { console.error(`✗ ${name}: ${e.message}`); process.exitCode = 1; }
}
function eq(actual, expected) {
  if (actual !== expected) throw new Error(`المتوقع ${expected}، الفعلي ${actual}`);
}

test("التوافق الكامل والخطة القوية يصلان إلى 100", () => {
  const q = opportunityQuality({ score: 80, tfScore: { "15m": 50, "1h": 70, "4h": 80, "1d": 90 }, dir: 1, rr: 3, volRatio: 2 });
  eq(q.value, 100); eq(q.grade, "ممتازة");
});
test("الاتجاه الهابط يطابق الفريمات السالبة", () => {
  const q = opportunityQuality({ score: -80, tfScore: { "15m": -50, "1h": -70, "4h": -80, "1d": -90 }, dir: -1, rr: 3, volRatio: 2 });
  eq(q.parts.alignment, 30);
});
test("البيانات القديمة لا تأخذ نقاط الطزاجة", () => {
  const q = opportunityQuality({ score: 40, tfScore: { "1d": 40 }, dir: 1, rr: 2, stale: true });
  eq(q.parts.fresh, 0);
});
test("الأرباح القريبة تخصم الخطر المعلن", () => {
  const base = { score: 50, tfScore: { "1h": 50, "4h": 50, "1d": 50 }, dir: 1, rr: 2 };
  const a = opportunityQuality(base), b = opportunityQuality({ ...base, earnDays: 3 });
  eq(a.value - b.value, 12);
});
test("الدرجة محصورة بين صفر ومئة", () => {
  const q = opportunityQuality({ score: 999, tfScore: { "1d": 999 }, dir: 1, rr: 99, volRatio: 99 });
  eq(q.value, 100);
});

if (!process.exitCode) console.log(`\n${passed} فحوص نجحت`);
