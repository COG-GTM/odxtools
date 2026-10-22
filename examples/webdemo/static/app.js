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
  if (b.dataset.tab === "security" && S.summary) saEnsure();
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
  $("#demoTag").hidden = !S.summary.demo_extension;
  if ($("#tab-security").classList.contains("active")) saEnsure(); else saFrame(saTarget());
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
  $("#txlog").innerHTML = ""; $("#trace tbody").innerHTML = ""; saClear();
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
    $("#txlog").innerHTML = ""; $("#trace tbody").innerHTML = ""; $("#gauges").innerHTML = ""; $("#frameRate").textContent = ""; saClear();
    drawChart();
    return;
  }
  const seen = S.after, fresh = x => x.seq > seen, prevTrans = S.lastTrans;
  for (const f of st.frames.filter(fresh)) addFrame(f);
  for (const t of st.transactions.filter(fresh)) {
    addTx(t);
    if (!t.blocked && t.state_before && t.state_before !== t.state_after) S.lastTrans = {chart: t.chart, from: t.state_before, to: t.state_after, service: t.service};
    saAddTx(t);
  }
  const all = [...st.frames, ...st.transactions]; if (all.length) S.after = Math.max(S.after, ...all.map(x => x.seq));
  renderGauges(st.ecu);
  const chartsChanged = JSON.stringify(st.charts) !== JSON.stringify(S.live?.charts);
  if (chartsChanged) S.live = {...S.live, ...st};
  if (chartsChanged || S.lastTrans !== prevTrans) drawChart();
  S.live.chart = st.chart;
  const now = performance.now(); S.frameTimes = S.frameTimes.filter(t => now - t < 5000);
  $("#frameRate").textContent = `${st.frame_count} frames captured by passive sniffer · ${(S.frameTimes.length / 5).toFixed(1)} frames/s`;
  saStatus(st);
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
  if (!sc) { $("#chartSvg").innerHTML = `<div class="muted" style="padding:30px 0">This ECU variant defines no STATE-CHARTs.</div>`; $("#chartName").textContent = ""; return; }
  $("#chartName").textContent = `${sc.name} · start: ${sc.start}`;
  $("#chartSvg").innerHTML = chartHtml(sc, S.live?.charts?.[sc.name] || sc.start, "lv");
  saDrawChart();
}

// Render an ODX STATE-CHART; the transition that last ran into the active state is highlighted.
function chartHtml(sc, active, idp) {
  const lt = S.lastTrans?.chart === sc.name && S.lastTrans.to === active ? S.lastTrans : null;
  const ran = lt && sc.transitions.find(t => t.from === lt.from && t.to === lt.to && (!lt.service || t.services.includes(lt.service)));
  const flat = idp === "sa" && sc.states.length === 2;
  const W = 400, H = flat ? 200 : 360, cx = W / 2, cy = H / 2 + 6, R = 132;
  const pos = {}; sc.states.forEach((s, i) => { const a = (flat ? Math.PI : -Math.PI / 2) + i * 2 * Math.PI / sc.states.length; pos[s] = [cx + R * Math.cos(a), cy + R * Math.sin(a)]; });
  const mk = (id, c) => `<marker id="${idp}-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="${c}"/></marker>`;
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%"><defs>${mk("ar", "#9a9a9a")}${mk("ran", "#000")}</defs>`;
  for (const t of sc.transitions) {
    const [x1, y1] = pos[t.from], [x2, y2] = pos[t.to];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, bend = 30;
    const ux = dx / len, uy = dy / len, rim = flat ? 1 / Math.hypot(ux / 44, uy / 22) + 4 : 0;
    const sx = x1 + ux * (flat ? rim : 34), sy = y1 + uy * (flat ? rim : 22), ex = x2 - ux * (flat ? rim + 2 : 36), ey = y2 - uy * (flat ? rim + 2 : 24);
    const mx0 = (sx + ex) / 2, my0 = (sy + ey) / 2;
    const trig = t.services.length, on = t === ran, bend2 = flat ? 2.2 : 1;
    const mx = mx0 + nx * bend * bend2, my = my0 + ny * bend * bend2;
    svg += `<path class="${on ? "ran" : ""}" d="M${sx},${sy} Q${mx},${my} ${ex},${ey}" fill="none" stroke="${on ? "#000" : trig ? "#0078d6" : "#bdbdbd"}" stroke-width="${on ? 2.6 : trig ? 1.5 : 1}" marker-end="url(#${idp}-${on ? "ran" : "ar"})"/>`;
    if (on) svg += `<text class="ranlbl" x="${mx0 + nx * (bend * bend2 / 2 + 16)}" y="${my0 + ny * (bend * bend2 / 2 + 16) + 4}" text-anchor="middle" font-size="11" font-weight="600" fill="#000">${esc(t.name)} ran</text>`;
  }
  for (const s of sc.states) {
    const [x, y] = pos[s], on = s === active;
    svg += `<g class="st${on ? " on" : ""}"><ellipse cx="${x}" cy="${y}" rx="44" ry="22" fill="${on ? "#000" : "#fff"}" stroke="${on ? "#000" : "#bdbdbd"}" stroke-width="1.2"></ellipse>
      <text x="${x}" y="${y + 4}" font-size="11.5" text-anchor="middle" fill="${on ? "#fff" : "#333"}" font-weight="${on ? 600 : 400}">${esc(s)}</text></g>`;
  }
  const rows = sc.transitions.map(t => `<tr${t === ran ? ' class="cur"' : ""}><td>${esc(t.name)}</td><td class="mono">${esc(t.from)} &rarr; ${esc(t.to)}</td><td class="mono">${esc([...new Set(t.services)].join(", ") || "\u2013")}</td></tr>`).join("");
  return svg + `</svg><table class="transitions"><tr><th>Transition</th><th>States</th><th>Triggered by</th></tr>${rows}</table>`;
}

