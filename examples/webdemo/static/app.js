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
  const lazy = ecus.find(l => l.state_charts.length); if (lazy) $("#liveLayer").value = lazy.name;
  updateLiveChartOptions();
  selectLayer(def.name);
  renderSecurity();
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
  const angry = l.state_charts.find(c => c.name.includes("angry")); if (angry) $("#liveChart").value = angry.name;
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
  $("#txlog").innerHTML = ""; $("#trace tbody").innerHTML = ""; secResetView();
  $("#liveIds").innerHTML = `<span class="pill on">Connected</span> tester → ECU <code>${hex2(st.rx_id)}</code> · ECU → tester <code>${hex2(st.tx_id)}</code> · 500 kbit/s virtual CAN`;
  $("#liveStart").textContent = "Reconnect"; $("#liveReset").disabled = false;
  drawChart();
}

async function sendLive(body) {
  if (!S.live) await connectLive();
  try { const tx = await api("/api/live/send", {method: "POST", body}); await poll(); return tx; }
  catch (e) { addTxError(e.message); secAddError(e.message); }
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
    $("#txlog").innerHTML = ""; $("#trace tbody").innerHTML = ""; $("#gauges").innerHTML = ""; $("#frameRate").textContent = "";
    S.ecu = null; S.gates = {}; secResetView(); drawChart(); renderSecurity();
    return;
  }
  const seen = S.after, fresh = x => x.seq > seen, prevTrans = S.lastTrans;
  for (const f of st.frames.filter(fresh)) addFrame(f);
  for (const t of st.transactions.filter(fresh)) {
    addTx(t); secAddTx(t);
    if (!t.blocked && t.state_before && t.state_before !== t.state_after) S.lastTrans = {chart: t.chart, from: t.state_before, to: t.state_after, service: t.service};
  }
  const all = [...st.frames, ...st.transactions]; if (all.length) S.after = Math.max(S.after, ...all.map(x => x.seq));
  renderGauges(st.ecu);
  S.gates = st.gates || {}; S.ecu = st.ecu;
  const chartsChanged = JSON.stringify(st.charts) !== JSON.stringify(S.live?.charts);
  if (chartsChanged) S.live = {...S.live, ...st};
  if (chartsChanged || S.lastTrans !== prevTrans) drawChart();
  S.live.chart = st.chart;
  const now = performance.now(); S.frameTimes = S.frameTimes.filter(t => now - t < 5000);
  $("#frameRate").textContent = `${st.frame_count} frames captured by passive sniffer · ${(S.frameTimes.length / 5).toFixed(1)} frames/s`;
  renderSecurity();
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
function addTxError(msg) { const el = document.createElement("div"); el.className = "tx neg"; el.innerHTML = `<div class="err">${esc(msg)}</div>`; $("#txlog").prepend(el); }
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
  if (!sc) { $("#chartSvg").innerHTML = `<div class="muted" style="padding:30px 0">This ECU variant defines no STATE-CHARTs.</div>`; $("#chartName").textContent = ""; renderSecurityChart(); return; }
  $("#chartName").textContent = `${sc.name} · start: ${sc.start}`;
  $("#chartSvg").innerHTML = chartHtml(sc, S.live?.charts?.[sc.name] || sc.start, S.lastTrans);
  renderSecurityChart();
}

