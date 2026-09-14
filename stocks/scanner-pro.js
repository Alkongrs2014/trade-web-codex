/* ماسح الاستراتيجيات: الواجهة فقط. الرياضيات في strategies.js وconsensus.js. */
(function () {
  "use strict";

  const ui = { sym: "", rows: [], consensus: null, busy: false };
  const byId = (id) => document.getElementById(id);
  const edgeMap = () => {
    const out = {};
    for (const r of (state.stratEdge && state.stratEdge.rows) || []) out[r.id] = r;
    return out;
  };
  const anchor = (sym, id) => ((state.strategies && state.strategies.rows) || [])
    .find(r => r.s === sym && r.st === id) || null;

  function loadScannerData() {
    lazyFile("strategies", "strategies.json", renderUniverseRanking);
    lazyFile("stratEdge", "strategy-edge.json", () => {
      renderUniverseRanking();
      if (ui.sym) analyzeSymbol(ui.sym);
    });
    lazyFile("wide", "wide.json", () => {});
  }

  function findSymbols(q) {
    const s = String(q || "").trim().toLowerCase();
    if (!s) return [];
    const seen = new Set();
    return allRows().filter(r => {
      if (!r || seen.has(r.s)) return false;
      const hit = `${r.s} ${r.ar || ""} ${r.en || ""}`.toLowerCase().includes(s);
      if (hit) seen.add(r.s);
      return hit;
    }).sort((a, b) => (b.s.toLowerCase() === s) - (a.s.toLowerCase() === s)).slice(0, 8);
  }

  function showSuggestions() {
    const input = byId("scxInput"), box = byId("scxSuggest");
    if (!input || !box) return;
    const rows = findSymbols(input.value);
    box.innerHTML = rows.map(r => `<button type="button" data-scx-symbol="${esc(r.s)}"><b class="num">${esc(r.s)}</b><span>${esc(nm(r))}</span><small>${esc(r.sec || "")}</small></button>`).join("");
    box.classList.toggle("on", !!rows.length);
  }

  async function analyzeSymbol(value) {
    const sym = String(value || "").trim().toUpperCase();
    if (!sym || ui.busy) return;
    const row = allRows().find(r => r.s === sym);
    byId("scxSuggest").classList.remove("on");
    if (!row) {
      byId("scxConsensus").innerHTML = `<div class="warn">الرمز ${esc(sym)} غير موجود في الكون المحمّل.</div>`;
      return;
    }
    ui.busy = true; ui.sym = sym;
    byId("scxInput").value = sym;
    byId("scxConsensus").innerHTML = `<div class="skl" style="height:150px"></div>`;
    byId("scxStrategies").style.display = "";
    byId("scxStrategies").innerHTML = `<div class="skl" style="height:260px"></div>`;
    loadScannerData();
    try {
      const rec = await getSymbol(sym);
      const now = Date.now();
      const mkt = marketStatus(rec.period || (state.market && state.market.period), now);
      const core = !!(state.summary && state.summary.rows.some(r => r.s === sym));
      const ctx = buildCtx({ rec, row, now, px: row.p, sess: mkt.state, wide: !core });
      const results = evalAll(ctx);
      for (const r of results) {
        const a = anchor(sym, r.id);
        r.at = a && Number.isFinite(a.at) ? a.at * 1000 : null;
        r.px0 = a && Number.isFinite(a.px0) ? a.px0 : null;
        r.plan = r.dir ? planFor(ctx, r) : null;
        if (r.at && r.dir && r.plan && !r.plan.bad) {
          const fr = freshness(now - r.at, r.tfUsed || r.tf);
          const t1 = r.plan.targets && r.plan.targets[0] && r.plan.targets[0].p;
          const q = entryQuality({ px: ctx.px, sigPx: r.px0, atr: r.plan.atr, dir: r.dir, target: t1, stop: r.plan.stop, fresh: fr });
          const e = entryScore(q, fr);
          r.eq = e && e.v; r.eqRaw = q;
          r.status = signalStatus(fr, q, now - r.at, r.tfUsed || r.tf);
        }
      }
      const regime = marketRegime(ctx.an);
      const consensus = consensusOf(results, { regime, edge: edgeMap() });
      ui.rows = results; ui.consensus = consensus;
      renderConsensus(row, ctx, results, consensus, regime, mkt, core);
      renderStrategies(results);
    } catch (e) {
      diag("strategy-scanner", `تعذّر تحليل ${sym}`, e.message);
      byId("scxConsensus").innerHTML = `<div class="warn">تعذّر تحليل ${esc(sym)} — ${esc(e.message)}</div>`;
    } finally { ui.busy = false; }
  }

  function renderConsensus(row, ctx, results, cons, regime, mkt, core) {
    const side = cons.dir > 0 ? "▲ شراء" : cons.dir < 0 ? "▼ بيع" : "⇄ لا جهة";
    const color = cons.dir > 0 ? "var(--up)" : cons.dir < 0 ? "var(--dn)" : "var(--neu)";
    const active = results.filter(r => r.active);
    const ages = active.map(r => r.at && Date.now() - r.at).filter(Number.isFinite);
    const bestEntry = active.map(r => r.eq).filter(Number.isFinite).sort((a, b) => b - a)[0];
    const hot = confluenceOf(cons, results);
    const regimeInfo = regime && REGIMES[regime];
    byId("scxConsensus").innerHTML = `<div class="scx-head"><div><h2 style="margin:0"><span class="num">${esc(row.s)}</span> <small>${esc(nm(row))}</small></h2><div><b class="num">${money(row.p)}</b> <span style="color:${row.chg >= 0 ? "var(--up)" : "var(--dn)"}">${pct(row.chg)}</span></div></div><div class="scx-verdict"><b style="color:${color}">${side}</b><span class="mut">${esc(cons.t || "لا إشارة")}</span></div></div>
      ${cons.k === "mixed" ? `<div class="scx-alert"><b>تعارض يمنع الخطة:</b> ${esc(cons.why)}</div>` : ""}
      ${hot ? `<div class="ok" style="margin-top:12px"><b>توافق استثنائي:</b> ${esc(hot.why)}</div>` : ""}
      <div class="scx-grid"><div class="scx-metric"><small>الإشارات النشطة</small><b class="num">${active.length} / ${results.length}</b></div><div class="scx-metric"><small>نتيجة الإجماع</small><b class="num">${Number.isFinite(cons.sc) ? cons.sc : "—"}</b></div><div class="scx-metric"><small>أفضل جودة دخول</small><b class="num">${Number.isFinite(bestEntry) ? bestEntry : "—"}</b></div><div class="scx-metric"><small>حالة السهم</small><b>${esc(regimeInfo ? regimeInfo.t : "غير محسومة")}</b></div></div>
      <p class="srcline">${core ? "تحليل كامل" : "تحليل يومي مُصغّر"} · حالة السوق ${esc(mkt.ar || mkt.state)} · ${ages.length ? `أحدث إشارة ${esc(ageShort(Math.min(...ages)))}` : "لا وقت بداية مسجّلاً"} · الثقة وصفٌ لاتساع الدليل وليست احتمال نجاح.</p>`;
  }

  function renderStrategies(results) {
    const edges = edgeMap();
    const rank = r => r.off ? 3 : !r.dir ? 2 : r.active ? 0 : 1;
    const rows = results.slice().sort((a, b) => rank(a) - rank(b) || (b.sc || 0) - (a.sc || 0));
    byId("scxStrategies").innerHTML = `<h2>تفصيل الاستراتيجيات العشر</h2><p class="hint">افتح أي صف لترى البوابات التي صنعت نتيجته وخطته والحافة المقيسة.</p>${rows.map(strategyCard).join("")}`;
    function strategyCard(r) {
      const meta = STRAT_BY_ID[r.id] || {};
      if (r.off) return `<details class="scx-row"><summary><b>⊘</b><b>${esc(r.lbl)}</b><span class="mut">—</span><span class="mut">غير متاحة</span><small>${esc(r.off)}</small></summary><div class="scx-body"><p>${esc(meta.why || "")}</p></div></details>`;
      if (!r.dir) return `<details class="scx-row"><summary><b>⇄</b><b>${esc(r.lbl)}</b><span class="mut">—</span><span class="mut">لم تتفعّل</span><small>${esc(FAMS[r.fam] || r.fam || "")}</small></summary><div class="scx-body"><p>${esc(meta.why || "")}</p>${edgeLine(r.id, edges)}</div></details>`;
      const color = r.dir > 0 ? "var(--up)" : "var(--dn)";
      const plan = r.plan && !r.plan.bad ? r.plan : null;
      const gates = (r.g || []).map(g => `<div class="scx-gate"><span>${esc(((meta.gates || []).find(x => x.id === g[0]) || {}).lbl || g[0])}</span><b style="color:${g[2] > 0 ? "var(--up)" : g[2] < 0 ? "var(--dn)" : "var(--mut)"}">${g[2] > 0 ? "تؤيد" : g[2] < 0 ? "تعارض" : "حائرة"} · ${fmt(g[1], 1)}</b></div>`).join("");
      return `<details class="scx-row${r.active ? " active" : ""}"><summary><b style="color:${color}">${r.dir > 0 ? "▲" : "▼"}</b><b>${esc(r.lbl)}</b><b class="num" style="color:${color}">${r.sc}</b><span>${esc(S_LABEL[r.band] || "")}</span><small>${r.at ? esc(ageShort(Date.now() - r.at)) : "منذ هذه الدورة"}</small></summary><div class="scx-body"><p>${esc(meta.why || "")}</p><div class="scx-gates">${gates || `<span class="mut">لا بوابات متاحة</span>`}</div>${plan ? `<div class="scx-plan"><div><small>الدخول</small><b class="num">${money(plan.entry)}</b></div><div><small>الوقف</small><b class="num">${money(plan.stop)}</b></div><div><small>العائد/المخاطرة</small><b class="num">${Number.isFinite(plan.rr) ? fmt(plan.rr, 2) + ":1" : "—"}</b></div></div>` : r.plan && r.plan.bad ? `<div class="warn">الخطة رفضتها بوابة الاتجاه: ${esc(r.plan.bad.join("، "))}</div>` : ""}${edgeLine(r.id, edges)}</div></details>`;
    }
  }

  function edgeLine(id, edges) {
    const e = edges[id];
    if (!e || !Number.isFinite(e.edge)) return `<div class="scx-edge">الحافة: لم تُقَس بعد بعينة كافية.</div>`;
    return `<div class="scx-edge">الحافة المقيسة: <b style="color:${e.edge >= 0 ? "var(--up)" : "var(--dn)"}">${e.edge > 0 ? "+" : ""}${fmt(e.edge, 2)}</b> على <span class="num">${e.n || 0}</span> إشارة${e.edge < 0 ? " — سالبة وتظهر كما قِيست" : ""}.</div>`;
  }

  function renderUniverseRanking() {
    const el = byId("scxRanking"); if (!el) return;
    const file = state.strategies;
    if (!file || !Array.isArray(file.rows)) {
      el.innerHTML = `<h2>أقوى إجماع في الكون</h2><div class="note">لم يصل ملف <span class="num">strategies.json</span> بعد. شغّل دورة الاستراتيجيات ليظهر ترتيب السوق الكامل؛ تحليل رمز واحد يظل متاحاً.</div>`;
      return;
    }
    const grouped = {};
    for (const r of file.rows) if (r.act) (grouped[r.s] ||= []).push({ id:r.st, lbl:(STRAT_BY_ID[r.st] || {}).lbl || r.st, fam:(STRAT_BY_ID[r.st] || {}).fam, dir:r.dir, sc:r.sc, active:true });
    const ranked = Object.entries(grouped).map(([s, rs]) => ({ s, rs, c:consensusOf(rs, { edge:edgeMap() }) })).filter(x => x.c.n).sort((a,b) => (b.c.mass || 0) - (a.c.mass || 0)).slice(0, 16);
    el.innerHTML = `<h2>أقوى إجماع في الكون</h2><p class="hint">لقطة الخادم لكل السوق؛ اضغط رمزاً لإعادة حسابه من شمعاته الحالية.</p><div class="scx-rank">${ranked.map(x => `<button type="button" data-scx-symbol="${esc(x.s)}"><b class="num">${esc(x.s)}</b><span>${esc(x.c.t)}</span><em style="color:${x.c.dir > 0 ? "var(--up)" : x.c.dir < 0 ? "var(--dn)" : "var(--neu)"}">${x.c.dir > 0 ? "▲" : x.c.dir < 0 ? "▼" : "⇄"} ${Number.isFinite(x.c.sc) ? x.c.sc : "—"}</em></button>`).join("") || `<div class="empty">لا إجماع نشط في آخر لقطة.</div>`}</div><p class="srcline">آخر حساب ${esc(ago(file.updated))} · ${file.count || file.rows.length} حالة مفعّلة قبل التصفية.</p>`;
  }

  function wire() {
    const input = byId("scxInput"), run = byId("scxRun");
    if (!input || !run) return;
    input.addEventListener("input", () => { if (input.value.trim()) lazyFile("wide", "wide.json", showSuggestions); showSuggestions(); });
    input.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); analyzeSymbol(input.value); } if (e.key === "Escape") byId("scxSuggest").classList.remove("on"); });
    run.addEventListener("click", () => analyzeSymbol(input.value));
    document.addEventListener("click", e => {
      const pick = e.target.closest("[data-scx-symbol]");
      if (pick) { input.value = pick.dataset.scxSymbol; go("scanner"); analyzeSymbol(pick.dataset.scxSymbol); return; }
      if (!e.target.closest(".scx-search-card")) byId("scxSuggest").classList.remove("on");
    });
    const tab = document.querySelector('[data-go="scanner"]');
    if (tab) tab.addEventListener("click", loadScannerData);
    renderUniverseRanking();
  }

  window.analyzeStrategySymbol = analyzeSymbol;
  window.renderStrategyRanking = renderUniverseRanking;
  wire();
})();
