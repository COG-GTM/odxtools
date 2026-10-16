"use strict";
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"}[c]));
const hex2 = n => "0x" + Number(n).toString(16).toUpperCase().padStart(3, "0");
const PALETTE = ["#0078d6", "#1c1c1c", "#5c7f99", "#00406f", "#6e6e6e", "#3a8fd9", "#2f4a5c", "#8a8a8a", "#004f8f", "#454545"];

async function api(path, opts = {}) {
  const r = await fetch(path, {headers: {"Content-Type": "application/json"}, ...opts,
    body: opts.body && typeof opts.body !== "string" && !(opts.body instanceof FormData) ? JSON.stringify(opts.body) : opts.body});
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.detail || r.statusText);
  return j;
}

const S = {db: null, summary: null, layer: null, service: null, detail: null, polling: null, after: 0, frameTimes: []};

// ---------------------------------------------------------------- tabs
$$("#tabs button").forEach(b => b.onclick = () => {
  $$("#tabs button").forEach(x => x.classList.toggle("active", x === b));
  $$(".tab").forEach(t => t.classList.toggle("active", t.id === "tab-" + b.dataset.tab));
});

// ---------------------------------------------------------------- databases
async function loadDatabases(select) {
  const dbs = await api("/api/databases");
  for (const id of ["dbSelect", "cmpOld", "cmpNew"]) {
    $("#" + id).innerHTML = dbs.map(d => `<option>${esc(d.name)}</option>`).join("");
  }
  if (dbs.length > 1) $("#cmpNew").value = dbs.find(d => d.name.includes("modified"))?.name || dbs[1].name;
  $("#cmpOld").value = "somersault.pdx";
  $("#dbSelect").value = select || dbs[0].name;
  await openDb($("#dbSelect").value);
}
$("#dbSelect").onchange = e => openDb(e.target.value);
$("#upload").onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  const fd = new FormData(); fd.append("file", f);
  $("#loadInfo").textContent = "loading " + f.name + "…";
  try { const r = await fetch("/api/upload", {method: "POST", body: fd}); const j = await r.json();
    if (!r.ok) throw new Error(j.detail); await loadDatabases(j.name); }
  catch (err) { $("#loadInfo").textContent = err.message; }
};

async function openDb(name) {
  S.db = name;
  S.summary = await api(`/api/db/${encodeURIComponent(name)}`);
  $("#loadInfo").textContent = `parsed in ${S.summary.load_time_ms} ms by odxtools.load_pdx_file()`;
  renderOverview();
  const layers = S.summary.layers;
  const opts = layers.map(l => `<option value="${esc(l.name)}">${esc(l.name)} · ${esc(l.variant_type)}</option>`).join("");
  $("#svcLayer").innerHTML = opts; $("#decLayer").innerHTML = opts;
  const ecus = layers.filter(l => l.variant_type === "ECU-VARIANT");
  $("#liveLayer").innerHTML = ecus.map(l => `<option>${esc(l.name)}</option>`).join("");
  const def = ecus[ecus.length - 1] || layers[layers.length - 1];
  $("#svcLayer").value = def.name; $("#decLayer").value = def.name;
  const lazy = secLayer() || ecus.find(l => l.state_charts.length); if (lazy) $("#liveLayer").value = lazy.name;
  updateLiveChartOptions();
  secOnDb();
  selectLayer(def.name);
}