// Renders a STATE-CHART; the transition that actually ran last (if any) is highlighted.
function chartHtml(sc, active, lastTrans, opts = {}) {
  const W = opts.w || 400, H = opts.h || 360, cx = W / 2, cy = H / 2 + 6, R = opts.r || 132;
  const pos = {}; sc.states.forEach((s, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / sc.states.length; pos[s] = [cx + R * Math.cos(a), cy + R * Math.sin(a)]; });
  const lt = lastTrans?.chart === sc.name && lastTrans.to === active ? lastTrans : null;
  const ran = lt && sc.transitions.find(t => t.from === lt.from && t.to === lt.to && (!lt.service || t.services.includes(lt.service)));
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%"><defs><marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#9a9a9a"/></marker><marker id="ar3" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#000"/></marker></defs>`;
  for (const t of sc.transitions) {
    const [x1, y1] = pos[t.from], [x2, y2] = pos[t.to];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, bend = 30;
    const sx = x1 + dx / len * 34, sy = y1 + dy / len * 22, ex = x2 - dx / len * 36, ey = y2 - dy / len * 24;
    const mx = (sx + ex) / 2 + nx * bend, my = (sy + ey) / 2 + ny * bend;
    const trig = t.services.length, isRan = t === ran;
    svg += `<path class="${isRan ? "ran" : ""}" d="M${sx},${sy} Q${mx},${my} ${ex},${ey}" fill="none" stroke="${isRan ? "#000" : trig ? "#0078d6" : "#bdbdbd"}" stroke-width="${isRan ? 2.6 : trig ? 1.5 : 1}" marker-end="url(#${isRan ? "ar3" : "ar2"})"/>`;
    if (opts.labels) svg += `<text x="${mx + nx * 14}" y="${my + ny * 14 + 4}" font-size="11" text-anchor="middle" fill="${isRan ? "#000" : "#767676"}" font-weight="${isRan ? 600 : 400}">${esc(t.name)}</text>`;
  }
  for (const s of sc.states) {
    const [x, y] = pos[s], on = s === active;
    svg += `<g class="state${on ? " on" : ""}"><ellipse cx="${x}" cy="${y}" rx="44" ry="22" fill="${on ? "#000" : "#fff"}" stroke="${on ? "#000" : "#bdbdbd"}" stroke-width="1.2"></ellipse>
      <text x="${x}" y="${y + 4}" font-size="11.5" text-anchor="middle" fill="${on ? "#fff" : "#333"}" font-weight="${on ? 600 : 400}">${esc(s)}</text></g>`;
  }
  const rows = sc.transitions.map(t => `<tr${t === ran ? ' class="cur"' : ""}><td>${esc(t.name)}${t === ran ? ' <span class="badge req">ran</span>' : ""}</td><td class="mono">${esc(t.from)} &rarr; ${esc(t.to)}</td><td class="mono">${esc([...new Set(t.services)].join(", ") || "\u2013")}</td></tr>`).join("");
  return svg + `</svg><table class="transitions"><tr><th>Transition</th><th>States</th><th>Triggered by</th></tr>${rows}</table>`;
}

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

// ---------------------------------------------------------------- security access (UDS 0x27)
// MODELED demo algorithm, not a real OEM algorithm: key = rotl32(seed ^ 0x5A5A5A5A, 3)
const SEC_MASK = 0x5A5A5A5A;
const u32 = n => n >>> 0;
const rotl32 = (x, r) => u32((x << r) | (x >>> (32 - r)));
const demoKey = seed => rotl32(u32(seed ^ SEC_MASK), 3);
const bytes4 = n => [24, 16, 8, 0].map(s => (u32(n) >>> s) & 0xff);
const h2 = b => b.toString(16).toUpperCase().padStart(2, "0");
const hex32 = n => "0x" + u32(n).toString(16).toUpperCase().padStart(8, "0");
const NRC_INFO = {
  0x12: ["SubFunctionNotSupported", "The ECU does not support this sub-function."],
  0x13: ["IncorrectMessageLengthOrInvalidFormat", "The telegram length does not match the ODX request."],
  0x22: ["ConditionsNotCorrect", "Preconditions of the ECU are not met."],
  0x24: ["RequestSequenceError", "A key was sent without a preceding seed request."],
  0x31: ["RequestOutOfRange", "A parameter is out of range."],
  0x33: ["SecurityAccessDenied", "The service requires a security level that is not unlocked."],
  0x35: ["InvalidKey", "The key does not match the seed under the demo algorithm."],
  0x36: ["ExceededNumberOfAttempts", "Third wrong key: the ECU starts its modeled 10 s delay."],
  0x37: ["RequiredTimeDelayNotExpired", "The lockout delay is still running; the request was refused."],
};
S.sec = {seed: null, key: null, keyWrong: false, computed: false, sent: false, pending: false, result: null, v: 0};
S.gates = {};

