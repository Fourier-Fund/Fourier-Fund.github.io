/* Fourier Fund performance page. Reads data/performance.json (built by
   scripts/build_data.py) and renders tabs, KPIs, charts and tables. */
(() => {
  "use strict";

  const COLOR_VAR = { total: "--c-total", quant: "--c-quant", esg: "--c-esg", analyst: "--c-analyst" };
  const RANGES = [
    { id: "1M", months: 1 }, { id: "3M", months: 3 }, { id: "6M", months: 6 },
    { id: "YTD" }, { id: "1Y", months: 12 }, { id: "ALL", label: "Since inception" },
  ];
  const MIN_STATS_DAYS = 20; // below this, annualized stats are suppressed

  let D, view = "total", range = "ALL";
  const charts = {};

  // ---------------------------------------------------------------- helpers
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const $ = (id) => document.getElementById(id);
  function el(tag, attrs = {}, ...kids) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "style") n.style.cssText = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const c of kids) if (c != null) n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    return n;
  }
  const pct = (x, d = 1, sign = true) =>
    x == null || !isFinite(x) ? "—" : (sign && x > 0 ? "+" : "") + (x * 100).toFixed(d).replace("-", "−") + "%";
  const money = (x) => x == null ? "—" : x.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
  const num = (x, d = 2) => x == null ? "—" : x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }).replace("-", "−");
  const tone = (x) => x == null || !isFinite(x) || Math.abs(x) < 5e-5 ? "" : x > 0 ? "up" : "down";
  const fmtDate = (s) => new Date(s + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

  function seriesFor(id) {
    if (D.series[id]) return D.series[id];
    const b = D.benchmarks.find((x) => x.id === id);
    return b ? b.series : null;
  }
  const portName = (id) => id === "total" ? "Total Fund" : D.portfolios.find((p) => p.id === id).name;
  const primaryBench = () => D.benchmarks.find((b) => b.primary) || D.benchmarks[0];

  // start index for a range
  function rangeStart(r) {
    const dates = D.dates, last = new Date(dates[dates.length - 1] + "T12:00:00");
    if (r === "ALL") return 0;
    let cut;
    if (r === "YTD") cut = `${last.getFullYear() - 1}-12-31`;
    else {
      const m = RANGES.find((x) => x.id === r).months;
      const c = new Date(last); c.setMonth(c.getMonth() - m);
      cut = c.toISOString().slice(0, 10);
    }
    // last trading day on/before the cut is the base; null if history too short
    let i = -1;
    for (let k = 0; k < dates.length; k++) if (dates[k] <= cut) i = k;
    return i < 0 ? null : i;
  }

  function stats(s, i0) {
    const seg = s.slice(i0).filter((v) => v != null);
    if (seg.length < 2) return {};
    const rets = [];
    for (let k = 1; k < seg.length; k++) rets.push(seg[k] / seg[k - 1] - 1);
    const total = seg[seg.length - 1] / seg[0] - 1;
    let peak = seg[0], mdd = 0;
    for (const v of seg) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
    const out = { total, mdd, n: rets.length };
    if (rets.length >= MIN_STATS_DAYS) {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
      out.vol = sd * Math.sqrt(252);
      out.sharpe = sd ? ((mean - D.risk_free_rate / 252) / sd) * Math.sqrt(252) : null;
    }
    return out;
  }

  // ---------------------------------------------------------------- chart plugins
  const crosshair = {
    id: "crosshair",
    afterDatasetsDraw(chart) {
      const a = chart.tooltip && chart.tooltip.getActiveElements();
      if (!a || !a.length) return;
      const x = a[0].element.x, { top, bottom } = chart.chartArea, ctx = chart.ctx;
      ctx.save(); ctx.strokeStyle = css("--axis"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.restore();
    },
  };
  // direct end labels, nudged apart so they never overlap
  const endLabels = {
    id: "endLabels",
    afterDatasetsDraw(chart, _a, opts) {
      if (!opts || !opts.enabled) return;
      const ctx = chart.ctx, items = [];
      chart.data.datasets.forEach((ds, i) => {
        const meta = chart.getDatasetMeta(i);
        if (meta.hidden) return;
        const pts = meta.data.filter((p, k) => ds.data[k] != null);
        const p = pts[pts.length - 1];
        if (p) items.push({ y: p.y, x: p.x, text: ds.label, color: ds.borderColor });
      });
      items.sort((a, b) => a.y - b.y);
      for (let k = 1; k < items.length; k++) if (items[k].y - items[k - 1].y < 14) items[k].y = items[k - 1].y + 14;
      ctx.save(); ctx.font = "12px system-ui, sans-serif"; ctx.textBaseline = "middle";
      for (const it of items) {
        ctx.fillStyle = it.color; ctx.fillRect(it.x + 6, it.y - 1, 8, 2);
        ctx.fillStyle = css("--ink-2"); ctx.fillText(it.text, it.x + 18, it.y);
      }
      ctx.restore();
    },
  };

  function lineChart(canvas, key, datasets, { yFmt = (v) => pct(v, 0), endLbl = false, fill = false } = {}) {
    if (charts[key]) charts[key].destroy();
    const ink2 = css("--ink-2"), muted = css("--muted"), grid = css("--grid");
    charts[key] = new Chart(canvas, {
      type: "line",
      data: { labels: datasets.labels, datasets: datasets.sets },
      plugins: [crosshair, endLabels],
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        layout: { padding: { right: endLbl && innerWidth >= 600 ? 92 : 4, top: 6 } },
        elements: { point: { radius: 0, hoverRadius: 4, hitRadius: 12 }, line: { borderWidth: 2, tension: 0 } },
        scales: {
          x: {
            grid: { display: false }, border: { color: css("--axis") },
            ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 7,
              callback(v) { return fmtDate(this.getLabelForValue(v)).replace(/, \d{4}$/, ""); } },
          },
          y: {
            grid: { color: grid }, border: { display: false },
            ticks: { color: muted, callback: yFmt, maxTicksLimit: 6 },
          },
        },
        plugins: {
          legend: { display: false },
          endLabels: { enabled: endLbl && innerWidth >= 600 },
          tooltip: {
            backgroundColor: css("--surface"), titleColor: ink2, bodyColor: css("--ink"),
            borderColor: css("--border"), borderWidth: 1, padding: 10, boxPadding: 4, usePointStyle: true,
            titleFont: { weight: "normal" }, bodyFont: { weight: "600" },
            callbacks: {
              title: (it) => fmtDate(it[0].label),
              label: (c) => ` ${pct(c.parsed.y, 2)}  ${c.dataset.label}`,
              labelPointStyle: () => ({ pointStyle: "line", rotation: 0 }),
            },
          },
        },
      },
    });
    if (fill) charts[key].data.datasets[0].fill = "origin";
  }

  function legend(node, items) {
    node.replaceChildren(...items.map((it) =>
      el("span", {}, el("i", { class: it.dash ? "dash" : "", style: `--k:${it.color}` }), it.label)));
  }

  // ---------------------------------------------------------------- render
  function render() {
    // tabs
    for (const b of document.querySelectorAll(".tab")) {
      b.setAttribute("aria-selected", String(b.dataset.id === view));
      if (b.dataset.id === view) b.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    // ranges
    const i0 = rangeStart(range) ?? 0;
    for (const b of document.querySelectorAll(".range")) {
      b.setAttribute("aria-pressed", String(b.dataset.id === range));
      b.disabled = b.dataset.id !== "ALL" && rangeStart(b.dataset.id) == null;
    }

    const labels = D.dates.slice(i0);
    const rebase = (s) => { const b = s[i0]; return s.slice(i0).map((v) => v == null || b == null ? null : v / b - 1); };
    const color = css(COLOR_VAR[view]);
    const pb = primaryBench();
    const s = seriesFor(view), st = stats(s, i0), bst = stats(pb.series, i0);
    const since = stats(s, 0);

    // KPIs
    const port = D.portfolios.find((p) => p.id === view);
    const value = view === "total" ? D.fund_value : port.value;
    const wNote = view === "total" ? `${D.portfolios.length} sleeves`
      : `${pct(port.weight_fund, 1, false)} of fund · target ${pct(port.target_weight_fund, 0, false)}`;
    const short = st.n < MIN_STATS_DAYS ? "needs ≥1 month of data" : "annualized";
    const kpi = (label, val, cls, sub) => el("div", { class: "kpi" },
      el("p", { class: "label" }, label), el("p", { class: "value " + (cls || "") }, val), el("p", { class: "sub" }, sub));
    const rLabel = range === "ALL" ? "since inception" : range;
    $("kpis").replaceChildren(
      kpi(`Return (${rLabel})`, pct(st.total, 2), tone(st.total), range === "ALL" ? `since ${fmtDate(D.inception_date)}` : `since inception ${pct(since.total, 2)}`),
      kpi(`vs ${pb.name}`, pct(st.total - bst.total, 2), tone(st.total - bst.total), `${pb.name}: ${pct(bst.total, 2)}`),
      kpi("Volatility", pct(st.vol, 1, false), "", short),
      kpi("Sharpe ratio", st.sharpe == null ? "—" : num(st.sharpe), "", short),
      kpi("Max drawdown", pct(st.mdd, 1), tone(st.mdd), `${pb.name}: ${pct(bst.mdd, 1)}`),
      kpi("Holdings value", money(value), "", wNote),
    );

    // main chart
    $("chart-title").textContent = `${portName(view)}: cumulative return`;
    const sets = [
      { label: portName(view), data: rebase(s), borderColor: color, backgroundColor: color, order: 0 },
      ...D.benchmarks.map((b, k) => ({
        label: b.name, data: rebase(b.series), borderColor: css(k === 0 ? "--c-bench" : "--c-bench-2"),
        backgroundColor: css(k === 0 ? "--c-bench" : "--c-bench-2"), borderWidth: 1.5,
        borderDash: k === 0 ? [] : [4, 3], order: 1 + k,
      })),
    ];
    lineChart($("perf-chart"), "perf", { labels, sets }, { endLbl: true });
    legend($("legend"), sets.map((d, k) => ({ label: d.label, color: d.borderColor, dash: k > 1 })));

    // sleeves comparison (total tab only)
    $("sleeve-card").hidden = view !== "total";
    if (view === "total") {
      const ids = ["total", ...D.portfolios.map((p) => p.id)];
      const ss = ids.map((id) => ({ label: id === "total" ? "Total" : D.portfolios.find((p) => p.id === id).short,
        data: rebase(D.series[id]), borderColor: css(COLOR_VAR[id]), backgroundColor: css(COLOR_VAR[id]),
        borderWidth: id === "total" ? 2.5 : 2 }));
      lineChart($("sleeve-chart"), "sleeve", { labels, sets: ss }, { endLbl: true });
      legend($("sleeve-legend"), ss.map((d) => ({ label: d.label, color: d.borderColor })));
    }

    // drawdown (from the range start)
    let peak = -Infinity;
    const dd = s.slice(i0).map((v) => { peak = Math.max(peak, v); return v / peak - 1; });
    lineChart($("dd-chart"), "dd", { labels, sets: [{ label: portName(view), data: dd, borderColor: color,
      backgroundColor: color + "26", borderWidth: 1.5 }] }, { yFmt: (v) => pct(v, 0), fill: true });

    // table
    $("research-card").hidden = view !== "quant";
    view === "total" ? sleeveTable(i0) : holdingsTable(port);
  }

  function sleeveTable(i0) {
    $("table-title").textContent = "Allocation by sleeve";
    const mix = Object.entries(D.asset_mix).map(([k, v]) => `${k} ${pct(v, 1, false)}`).join(" · ");
    $("table-note").textContent = `Asset mix: ${mix}`;
    const rLabel = range === "ALL" ? "Since inception" : `Return ${range}`;
    const head = el("thead", {}, el("tr", {}, ...["Sleeve", "Value", "Weight", "Target", "Drift", rLabel, "Max DD"]
      .map((h, k) => el("th", { class: k ? "num" : "" }, h))));
    const rows = D.portfolios.map((p) => {
      const st = stats(D.series[p.id], i0), drift = p.weight_fund - (p.target_weight_fund ?? 0);
      return el("tr", {},
        el("td", {}, el("span", { class: "dot", style: `background:${css(COLOR_VAR[p.id])}` }), p.name),
        el("td", { class: "num" }, money(p.value)),
        el("td", { class: "num" }, pct(p.weight_fund, 1, false)),
        el("td", { class: "num" }, pct(p.target_weight_fund, 1, false)),
        el("td", { class: "num" }, pct(drift, 1)),
        el("td", { class: "num " + tone(st.total) }, pct(st.total, 2)),
        el("td", { class: "num" }, pct(st.mdd, 1)));
    });
    const tst = stats(D.series.total, i0);
    const foot = el("tfoot", {}, el("tr", {}, el("td", {}, "Total Fund"), el("td", { class: "num" }, money(D.fund_value)),
      el("td", { class: "num" }, "100%"), el("td", { class: "num" }, "100%"), el("td", {}),
      el("td", { class: "num " + tone(tst.total) }, pct(tst.total, 2)), el("td", { class: "num" }, pct(tst.mdd, 1))));
    $("table").replaceChildren(head, el("tbody", {}, ...rows), foot);
  }

  function holdingsTable(p) {
    $("table-title").textContent = `${p.name} holdings`;
    $("table-note").textContent = p.description || "";
    const color = css(COLOR_VAR[p.id]);
    const maxW = Math.max(...p.holdings.map((h) => h.weight_portfolio));
    const head = el("thead", {}, el("tr", {}, ...["Holding", "Shares", "Price", "Value", "Sleeve weight", "Fund weight",
      "Target", "1 day", "Since held"].map((h, k) => el("th", { class: k ? "num" : "" }, h))));
    const rows = p.holdings.map((h) => el("tr", {},
      el("td", {}, el("strong", {}, h.ticker), " ", el("span", { class: "name" }, h.ticker === "CASH" ? "" : h.name)),
      el("td", { class: "num" }, h.shares == null ? "" : num(h.shares, h.shares % 1 ? 2 : 0)),
      el("td", { class: "num" }, h.price == null ? "" : num(h.price)),
      el("td", { class: "num" }, money(h.value)),
      el("td", { class: "num" }, pct(h.weight_portfolio, 1, false),
        el("span", { class: "bar", style: `--k:${color};width:${Math.max(2, 48 * h.weight_portfolio / maxW)}px` })),
      el("td", { class: "num" }, pct(h.weight_fund, 2, false)),
      el("td", { class: "num" }, h.target_weight_fund == null ? "" : pct(h.target_weight_fund, 2, false)),
      el("td", { class: "num " + tone(h.return_1d) }, h.ticker === "CASH" ? "" : pct(h.return_1d, 2)),
      el("td", { class: "num " + tone(h.return_since_held) }, h.ticker === "CASH" ? "" : pct(h.return_since_held, 1))));
    const foot = el("tfoot", {}, el("tr", {}, el("td", {}, "Total"), el("td", {}), el("td", {}),
      el("td", { class: "num" }, money(p.value)), el("td", { class: "num" }, "100%"),
      el("td", { class: "num" }, pct(p.weight_fund, 2, false)), el("td", { class: "num" }, pct(p.target_weight_fund, 2, false)),
      el("td", {}), el("td", {})));
    $("table").replaceChildren(head, el("tbody", {}, ...rows), foot);
  }

  // ---------------------------------------------------------------- setup
  function setView(id, push = true) {
    view = id;
    if (push) history.replaceState(null, "", id === "total" ? location.pathname : `#${id}`);
    render();
  }

  function init(data) {
    D = data;
    $("asof").textContent = `Data as of ${fmtDate(D.as_of)} close · inception ${fmtDate(D.inception_date)}`;
    $("rf").textContent = pct(D.risk_free_rate, 1, false);
    $("generated").textContent = `Last built ${new Date(D.generated_at).toLocaleString()}.`;
    if (D.placeholder) { $("placeholder-banner").hidden = false; $("placeholder-note").textContent = D.placeholder_note; }

    const tabs = [{ id: "total", name: "Total Fund", w: null }, ...D.portfolios.map((p) => ({ id: p.id, name: p.name, w: p.target_weight_fund }))];
    $("tabs").replaceChildren(...tabs.map((t) => el("button", {
      class: "tab", role: "tab", "data-id": t.id, style: `--tab-color:var(${COLOR_VAR[t.id]})`,
      onclick: () => setView(t.id),
    }, el("span", { class: "swatch" }), t.name, t.w == null ? null : el("span", { class: "w" }, pct(t.w, 0, false)))));

    $("ranges").replaceChildren(...RANGES.map((r) => el("button", {
      class: "range", "data-id": r.id, onclick: () => { range = r.id; render(); },
    }, r.label || r.id)));

    const h = location.hash.slice(1);
    setView(tabs.some((t) => t.id === h) ? h : "total", false);
    window.addEventListener("hashchange", () => {
      const k = location.hash.slice(1); if (tabs.some((t) => t.id === k)) setView(k, false);
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
    matchMedia("(min-width: 600px)").addEventListener("change", render);
  }

  fetch("data/performance.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(init)
    .catch((e) => { $("asof").textContent = `Could not load performance data (${e.message}).`; });
})();
