"use strict";
/* مختبر القرار: يجمع ملفات مستقلة عند فتحه، فلا يجعل ميزاته الثقيلة شرطاً
   لظهور الصفحة الأساسية. */
(() => {
  const PKEY = "pro_portfolio_v1", TKEY = "pro_trial_started";
  let loading = null;
  const q = s => document.querySelector(s);
  const latin = n => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: 2 });
  const cls = n => n > 0 ? "pro-up" : n < 0 ? "pro-dn" : "";
  const signed = n => Number.isFinite(n) ? `${n > 0 ? "+" : ""}${latin(n)}%` : "—";
  const rows = () => [...((state.summary || {}).rows || []), ...((state.wide || {}).rows || [])];
  const bySym = () => new Map(rows().map(x => [String(x.s).toUpperCase(), x]));

  function trial() {
    let started = Number(localStorage.getItem(TKEY));
    if (!started) { started = Date.now(); localStorage.setItem(TKEY, String(started)); }
    const day = Math.max(1, Math.min(7, Math.floor((Date.now() - started) / 864e5) + 1));
    const el = q("#proTrialDay"); if (el) el.textContent = day;
    const ring = q(".trial-ring"); if (ring) ring.style.background = `conic-gradient(var(--glow) 0 ${day / 7 * 100}%,rgba(255,255,255,.08) ${day / 7 * 100}%)`;
  }

  function renderProof() {
    const el = q("#proProof"); if (!el) return;
    const arch = state.arch || {}, an = state.analytics || {}, op = state.opts || {};
    const bars = arch.bars || 0, signals = (state.signals?.records || []).length;
    el.innerHTML = [
      [latin(bars), "مشاهدة تاريخية", "كل شرط مقابل خط أساسه"],
      [latin(an.n || 0), "رمزًا بقوة نسبية", "1 و3 و6 أشهر"],
      [latin(op.count || 0), "رمزًا في سوق العقود", "سيولة وتسعير معلنان"],
      [latin(signals), "إشارة تحت المتابعة", "لا تُحسب المفتوحة رابحة"]
    ].map(([v,k,n]) => `<div class="pro-proof-card"><small>${k}</small><b>${v}</b><em>${n}</em></div>`).join("");
  }

  function renderLeaders() {
    const el = q("#proLeaders"); if (!el) return;
    const list = (state.analytics?.rs || []).filter(x => !x.cx).slice(0, 10);
    if (!list.length) { el.innerHTML = '<div class="pro-empty">سيظهر ترتيب القوة النسبية بعد دورة التحليلات التالية.</div>'; return; }
    const names = bySym();
    el.innerHTML = `<div class="pro-leaders">${list.map(x => {
      const r = names.get(x.s) || x;
      return `<div class="pro-leader" data-open="${esc(x.s)}"><strong><span class="tick">${esc(x.s)}</span><i>${latin(x.rk)}%</i></strong><p>${esc(nm(r))}<br>فائض شهر ${signed(x.x1)} · بيتا ${latin(x.beta)}</p><div class="rankbar"><i style="width:${Math.max(0,Math.min(100,x.rk || 0))}%"></i></div></div>`;
    }).join("")}</div>`;
  }

  function renderPrecision() {
    const el = q("#proPrecision"), x = state.intel; if (!el) return;
    if (!x) { el.innerHTML = '<div class="pro-empty">لم تصل طبقة الدقة بعد؛ بقية التحليل يعمل بصورة مستقلة.</div>'; return; }
    const list = x.opportunities || [];
    const gates = Object.entries(x.gates || {}).sort((a,b) => b[1]-a[1]).slice(0,3);
    const summary = `<div class="precision-summary"><div><b>${latin(x.reviewed)}</b><small>فُحصت</small></div><i></i><div><b>${latin(x.passed)}</b><small>اجتازت</small></div><div><b>${latin(x.rejected)}</b><small>رُفضت</small></div><p>المقياس درجة دليل من 100، وليس احتمال نجاح.</p></div>`;
    if (!list.length) {
      const watch = x.watchlist || [];
      el.innerHTML = summary + `<div class="pro-empty">لا فرصة اجتازت البوابات الآن. أكثر أسباب الرفض: ${gates.map(([k,v]) => `${esc(k)} (${latin(v)})`).join(" · ") || "لا بيانات كافية"}.</div>` +
        (watch.length ? `<div class="watch-head"><b>الأقرب للاجتياز</b><small>مراقبة فقط — ليست فرصاً معتمدة</small></div><div class="watch-list">${watch.slice(0,5).map(o => `<button data-open="${esc(o.s)}"><span><b class="tick">${esc(o.s)}</b><small>${esc(o.ar || o.en || "")}</small></span><em>${(o.reasons || []).slice(0,2).map(esc).join(" · ")}</em><i>${latin(o.score)}</i></button>`).join("")}</div>` : "");
      return;
    }
    el.innerHTML = summary + `<div class="precision-list">${list.slice(0,6).map(o => `<button class="precision-pick" data-open="${esc(o.s)}">
      <span class="precision-score"><b>${latin(o.score)}</b><small>${esc(o.grade)}</small></span>
      <span class="precision-id"><b class="tick">${esc(o.s)}</b><em>${esc(o.ar || o.en || "")}</em><small>${(o.proof || []).map(esc).join(" · ")}</small></span>
      <span class="precision-plan"><i>دخول <b>${money(o.plan?.entry)}</b></i><i>وقف <b>${money(o.plan?.stop)}</b></i><i>هدف <b>${money(o.plan?.target)}</b></i></span>
      <span class="precision-evidence">${o.evidence?.holdout ? "اختبار سنة أخيرة" : "سجل كامل"}<b>${esc(o.evidence?.lbl || "—")}</b><small>${latin(o.evidence?.n)} عينة</small></span>
    </button>`).join("")}</div><p class="rejection-note">استُبعد ${latin(x.rejected)} من ${latin(x.reviewed)} رمزاً. قلة النتائج هنا ميزة: النظام لا يملأ الشاشة بفرص متوسطة.</p>`;
  }

  function renderFinancialPro() {
    const el = q("#proFinancial"), list = state.intel?.financial || []; if (!el) return;
    if (!list.length) { el.innerHTML = '<div class="pro-empty">التحليل المالي غير متاح الآن.</div>'; return; }
    const map = bySym();
    el.innerHTML = `<div class="financial-list">${list.slice(0,8).map((x,i) => { const r=map.get(x.s)||{}; return `<button data-open="${esc(x.s)}"><i>${i+1}</i><span><b class="tick">${esc(x.s)}</b><small>${esc(nm(r))}</small></span><em><b>${latin(x.total)}</b><small>درجة مالية</small></em><u style="--w:${Math.max(0,Math.min(100,x.total||0))}%"></u></button>`; }).join("")}</div><p class="desk-note">الجودة 35% · النمو 25% · القيمة 25% · المحللون والمطلعون 15%. كل رقم يُرتّب داخل قطاعه.</p>`;
  }

  function renderNewsPro() {
    const el = q("#proNews"), list = state.intel?.newsroom || []; if (!el) return;
    if (!list.length) { el.innerHTML = '<div class="pro-empty">لا خبر حديث عالي الأثر.</div>'; return; }
    el.innerHTML = `<div class="newswire">${list.slice(0,7).map(n => `<a href="${esc(n.link)}" target="_blank" rel="noopener"><span class="wire-mark ${n.tone<0?'neg':n.tone>0?'pos':''}">${n.imp===3?'عاجل':n.imp===2?'مهم':'خبر'}</span><div><b>${esc(n.ar || n.title)}</b><small>${n.official?'مصدر رسمي · ':''}${esc(n.src || '')} · ${n.t ? esc(ago(n.t)) : 'الآن'}</small></div></a>`).join("")}</div><p class="desk-note">“عاجل” يعني أن الموضوع قادر على تحريك السعر؛ لا يعني أن اتجاهه متوقّع.</p>`;
  }

  function optionMarket() {
    if (state.opts?.mkt) return state.opts.mkt;
    const a = (state.opts?.rows || []).reduce((o, x) => {
      if (Number.isFinite(x.ivHv)) { o.iv.push(x.ivHv); if (x.ivHv >= 1.3) o.rich++; if (x.ivHv <= .8) o.cheap++; }
      if (x.flow) { o.flow++; x.flow.side === "call" ? o.fc++ : o.fp++; }
      return o;
    }, { iv: [], rich: 0, cheap: 0, flow: 0, fc: 0, fp: 0 });
    a.iv.sort((x,y) => x-y); const med = a.iv.length ? a.iv[a.iv.length >> 1] : null;
    return { n: state.opts?.count || 0, ivHvMed: med, rich: a.rich, cheap: a.cheap, flow: a.flow, flowC: a.fc, flowP: a.fp };
  }
  function renderOptionsPro() {
    const el = q("#proOptions"); if (!el) return;
    const m = optionMarket();
    if (!m.n) { el.innerHTML = '<div class="pro-empty">ملف العقود غير متاح الآن؛ بقية الموقع تعمل بدونه.</div>'; return; }
    const mood = Number.isFinite(m.pcv) ? (m.pcv > 1.1 ? "ميل للحماية" : m.pcv < .8 ? "ميل للكول" : "متوازن") : "قيد القياس";
    el.innerHTML = `<div class="pro-metrics">
      <div class="pro-metric"><small>قراءة العقود</small><b>${mood}</b><p>${Number.isFinite(m.pcv) ? `بوت/كول ${latin(m.pcv)}` : "تظهر بعد تحديث المحرك الجديد"}</p></div>
      <div class="pro-metric"><small>وسيط الضمني ÷ المحقق</small><b class="${m.ivHvMed > 1.3 ? "pro-neu" : ""}">${latin(m.ivHvMed)}×</b><p>هل القسط غالٍ مقابل حركة السهم</p></div>
      <div class="pro-metric"><small>عقود غالية / رخيصة</small><b>${latin(m.rich)} / ${latin(m.cheap)}</b><p>حدود معلنة 1.3× و0.8×</p></div>
      <div class="pro-metric"><small>نشاط غير معتاد</small><b>${latin(m.flow)}</b><p>${latin(m.flowC)} كول · ${latin(m.flowP)} بوت</p></div>
    </div>`;
  }

  function renderEdge() {
    const el = q("#proEdge"); if (!el) return;
    const list = (state.arch?.scans || []).filter(x => x.ret?.[20] && Number.isFinite(x.edge?.[20]))
      .sort((a,b) => b.edge[20] - a.edge[20]).slice(0,5);
    if (!list.length) { el.innerHTML = '<div class="pro-empty">الأرشيف التاريخي غير متاح الآن.</div>'; return; }
    el.innerHTML = list.map(x => { const v=x.validation?.ret?.[20]?.n>=300?x.validation:x; return `<div class="pro-edge-row"><strong>${esc(x.lbl)}</strong><b class="${cls(v.edge[20])}">${signed(v.edge[20])}</b><span>${latin(v.ret[20].n)} عينة${v===x?'':' · سنة أخيرة'}</span></div>`; }).join("") +
      '<p class="hint" style="margin-top:10px">الحافة = وسيط عائد الشرط ناقص وسيط السوق في نفس الاتجاه خلال 20 يومًا. تُفضّل سنة التحقق الأخيرة حين تكفي عينتها.</p>';
  }

  function readPortfolio() { const x = load(PKEY, []); return Array.isArray(x) ? x : []; }
  function writePortfolio(x) { save(PKEY, x); renderPortfolio(); }
  function renderPortfolio() {
    const el = q("#proPortfolio"); if (!el) return;
    const p = readPortfolio(), map = bySym();
    if (!p.length) { el.innerHTML = '<div class="pro-empty">أضف مراكزك لترى الربح، الوزن، وأكبر تركّز في المحفظة—بلا حساب أو رفع بيانات.</div>'; return; }
    const calc = p.map(x => { const r = map.get(x.s), px = r?.p; const value = Number.isFinite(px) ? px * x.q : null, cost = x.avg * x.q; return { ...x, r, px, value, cost, pnl: Number.isFinite(value) ? value - cost : null }; });
    const value = calc.reduce((a,x) => a + (x.value || 0), 0), cost = calc.reduce((a,x) => a + x.cost, 0), pnl = value - cost;
    const top = [...calc].filter(x => x.value).sort((a,b) => b.value-a.value)[0], concentration = top && value ? top.value/value*100 : 0;
    el.innerHTML = `<div class="pro-port-summary">
      <div class="pro-metric"><small>القيمة الحالية</small><b>${money(value)}</b></div><div class="pro-metric"><small>التكلفة</small><b>${money(cost)}</b></div>
      <div class="pro-metric"><small>الربح غير المحقق</small><b class="${cls(pnl)}">${money(pnl)}</b></div><div class="pro-metric"><small>أكبر تركّز</small><b class="${concentration>35?'pro-neu':''}">${latin(concentration)}%</b><p>${esc(top?.s || "—")}</p></div>
    </div><div>${calc.map((x,i) => `<div class="pro-pos"><div><b class="tick">${esc(x.s)}</b><small>${esc(nm(x.r)||"")}</small></div><span>${latin(x.q)} سهم</span><span>${money(x.avg)}</span><span>${money(x.px)}</span><b class="${cls(x.pnl)}">${money(x.pnl)}</b><button data-pro-remove="${i}" aria-label="حذف">×</button></div>`).join("")}</div>`;
  }

  function addPosition(e) {
    e.preventDefault(); const s = q("#proSym").value.trim().toUpperCase(), qty = +q("#proQty").value, avg = +q("#proAvg").value;
    if (!/^[A-Z0-9.-]{1,12}$/.test(s) || !(qty > 0) || !(avg > 0)) { q("#proSym").focus(); return; }
    const p = readPortfolio(), old = p.find(x => x.s === s);
    if (old) { const total = old.q + qty; old.avg = (old.avg * old.q + avg * qty) / total; old.q = total; }
    else p.push({ s, q: qty, avg });
    writePortfolio(p); e.target.reset();
  }

  async function loadPro() {
    trial(); renderPortfolio();
    if (loading) return loading;
    loading = Promise.allSettled([
      state.analytics ? Promise.resolve(state.analytics) : getJSON("analytics.json").then(x => state.analytics = x),
      state.opts ? Promise.resolve(state.opts) : getJSON("options.json").then(x => state.opts = x),
      state.arch ? Promise.resolve(state.arch) : getJSON("backtest.json").then(x => state.arch = x),
      state.wide ? Promise.resolve(state.wide) : getJSON("wide.json").then(x => state.wide = x),
      state.intel ? Promise.resolve(state.intel) : getJSON("intelligence.json").then(x => state.intel = x),
      state.news ? Promise.resolve(state.news) : getJSON("news.json").then(x => state.news = x),
      state.fund ? Promise.resolve(state.fund) : getJSON("fundamentals.json").then(x => state.fund = x)
    ]).then(() => { renderProof(); renderPrecision(); renderLeaders(); renderOptionsPro(); renderEdge(); renderFinancialPro(); renderNewsPro(); renderPortfolio(); }).finally(() => loading = null);
    return loading;
  }

  const tab = q('#tabbar [data-go="pro"]'); if (tab) tab.addEventListener("click", loadPro);
  const form = q("#proPortfolioForm"); if (form) form.addEventListener("submit", addPosition);
  document.addEventListener("click", e => { const b = e.target.closest("[data-pro-remove]"); if (!b) return; const p = readPortfolio(); p.splice(+b.dataset.proRemove, 1); writePortfolio(p); });
  trial();
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
})();