// ---------------------------------------------------------------- security access (UDS 0x27)
// Names as in odxtools.uds.NegativeResponseCodes
const NRC = {0x10: "GeneralReject", 0x11: "ServiceNotSupported", 0x12: "SubFunctionNotSupported", 0x13: "InvalidFormat", 0x21: "Busy", 0x22: "ConditionsIncorrect", 0x24: "RequestSequenceError", 0x31: "RequestOutOfRange", 0x33: "SecurityAccessDenied", 0x35: "InvalidKey", 0x36: "ExceededNumberOfAttempts", 0x37: "RequiredTimeDelayNotExpired"};
const SA_SVCS = new Set(["security_request_seed", "security_send_key", "session_stop"]);
const RM = matchMedia("(prefers-reduced-motion: reduce)");
const pause = ms => sleep(RM.matches ? 0 : ms);
const hx = b => b.toString(16).toUpperCase().padStart(2, "0");
const SA = {seed: null, seedUsed: false, steps: null, key: null, wrong: false, keyState: null, unlocking: false, busy: false, prot: null, protLast: null, st: null};

function saTarget() {
  const c = (S.summary?.layers || []).filter(l => l.variant_type === "ECU-VARIANT" && l.state_charts.some(x => x.semantic === "SECURITY") &&
    ["security_request_seed", "security_send_key"].every(n => l.services.some(s => s.name === n)));
  const l = c.find(x => x.name === "somersault_assiduous") || c[0];
  return l ? {layer: l.name, chart: l.state_charts.find(x => x.semantic === "SECURITY").name, summary: l} : null;
}
function saFrame(tg) {
  $("#saRibbon").hidden = !S.summary?.demo_extension; $("#saRibbonDb").textContent = S.db || "";
  $("#saEmpty").hidden = !!tg; $("#saBody").hidden = !tg;
  $$(".sa-controls .btn").forEach(b => b.disabled = !tg || SA.busy);
  if (!tg) $("#saConn").innerHTML = "";
}
async function saEnsure() {
  const tg = saTarget(); saFrame(tg);
  if (!tg) return false;
  if (!S.live || S.live.db !== S.db || S.live.layer !== tg.layer || S.live.chart !== tg.chart) {
    $("#liveLayer").value = tg.layer; updateLiveChartOptions(); $("#liveChart").value = tg.chart;
    await connectLive();
  }
  saDrawChart();
  return true;
}
$("#saOpenDemo").onclick = async () => {
  if (![...$("#dbSelect").options].some(o => o.value === "somersault_security.pdx")) return;
  $("#dbSelect").value = "somersault_security.pdx"; await openDb("somersault_security.pdx");
};