function secLayer() { return S.summary?.layers.find(l => l.state_charts.some(c => c.name === "security_chart")) || null; }
function secConnected() { const l = secLayer(); return !!(l && S.live && S.live.layer === l.name); }
function secChartState() { return secConnected() ? (S.live?.charts?.security_chart || "locked") : null; }

async function secConnect() {
  const l = secLayer(); if (!l) { renderSecurity(); return; }
  if (secConnected()) return;
  $("#liveLayer").value = l.name; updateLiveChartOptions(); $("#liveChart").value = "security_chart";
  await connectLive();
}
async function secEnsure() { if (!secConnected()) await secConnect(); return secConnected(); }

function secResetView() {
  S.sec = {seed: null, key: null, keyWrong: false, computed: false, sent: false, pending: false, result: null, v: (S.sec?.v || 0) + 1};
  S.secLastProt = null; S.secSteps = 0;
  const tl = $("#secTimeline"); if (tl) tl.innerHTML = "";
  renderPipeline();
}

function secNote(msg, bad) { const n = $("#secNote"); n.textContent = msg || ""; n.classList.toggle("bad", !!bad); }

function nrcOf(resp) {
  const p = resp.params || {};
  const code = Number(p.response_code ?? p.nrc ?? parseInt(resp.hex.slice(4, 6), 16));
  const info = NRC_INFO[code] || [resp.coding_object || "NegativeResponse", ""];
  const odxName = resp.coding_object && !resp.coding_object.includes("not in ODX") ? resp.coding_object : null;
  return {code, name: odxName || info[0], desc: info[1], odx: !!odxName};
}

function secAddTx(t) {
  const layer = secLayer(); if (!layer || !S.live || S.live.layer !== layer.name) return;
  const resp = t.response, ok = resp && resp.kind === "positive";
  if (t.service === "security_request_seed" && ok) {
    const seed = Number(resp.params.seed);
    S.sec = {seed, key: null, keyWrong: false, computed: false, sent: false, pending: seed !== 0, result: seed === 0 ? "zero" : null, v: S.sec.v + 1};
    renderPipeline();
  } else if (t.service === "security_send_key" && resp) {
    const n = ok ? null : nrcOf(resp);
    S.sec = {...S.sec, sent: true, result: ok ? "ok" : n, pending: !ok && n.code === 0x35, v: S.sec.v + 1};
    renderPipeline();
  } else if (t.service === "headstand") {
    S.secLastProt = t;
  } else if (t.service === "session_stop" || (t.service === "security_request_seed" && resp)) {
    S.sec.pending = false;
  }
  const tl = $("#secTimeline"); tl.querySelector(".emptystate")?.remove();
  const el = document.createElement("div"); el.className = "step";
  const step = S.secSteps = (S.secSteps || 0) + 1;
  const chg = t.state_before && t.state_before !== t.state_after ? `<span class="badge gnr">${esc(t.chart)}: ${esc(t.state_before)} &rarr; ${esc(t.state_after)}</span>` : "";
  let respHtml;
  if (t.blocked) {
    respHtml = `<div class="blockedcard resp">Not sent. odxtools <code>StateMachine</code>: no PRE-CONDITION-STATE-REF of <b>${esc(t.service)}</b> applies in state <b>${esc(t.state_before)}</b> of <code>${esc(t.chart)}</code>.</div>`;
  } else if (!resp) {
    respHtml = `<div class="nrc resp"><span class="name">Timeout</span><span class="desc">The ECU did not answer.</span></div>`;
  } else if (resp.kind === "positive") {
    respHtml = `<div class="resp"><div class="dir"><span class="badge pos">${esc(resp.coding_object || "positive")}</span>ECU &rarr; tester</div>${bytesHtml(resp)}</div>`;
  } else {
    const n = nrcOf(resp);
    respHtml = `<div class="nrc resp"><span class="hex">0x${esc(h2(n.code))}</span><span class="name">${esc(n.name)}</span><span class="badge neg">${n.odx ? "ODX NEG-RESPONSE" : esc(resp.kind.replace("_", " "))}</span><span class="desc">${esc(n.desc)}</span>${bytesHtml(resp)}</div>`;
  }
  el.innerHTML = `<div class="hd"><b>${step}. ${esc(t.service || t.request.coding_object || "raw telegram")}</b><span>${chg} <span class="muted small">${t.blocked ? "blocked" : `${esc(t.frames ?? "?")} CAN frames · ${esc(t.latency_ms)} ms`}</span></span></div>
    <div class="dir"><span class="badge req">${esc(t.request.coding_object || "request")}</span>tester &rarr; ECU</div>${bytesHtml(t.request)}${respHtml}`;
  tl.prepend(el);
  while (tl.children.length > 40) tl.lastChild.remove();
}
function secAddError(msg) {
  const tl = $("#secTimeline"); if (!tl) return; tl.querySelector(".emptystate")?.remove();
  const el = document.createElement("div"); el.className = "step";
  el.innerHTML = `<div class="nrc"><span class="name">Request failed</span><span class="desc">${esc(msg)}</span></div>`; tl.prepend(el);
}

