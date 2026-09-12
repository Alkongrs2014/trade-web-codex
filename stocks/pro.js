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
    el.innerHTML = list.map(x => `<div class="pro-edge-row"><strong>${esc(x.lbl)}</strong><b class="${cls(x.edge[20])}">${signed(x.edge[20])}</b><span>${latin(x.ret[20].n)} عينة</span></div>`).join("") +
      '<p class="hint" style="margin-top:10px">الحافة = وسيط عائد الشرط ناقص وسيط السوق في نفس الاتجاه خلال 20 يومًا.</p>';
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
      state.wide ? Promise.resolve(state.wide) : getJSON("wide.json").then(x => state.wide = x)
    ]).then(() => { renderProof(); renderLeaders(); renderOptionsPro(); renderEdge(); renderPortfolio(); }).finally(() => loading = null);
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