// ---------------------------------------------------------------- overview
function renderOverview() {
  const s = S.summary, L = s.layers;
  const svcNames = new Set(L.flatMap(l => l.services.map(x => x.name)));
  const dops = L.reduce((a, l) => a + l.dops, 0);
  const stats = [
    ["Diag layers", L.length], ["ECU variants", L.filter(l => l.variant_type === "ECU-VARIANT").length],
    ["Services", svcNames.size], ["Data object props", dops],
    ["Comparam subsets", s.comparam_subsets.length], ["State charts", L.reduce((a, l) => a + l.state_charts.length, 0)]];
  $("#stats").innerHTML = stats.map(([l, v]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");

  // inheritance graph
  const cols = {"PROTOCOL": 0, "FUNCTIONAL-GROUP": 1, "BASE-VARIANT": 2, "ECU-SHARED-DATA": 1, "ECU-VARIANT": 3};
  const byCol = {}; L.forEach(l => (byCol[cols[l.variant_type] ?? 1] ||= []).push(l));
  const usedCols = Object.keys(byCol).map(Number).sort();
  const W = 720, colW = W / usedCols.length, boxW = Math.min(196, colW - 34), boxH = 58;
  const maxRows = Math.max(...Object.values(byCol).map(a => a.length));
  const gap = 30 + 13 * Math.max(0, ...L.map(l => l.not_inherited.length));
  const H = Math.max(180, maxRows * (boxH + gap) + 30);
  const pos = {};
  usedCols.forEach((c, ci) => byCol[c].forEach((l, i) => {
    const n = byCol[c].length, y = H / 2 + (i - (n - 1) / 2) * (boxH + gap);
    pos[l.name] = {x: ci * colW + (colW - boxW) / 2, y: y - boxH / 2, l};
  }));
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%"><defs><marker id="ar" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#9a9a9a"/></marker></defs>`;
  for (const l of L) for (const p of l.parents) {
    const a = pos[p], b = pos[l.name]; if (!a || !b) continue;
    const x1 = a.x + boxW, y1 = a.y + boxH / 2, x2 = b.x, y2 = b.y + boxH / 2, mx = (x1 + x2) / 2;
    svg += `<path d="M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}" stroke="#9a9a9a" fill="none" stroke-width="1.2" marker-end="url(#ar)"/>`;
    l.not_inherited.forEach((n, k) => svg += `<text x="${b.x + 10}" y="${b.y + boxH + 14 + 13 * k}" fill="#d92121" font-size="10.5">&#10005; ${esc(n)} <tspan fill="#767676">not inherited</tspan></text>`);
  }
  for (const {x, y, l} of Object.values(pos)) {
    svg += `<g><rect x="${x}" y="${y}" width="${boxW}" height="${boxH}" fill="#fff" stroke="${l.variant_type === "ECU-VARIANT" ? "#000" : "#bdbdbd"}" stroke-width="${l.variant_type === "ECU-VARIANT" ? 1.4 : 1}"/>
      <text x="${x + 10}" y="${y + 18}" fill="#767676" font-size="9" letter-spacing="1.2">${esc(l.variant_type)}</text>
      <text x="${x + 10}" y="${y + 35}" fill="#000" font-size="12.5" font-weight="600">${esc(l.name)}</text>
      <text x="${x + 10}" y="${y + 50}" fill="#767676" font-size="10">${l.services.length} services · ${l.dops} DOPs</text></g>`;
  }
  $("#inherit").innerHTML = svg + "</svg>";

  // comparams
  const cp = L.filter(l => Object.keys(l.comparams).length);
  $("#comparams").innerHTML = `<table><tr><th>Layer</th><th>ECU RX</th><th>ECU TX</th><th>Baudrate</th></tr>` + cp.map(l =>
    `<tr><td>${esc(l.name)}</td><td class="mono">${l.comparams.can_receive_id != null ? hex2(l.comparams.can_receive_id) : "–"}</td><td class="mono">${l.comparams.can_send_id != null ? hex2(l.comparams.can_send_id) : "–"}</td><td class="mono">${l.comparams.baudrate ? l.comparams.baudrate / 1000 + " kbit/s" : "–"}</td></tr>`).join("") + `</table>`;
  $("#revisions").innerHTML = s.revisions.map(r => `<div class="rev"><b>${esc(r.label)}</b> <span class="muted small">${esc(r.date || "")} ${r.state ? "· " + esc(r.state) : ""} ${r.tool ? "· " + esc(r.tool) : ""}</span>
    ${r.changes.map(c => `<div class="small">• ${esc(c.change)}${c.reason ? ` <span class="muted">— ${esc(c.reason)}</span>` : ""}</div>`).join("")}</div>`).join("") || `<div class="muted">none</div>`;

  // matrix
  const svcLayers = L.filter(l => l.variant_type !== "PROTOCOL");
  const order = [...new Set(svcLayers.flatMap(l => l.services.map(x => x.name)))];
  let m = `<table class="matrix"><tr><th>Service</th><th>SID</th>${svcLayers.map(l => `<th>${esc(l.name)}</th>`).join("")}</tr>`;
  for (const name of order) {
    const anySvc = svcLayers.flatMap(l => l.services).find(x => x.name === name);
    m += `<tr><td>${esc(name)} ${anySvc.semantic ? `<span class="badge">${esc(anySvc.semantic)}</span>` : ""}</td><td class="mono">${esc(anySvc.request_hex || "")}</td>`;
    for (const l of svcLayers) {
      const sv = l.services.find(x => x.name === name);
      m += sv ? (sv.own ? `<td class="m-own">●</td>` : `<td class="m-inh">○</td>`) : (l.not_inherited.includes(name) ? `<td class="m-not">✕</td>` : `<td class="m-abs">–</td>`);
    }
    m += `</tr>`;
  }
  $("#matrix").innerHTML = m + `</table>`;
}

// ---------------------------------------------------------------- service inspector
$("#svcLayer").onchange = e => selectLayer(e.target.value);
function selectLayer(name) {
  S.layer = S.summary.layers.find(l => l.name === name);
  $("#svcList").innerHTML = S.layer.services.map(s => `<div class="svc" data-s="${esc(s.name)}"><span>${esc(s.name)}</span><span class="sid">${esc(s.request_hex || "")}</span></div>`).join("") || `<div class="muted">no services</div>`;
  $$("#svcList .svc").forEach(el => el.onclick = () => selectService(el.dataset.s));
  if (S.layer.services.length) selectService((S.layer.services.find(s => s.name === "do_forward_flips") || S.layer.services[0]).name);
  else {
    S.detail = null;
    $("#svcHeader").innerHTML = `<div class="muted">${esc(S.layer.name)} defines no diagnostic services.</div>`;
    $("#encForm").innerHTML = ""; $("#encOut").innerHTML = ""; $("#svcLayouts").innerHTML = "";
  }
}

async function selectService(name) {
  $$("#svcList .svc").forEach(el => el.classList.toggle("active", el.dataset.s === name));
  const db = S.db, layer = S.layer;
  const d = await api(`/api/db/${encodeURIComponent(db)}/layer/${layer.name}/service/${name}`);
  if (S.db !== db || S.layer !== layer || !$(`#svcList .svc.active[data-s="${CSS.escape(name)}"]`)) return;
  S.detail = d;
  $("#svcHeader").innerHTML = `<div class="row" style="margin:0"><h2 class="svc-title">${esc(d.name)}</h2>
    <span class="badge">${esc(d.semantic || "")}</span>${d.preconditions.length ? `<span class="badge gnr">pre-conditions: ${esc(d.preconditions.join(", "))}</span>` : ""}</div>
    ${d.description || d.long_name ? `<div class="muted" style="margin-top:6px">${esc(d.description || d.long_name)}</div>` : ""}`;
  buildForm($("#encForm"), d.request, () => encodeNow());
  encodeNow();
  const blocks = [["req", "Request", d.request ? [d.request] : []], ["pos", "Positive response", d.positive_responses], ["neg", "Negative response", d.negative_responses], ["gnr", "Global negative response", d.global_negative_responses]];
  $("#svcLayouts").innerHTML = blocks.filter(b => b[2].length).map(([cls, title, objs]) => `<div class="card"><h2>${title}s</h2>${objs.map(o => layoutHtml(o, cls)).join("")}</div>`).join("");
}

function buildForm(el, req, onchange) {
  if (!req) { el.innerHTML = `<div class="muted">This service has no request.</div>`; return; }
  const settable = req.params.filter(p => p.settable);
  el.innerHTML = settable.map(p => {
    const dop = p.dop || {};
    let input;
    if (dop.texttable) input = `<select data-p="${esc(p.name)}">${dop.texttable.map(v => `<option>${esc(v.physical)}</option>`).join("")}</select>`;
    else input = `<input data-p="${esc(p.name)}" value="${esc(p.default ?? exampleValue(p))}">`;
    return `<div class="f"><label>${esc(p.name)}${p.required ? " *" : ""}</label>${input}<div class="hint">${esc(dop.name || p.type)} · ${esc(dop.physical_type || "")}${dop.unit ? " · " + esc(dop.unit) : ""}${p.bit_length ? " · " + p.bit_length + " bit" : ""}</div></div>`;
  }).join("") || `<div class="muted">No settable parameters — the request is fully constant.</div>`;
  $$("[data-p]", el).forEach(i => i.oninput = onchange);
}
function exampleValue(p) {
  if (p.name.includes("soberness")) return "0x12";
  if (p.name === "num_flips") return "5";
  if (p.name === "duration") return "3";
  if (p.name === "bribe") return "1";
  return "0";
}
function formValues(el) { const o = {}; $$("[data-p]", el).forEach(i => o[i.dataset.p] = i.value); return o; }

let encTimer;
function encodeNow() {
  clearTimeout(encTimer);
  encTimer = setTimeout(async () => {
    const detail = S.detail;
    if (!detail?.request) { $("#encOut").innerHTML = ""; return; }
    try {
      const r = await api(`/api/db/${encodeURIComponent(S.db)}/encode`, {method: "POST", body: {layer: S.layer.name, service: detail.name, params: formValues($("#encForm"))}});
      if (S.detail !== detail) return;
      $("#encOut").innerHTML = bytesHtml(r) + paramsKv(r.params) + `<div class="muted small" style="margin-top:6px">Round-trip: encoded by odxtools, then re-decoded with <code>DiagLayer.decode()</code> → identified as <b>${esc(r.coding_object)}</b></div>`;
    } catch (e) { $("#encOut").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  }, 120);
}

function bytesHtml(msg) {
  const bytes = msg.hex.match(/../g) || [];
  const colors = {}; (msg.spans || []).forEach((s, i) => colors[s.param] = PALETTE[i % PALETTE.length]);
  const owner = bytes.map((_, i) => (msg.spans || []).find(s => i >= s.start && i < s.start + s.length));
  return `<div class="bytes">${bytes.map((b, i) => {
    const o = owner[i], c = o ? colors[o.param] : "#9a9a9a";
    return `<div class="byte" style="background:${c}" title="byte ${i}${o ? " · " + esc(o.param) : ""}">${b.toUpperCase()}<small>${o && o.start === i ? esc(o.param) : "&nbsp;"}</small></div>`;
  }).join("")}</div>`;
}
function paramsKv(params) {
  const flat = []; const walk = (o, pre) => {
    if (Array.isArray(o) && o.length === 2 && typeof o[0] === "string") { flat.push([pre, o[0]]); walk(o[1], pre + "." + o[0]); return; }
    if (o && typeof o === "object") { for (const [k, v] of Object.entries(o)) walk(v, pre ? pre + "." + k : k); return; }
    flat.push([pre, o]);
  };
  walk(params, "");
  return `<div class="kv" style="margin-left:0">${flat.map(([k, v]) => `<span><b>${esc(k)}</b> = ${esc(typeof v === "number" && Number.isInteger(v) && k.endsWith("sid") ? "0x" + v.toString(16) : v)}</span>`).join("")}</div>`;
}

function layoutHtml(o, cls) {
  const rows = o.params.map((p, i) => {
    const d = p.dop || {};
    let val = p.coded_value != null ? `<span class="mono">${esc(Array.isArray(p.coded_value) ? p.coded_value.join(" | ") : "0x" + Number(p.coded_value).toString(16))}</span>` : "";
    if (d.texttable) val = d.texttable.map(t => `<span class="mono">${esc(t.internal)}→"${esc(t.physical)}"</span>`).join(" ");
    if (p.table) val = `table <b>${esc(p.table.name)}</b>: ${p.table.rows.map(esc).join(", ")}`;
    return `<tr><td><i style="display:inline-block;width:10px;height:10px;background:${PALETTE[i % PALETTE.length]}"></i> <b>${esc(p.name)}</b></td><td>${esc(p.type)}</td>
      <td class="mono">${p.byte_position ?? "–"}${p.bit_position ? "." + p.bit_position : ""}</td><td class="mono">${p.bit_length ?? "var"}</td>
      <td>${esc(d.name || "")}${d.compu_method ? ` <span class="badge">${esc(d.compu_method)}</span>` : ""}</td><td class="mono">${esc(d.coded_type || "")}</td><td>${esc(d.unit || "")}</td><td>${val}</td></tr>`;
  }).join("");
  const label = {req: "REQUEST", pos: "POSITIVE", neg: "NEGATIVE", gnr: "GLOBAL NEG"}[cls];
  return `<div class="layout"><div class="title"><span class="badge ${cls}">${label}</span><b>${esc(o.name)}</b></div>
    <table><tr><th>Parameter</th><th>Kind</th><th>Byte</th><th>Bits</th><th>DOP / compu-method</th><th>Coded type</th><th>Unit</th><th>Constant / values</th></tr>${rows}</table></div>`;
}

// ---------------------------------------------------------------- decoder
$("#decGo").onclick = decodeNow;
$$(".chip[data-hex]").forEach(c => c.onclick = () => { $("#decHex").value = c.dataset.hex; $("#decReq").value = c.dataset.req; decodeNow(); });
async function decodeNow() {
  try {
    const r = await api(`/api/db/${encodeURIComponent(S.db)}/decode`, {method: "POST", body: {layer: $("#decLayer").value, hex: $("#decHex").value, request_hex: $("#decReq").value || null}});
    $("#decOut").innerHTML = r.map(m => `<div class="card" style="background:var(--panel2)"><div class="row" style="margin:0"><span class="badge ${kindCls(m.kind)}">${esc(m.kind.toUpperCase())}</span>
      <b>${esc(m.coding_object)}</b> ${m.service ? `<span class="muted">of service ${esc(m.service)}</span>` : ""}</div>${bytesHtml(m)}${paramsKv(m.params)}</div>`).join("");
  } catch (e) { $("#decOut").innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}
const kindCls = k => ({request: "req", positive: "pos", negative: "neg", global_negative: "gnr"}[k] || "");

// ---------------------------------------------------------------- compare
$("#cmpGo").onclick = async () => {
  const r = await api(`/api/compare?old=${encodeURIComponent($("#cmpOld").value)}&new=${encodeURIComponent($("#cmpNew").value)}`);
  $("#cmpTime").textContent = `diffed in ${r.time_ms.toFixed(1)} ms`;
  if (!r.changes) { $("#cmpOut").innerHTML = `<div class="card">No differences.</div>`; return; }
  const sm = r.summary, c = r.changes;
  const cards = [["New layers", sm.new_layers], ["Deleted layers", sm.deleted_layers], ["Changed layers", sm.changed_layers], ["Renamed services", sm.renamed_services], ["Changed services", sm.changed_services], ["Change score", sm.total_change_score]];
  let h = `<div class="stats">${cards.map(([l, v]) => `<div class="stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("")}</div><div class="card">`;
  for (const l of c.new_diagnostic_layers) h += `<div class="diff-layer" style="border-color:var(--ok)"><span class="badge pos">NEW LAYER</span> <b>${esc(l.short_name)}</b> <span class="muted">${esc(l.variant_type)}</span></div>`;
  for (const l of c.deleted_diagnostic_layers) h += `<div class="diff-layer" style="border-color:var(--bad)"><span class="badge neg">DELETED LAYER</span> <b>${esc(l.short_name)}</b></div>`;
  for (const l of c.changed_diagnostic_layers) {
    h += `<div class="diff-layer"><div class="row" style="margin:0"><span class="badge">${esc(l.diag_layer_type)}</span><b>${esc(l.diag_layer)}</b><span class="muted small">score ${l.change_score}</span></div>`;
    for (const s of l.new_services) h += `<div class="chg new">+ service ${esc(s.short_name || s)}</div>`;
    for (const s of l.deleted_services) h += `<div class="chg old">- service ${esc(s.short_name || s)}</div>`;
    for (const s of l.renamed_services) h += `<div class="chg">renamed <span class="old">${esc(s.old_service_name)}</span> → <span class="new">${esc(s.new_service_name)}</span></div>`;
    for (const s of l.services_with_parameter_changes) {
      h += `<div style="margin:8px 0 4px"><b>${esc(s.service.short_name)}</b></div>`;
      for (const p of s.changed_parameters) {
        h += `<div class="muted small" style="margin-left:12px">${esc(p.description)}</div><table style="margin:2px 0 6px 12px;width:calc(100% - 12px)">` + p.changed_attributes.map(a =>
          `<tr><td style="width:40%">${esc(a.attribute)}</td><td class="chg"><span class="old">${esc(a.old_value)}</span></td><td class="chg"><span class="new">${esc(a.new_value)}</span></td></tr>`).join("") + `</table>`;
      }
    }
    h += `</div>`;
  }
  $("#cmpOut").innerHTML = h + `</div>`;
};

// ---------------------------------------------------------------- live
function liveLayerSummary() { return S.summary.layers.find(l => l.name === $("#liveLayer").value); }
function updateLiveChartOptions() {
  const l = liveLayerSummary(); if (!l) return;
  $("#liveChart").innerHTML = l.state_charts.length ? l.state_charts.map(c => `<option value="${esc(c.name)}">${esc(c.name)} (${esc(c.semantic || "")})</option>`).join("") : `<option value="">(none)</option>`;
  const pref = l.state_charts.find(c => c.name === SEC_CHART) || l.state_charts.find(c => c.name.includes("angry")); if (pref) $("#liveChart").value = pref.name;
  $("#liveSvc").innerHTML = l.services.map(s => `<option>${esc(s.name)}</option>`).join("");
  $("#liveSvc").value = l.services.find(s => s.name === "session_start") ? "session_start" : l.services[0]?.name;
  loadLiveSvcForm();
}
$("#liveLayer").onchange = () => { updateLiveChartOptions(); connectLive(); };
$("#liveChart").onchange = async () => { if (!$("#liveChart").value) return; await api("/api/live/chart", {method: "POST", body: {chart: $("#liveChart").value}}); drawChart(); };
$("#liveSvc").onchange = loadLiveSvcForm;
async function loadLiveSvcForm() {
  const name = $("#liveSvc").value, db = S.db, layer = $("#liveLayer").value; if (!name) return;
  const d = await api(`/api/db/${encodeURIComponent(db)}/layer/${layer}/service/${name}`);
  if (db !== S.db || layer !== $("#liveLayer").value || name !== $("#liveSvc").value) return;
  buildForm($("#liveForm"), d.request, () => {});
}
$("#liveStart").onclick = connectLive;
$("#liveReset").onclick = async () => {
  if (!S.live) return;
  S.gen = (S.gen || 0) + 1;
  let st; try { st = await api(`/api/live/reset?session=${S.live.session}`, {method: "POST"}); } catch { poll(); return; }
  if (!S.live || st.session !== S.live.session) return;
  S.gen++; S.after = Math.max(S.after, st.seq); S.live.charts = null; S.lastTrans = null; poll();
};

async function connectLive() {
  const conn = S.conn = (S.conn || 0) + 1;
  S.gen = (S.gen || 0) + 1;
  const st = await api("/api/live/start", {method: "POST", body: {db: S.db, layer: $("#liveLayer").value, chart: $("#liveChart").value || null}});
  if (conn !== S.conn) return;
  adoptSession(st);
  if (!S.polling) S.polling = setInterval(poll, 250);
  poll();
}

// Follow the server's session when it matches the selected ECU (e.g. after overlapping reconnects or another tab).
function adoptSession(st) {
  S.gen = (S.gen || 0) + 1; S.after = 0; S.live = st; S.frameTimes = []; S.lastTrans = null;
  if (st.chart && [...$("#liveChart").options].some(o => o.value === st.chart)) $("#liveChart").value = st.chart;
  $("#txlog").innerHTML = ""; $("#trace tbody").innerHTML = ""; secClear();
  $("#liveIds").innerHTML = `<span class="pill on">Connected</span> tester → ECU <code>${hex2(st.rx_id)}</code> · ECU → tester <code>${hex2(st.tx_id)}</code> · 500 kbit/s virtual CAN`;
  $("#liveStart").textContent = "Reconnect"; $("#liveReset").disabled = false;
  drawChart();
}

async function sendLive(body) {
  if (!S.live) await connectLive();
  try { const tx = await api("/api/live/send", {method: "POST", body}); await poll(); return tx; }
  catch (e) { addTxError(e.message); }
}
$("#liveSend").onclick = () => sendLive({service: $("#liveSvc").value, params: formValues($("#liveForm"))});
$("#liveSendRaw").onclick = () => sendLive({raw: $("#liveRaw").value});
$("#liveLong").onclick = () => { $("#liveRaw").value = "ba 12 03 " + Array.from({length: 17}, (_, i) => (0xa0 + i).toString(16)).join(" "); sendLive({raw: $("#liveRaw").value}); };

async function poll() {
  const gen = S.gen;
  let st; try { st = await api(`/api/live/poll?after=${S.after}`); } catch { return; }
  if (gen !== S.gen || !st.running || !S.live) return;
  if (st.session !== S.live.session) {
    if (st.db === S.db && st.layer === $("#liveLayer").value) { adoptSession(st); return poll(); }
    S.gen++; S.live = null; S.lastTrans = null;
    $("#liveIds").innerHTML = `<span class="pill off">Disconnected</span> Another client replaced the live session (${esc(st.db)} / ${esc(st.layer)}). Connect or send to start a session for the selected ECU.`;
    $("#liveStart").textContent = "Connect"; $("#liveReset").disabled = true;
    $("#txlog").innerHTML = ""; $("#trace tbody").innerHTML = ""; $("#gauges").innerHTML = ""; $("#frameRate").textContent = ""; secClear();
    drawChart();
    return;
  }
  const seen = S.after, fresh = x => x.seq > seen, prevTrans = S.lastTrans;
  for (const f of st.frames.filter(fresh)) addFrame(f);
  for (const t of st.transactions.filter(fresh)) {
    addTx(t); secAddTx(t);
    if (!t.blocked && t.state_before && t.state_before !== t.state_after) S.lastTrans = {chart: t.chart, from: t.state_before, to: t.state_after, service: t.service};
  }
  const all = [...st.frames, ...st.transactions]; if (all.length) S.after = Math.max(S.after, ...all.map(x => x.seq));
  renderGauges(st.ecu); secStatus(st);
  const chartsChanged = JSON.stringify(st.charts) !== JSON.stringify(S.live?.charts);
  if (chartsChanged) S.live = {...S.live, ...st};
  if (chartsChanged || S.lastTrans !== prevTrans) drawChart();
  S.live.chart = st.chart;
  const now = performance.now(); S.frameTimes = S.frameTimes.filter(t => now - t < 5000);
  $("#frameRate").textContent = `${st.frame_count} frames captured by passive sniffer · ${(S.frameTimes.length / 5).toFixed(1)} frames/s`;
}

function addFrame(f) {
  S.frameTimes.push(performance.now());
  const tb = $("#trace tbody"), tr = document.createElement("tr");
  tr.className = f.node + " new";
  const bytes = f.data.match(/../g).map((b, i) => i === 0 ? `<b>${b}</b>` : b).join(" ");
  tr.innerHTML = `<td>${f.seq}</td><td>${f.t.toFixed(2)}</td><td>${hex2(f.id)}</td><td>${f.node === "ECU" ? "ECU →" : "→ Tester"}</td><td><span class="isotp ${f.isotp}">${f.isotp}</span></td><td>${bytes}</td><td>${f.telegram.map(t => `<span class="telegram">${t}</span>`).join(" ")}</td>`;
  tr.cells[3].textContent = f.node === "ECU" ? "ECU → tester" : "tester → ECU";
  tb.appendChild(tr);
  while (tb.rows.length > 400) tb.deleteRow(0);
  const w = $(".tracewrap"); w.scrollTop = w.scrollHeight;
}

function addTx(t) {
  const el = document.createElement("div");
  const resp = t.response;
  const cls = t.blocked ? "blocked" : resp ? (resp.kind === "positive" ? "pos" : "neg") : "neg";
  el.className = "tx " + cls;
  const stateChange = t.state_before && t.state_before !== t.state_after ? `<span class="badge gnr">${esc(t.state_before)} → ${esc(t.state_after)}</span>` : "";
  el.innerHTML = `<div class="hd"><b>${esc(t.service || t.request.coding_object || "raw telegram")}</b><span>${stateChange} <span class="muted small">${t.blocked ? "" : `${t.frames ?? "?"} frames · ${t.latency_ms} ms`}</span></span></div>
    <div class="line"><span class="arrow">→</span><span class="badge req">REQ</span><span>${spaced(t.request.hex)}</span><span class="muted">${esc(t.request.coding_object || "")}</span></div>${paramsKvSmall(t.request.params)}
    ${t.blocked ? `<div class="line"><span class="arrow">&times;</span><span class="note">Blocked, not sent: odxtools StateMachine — no PRE-CONDITION-STATE-REF of <b>${esc(t.service)}</b> applies in state <b>${esc(t.state_before)}</b> of ${esc(t.chart)}</span></div>` :
      resp ? `<div class="line"><span class="arrow">←</span><span class="badge ${kindCls(resp.kind)}">${esc(resp.kind.replace("_", " ").toUpperCase())}</span><span>${spaced(resp.hex)}</span><span class="muted">${esc(resp.coding_object || "")}</span></div>${paramsKvSmall(resp.params)}` :
      `<div class="line"><span class="arrow">←</span><span class="note bad">Timeout, no response</span></div>`}`;
  const log = $("#txlog"); log.prepend(el);
  while (log.children.length > 60) log.lastChild.remove();
}
function addTxError(msg) { secTlError(msg); const el = document.createElement("div"); el.className = "tx neg"; el.innerHTML = `<div class="err">${esc(msg)}</div>`; $("#txlog").prepend(el); }
const spaced = h => (h.match(/../g) || []).join(" ").toUpperCase();
function paramsKvSmall(p) { const h = paramsKv(p); return h.replace('style="margin-left:0"', ""); }

function renderGauges(e) {
  const g = (label, v, max, lim, unit, col) => `<div class="gauge"><div class="lab"><span>${label}</span><span class="mono">${v}${unit}</span></div><div class="bar"><div class="fill" style="width:${Math.min(100, v / max * 100)}%;background:${col(v)}"></div>${lim ? `<div class="lim" style="left:${lim / max * 100}%" title="limit ${lim}"></div>` : ""}</div></div>`;
  $("#gauges").innerHTML = `<div class="row" style="margin:0 0 6px"><span class="pill ${e.session_active ? "on" : "off"}">${e.session_active ? "Session active" : "No session"}</span>${e.fire_ring ? `<span class="pill fire">Fire ring</span>` : ""}<span class="muted small">${e.total_flips} flips total</span></div>` +
    g("Dizziness", e.dizziness, 255, e.limits.dizziness, "", v => v >= e.limits.dizziness ? "#d92121" : v > e.limits.dizziness * .7 ? "#e09400" : "#000") +
    g("Temperature", e.temperature, 100, e.limits.temperature, " °C", v => v >= e.limits.temperature ? "#d92121" : v > e.limits.temperature * .85 ? "#e09400" : "#000") +
    g("Happiness", e.happiness, 255, 0, "", () => "#0078d6");
}

function drawChart() {
  const l = liveLayerSummary(); const name = $("#liveChart").value;
  const sc = l?.state_charts.find(c => c.name === name);
  if (!sc) { $("#chartSvg").innerHTML = `<div class="muted" style="padding:30px 0">This ECU variant defines no STATE-CHARTs.</div>`; $("#chartName").textContent = ""; }
  else {
    $("#chartName").textContent = `${sc.name} · start: ${sc.start}`;
    $("#chartSvg").innerHTML = chartHtml(sc, S.live?.charts?.[sc.name] || sc.start, "live");
  }
  secChart();
}

// SVG + transition table of a STATE-CHART; the transition which actually ran last is highlighted
function chartHtml(sc, active, mid) {
  const two = sc.states.length === 2, W = 400, H = two ? 220 : 360, cx = W / 2, cy = H / 2 + 6, R = 132;
  const lt = S.lastTrans?.chart === sc.name && S.lastTrans.to === active ? S.lastTrans : null;
  const ran = lt && sc.transitions.find(t => t.from === lt.from && t.to === lt.to && (!lt.service || t.services.includes(lt.service)));
  const pos = {}; sc.states.forEach((s, i) => { const a = two ? Math.PI * (i + 1) : -Math.PI / 2 + i * 2 * Math.PI / sc.states.length; pos[s] = [cx + R * Math.cos(a), cy + R * Math.sin(a)]; });
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%"><defs><marker id="ar-${mid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#9a9a9a"/></marker><marker id="arr-${mid}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#000"/></marker></defs>`;
  for (const t of sc.transitions) {
    const [x1, y1] = pos[t.from], [x2, y2] = pos[t.to];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, bend = two ? 46 : 30;
    const sx = x1 + dx / len * 34, sy = y1 + dy / len * 22, ex = x2 - dx / len * 36, ey = y2 - dy / len * 24;
    const mx = (sx + ex) / 2 + nx * bend, my = (sy + ey) / 2 + ny * bend;
    const trig = t.services.length, on = t === ran;
    svg += `<path${on ? ' class="ran"' : ""} d="M${sx},${sy} Q${mx},${my} ${ex},${ey}" fill="none" stroke="${on ? "#000" : trig ? "#0078d6" : "#bdbdbd"}" stroke-width="${on ? 2.6 : trig ? 1.5 : 1}" marker-end="url(#${on ? "arr" : "ar"}-${mid})"/>`;
    if (on) svg += `<text x="${mx + nx * 14}" y="${my + ny * 14 + 4}" font-size="11" text-anchor="middle" fill="#000" font-weight="600">${esc(t.name)}</text>`;
  }
  for (const s of sc.states) {
    const [x, y] = pos[s], on = s === active;
    svg += `<g><ellipse cx="${x}" cy="${y}" rx="44" ry="22" fill="${on ? "#000" : "#fff"}" stroke="${on ? "#000" : "#bdbdbd"}" stroke-width="1.2"></ellipse>
      <text x="${x}" y="${y + 4}" font-size="11.5" text-anchor="middle" fill="${on ? "#fff" : "#333"}" font-weight="${on ? 600 : 400}">${esc(s)}</text></g>`;
  }
  const rows = sc.transitions.map(t => `<tr${t === ran ? ' class="cur"' : ""}><td>${esc(t.name)}</td><td class="mono">${esc(t.from)} &rarr; ${esc(t.to)}</td><td class="mono">${esc([...new Set(t.services)].join(", ") || "\u2013")}</td></tr>`).join("");
  return svg + `</svg><table class="transitions"><tr><th>Transition</th><th>States</th><th>Triggered by</th></tr>${rows}</table>`;
}

// ---------------------------------------------------------------- security access (UDS 0x27)
const SEC_CHART = "security_chart", SEC_DEMO_DB = "somersault_security.pdx", SEC_MASK = [0x5a, 0x5a, 0x5a, 0x5a];
const SEC_SERVICES = new Set(["security_request_seed", "security_send_key", "headstand", "session_start", "session_stop"]);
const NRC_INFO = {
  0x24: ["RequestSequenceError", "A key was sent without a preceding seed request; the ECU discards a seed after one key."],
  0x35: ["InvalidKey", "The key does not match the demo algorithm for the current seed. The state chart stays locked."],
  0x36: ["ExceededNumberOfAttempts", "Third wrong key in a row: the ECU starts its modeled 10 s lockout delay."],
  0x37: ["RequiredTimeDelayNotExpired", "The modeled lockout delay is still running, so the ECU refuses seed and key requests."],
};
const Sec = {seed: null, seedUsed: false, seedNrc: null, calc: null, key: null, wrong: false, keyResult: null, busy: false, unlocking: false, state: null, sec: null, lastProt: null};

function secLayer() { return S.summary?.layers.find(l => l.state_charts.some(c => c.name === SEC_CHART) && l.services.some(s => s.name === "security_request_seed")); }
function secLive() { const l = secLayer(); return !!(l && S.live && S.live.db === S.db && S.live.layer === l.name); }
const hexBytes = h => (String(h || "").replace(/^0x/, "").match(/../g) || []).map(b => parseInt(b, 16));
const bhex = b => Number(b).toString(16).toUpperCase().padStart(2, "0");
function setHtml(el, h) { if (el._h !== h) { el.innerHTML = h; el._h = h; } }
// demo algorithm, byte by byte: x = seed XOR 5A5A5A5A, key = rotl32(x, 3)
function demoKey(seed) {
  const x = seed.map((b, i) => b ^ SEC_MASK[i]);
  return {x, key: x.map((b, i) => ((b << 3) | (x[(i + 1) % 4] >> 5)) & 0xff)};
}
function nrcOf(r) {
  const code = Number(r.params?.response_code ?? hexBytes(r.hex)[2]);
  const info = NRC_INFO[code] || [r.coding_object || "negative response", ""];
  return ["0x" + bhex(code), info[0], info[1]];
}

function secOnDb() {
  const l = secLayer();
  $("#secEmpty").hidden = !!l; $("#secMain").hidden = !l; $("#demoFlag").hidden = !l;
  $("#secOpenDemo").hidden = ![...$("#dbSelect").options].some(o => o.value === SEC_DEMO_DB);
  secClear();
}
function secClear() {
  Object.assign(Sec, {seed: null, seedUsed: false, seedNrc: null, calc: null, key: null, wrong: false, keyResult: null, unlocking: false, lastProt: null});
  if (!secLive()) { Sec.state = null; Sec.sec = null; }
  $("#secTimeline").innerHTML = `<div class="empty"><div class="hairline"><span></span></div>No 0x27 exchanges yet. Request a seed to start.</div>`;
  secSeedHtml(); secAlgoHtml(); secKeyHtml(); secLockRender(); secProt(); secButtons(); secConnInfo(); secChart();
}
function secConnInfo() {
  const on = secLive();
  setHtml($("#secConnInfo"), on ? `<span class="pill on">Connected</span> ${esc(S.live.layer)} &middot; tester <code>${esc(hex2(S.live.rx_id))}</code> &rarr; ECU <code>${esc(hex2(S.live.tx_id))}</code>` : `<span class="pill off">Not connected</span>`);
  $("#secConnect").textContent = on ? "Reconnect" : "Connect";
}
function secChart() {
  const sc = secLayer()?.state_charts.find(c => c.name === SEC_CHART); if (!sc) return;
  setHtml($("#secChart"), chartHtml(sc, (secLive() && S.live?.charts?.[SEC_CHART]) || sc.start, "sec"));
}

async function secEnsure() {
  const l = secLayer(); if (!l) return false;
  if ($("#liveLayer").value !== l.name) { $("#liveLayer").value = l.name; updateLiveChartOptions(); }
  if ($("#liveChart").value !== SEC_CHART) $("#liveChart").value = SEC_CHART;
  try {
    if (!secLive()) await connectLive();
    else if (S.live.chart !== SEC_CHART) { await api("/api/live/chart", {method: "POST", body: {chart: SEC_CHART}}); S.live.chart = SEC_CHART; drawChart(); }
  } catch (e) { secTlError(e.message); return false; }
  secConnInfo();
  return secLive();
}
async function secTx(body) { return await secEnsure() ? sendLive(body) : null; }
function secAction(fn) {
  return async () => {
    if (Sec.busy) return;
    Sec.busy = true; secButtons();
    try { await fn(); } finally { Sec.busy = false; secButtons(); }
  };
}

function secButtons() {
  const has = !!secLayer(), b = Sec.busy, seedOk = !!Sec.seed && !Sec.seedUsed && Sec.seed.some(x => x);
  for (const id of ["#secSeed", "#secWrong", "#secTry", "#secStop", "#secConnect"]) $(id).disabled = !has || b;
  $("#secCompute").disabled = !has || b || !seedOk || !!Sec.calc;
  $("#secSend").disabled = !has || b || !seedOk || !Sec.calc;
}

const cellsHtml = (bytes, cls, labels, delay = 0) => bytes ?
  bytes.map((b, i) => `<div class="cell v ${cls}" style="animation-delay:${delay + i * 70}ms">${esc(bhex(b))}<small>${esc(labels[i])}</small></div>`).join("") :
  [0, 1, 2, 3].map(() => `<div class="cell">&middot;&middot;<small>&nbsp;</small></div>`).join("");
function secSeedHtml() {
  $("#secSeedCells").innerHTML = cellsHtml(Sec.seed, "seed", ["s0", "s1", "s2", "s3"]);
  const zero = Sec.seed && !Sec.seed.some(x => x), n = $("#secSeedNote");
  n.className = "pnote small " + (Sec.seedNrc ? "bad" : zero ? "good" : "muted");
  n.textContent = Sec.seedNrc ? `${Sec.seedNrc[0]} ${Sec.seedNrc[1]}: no seed issued` : zero ? "All-zero seed: the ECU is already unlocked (ISO 14229-1)" :
    Sec.seed ? (Sec.seedUsed ? "Used: the ECU discards a seed after one key" : "Random 4-byte seed, fresh for every request") : "Request a seed to start.";
  $("#secBoxSeed").className = "pbox" + (Sec.seedNrc ? " bad" : Sec.seed ? " active" : "");
}
function secAlgoHtml() {
  const c = Sec.calc, box = $("#secBoxAlgo");
  box.className = "pbox algo" + (c ? " active" : "");
  if (!c) {
    $("#secAlgo").innerHTML = `<div class="algo-empty">${Sec.wrong ? "Skipped: <b>Send wrong key</b> sends a deliberately corrupted key." : "<b>Compute key</b> runs the demo algorithm on the seed, byte by byte."}</div><div class="algo-f">key = rotl32(seed &oplus; 0x5A5A5A5A, 3)</div>`;
    return;
  }
  const row = (lab, bytes, cls, labels, r) => `<span class="lab">${lab}</span>` + cellsHtml(bytes, cls, labels, r * 260);
  $("#secAlgo").innerHTML = `<div class="algo-grid">
    ${row("seed", Sec.seed, "seed", ["s0", "s1", "s2", "s3"], 0)}
    ${row("&oplus; mask", SEC_MASK, "mask", ["", "", "", ""], 1)}
    ${row("= x", c.x, "x", ["s0^5A", "s1^5A", "s2^5A", "s3^5A"], 2)}
    ${row("rotl32 &laquo;3", c.key, "key", [0, 1, 2, 3].map(i => `x${i}<<3|x${(i + 1) % 4}>>5`), 3)}
  </div><div class="algo-f">key = rotl32(seed &oplus; 0x5A5A5A5A, 3)</div>`;
}
function secKeyHtml(delay = 0) {
  $("#secKeyCells").innerHTML = cellsHtml(Sec.key, Sec.wrong ? "wrong" : "key", Sec.wrong ? ["bad", "bad", "bad", "bad"] : ["k0", "k1", "k2", "k3"], delay);
  const r = Sec.keyResult, n = $("#secKeyNote");
  n.className = "pnote small " + (r ? (r.ok ? "good" : "bad") : "muted");
  n.textContent = r ? (r.ok ? "Accepted: 67 02, security_chart locked \u2192 unlocked" : `Rejected: ${r.nrc ? r.nrc[0] + " " + r.nrc[1] : r.text}`) :
    Sec.key ? (Sec.wrong ? "Deliberately wrong key" : Sec.seedUsed ? "Sent, waiting for the ECU\u2026" : "Ready to send") : "\u00a0";
  $("#secBoxKey").className = "pbox" + (r ? (r.ok ? " good" : " bad") : Sec.key ? " active" : "");
}

function secLockRender() {
  const sec = Sec.sec, conn = secLive(), out = !!(conn && sec && sec.delay_remaining > 0);
  const state = !conn ? "locked" : out ? "lockedout" : Sec.unlocking ? "unlocking" : Sec.state === "unlocked" ? "unlocked" : "locked";
  const box = $("#secLockBox");
  if (box.dataset.state !== state || box.dataset.conn !== String(conn)) {
    box.dataset.state = state; box.dataset.conn = String(conn);
    const [w, sub] = {
      locked: ["Locked", conn ? "security_chart is in state locked: the protected service is refused." : "Connect to the virtual ECU to begin."],
      unlocking: ["Unlocking\u2026", "Key on the bus, waiting for the ECU's verdict."],
      unlocked: ["Unlocked", "Key accepted: security_chart is in state unlocked."],
      lockedout: ["Locked out", "Three wrong keys: the ECU refuses 0x27 until the modeled delay expires."],
    }[state];
    for (const [id, txt] of [["#secLockWord", w], ["#secLockSub", sub]]) { const e = $(id); e.textContent = txt; e.classList.remove("fade"); void e.offsetWidth; e.classList.add("fade"); }
  }
  const n = conn && sec ? sec.attempts : 0, max = sec?.max_attempts || 3, total = sec?.delay || 10, rem = out ? sec.delay_remaining : 0;
  $$("#secDots i").forEach((d, i) => d.classList.toggle("on", i < n));
  $("#secAttempts").textContent = `${n} / ${max}`;
  $("#secRing").style.strokeDashoffset = String(465 * (1 - rem / total));
  const cd = $("#secCountdown"); cd.classList.toggle("on", out);
  cd.textContent = out ? `Lockout ${rem.toFixed(1)} s remaining (modeled delay)` : n ? `${max - n} attempt${max - n === 1 ? "" : "s"} left before the modeled ${total} s lockout` : "\u00a0";
}
function secProt() {
  const conn = secLive(), allowed = conn && Sec.state === "unlocked", pill = $("#secProtPill");
  pill.className = "pill " + (allowed ? "on" : "blk"); pill.textContent = allowed ? "Allowed" : "Blocked";
  setHtml($("#secProtWhy"), `PRE-CONDITION-STATE-REF &rarr; <code>${SEC_CHART}</code> = <code>unlocked</code> &middot; current state <code>${esc(conn ? Sec.state || "locked" : "\u2013")}</code>`);
  const t = Sec.lastProt;
  setHtml($("#secProtLast"), !t ? `<span class="muted">Not tried yet.</span>` :
    t.blocked ? `<span style="color:var(--warn)">#${esc(t.seq)} blocked by the state chart: nothing was sent on the bus.</span>` :
    t.response?.kind === "positive" ? `<span style="color:var(--ok)">#${esc(t.seq)} allowed: ECU answered <span class="mono">${esc(spaced(t.response.hex))}</span> (${esc(t.response.coding_object)}).</span>` :
    `<span style="color:var(--bad)">#${esc(t.seq)} sent, ECU answered <span class="mono">${esc(t.response ? spaced(t.response.hex) : "nothing")}</span>.</span>`);
}
function secStatus(st) {
  if (!secLive()) { secConnInfo(); return; }
  Sec.state = st.charts?.[SEC_CHART] || null; Sec.sec = st.ecu?.security || null;
  secLockRender(); secProt(); secConnInfo();
}

function secAddTx(t) {
  if (!secLive() || !(SEC_SERVICES.has(t.service) || String(t.request?.hex || "").startsWith("27"))) return;
  const tl = $("#secTimeline"); tl.querySelector(".empty")?.remove();
  const r = t.response, el = document.createElement("div");
  el.className = "xchg " + (t.blocked ? "blocked" : r?.kind === "positive" ? "pos" : "neg");
  const st = t.state_before && t.state_before !== t.state_after ? `<span class="badge gnr">${esc(t.state_before)} &rarr; ${esc(t.state_after)}</span>` : t.state_after ? `<span class="badge">${esc(t.state_after)}</span>` : "";
  let resp;
  if (t.blocked) resp = `<div class="nrc blocked"><div class="nh"><span class="code">NOT SENT</span><b>Blocked by the ODX state chart</b></div><div class="small muted" style="margin-left:0">odxtools <code>StateMachine</code>: no PRE-CONDITION-STATE-REF of <code>${esc(t.service)}</code> applies in state <code>${esc(t.state_before)}</code> of <code>${esc(t.chart)}</code>. The telegram never reached the bus.</div></div>`;
  else if (!r) resp = `<div class="nrc"><div class="nh"><b>Timeout, no response</b></div></div>`;
  else if (r.kind === "positive") resp = `<div class="xrow resp"><span class="dir">ECU &rarr; tester<br><span class="badge pos">${esc(r.coding_object)}</span></span>${bytesHtml(r)}</div>`;
  else { const [code, name, why] = nrcOf(r); resp = `<div class="xrow resp"><span class="dir">ECU &rarr; tester<br><span class="badge neg">negative</span></span><div class="nrc"><div class="nh"><span class="code">${esc(code)}</span><b>${esc(name)}</b></div><div class="small muted" style="margin-left:0">${esc(why)}</div>${bytesHtml(r)}</div></div>`; }
  el.innerHTML = `<div class="xh"><span class="mono muted">#${esc(t.seq)}</span><b>${esc(t.service || "raw telegram")}</b>${st}<span class="r muted small">${t.blocked ? "state chart only" : `${esc(t.frames ?? "?")} CAN frames &middot; ${esc(t.latency_ms)} ms`}</span></div>
    <div class="xrow req"><span class="dir">tester &rarr; ECU<br><span class="badge req">${esc(t.request?.coding_object || "request")}</span></span>${bytesHtml(t.request)}</div>${resp}`;
  tl.prepend(el);
  while (tl.children.length > 30) tl.lastChild.remove();
}
function secTlError(msg) {
  const tl = $("#secTimeline"); if (!tl) return; tl.querySelector(".empty")?.remove();
  const el = document.createElement("div"); el.className = "xchg neg";
  el.innerHTML = `<div class="nrc"><div class="nh"><span class="code">ERROR</span><b>Request failed</b></div><div class="small muted" style="margin-left:0">${esc(msg)}</div></div>`;
  tl.prepend(el);
}

async function secRequestSeed() {
  const tx = await secTx({service: "security_request_seed"});
  Object.assign(Sec, {calc: null, key: null, wrong: false, keyResult: null, seedUsed: false, seedNrc: null, seed: null});
  const r = tx?.response;
  if (r?.kind === "positive") Sec.seed = hexBytes(r.params.security_seed);
  else if (r) Sec.seedNrc = nrcOf(r);
  secSeedHtml(); secAlgoHtml(); secKeyHtml(); secButtons();
  return Sec.seed;
}
function secCompute() {
  if (!Sec.seed) return;
  Sec.calc = demoKey(Sec.seed); Sec.key = Sec.calc.key; Sec.wrong = false; Sec.keyResult = null;
  secAlgoHtml(); secKeyHtml(1100); secButtons();
}
async function secSendKey(key, wrong) {
  Object.assign(Sec, {key, wrong, keyResult: null, unlocking: !wrong, seedUsed: !!Sec.seed});
  secSeedHtml(); secKeyHtml(); secLockRender();
  const tx = await secTx({service: "security_send_key", params: {security_key: key.map(bhex).join("")}});
  const r = tx?.response;
  Sec.keyResult = r ? {ok: r.kind === "positive", nrc: r.kind === "positive" ? null : nrcOf(r)} : {ok: false, nrc: null, text: "no response"};
  secKeyHtml();
  if (Sec.unlocking) { await sleep(Sec.keyResult.ok ? 450 : 0); Sec.unlocking = false; }
  secLockRender();
}

$("#secOpenDemo").onclick = async () => { $("#dbSelect").value = SEC_DEMO_DB; await openDb(SEC_DEMO_DB); secEnsure(); };
$("#secConnect").onclick = secAction(async () => {
  const l = secLayer(); if (!l) return;
  $("#liveLayer").value = l.name; updateLiveChartOptions(); $("#liveChart").value = SEC_CHART;
  try { await connectLive(); } catch (e) { secTlError(e.message); }
  secConnInfo();
});
$("#secSeed").onclick = secAction(secRequestSeed);
$("#secCompute").onclick = secCompute;
$("#secSend").onclick = secAction(() => secSendKey(Sec.key, false));
$("#secWrong").onclick = secAction(async () => {
  if (!Sec.seed || Sec.seedUsed) { await secRequestSeed(); await sleep(400); }
  const base = Sec.seed && Sec.seed.some(x => x) ? demoKey(Sec.seed).key : [0, 0, 0, 0];
  Sec.calc = null; secAlgoHtml();
  await secSendKey(base.map((b, i) => i === 3 ? b ^ 0xff : b), true);
});
$("#secTry").onclick = secAction(async () => { const tx = await secTx({service: "headstand", params: {duration: "3"}}); if (tx) Sec.lastProt = tx; secProt(); });
$("#secStop").onclick = secAction(async () => { await secTx({service: "session_stop"}); });
$$("#tabs button").forEach(b => b.addEventListener("click", () => { if (b.dataset.tab === "security" && secLayer() && !secLive()) secEnsure(); }));

// ---------------------------------------------------------------- scenario
const sleep = ms => new Promise(r => setTimeout(r, ms));
$("#liveScenario").onclick = async () => {
  const btn = $("#liveScenario"); btn.disabled = true;
  try {
    await connectLive();
    const has = n => liveLayerSummary().services.some(s => s.name === n);
    const steps = [
      {service: "tester_present"},
      {service: "session_start", params: {bribe: "0"}},
      {service: "session_start", params: {bribe: "1"}},
      {service: "do_forward_flips", params: {forward_soberness_check: "0x12", num_flips: "5"}},
      {service: "report_status"},
      {service: "do_forward_flips", params: {forward_soberness_check: "0x42", num_flips: "2"}},
      has("set_operation_params") ? {service: "set_operation_params", params: {use_fire_ring: "true"}} : null,
      {service: "do_forward_flips", params: {forward_soberness_check: "0x12", num_flips: "5"}},
      {service: "do_forward_flips", params: {forward_soberness_check: "0x12", num_flips: "5"}},
      {service: "do_forward_flips", params: {forward_soberness_check: "0x12", num_flips: "1"}},
      {raw: "ba 12 03 " + Array.from({length: 17}, (_, i) => (0xa0 + i).toString(16)).join(" ")},
      {raw: "31 01 ff 00"},
      {service: "session_stop"},
    ].filter(Boolean);
    for (const st of steps) {
      if (st.service) { $("#liveSvc").value = st.service; await loadLiveSvcForm(); for (const [k, v] of Object.entries(st.params || {})) { const i = $(`#liveForm [data-p="${k}"]`); if (i) i.value = v; } }
      else $("#liveRaw").value = st.raw;
      await sleep(700);
      await sendLive(st.service ? {service: st.service, params: formValues($("#liveForm"))} : {raw: st.raw});
      await sleep(1100);
    }
  } finally { btn.disabled = false; }
};

loadDatabases().then(() => {
  const t = location.hash.slice(1); const b = $(`#tabs button[data-tab="${t}"]`); if (b) b.click();
  if (t === "compare") $("#cmpGo").click();
  if (t === "decode") decodeNow();
  if (t === "live") connectLive();
  if (t === "security" && secLayer()) secEnsure();
});