function quad(n, cls = "", delay = 0) {
  if (n == null) return `<div class="quad">${"<span class=\"b empty\">&ndash;</span>".repeat(4)}</div>`;
  return `<div class="quad">${bytes4(n).map((b, i) => `<span class="b ${cls}" style="animation-delay:${delay + i * 110}ms">${h2(b)}</span>`).join("")}</div>`;
}
function renderPipeline() {
  const el = $("#secPipe"); if (!el) return;
  const c = S.sec, seed = c.seed, key = c.computed ? c.key : null;
  const res = c.result;
  let seedCap = "Press Request seed: <span class=\"mono\">27 01</span>";
  if (res === "zero") seedCap = "All-zero seed: the ECU is already unlocked (ISO 14229-1)";
  else if (seed != null) seedCap = `<span class="mono">67 01</span> security_seed · ${esc(hex32(seed))}`;
  let algo = `<div class="formula">key = rotl32(seed &oplus; 0x5A5A5A5A, 3)</div><div class="cap">Request a seed, then press Compute key.</div>`;
  if (c.computed && seed != null) {
    const x = u32(seed ^ SEC_MASK), rows = [["seed", seed], ["&oplus; mask", SEC_MASK], ["= xor", x], ["rotl 3", demoKey(seed)]];
    algo = `<div class="formula">key = rotl32(seed &oplus; 0x5A5A5A5A, 3)</div><table>${rows.map(([lab, v], r) =>
      `<tr class="${r === 3 ? "res" : ""}"><td class="op">${lab}</td>${bytes4(v).map((b, i) => `<td><span class="c" style="animation-delay:${r * 260 + i * 70}ms">${h2(b)}</span></td>`).join("")}</tr>`).join("")}</table>`;
  }
  let keyCap = "Computed by the tester, sent as <span class=\"mono\">27 02</span>", keyCls = key != null ? "filled" : "";
  if (c.computed && c.keyWrong) keyCap = "Deliberately wrong key (demo algorithm result with flipped bits)";
  if (c.sent && res === "ok") { keyCap = "<span class=\"mono\">67 02</span> security_key_accepted"; keyCls = "ok"; }
  else if (c.sent && res && res.code != null) { keyCap = `<span class="mono">7F 27 ${esc(h2(res.code))}</span> ${esc(res.name)}`; keyCls = "bad"; }
  const keyDelay = c.computed && !c.keyWrong ? 3 * 260 + 200 : 0;
  el.innerHTML = `
    <div class="pbox ${seed != null ? "filled" : ""}"><div class="ttl">Seed (from ECU) <span class="tag real">REAL</span></div>${quad(res === "zero" ? 0 : seed)}<div class="cap">${seedCap}</div></div>
    <div class="parrow ${c.computed ? "on" : ""}"></div>
    <div class="pbox algo ${c.computed ? "filled" : ""}"><div class="ttl">Demo algorithm <span class="tag model">MODELED &ndash; demo algorithm, not a real OEM algorithm</span></div>${algo}</div>
    <div class="parrow ${c.sent ? "on" : ""}"></div>
    <div class="pbox ${keyCls}"><div class="ttl">Key (to ECU) <span class="tag real">REAL</span></div>${quad(key, c.keyWrong ? "wrong" : "", keyDelay)}<div class="cap">${keyCap}</div></div>`;
}