function setHtml(el, h) { if (el.dataset.h !== h) { el.dataset.h = h; el.innerHTML = h; return true; } return false; }
function saClear() {
  Object.assign(SA, {seed: null, seedErr: null, seedUsed: false, steps: null, key: null, wrong: false, keyState: null, unlocking: false, protLast: null});
  $("#saLog").innerHTML = `<div class="sa-emptylog"><div class="sa-illu" aria-hidden="true"><i></i><span></span><i></i></div>
    <b>No exchanges yet</b><span class="muted small">Request a seed to start the 0x27 handshake between tester and ECU.</span></div>`;
  saRenderPipe();
}
function saSteps(seed) {
  const x = seed.map(b => b ^ 0x5a);
  return {seed, x, k: x.map((b, i) => ((b << 3) | (x[(i + 1) % 4] >> 5)) & 0xff)};
}
function saCells(el, bytes, cls, delay = 0, notes = null) {
  const h = [0, 1, 2, 3].map(i => `<span class="sa-cell${bytes ? " on " + cls : ""}" style="--i:${i};--d:${delay}ms">${bytes ? hx(bytes[i]) : "&middot;&middot;"}${notes ? `<small>${bytes ? esc(notes[i]) : "&nbsp;"}</small>` : ""}</span>`).join("");
  setHtml(el, h);
}
function saRenderPipe() {
  const sb = $("#saBoxSeed"), ab = $("#saBoxAlgo"), kb = $("#saBoxKey"), z = SA.seed && SA.seed.every(b => !b);
  saCells($(".sa-cells", sb), SA.seed, "seed");
  sb.classList.toggle("filled", !!SA.seed);
  setHtml($(".sa-boxft", sb), !SA.seed ? `waiting for <span class="mono">67 01</span>` : z ? "all-zero seed: ECU is already unlocked" :
    SA.seedUsed ? `consumed by <span class="mono">27 02</span> &mdash; request a new one` : `received in <span class="mono">67 01</span> &middot; pending`);
  const st = SA.steps, rows = [["seed", st?.seed, "seed", 0, null], ["&oplus; 5A", st?.x, "xor", 260, st?.seed.map(b => `${hx(b)}\u22955A`)],
    ["rotl 3", st?.k, "key", 560, st?.x.map((b, i) => `${hx(b)}\u226a3|${hx(st.x[(i + 1) % 4])}\u226b5`)]];
  if (!$(".sa-steps", ab).children.length) $(".sa-steps", ab).innerHTML = rows.map(r => `<div class="sa-steprow"><span class="sa-oplbl">${r[0]}</span><div class="sa-cells"></div></div>`).join("");
  $$(".sa-steprow .sa-cells", ab).forEach((el, i) => saCells(el, rows[i][1], rows[i][2], rows[i][3], i ? rows[i][4] || [1, 2, 3, 4] : null));
  ab.classList.toggle("filled", !!st);
  saCells($(".sa-cells", kb), SA.key, SA.wrong ? "wrong" : "key", st && !SA.wrong ? 860 : 0);
  const ks = SA.keyState || "";
  kb.classList.toggle("filled", !!SA.key); kb.classList.toggle("good", ks === "accepted"); kb.classList.toggle("bad", ks.startsWith("rejected"));
  setHtml($(".sa-boxft", kb), !SA.key ? "not computed" : ks === "accepted" ? `sent in <span class="mono">27 02</span> &middot; accepted (<span class="mono">67 02</span>)` :
    ks.startsWith("rejected") ? `sent in <span class="mono">27 02</span> &middot; rejected ${esc(ks.slice(9))}` : ks === "sending" ? `sending <span class="mono">27 02</span>&hellip;` :
    SA.wrong ? "deliberately wrong key (bit-inverted)" : "computed &middot; ready to send");
  $$(".sa-link").forEach((l, i) => l.classList.toggle("on", i === 0 ? !!st : !!SA.key && !SA.wrong));
  saRenderFlow();
}
function saRenderFlow() {
  const ks = SA.keyState || "", e = SA.seedErr, nrc = c => `0x${hx(c)} ${NRC[c] || ""}`;
  const steps = [
    ["27 01", "Request seed", e != null ? "fail" : SA.seed ? "done" : ""],
    ["67 01", e != null ? esc(nrc(e)) : "Seed from ECU", e != null ? "fail" : SA.seed ? "done" : ""],
    ["&oplus; &#8810;", SA.wrong ? "Wrong key (bit-inverted)" : "Demo algorithm", SA.wrong ? "fail" : SA.steps ? "done" : ""],
    ["27 02", "Send key", ks === "sending" ? "busy" : ks ? "done" : ""],
    [ks.startsWith("rejected") ? "7F 27" : "67 02", ks.startsWith("rejected") ? esc(ks.slice(10)) : "Key accepted", ks === "accepted" ? "ok" : ks.startsWith("rejected") ? "fail" : ""],
  ];
  setHtml($("#saFlow"), steps.map(([c, d, cls], i) => `<li class="${cls}"><span class="n">Step ${i + 1}</span><span class="c">${c}</span><span class="d">${d}</span></li>`).join(""));
}

