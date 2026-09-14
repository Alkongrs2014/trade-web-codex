/* عرض موجز لإيداعات SEC. المصدر يُحمّل عند فتح الأخبار فقط. */
(function () {
  "use strict";
  const formLabel = f => f === "8-K" ? "حدث جوهري 8-K" : f === "4" ? "تداول مطّلع Form 4" : f;
  const txText = tx => {
    if (!tx) return "";
    const act = tx.code === "P" ? "شراء" : tx.code === "S" ? "بيع" : tx.code ? `عملية ${tx.code}` : "إفصاح مطّلع";
    const qty = Number.isFinite(tx.shares) ? ` · ${compact(tx.shares, "")} سهم` : "";
    const px = Number.isFinite(tx.price) ? ` بسعر ${money(tx.price)}` : "";
    return `${act}${qty}${px}${tx.who ? ` · ${tx.who}` : ""}`;
  };
  function renderFilings() {
    const el = document.getElementById("filingsList"); if (!el) return;
    const rows = (state.filings && state.filings.rows) || [];
    if (!rows.length) { el.innerHTML = `<div class="empty">لا إيداعات حديثة في الملف الحالي.</div>`; return; }
    const score = r => (r.form === "8-K" ? 4 : 0) + (r.tx && r.tx.sig ? 3 : 0) + (r.form === "4" ? 1 : 0);
    const picked = rows.slice().sort((a,b) => score(b) - score(a) || (b.at || 0) - (a.at || 0)).slice(0, 18);
    el.innerHTML = picked.map(r => `<a class="news-item" href="${esc(r.href)}" target="_blank" rel="noopener noreferrer">
      <div class="news-t rtl"><b class="num">${esc(r.s || "—")}</b> · ${esc(formLabel(r.form))}${r.items && r.items.length ? ` — البنود ${r.items.map(esc).join("، ")}` : ""}</div>
      ${r.tx ? `<div class="news-o rtl">${esc(txText(r.tx))}${r.tx.role ? ` · ${esc(r.tx.role)}` : ""}</div>` : ""}
      <div class="news-m"><span class="tag-official">SEC رسمي</span>${r.w >= 2 ? `<span class="tag-important">أثر محتمل</span>` : ""}<span>${esc(ago(r.at))}</span></div>
    </a>`).join("") + `<p class="srcline">${rows.length} إيداعاً محفوظاً خلال 30 يوماً · آخر تحديث ${esc(ago(state.filings.updated))}. ظهور الإيداع لا يحدد اتجاه السعر.</p>`;
  }
  function loadFilings() { lazyFile("filings", "filings.json", renderFilings, () => { const el=document.getElementById("filingsList"); if(el) el.innerHTML=`<div class="empty">تعذّر جلب إيداعات SEC الآن.</div>`; }); }
  const tab = document.querySelector('[data-go="news"]');
  if (tab) tab.addEventListener("click", loadFilings);
  window.renderFilings = renderFilings;
})();