function secLockState() {
  const e = S.ecu?.security;
  if (!secConnected() || !e) return "locked";
  if (e.delay_remaining > 0) return "locked-out";
  if (secChartState() === "unlocked") return "unlocked";
  if (S.sec.pending) return "unlocking";
  return "locked";
}
function renderSecurityChart() {
  const host = $("#secChart"); if (!host) return;
  const l = secLayer(), sc = l?.state_charts.find(c => c.name === "security_chart");
  if (!sc) { host.innerHTML = ""; return; }
  const active = secChartState() || sc.start;
  const key = JSON.stringify([active, S.lastTrans, secConnected()]);
  if (host.dataset.k === key) return; host.dataset.k = key;
  host.innerHTML = chartHtml(sc, active, secConnected() ? S.lastTrans : null, {w: 320, h: 300, r: 100, labels: true});
}
function renderSecurity() {
  if (!$("#tab-security")) return;
  const l = secLayer(), has = !!l, conn = secConnected();
  $("#secRibbon").hidden = !has;
  if (has) $("#secRibbonText").innerHTML = `<b>${esc(S.db)}</b> is generated by <code>examples/mksomersaultsecuritypdx.py</code>: it adds UDS 0x27 services and <code>security_chart</code> to <b>${esc(l.name)}</b>. The bundled PDX files are unchanged.`;
  $("#secEmpty").hidden = has; $("#secBody").hidden = !has;
  if (!has) { $("#secEmptyDb").textContent = S.db || "This database"; $("#secConnect").hidden = true; $("#secConn").textContent = ""; return; }
  $("#secConnect").hidden = conn; $("#secConnect").textContent = `Connect to ${l.name}`;
  $("#secConn").innerHTML = conn ? `<span class="pill on">Connected</span> ${esc(l.name)} · tester &rarr; ECU <code>${hex2(S.live.rx_id)}</code> · ECU &rarr; tester <code>${hex2(S.live.tx_id)}</code>` : `<span class="pill off">Not connected</span>`;
  $$(".secbtns .btn, #secTry").forEach(b => b.disabled = !conn);
  const tl = $("#secTimeline");
  if (!tl.children.length) tl.innerHTML = `<div class="emptystate"><div class="empty-line"></div>${conn ? "No exchanges yet. Try headstand, or request a seed." : "Not connected. Connect to the ECU to start exchanging telegrams."}</div>`;

  const ls = secLockState(), lock = $("#secLock");
  if (!lock.classList.contains(ls)) {
    lock.className = "lock " + ls;
    const lab = $("#secLockLabel"); lab.textContent = {"locked": "Locked", "unlocking": "Unlocking", "unlocked": "Unlocked", "locked-out": "Locked out"}[ls];
    lab.style.animation = "none"; void lab.offsetWidth; lab.style.animation = "";
  }
  const e = S.ecu?.security || {attempts: 0, max_attempts: 3, delay_remaining: 0, delay_total: 10};
  $("#secLockSub").innerHTML = conn ? `security_chart: <b>${esc(secChartState())}</b>${ls === "unlocking" ? " · seed issued, waiting for key" : ""}` : "not connected";
  const filled = e.delay_remaining > 0 ? e.max_attempts : e.attempts;
  $$("#secDots i").forEach((d, i) => d.classList.toggle("on", i < filled));
  const C = 163.36, frac = e.delay_total ? e.delay_remaining / e.delay_total : 0;
  $("#secRing").style.strokeDashoffset = String(C * (1 - frac));
  $("#secDelay").classList.toggle("idle", !(e.delay_remaining > 0));
  $("#secDelayNum").textContent = e.delay_remaining > 0 ? `${Math.ceil(e.delay_remaining)} s` : "No lockout";
  $("#secDelayTxt").textContent = e.delay_remaining > 0 ? "modeled delay: requests get 0x37" : `delay of ${e.delay_total} s after ${e.max_attempts} wrong keys`;

  const gate = conn ? S.gates?.headstand : undefined, prot = $("#secProt");
  const lp = S.secLastProt;
  const last = lp ? (lp.blocked ? "Last try: blocked before sending" : lp.response?.kind === "positive" ? `Last try: <span class="mono">${esc(spaced(lp.response.hex))}</span> ${esc(lp.response.coding_object)}` : lp.response ? `Last try: ${esc(lp.response.coding_object)}` : "Last try: timeout") : "Not tried yet";
  const cls = gate === true ? "allowed" : gate === false ? "blocked" : "";
  const st = gate === true ? "headstand allowed" : gate === false ? "headstand blocked" : "headstand";
  const why = gate === true ? "PRE-CONDITION-STATE-REF met: security_chart is <b>unlocked</b>" : gate === false ? `Chart precondition not met: needs security_chart <b>unlocked</b>, is <b>${esc(secChartState())}</b>` : "Connect to evaluate the ODX precondition";
  const sig = cls + "|" + last + "|" + why;
  if (prot.dataset.k !== sig) { prot.dataset.k = sig; prot.className = "prot " + cls; prot.innerHTML = `<div class="st">${st}</div><div class="why">${why}</div><div class="last">${last}</div>`; }
  renderSecurityChart();
}