function saAddTx(t) {
  const isSec = (t.request?.hex || "").startsWith("27") || SA_SVCS.has(t.service) || (SA.prot && t.service === SA.prot);
  if (!isSec) return;
  const resp = t.response, code = resp && resp.hex.startsWith("7f") ? parseInt(resp.hex.slice(4, 6), 16) : null;
  if (t.service === "security_request_seed" && resp?.kind === "positive") {
    const h = String(resp.params?.security_seed ?? "").replace(/^0x/, "");
    SA.seed = (h.match(/../g) || []).map(b => parseInt(b, 16)); SA.seedUsed = false; SA.steps = null; SA.key = null; SA.wrong = false; SA.keyState = null;
  }
  if (t.service === "security_request_seed") SA.seedErr = code != null && !t.blocked ? code : null;
  if (t.service === "security_send_key") {
    SA.seedUsed = true;
    SA.keyState = resp?.kind === "positive" ? "accepted" : `rejected: ${code != null ? "0x" + hx(code) + " " + (NRC[code] || "") : "no response"}`;
  }
  if (t.service === SA.prot) SA.protLast = t;
  saRenderPipe();
  const log = $("#saLog"); $(".sa-emptylog", log)?.remove();
  const el = document.createElement("div");
  el.className = "sa-x " + (t.blocked ? "blocked" : resp?.kind === "positive" ? "pos" : "neg");
  const sub = (t.request.hex || "").startsWith("27") ? {"01": "requestSeed", "02": "sendKey"}[t.request.hex.slice(2, 4)] || "" : "";
  const chg = t.state_before && t.state_before !== t.state_after ? `<span class="badge gnr">${esc(t.chart)}: ${esc(t.state_before)} &rarr; ${esc(t.state_after)}</span>` : "";
  let r;
  if (t.blocked) r = `<div class="sa-step resp sa-blocked"><b>Blocked by the ODX state chart</b> &mdash; no PRE-CONDITION-STATE-REF of <code>${esc(t.service)}</code> applies in state <b>${esc(t.state_before)}</b> of <code>${esc(t.chart)}</code>. Nothing was sent on CAN.</div>`;
  else if (!resp) r = `<div class="sa-step resp sa-nrc"><div class="sa-nrchd"><span class="code">timeout</span><b>No response from ECU</b></div></div>`;
  else if (code != null) r = `<div class="sa-step resp sa-nrc"><div class="sa-nrchd"><span class="code">0x${hx(code)}</span><b>${esc(NRC[code] || "NegativeResponse")}</b><span class="muted small">ODX NEG-RESPONSE <code>${esc(resp.coding_object)}</code></span></div>${bytesHtml(resp)}</div>`;
  else r = `<div class="sa-step resp"><div class="sa-dir">ECU &rarr; tester <span class="badge pos">POSITIVE</span> <code>${esc(resp.coding_object)}</code></div>${bytesHtml(resp)}</div>`;
  el.innerHTML = `<div class="sa-xhd"><b>${esc(t.service || t.request.coding_object || "raw telegram")}</b>${sub ? `<span class="muted small mono">0x27 ${esc(sub)}</span>` : ""}
      <span class="sa-xmeta">${chg}<span class="muted small">${t.blocked ? "not sent" : `${esc(t.frames ?? "?")} CAN frames &middot; ${esc(t.latency_ms)} ms`}</span></span></div>
    <div class="sa-step req"><div class="sa-dir">tester &rarr; ECU <span class="badge req">REQUEST</span> <code>${esc(t.request.coding_object || "")}</code></div>${bytesHtml(t.request)}</div>${r}`;
  log.prepend(el);
  while (log.children.length > 40) log.lastChild.remove();
}

