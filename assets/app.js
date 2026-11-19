/* Fourier Fund performance page. Reads data/performance.json (built by
   scripts/build_data.py) and renders the tabs, one return chart and a table. */
(() => {
  "use strict";

  const COLOR_VAR = { total: "--c-total", quant: "--c-quant", esg: "--c-esg", analyst: "--c-analyst" };
  const BLURB = {
    total: "All three parts of the fund together.",
    quant: "Eleven ETFs, equally weighted. Mostly U.S. sector and growth funds, with dividend stocks, gold and Treasuries mixed in to hold up better when stocks fall.",
    esg: "One fund: Vanguard's ESG U.S. Stock ETF (ESGV). It owns U.S. companies of every size, minus ones in areas like fossil fuels, weapons and tobacco.",
    analyst: "Twelve stocks, equally weighted. Each one was pitched by an analyst with a written thesis, a valuation, a downside case and a plan for when to sell.",
  };
  const RANGES = [
    { id: "1M", months: 1 }, { id: "3M", months: 3 }, { id: "6M", months: 6 },
    { id: "YTD" }, { id: "1Y", months: 12 }, { id: "ALL", label: "Since inception" },
  ];
  // benchmarks are neutral ink; line style tells them apart
  const BENCH_STYLE = [
    { c: "--c-bench", dash: [], cls: "" },
    { c: "--c-bench-2", dash: [4, 3], cls: "dash" },
    { c: "--c-bench", dash: [1, 3], cls: "dot" },
  ];
  const MIN_STATS_DAYS = 20; // below this, Sharpe is suppressed

  let D, view = "total", range = "ALL", chart;

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

  const portName = (id) => id === "total" ? "Total Fund" : D.portfolios.find((p) => p.id === id).name;
  const primaryBench = () => D.benchmarks.find((b) => b.primary) || D.benchmarks[0];

  function rangeStart(r) {
    const dates = D.dates, last = new Date(dates[dates.length - 1] + "T12:00:00");
    if (r === "ALL") return 0;
    let cut;
    if (r === "YTD") cut = `${last.getFullYear() - 1}-12-31`;
    else {
      const c = new Date(last); c.setMonth(c.getMonth() - RANGES.find((x) => x.id === r).months);
      cut = c.toISOString().slice(0, 10);
    }
    let i = -1;
    for (let k = 0; k < dates.length; k++) if (dates[k] <= cut) i = k;
    return i < 0 ? null : i;
  }

  function stats(s, i0) {
    const seg = s.slice(i0).filter((v) => v != null);
    if (seg.length < 2) return {};
    const rets = [];
    for (let k = 1; k < seg.length; k++) rets.push(seg[k] / seg[k - 1] - 1);
    let peak = seg[0], mdd = 0;
    for (const v of seg) { peak = Math.max(peak, v); mdd = Math.min(mdd, v / peak - 1); }
    const out = { total: seg[seg.length - 1] / seg[0] - 1, mdd, n: rets.length };
    if (rets.length >= MIN_STATS_DAYS) {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / (rets.length - 1));
      out.sharpe = sd ? ((mean - D.risk_free_rate / 252) / sd) * Math.sqrt(252) : null;
    }
    return out;
  }

  // ---------------------------------------------------------------- chart
  const crosshair = {
    id: "crosshair",
    afterDatasetsDraw(c) {
      const a = c.tooltip && c.tooltip.getActiveElements();
      if (!a || !a.length) return;
      const x = a[0].element.x, { top, bottom } = c.chartArea, ctx = c.ctx;
      ctx.save(); ctx.strokeStyle = css("--axis"); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, top); ctx.lineTo(x, bottom); ctx.stroke(); ctx.restore();
    },
  };
  const endLabels = {
    id: "endLabels",
    afterDatasetsDraw(c, _a, opts) {
      if (!opts || !opts.enabled) return;
      const ctx = c.ctx, items = [];
      c.data.datasets.forEach((ds, i) => {
        const pts = c.getDatasetMeta(i).data.filter((p, k) => ds.data[k] != null);
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

  function drawChart(labels, sets) {
    if (chart) chart.destroy();
    const wide = innerWidth >= 600, muted = css("--muted");
    chart = new Chart($("perf-chart"), {
      type: "line",
      data: { labels, datasets: sets },
      plugins: [crosshair, endLabels],
      options: {
        responsive: true, maintainAspectRatio: false, animation: false,
        interaction: { mode: "index", intersect: false },
        layout: { padding: { right: wide ? 92 : 4, top: 6 } },
        elements: { point: { radius: 0, hoverRadius: 4, hitRadius: 12 }, line: { borderWidth: 2, tension: 0 } },
        scales: {
          x: {
            grid: { display: false }, border: { color: css("--axis") },
            ticks: { color: muted, maxRotation: 0, autoSkip: true, maxTicksLimit: 7,
              callback(v) { return fmtDate(this.getLabelForValue(v)).replace(/, \d{4}$/, ""); } },
          },
          y: { grid: { color: css("--grid") }, border: { display: false },
            ticks: { color: muted, callback: (v) => pct(v, 0), maxTicksLimit: 6 } },
        },
        plugins: {
          legend: { display: false },
          endLabels: { enabled: wide },
          tooltip: {
            backgroundColor: css("--surface"), titleColor: css("--ink-2"), bodyColor: css("--ink"),
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
  }

  // ---------------------------------------------------------------- render
  function render() {
    for (const b of document.querySelectorAll(".tab")) {
      b.setAttribute("aria-selected", String(b.dataset.id === view));
      if (b.dataset.id === view) b.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
    for (const b of document.querySelectorAll(".range")) {
      b.setAttribute("aria-pressed", String(b.dataset.id === range));
      b.disabled = b.dataset.id !== "ALL" && rangeStart(b.dataset.id) == null;
    }
    $("blurb").textContent = BLURB[view] || (D.portfolios.find((p) => p.id === view) || {}).description || "";

    // order: Total shows performance first; sleeves show holdings first
    const main = $("main"), perf = $("perf"), table = $("table-card");
    if (view === "total") main.insertBefore(perf, table); else main.insertBefore(table, perf);
    $("research-card").hidden = view !== "quant";

    const i0 = rangeStart(range) ?? 0;
    const series = D.series[view], pb = primaryBench();
    const st = stats(series, i0), bst = stats(pb.series, i0), since = stats(series, 0);

    const kpi = (label, val, cls, sub) => el("div", { class: "kpi" },
      el("p", { class: "label" }, label), el("p", { class: "value " + (cls || "") }, val), el("p", { class: "sub" }, sub));
    $("kpis").replaceChildren(
      kpi(range === "ALL" ? "Return since inception" : `Return (${range})`, pct(st.total, 2), tone(st.total),
        range === "ALL" ? `since ${fmtDate(D.inception_date)}` : `since inception ${pct(since.total, 2)}`),
      kpi(`vs ${pb.name}`, pct(st.total - bst.total, 2), tone(st.total - bst.total), `${pb.name}: ${pct(bst.total, 2)}`),
      kpi("Max drawdown", pct(st.mdd, 1), tone(st.mdd), `${pb.name}: ${pct(bst.mdd, 1)}`),
      kpi("Sharpe ratio", st.sharpe == null ? "—" : num(st.sharpe), "",
        st.n < MIN_STATS_DAYS ? "needs a month of data" : "annualized"),
    );

    const rebase = (s) => { const b = s[i0]; return s.slice(i0).map((v) => v == null || b == null ? null : v / b - 1); };
    const color = css(COLOR_VAR[view]);
    const sets = [
      { label: portName(view), data: rebase(series), borderColor: color, backgroundColor: color, order: 0 },
      ...D.benchmarks.map((b, k) => {
        const s = BENCH_STYLE[k % 3];
        return { label: b.name, data: rebase(b.series), borderColor: css(s.c), backgroundColor: css(s.c),
          borderWidth: 1.5, borderDash: s.dash, order: 1 + k, _cls: s.cls };
      }),
    ];
    drawChart(D.dates.slice(i0), sets);
    $("legend").replaceChildren(...sets.map((d) =>
      el("span", {}, el("i", { class: d._cls || "", style: `--k:${d.borderColor}` }), d.label)));

    view === "total" ? sleeveTable(i0) : holdingsTable(D.portfolios.find((p) => p.id === view));
  }

  function sleeveTable(i0) {
    $("table-title").textContent = "Where the money is";
    $("table-note").textContent = "";
    $("table").className = "";
    const head = el("thead", {}, el("tr", {}, ...["", "Value", "Weight", "Target", range === "ALL" ? "Since inception" : range]
      .map((h, k) => el("th", { class: k ? "num" : "" }, h))));
    const rows = D.portfolios.map((p) => {
      const st = stats(D.series[p.id], i0);
      return el("tr", {},
        el("td", {}, el("span", { class: "dot", style: `background:${css(COLOR_VAR[p.id])}` }), p.name),
        el("td", { class: "num" }, money(p.value)),
        el("td", { class: "num" }, pct(p.weight_fund, 1, false)),
        el("td", { class: "num" }, pct(p.target_weight_fund, 0, false)),
        el("td", { class: "num " + tone(st.total) }, pct(st.total, 2)));
    });
    const tst = stats(D.series.total, i0);
    const foot = el("tfoot", {}, el("tr", {}, el("td", {}, "Total"), el("td", { class: "num" }, money(D.fund_value)),
      el("td", { class: "num" }, "100%"), el("td", { class: "num" }, "100%"),
      el("td", { class: "num " + tone(tst.total) }, pct(tst.total, 2))));
    $("table").replaceChildren(head, el("tbody", {}, ...rows), foot);
  }

  function holdingsTable(p) {
    $("table-title").textContent = "Holdings";
    const tickers = new Set(p.holdings.map((h) => h.ticker));
    const splits = (D.splits || []).filter((x) => tickers.has(x.ticker))
      .map((x) => x.ratio < 1.5
        ? `${x.ticker} paid a ${+((x.ratio - 1) * 100).toFixed(2)}% stock dividend on ${fmtDate(x.date)}`
        : `${x.ticker} split ${+x.ratio.toFixed(3)}-for-1 on ${fmtDate(x.date)}`);
    $("table-note").textContent = splits.length ? splits.join("; ") + "." : "";
    const head = el("thead", {}, el("tr", {}, ...["", "Shares", "Price", "Value", "Weight", "Return"]
      .map((h, k) => el("th", { class: k ? "num" : "" }, h))));
    const rows = p.holdings.map((h) => {
      const cash = h.ticker === "CASH";
      return el("tr", {},
        el("td", {}, el("strong", {}, cash ? "Cash" : h.ticker), " ", el("span", { class: "name" }, cash ? "" : h.name)),
        el("td", { class: "num" }, cash ? "" : num(h.shares, h.shares % 1 ? 2 : 0)),
        el("td", { class: "num" }, cash ? "" : num(h.price)),
        el("td", { class: "num" }, money(h.value)),
        el("td", { class: "num" }, pct(h.weight_portfolio, 1, false)),
        el("td", { class: "num " + tone(h.return_since_held) }, cash ? "" : pct(h.return_since_held, 1)));
    });
    const foot = el("tfoot", {}, el("tr", {}, el("td", {}, "Total"), el("td", {}), el("td", {}),
      el("td", { class: "num" }, money(p.value)), el("td", { class: "num" }, "100%"), el("td", {})));
    $("table").replaceChildren(head, el("tbody", {}, ...rows), foot);
    $("table").className = "holdings";
  }

  // ---------------------------------------------------------------- setup
  function setView(id, push = true) {
    view = id;
    if (push) history.replaceState(null, "", id === "total" ? location.pathname : `#${id}`);
    render();
  }

  function init(data) {
    D = data;
    $("asof").textContent = `Updated through the ${fmtDate(D.as_of)} close. Started ${fmtDate(D.inception_date)}.`;
    if (D.placeholder) { $("placeholder-banner").hidden = false; $("placeholder-note").textContent = D.placeholder_note; }

    const tabs = [{ id: "total", name: "Total Fund" }, ...D.portfolios.map((p) => ({ id: p.id, name: p.name, w: p.target_weight_fund }))];
    $("tabs").replaceChildren(...tabs.map((t) => el("button", {
      class: "tab", role: "tab", "data-id": t.id, style: `--tab-color:var(${COLOR_VAR[t.id]})`,
      onclick: () => setView(t.id),
    }, el("span", { class: "swatch" }), t.name, t.w == null ? null : el("span", { class: "w" }, pct(t.w, 0, false)))));

    $("ranges").replaceChildren(...RANGES.map((r) => el("button", {
      class: "range", "data-id": r.id, onclick: () => { range = r.id; render(); },
    }, r.label || r.id)));

    const h = location.hash.slice(1);
    setView(tabs.some((t) => t.id === h) ? h : "total", false);
    addEventListener("hashchange", () => {
      const k = location.hash.slice(1); if (tabs.some((t) => t.id === k)) setView(k, false);
    });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
    matchMedia("(min-width: 600px)").addEventListener("change", render);
  }

  fetch("data/performance.json", { cache: "no-cache" })
    .then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); })
    .then(init)
    .catch((e) => { $("asof").textContent = `Couldn't load the performance data (${e.message}).`; });
})();