$("#secConnect").onclick = secConnect;
$("#secOpenDemo").onclick = async () => {
  const opt = [...$("#dbSelect").options].find(o => o.value === "somersault_security.pdx");
  if (!opt) { secNote("somersault_security.pdx not found; run examples/mksomersaultsecuritypdx.py", true); return; }
  $("#dbSelect").value = opt.value; await openDb(opt.value);
};
$("#secSeed").onclick = async () => { if (await secEnsure()) { secNote(""); await sendLive({service: "security_request_seed", params: {}}); } };
function secCompute(wrong) {
  const seed = S.sec.seed;
  if (seed == null) { secNote(wrong ? "No seed: sending an arbitrary wrong key" : "Request a seed first.", !wrong); if (!wrong) return false; }
  const key = seed == null ? 0xDEADBEEF : wrong ? u32(demoKey(seed) ^ 0x00FF00FF) : demoKey(seed);
  S.sec = {...S.sec, key, keyWrong: !!wrong, computed: true, sent: false, result: null, v: S.sec.v + 1};
  renderPipeline(); return true;
}
$("#secCompute").onclick = () => { if (secCompute(false)) secNote("Key computed by the tester with the demo algorithm."); };
async function secSend(wrong) {
  if (!(await secEnsure())) return;
  if (wrong || !S.sec.computed || S.sec.keyWrong) { if (!secCompute(wrong)) return; if (!wrong) await sleep(1100); }
  else secNote("");
  await sendLive({service: "security_send_key", params: {key: hex32(S.sec.key)}});
}
$("#secSendKey").onclick = () => secSend(false);
$("#secWrong").onclick = () => secSend(true);
$("#secTry").onclick = async () => { if (await secEnsure()) await sendLive({service: "headstand", params: {duration: "3"}}); };
$("#secStop").onclick = async () => { if (await secEnsure()) await sendLive({service: "session_stop", params: {}}); };

loadDatabases().then(() => {
  const t = location.hash.slice(1); const b = $(`#tabs button[data-tab="${t}"]`); if (b) b.click();
  if (t === "compare") $("#cmpGo").click();
  if (t === "decode") decodeNow();
  if (t === "live") connectLive();
  if (t === "security") secConnect();
});