function saPadState() {
  const st = SA.st, sec = st?.ecu?.security, tg = saTarget();
  if (!sec || !tg) return "locked";
  if (sec.delay_remaining > 0) return "lockedout";
  if (SA.unlocking) return "unlocking";
  return st.charts?.[tg.chart] === "unlocked" ? "unlocked" : "locked";
}
const PAD = {
  locked: ["Locked", c => `<code>${esc(c)}</code> is <b>locked</b> &middot; protected services are blocked`],
  unlocking: ["Unlocking&hellip;", () => `key sent in <span class="mono">27 02</span>, waiting for the ECU`],
  unlocked: ["Unlocked", c => `<code>${esc(c)}</code> is <b>unlocked</b> &middot; security level 1`],
  lockedout: ["Locked out", () => `3 wrong keys &middot; ECU answers <span class="mono">0x37</span> until the delay expires`],
};
function saRenderLock() {
  const st = SA.st, sec = st?.ecu?.security, tg = saTarget(); if (!sec || !tg) return;
  const p = saPadState(), pad = $("#saPad");
  if (!pad.classList.contains(p)) { pad.className = "pad " + p; }
  const lbl = $("#saState");
  if (setHtml(lbl, PAD[p][0])) { lbl.classList.remove("swap"); void lbl.offsetWidth; lbl.classList.add("swap"); }
  lbl.dataset.p = p;
  setHtml($("#saStateSub"), PAD[p][1](tg.chart));
  $$("#saDots i").forEach((d, i) => d.classList.toggle("on", i < sec.attempts));
  const C = 2 * Math.PI * 26, rem = sec.delay_remaining, ring = $("#saRing");
  ring.classList.toggle("idle", !(rem > 0));
  $(".prog", ring).style.strokeDasharray = `${C}`;
  $(".prog", ring).style.strokeDashoffset = `${rem > 0 ? C * (1 - rem / sec.delay_total) : C}`;
  $("#saRingTxt").textContent = rem > 0 ? `${Math.ceil(rem)} s` : "\u2013";
}
function saRenderProtected() {
  const st = SA.st, tg = saTarget(); if (!st || !tg) return;
  const g = st.gates || {}; SA.prot = g.headstand ? "headstand" : Object.keys(g)[0] || null;
  $("#saTry").textContent = `Try ${SA.prot || "protected service"}`;
  const gate = SA.prot && g[SA.prot], cur = st.charts?.[tg.chart] || "";
  if (!gate) { setHtml($("#saProtected"), `<div class="sa-cardhd"><h2>Protected service</h2></div><div class="muted">No service of this ECU variant has a pre-condition on <code>${esc(tg.chart)}</code>.</div>`); return; }
  const lt = SA.protLast, r = lt?.response;
  const last = !lt ? `<span class="muted">not tried yet</span>` : lt.blocked ? `<span class="warn">blocked by the state chart &middot; not sent</span>` :
    r?.kind === "positive" ? `<span class="ok">sent &middot; positive response <code>${esc(r.coding_object)}</code></span>` : `<span class="bad">sent &middot; ${esc(r?.coding_object || "no response")}</span>`;
  setHtml($("#saProtected"), `<div class="sa-cardhd"><h2>Try ${esc(SA.prot)}</h2><span class="tag real">ODX PRE-CONDITION</span></div>
    <div class="sa-gate ${gate.allowed ? "allowed" : "blocked"}"><span class="sa-gateword">${gate.allowed ? "Allowed" : "Blocked"}</span>
      <span class="small">${gate.allowed ? "pre-condition met" : "chart pre-condition not met"}</span></div>
    <div class="small sa-gatefacts">requires <code>${esc(tg.chart)}</code> = <b>${esc(gate.requires.join(" | "))}</b> &middot; active: <b>${esc(cur)}</b></div>
    <div class="small sa-gatefacts">last try: ${last}</div>`);
}
function saButtons() {
  const sec = SA.st?.ecu?.security, tg = saTarget(), b = SA.busy || !tg;
  $("#saSeed").disabled = b; $("#saWrong").disabled = b; $("#saTry").disabled = b; $("#saStop").disabled = b; $("#saReset").disabled = b;
  const usable = SA.seed && !SA.seedUsed && SA.seed.some(x => x) && sec?.seed_pending;
  $("#saCompute").disabled = b || !usable || (!!SA.steps && !SA.wrong);
  $("#saSend").disabled = b || !usable;
}
function saDrawChart() {
  const tg = saTarget(); if (!tg) return;
  const sc = tg.summary.state_charts.find(c => c.name === tg.chart);
  const active = (SA.st?.layer === tg.layer && SA.st?.charts?.[sc.name]) || S.live?.charts?.[sc.name] || sc.start;
  setHtml($("#saChart"), chartHtml(sc, active, "sa"));
}
function saStatus(st) {
  SA.st = st;
  const tg = saTarget();
  if (!tg || st.layer !== tg.layer) { saButtons(); return; }
  setHtml($("#saConn"), `<span class="pill on">Connected</span> <span class="mono">${esc(st.layer)}</span><br><span class="muted small" style="margin:0">tester &rarr; ECU <code>${hex2(st.rx_id)}</code> &middot; ECU &rarr; tester <code>${hex2(st.tx_id)}</code> &middot; virtual CAN</span>`);
  saRenderLock(); saRenderProtected(); saDrawChart(); saButtons();
}

async function saRun(fn) {
  if (SA.busy) return;
  SA.busy = true; saButtons();
  try { if (await saEnsure()) await fn(); }
  finally { SA.busy = false; SA.unlocking = false; saRenderLock(); saButtons(); }
}
function saCompute() {
  if (!SA.seed) return;
  SA.steps = saSteps(SA.seed); SA.key = SA.steps.k; SA.wrong = false; SA.keyState = null; saRenderPipe();
}
const saSendKey = () => sendLive({service: "security_send_key", params: {security_key: SA.key.map(hx).join("")}});
$("#saSeed").onclick = () => saRun(() => sendLive({service: "security_request_seed"}));
$("#saCompute").onclick = () => saRun(async () => { saCompute(); await pause(1100); });
$("#saSend").onclick = () => saRun(async () => {
  if (!SA.steps || SA.wrong) { saCompute(); await pause(1200); }
  SA.unlocking = true; SA.keyState = "sending"; saRenderPipe(); saRenderLock();
  await pause(300);
  await saSendKey();
});
$("#saWrong").onclick = () => saRun(async () => {
  if (!SA.seed || SA.seedUsed || !SA.st?.ecu?.security?.seed_pending) {
    const tx = await sendLive({service: "security_request_seed"});
    if (tx?.response?.kind !== "positive" || !SA.seed) return;
    await pause(500);
  }
  SA.steps = null; SA.key = saSteps(SA.seed).k.map(b => b ^ 0xff); SA.wrong = true; SA.keyState = null; saRenderPipe();
  await pause(400);
  await saSendKey();
});
$("#saTry").onclick = () => saRun(() => sendLive({service: SA.prot || "headstand", params: SA.prot === "headstand" || !SA.prot ? {duration: "3"} : {}}));
$("#saStop").onclick = () => saRun(() => sendLive({service: "session_stop"}));
$("#saReset").onclick = () => saRun(async () => { await $("#liveReset").onclick(); saClear(); });
saClear();

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
});
