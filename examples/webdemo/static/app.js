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
  if (S.live && S.live.db !== name) liveDetach(`The live session belongs to ${S.live.db}. Connect or send to start a session for ${name}.`);
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
  // with fault memory, prefer the variant that can run every modeled fault trigger
  const fm = ecus.filter(fmHasFaults).sort((a, b) => b.services.length - a.services.length)[0];
  if (fm) $("#liveLayer").value = fm.name;
  updateLiveChartOptions();
  selectLayer(def.name);
  fmResetView(); fmRenderAll();
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
$("#liveLayer").onchange = () => { updateLiveChartOptions(); fmResetView(); fmRenderAll(); connectLive(); };
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
  $("#txlog").innerHTML = ""; $("#trace tbody").innerHTML = "";
  $("#liveIds").innerHTML = `<span class="pill on">Connected</span> tester → ECU <code>${hex2(st.rx_id)}</code> · ECU → tester <code>${hex2(st.tx_id)}</code> · 500 kbit/s virtual CAN`;
  $("#liveStart").textContent = "Reconnect"; $("#liveReset").disabled = false;
  $("#fmConn").innerHTML = `<span class="pill on">Connected</span> ${esc(st.layer)} · ${hex2(st.rx_id)} / ${hex2(st.tx_id)}`;
  drawChart(); fmResetView(); fmRenderAll();
}

// forget the server-side session locally; the next send starts one for the selected ECU
function liveDetach(why) {
  S.gen = (S.gen || 0) + 1; S.live = null; S.ecu = null; S.lastTrans = null;
  $("#liveIds").innerHTML = `<span class="pill off">Disconnected</span> ${esc(why)}`;
  $("#liveStart").textContent = "Connect"; $("#liveReset").disabled = true; $("#fmConn").textContent = "Disconnected";
  $("#txlog").innerHTML = ""; $("#trace tbody").innerHTML = ""; $("#gauges").innerHTML = ""; $("#frameRate").textContent = "";
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
    liveDetach(`Another client replaced the live session (${st.db} / ${st.layer}). Connect or send to start a session for the selected ECU.`);
    return;
  }
  const seen = S.after, fresh = x => x.seq > seen, prevTrans = S.lastTrans;
  for (const f of st.frames.filter(fresh)) addFrame(f);
  for (const t of st.transactions.filter(fresh)) {
    addTx(t);
    if (!t.blocked && t.state_before && t.state_before !== t.state_after) S.lastTrans = {chart: t.chart, from: t.state_before, to: t.state_after, service: t.service};
  }
  const all = [...st.frames, ...st.transactions]; if (all.length) S.after = Math.max(S.after, ...all.map(x => x.seq));
  renderGauges(st.ecu);
  S.ecu = st.ecu; fmRenderTimeline();
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
  const active = S.live?.charts?.[sc.name] || sc.start;
  const W = 400, H = 360, cx = W / 2, cy = H / 2 + 6, R = 132;
  const pos = {}; sc.states.forEach((s, i) => { const a = -Math.PI / 2 + i * 2 * Math.PI / sc.states.length; pos[s] = [cx + R * Math.cos(a), cy + R * Math.sin(a)]; });
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%"><defs><marker id="ar2" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0L10,5L0,10z" fill="#9a9a9a"/></marker></defs>`;
  for (const t of sc.transitions) {
    const [x1, y1] = pos[t.from], [x2, y2] = pos[t.to];
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy) || 1, nx = -dy / len, ny = dx / len, bend = 30;
    const sx = x1 + dx / len * 34, sy = y1 + dy / len * 22, ex = x2 - dx / len * 36, ey = y2 - dy / len * 24;
    const mx = (sx + ex) / 2 + nx * bend, my = (sy + ey) / 2 + ny * bend;
    const trig = t.services.length;
    svg += `<path d="M${sx},${sy} Q${mx},${my} ${ex},${ey}" fill="none" stroke="${trig ? "#0078d6" : "#bdbdbd"}" stroke-width="${trig ? 1.5 : 1}" marker-end="url(#ar2)"/>`;
  }
  for (const s of sc.states) {
    const [x, y] = pos[s], on = s === active;
    svg += `<g><ellipse cx="${x}" cy="${y}" rx="44" ry="22" fill="${on ? "#000" : "#fff"}" stroke="${on ? "#000" : "#bdbdbd"}" stroke-width="1.2"></ellipse>
      <text x="${x}" y="${y + 4}" font-size="11.5" text-anchor="middle" fill="${on ? "#fff" : "#333"}" font-weight="${on ? 600 : 400}">${esc(s)}</text></g>`;
  }
  const lt = S.lastTrans?.chart === sc.name && S.lastTrans.to === active ? S.lastTrans : null;
  const ran = lt && sc.transitions.find(t => t.from === lt.from && t.to === lt.to && (!lt.service || t.services.includes(lt.service)));
  const rows = sc.transitions.map(t => `<tr${t === ran ? ' class="cur"' : ""}><td>${esc(t.name)}</td><td class="mono">${esc(t.from)} &rarr; ${esc(t.to)}</td><td class="mono">${esc([...new Set(t.services)].join(", ") || "\u2013")}</td></tr>`).join("");
  $("#chartSvg").innerHTML = svg + `</svg><table class="transitions"><tr><th>Transition</th><th>States</th><th>Triggered by</th></tr>${rows}</table>`;
}

// ---------------------------------------------------------------- fault memory
const FM = {cards: new Map(), open: null, busy: false, eventsKey: null, lastRecords: null};
const fmHex = n => Number(n).toString(16).toUpperCase().padStart(6, "0");
const fmHasFaults = l => !!l && l.services.some(s => s.name === "read_dtc_by_status_mask");
const fmLayer = () => S.summary && liveLayerSummary();
const fmDtcs = () => fmLayer()?.dtcs || [];
const fmInitials = n => n.split("_").map(w => w[0]).join("").toUpperCase();
const fmHuman = n => n.replace(/_/g, " ").replace(/\bdtc\b/g, "DTC");
const fmMask = () => S.ecu?.fault_memory?.availability_mask ?? 0xFF;
function fmProgress(html) { $("#fmProgress").innerHTML = html; }

function fmBytes(msg, cls = "") {
  const spans = msg.detail_spans?.length ? msg.detail_spans : (msg.spans || []);
  const bytes = msg.hex.match(/../g) || [];
  const colors = {}; let k = 0;
  spans.forEach(s => { if (!(s.param in colors)) colors[s.param] = PALETTE[k++ % PALETTE.length]; });
  const owner = bytes.map((_, i) => spans.find(s => i >= s.start && i < s.start + s.length));
  return `<div class="bytes ${cls}">${bytes.map((b, i) => {
    const o = owner[i], c = o ? colors[o.param] : "#9a9a9a";
    return `<div class="byte" style="background:${c};animation-delay:${Math.min(i * 18, 280)}ms" title="byte ${i}${o ? " · " + esc(o.path || o.param) : ""}">${esc(b.toUpperCase())}<small>${o && o.start === i ? esc(o.param) : "&nbsp;"}</small></div>`;
  }).join("")}</div>`;
}

function fmNrcCard(resp) {
  const n = resp.nrc; if (!n) return "";
  return `<div class="fm-nrc"><div><b>Negative response · ${esc(n.name)}</b><span>${esc(resp.coding_object || "")} for request SID 0x${esc(n.rq_sid.toString(16).toUpperCase().padStart(2, "0"))}${n.rq_name ? " (" + esc(n.rq_name) + ")" : ""}</span></div><div class="hex">0x${esc(n.code.toString(16).toUpperCase().padStart(2, "0"))}</div></div>`;
}

// one request/response pair; the strips fill in once the CAN frames arrived
async function fmExchange(label, body) {
  const box = $("#fmExchanges"); $(".fm-quiet", box)?.remove();
  const el = document.createElement("div"); el.className = "fm-ex";
  el.innerHTML = `<div class="hd"><b>${esc(label)}</b><span class="muted small">sending over ISO-TP…</span></div>
    <div class="dir"><span class="badge req">REQ</span><div class="fm-wait">waiting for CAN frames</div></div>
    <div class="dir"><span class="badge">RSP</span><div class="fm-wait">waiting for ECU</div></div>`;
  box.prepend(el); while (box.children.length > 8) box.lastChild.remove();
  const tx = await sendLive(body);
  const [rq, rs] = $$(".dir", el);
  if (!tx) { el.classList.add("neg"); rs.lastElementChild.outerHTML = `<div class="err">request failed, see the transaction log on Live ECU</div>`; rq.lastElementChild.outerHTML = `<div class="err">not sent</div>`; return null; }
  const resp = tx.response, pos = resp?.kind === "positive";
  $(".hd span", el).innerHTML = `<span class="tag real">REAL</span> ${esc(tx.frames ?? "?")} CAN frames · ${esc(tx.latency_ms)} ms`;
  rq.lastElementChild.outerHTML = `<div><span class="muted small" style="margin:0">${esc(tx.request.coding_object || "")}</span>${fmBytes(tx.request, "fm-in")}</div>`;
  await sleep(220);
  el.classList.add(pos ? "pos" : "neg");
  $(".badge", rs).className = `badge ${resp ? kindCls(resp.kind) : "neg"}`;
  rs.lastElementChild.outerHTML = resp ? `<div><span class="muted small" style="margin:0">${esc(resp.coding_object || "")}</span>${fmBytes(resp, "fm-in")}${fmNrcCard(resp)}</div>` : `<div class="err">timeout, no response</div>`;
  return tx;
}

function fmEmpty(cleared) {
  return `<div class="fm-empty${cleared ? " cleared" : ""}"><div class="line"></div><b>${cleared ? "Fault memory cleared" : "No stored faults"}</b>${cleared ? "The ECU confirmed <code>0x14 ClearDiagnosticInformation</code> with <code>54</code>." : "The last <code>19 02</code> read returned no DTC whose status matches the mask."}</div>`;
}

function fmCardHtml(r) {
  const d = r.dtc, occ = S.ecu?.fault_memory?.faults.find(f => f.trouble_code === d.trouble_code)?.occurrences;
  const bits = Object.entries(r.status || {}).map(([name, v], i) => `<span class="fm-bit${v ? " on" : ""}" data-bit="${esc(name)}" title="bit ${i} · ${esc(fmHuman(name))} = ${v ? 1 : 0}">${esc(fmInitials(name))}<i>b${i}</i></span>`).join("");
  return `<div class="code">${esc(d.display || fmHex(d.trouble_code))}<small>0x${esc(fmHex(d.trouble_code))}</small></div>
    <div class="text">${esc(d.text)}</div>
    <div class="meta"><span>${esc(d.short_name)}</span><span>occurrences <b>${esc(occ ?? "–")}</b> <span class="tag model" title="occurrence counter of the modeled fault memory">MODELED</span></span></div>
    <div class="fm-bits">${bits}</div>`;
}

function fmRenderCards(records) {
  FM.lastRecords = records;
  const wrap = $("#fmCards"), seen = new Set();
  $(".fm-empty", wrap)?.remove();
  for (const r of records) {
    const code = r.dtc.trouble_code; seen.add(code);
    let card = FM.cards.get(code);
    if (!card) {
      card = document.createElement("button"); card.className = "fm-card"; card.type = "button";
      card.innerHTML = fmCardHtml(r); card.onclick = () => fmSnapshot(code, r.dtc);
      FM.cards.set(code, card); wrap.appendChild(card);
    } else {
      // cross-fade changed status bits instead of re-rendering the card
      const fresh = document.createElement("div"); fresh.innerHTML = fmCardHtml(r);
      $$(".fm-bit", card).forEach((b, i) => { const nb = $$(".fm-bit", fresh)[i]; if (nb) { b.classList.toggle("on", nb.classList.contains("on")); b.title = nb.title; } });
      $(".meta", card).innerHTML = $(".meta", fresh).innerHTML;
    }
  }
  for (const [code, card] of FM.cards) if (!seen.has(code)) { card.classList.add("leave"); FM.cards.delete(code); setTimeout(() => card.remove(), 260); if (FM.open === code) fmCloseDrawer(); }
  $("#fmCount").textContent = `${records.length} DTC${records.length === 1 ? "" : "s"} · status mask 0x${fmMask().toString(16).toUpperCase()}`;
  if (!records.length) setTimeout(() => { if (!FM.cards.size && !$(".fm-empty", wrap)) wrap.insertAdjacentHTML("beforeend", fmEmpty(false)); }, 280);
}

function fmCloseDrawer() { FM.open = null; $("#fmDrawer").classList.remove("open"); $$(".fm-card").forEach(c => c.classList.remove("open")); }

async function fmSnapshot(code, dtc) {
  if (FM.open === code) { fmCloseDrawer(); return; }
  FM.open = code;
  $$(".fm-card").forEach(c => c.classList.toggle("open", c === FM.cards.get(code)));
  const dr = $("#fmDrawer");
  dr.innerHTML = `<div class="inner"><div class="hd"><h3>Snapshot record 0x01 · ${esc(dtc.display || fmHex(code))}</h3><span class="muted small">requesting <code>19 04 ${esc(spaced(fmHex(code)))} 01</code>…</span></div><div class="fm-wait">waiting for ECU</div></div>`;
  dr.classList.add("open");
  const tx = await fmExchange(`Snapshot ${dtc.display || fmHex(code)}`, {service: "read_dtc_snapshot", params: {dtc: "0x" + fmHex(code), record_number: "0x01"}});
  if (FM.open !== code) return;
  const resp = tx?.response;
  if (!resp || resp.kind !== "positive") { $(".inner", dr).innerHTML = `<h3>Snapshot record 0x01 · ${esc(dtc.display || fmHex(code))}</h3>${resp ? fmNrcCard(resp) : `<div class="err">no response</div>`}`; return; }
  const sn = resp.params.snapshot || {}, lim = S.ecu?.limits || {temperature: 65};
  const g = (label, v, max, limv, unit) => `<div class="gauge"><div class="lab"><span>${esc(label)}</span><span class="mono">${esc(v)}${esc(unit)}</span></div><div class="bar"><div class="fill" style="width:${Math.min(100, v / max * 100)}%;background:${v >= limv ? "#d92121" : v > limv * .85 ? "#e09400" : "#000"}"></div><div class="lim" style="left:${limv / max * 100}%" title="limit ${esc(limv)}${esc(unit)}"></div></div></div>`;
  $(".inner", dr).innerHTML = `<div class="hd"><h3>Snapshot record 0x${esc(Number(resp.params.record_number).toString(16).padStart(2, "0"))} · ${esc(resp.params.dtc.display)} ${esc(resp.params.dtc.text)}</h3><span><span class="tag real">REAL</span> <span class="muted small">decoded by odxtools from <code>${esc(resp.coding_object)}</code></span></span></div>
    <div class="fm-snapgrid"><div>${g("Temperature at fault", sn.temperature, 100, lim.temperature, " °C")}${g("Dizziness at fault (of flip limit)", sn.dizziness, 150, 100, " %")}</div>
    <div class="fm-figs"><div>Total flips<b>${esc(sn.total_flips)}</b></div><div>Stored at<b>t+${esc(sn.timestamp)} s</b></div></div></div>
    ${fmBytes(resp, "fm-in")}`;
}

async function fmRead() {
  const tx = await fmExchange("Read DTCs by status mask", {service: "read_dtc_by_status_mask", params: {status_mask: "0x" + fmMask().toString(16)}});
  if (tx?.response?.kind === "positive") fmRenderCards(tx.response.params.dtc_records || []);
}
async function fmClear() {
  const tx = await fmExchange("Clear diagnostic information", {service: "clear_dtcs"});
  if (tx?.response?.kind !== "positive") return;
  fmCloseDrawer(); FM.lastRecords = [];
  const cards = [...FM.cards.values()]; FM.cards.clear();
  cards.forEach((c, i) => setTimeout(() => c.classList.add("leave"), i * 80));
  await sleep(cards.length * 80 + 260);
  cards.forEach(c => c.remove()); $(".fm-empty", $("#fmCards"))?.remove();
  await poll();
  if (S.ecu?.fault_memory?.faults.length) {
    // a still-failing monitor (e.g. the acrobat is still too hot) re-stores its DTC right away
    fmProgress(`<span class="tag model">MODELED</span> a fault condition is still active and was re-detected after the clear; reading the fault memory again`);
    await fmRead();
    return;
  }
  $("#fmCards").insertAdjacentHTML("beforeend", fmEmpty(true)); $("#fmCount").textContent = "0 DTCs";
}

// ---- modeled fault triggers: drive the ECU through ordinary ODX services
const fmHas = n => fmLayer()?.services.some(s => s.name === n);
async function fmReady() {
  if (!S.live) await connectLive();
  await poll();
  if (!S.ecu) { await connectLive(); await poll(); }
  if (!S.ecu) throw new Error("no live session for the selected ECU");
  for (let i = 0; i < 60 && S.ecu && S.ecu.temperature > S.ecu.limits.temperature; i++) {
    fmProgress(`<span class="tag model">MODELED</span> waiting for the acrobat to cool down: ${esc(S.ecu.temperature)} °C &gt; ${esc(S.ecu.limits.temperature)} °C, the ECU answers <i>too_hot</i> until then`);
    await sleep(600); await poll();
  }
  if (!S.ecu?.session_active) await sendLive({service: "session_start", params: {bribe: "1"}});
}
const FM_RECIPES = [
  {id: "fire", title: "Fire-ring flip", needs: ["set_operation_params", "do_forward_flips"],
    what: "Light the fire ring, then request a flip that fails its soberness check",
    async run() {
      await sendLive({service: "set_operation_params", params: {use_fire_ring: "true"}});
      await sleep(350);
      await sendLive({service: "do_forward_flips", params: {forward_soberness_check: "0x42", num_flips: "1"}});
      await sleep(350);
      await sendLive({service: "set_operation_params", params: {use_fire_ring: "false"}});
    }},
  {id: "dizzy", title: "Flip while dizzy", needs: ["do_forward_flips"],
    what: "Make the acrobat dizzy (headstand), then ask for ten flips",
    async run() {
      if (fmHas("headstand") && S.ecu.dizziness <= S.ecu.limits.dizziness / 2) { await sendLive({service: "headstand", params: {duration: "255"}}); await sleep(350); }
      for (let i = 0; i < 4; i++) {
        const tx = await sendLive({service: "do_forward_flips", params: {forward_soberness_check: "0x12", num_flips: "10"}});
        if (tx?.response?.params?.reason === 1 || tx?.response?.kind !== "positive") return;
        await sleep(350);
      }
    }},
  {id: "hot", title: "Overheat", needs: ["do_forward_flips"],
    what: "Repeated flips (fire ring lit, 4 °C each) until the temperature crosses the limit",
    async run() {
      const ring = fmHas("set_operation_params"), prev = !!S.ecu.fire_ring;
      const setRing = v => sendLive({service: "set_operation_params", params: {use_fire_ring: String(v)}});
      // the ECU refuses set_operation_params once it is too hot, so restore the ring before the last flips
      let lit = ring && !prev;
      if (lit) await setRing(true);
      try {
        const until = Date.now() + 120000;
        while (S.ecu && Date.now() < until) {
          const e = S.ecu, lim = e.limits;
          if (e.temperature > lim.temperature) return;
          let n;
          if (lit) {
            n = Math.floor((lim.temperature - 0.5 - e.temperature) / 4);
            if (n < 1) { await setRing(false); lit = false; continue; }
          } else n = Math.ceil((lim.temperature - e.temperature + 0.01) / (e.fire_ring ? 4 : 2.5));
          n = Math.min(10, n);
          const room = Math.floor((lim.dizziness - 1 - e.dizziness) / 14);
          if (room < n) { fmProgress(`<span class="tag model">MODELED</span> letting the dizziness settle (${esc(e.dizziness)} / ${esc(lim.dizziness)}) so ${n} flip${n > 1 ? "s" : ""} in a row are not refused`); await sleep(700); await poll(); continue; }
          fmProgress(`<span class="tag model">MODELED</span> ${n} forward flip${n > 1 ? "s" : ""}${e.fire_ring ? " through the fire ring" : ""} · ${esc(e.temperature)} °C → limit ${esc(lim.temperature)} °C`);
          await sendLive({service: "do_forward_flips", params: {forward_soberness_check: "0x12", num_flips: String(n)}});
          await sleep(400);
        }
      } finally {
        if (lit && S.live && S.ecu && S.ecu.temperature <= S.ecu.limits.temperature) await setRing(false);
      }
    }},
];
function fmRenderMenu() {
  $("#fmMenu").innerHTML = FM_RECIPES.map(r => {
    const missing = r.needs.filter(n => !fmHas(n));
    return `<button role="menuitem" data-r="${r.id}"${missing.length ? " disabled" : ""}><b>${esc(r.title)}</b><span>${missing.length ? `not possible on ${esc(fmLayer()?.name)}: no ${esc(missing.join(", "))}` : esc(r.what)}</span></button>`;
  }).join("");
  $$("#fmMenu button").forEach(b => b.onclick = () => fmProvoke(FM_RECIPES.find(r => r.id === b.dataset.r)));
}
function fmToggleMenu(open) { $("#fmMenu").hidden = !open; $("#fmProvoke").setAttribute("aria-expanded", String(open)); }
async function fmProvoke(r) {
  fmToggleMenu(false); if (FM.busy) return; FM.busy = true; fmSetBusy();
  const before = (S.ecu?.fault_memory?.events || []).length;
  try {
    fmProgress(`<span class="tag model">MODELED</span> ${esc(r.title)}: ${esc(r.what.toLowerCase())}…`);
    await fmReady(); await r.run(); await poll();
    const ev = (S.ecu?.fault_memory?.events || []).slice(before).filter(e => e.kind === "stored");
    fmProgress(ev.length ? `<span class="tag model">MODELED</span> the ECU stored ${ev.map(e => `<b class="mono">${esc(fmHex(e.trouble_code))}</b>`).join(", ")}: ${esc(ev[ev.length - 1].trigger)}. Press <b>Read DTCs</b> to fetch it over UDS.` : `<span class="tag model">MODELED</span> no new fault was stored.`);
  } catch (e) { fmProgress(`<span class="err">${esc(r.title)} stopped: ${esc(e.message)}</span>`); } finally { FM.busy = false; fmSetBusy(); }
}
function fmSetBusy() { const off = FM.busy || !fmHasFaults(fmLayer()); ["#fmRead", "#fmClear", "#fmProvoke"].forEach(id => $(id).disabled = off); }

function fmRenderTimeline() {
  const fm = S.ecu?.fault_memory, el = $("#fmTimeline");
  const dtcs = fmDtcs(), events = fm?.events || [];
  const span = Math.max(30, Math.ceil(((fm?.since_connect || 0) + 5) / 10) * 10);
  const last = events[events.length - 1];
  const key = JSON.stringify([dtcs.map(d => d.trouble_code), events.length, last?.t, last?.kind, span, S.live?.session]);
  const pct = t => `${(t / span * 100).toFixed(2)}%`;
  if (key !== FM.eventsKey) {
    FM.eventsKey = key;
    if (!dtcs.length) { el.innerHTML = `<div class="fm-quiet">The selected ECU variant defines no DTC-DOP, so there is nothing to store.</div>`; return; }
    const lanes = dtcs.map(d => ({who: `<b>${esc(d.display)}</b>${esc(d.text)}`, ev: events.filter(e => e.trouble_code === d.trouble_code), d}));
    lanes.push({who: `<b>14</b>clear requests`, ev: events.filter(e => e.kind === "cleared")});
    const mark = (e, d) => {
      const what = e.kind === "cleared" ? "Fault memory cleared" : e.kind === "passed" ? `${esc(d.display)} test passed, testFailed bit reset` : `${esc(d.display)} stored · occurrence ${esc(e.occurrences)}`;
      return `<span class="fm-mark ${esc(e.kind)}" tabindex="0" style="left:${pct(e.t)}" aria-label="${what}: ${esc(e.trigger)}"><span class="fm-tip"><b>t+${esc(e.t.toFixed(1))} s</b> · ${what}<br>${esc(e.trigger)}</span></span>`;
    };
    const ticks = Array.from({length: span / 10 + 1}, (_, i) => `<span style="left:${pct(i * 10)}">${i * 10}s</span>`).join("");
    el.innerHTML = lanes.map(l => `<div class="fm-lane"><div class="who" title="${l.d ? esc(l.d.short_name) : ""}">${l.who}</div><div class="fm-track">${l.ev.map(e => mark(e, l.d)).join("")}</div></div>`).join("") +
      `<div class="fm-axis"><div></div><div class="ticks">${ticks}<i class="fm-now"></i></div></div>`;
  }
  const now = $(".fm-now", el); if (now && fm) now.style.left = pct(fm.since_connect);
}

function fmRenderAll() {
  const l = fmLayer(), ok = fmHasFaults(l);
  $("#fmRibbon").hidden = $("#dbRibbon").hidden = !S.summary?.demo_extension;
  $("#fmRibbon").title = S.summary?.demo_extension || "";
  $("#fmMask").textContent = `19 02 ${fmMask().toString(16).toUpperCase().padStart(2, "0")}`;
  const un = $("#fmUnsupported"); un.hidden = ok;
  if (!ok) {
    const alt = [...$("#dbSelect").options].map(o => o.value).find(n => n.includes("dtc"));
    un.innerHTML = `<h3>No fault memory in this database</h3><div>${esc(S.db)} / ${esc(l?.name)} defines no <code>0x19</code> / <code>0x14</code> services or DTC-DOP.${alt ? ` <button class="btn ghost" id="fmUseDemo">Open ${esc(alt)}</button>` : ""}</div>`;
    $("#fmUseDemo")?.addEventListener("click", async () => { $("#dbSelect").value = alt; await openDb(alt); });
  }
  fmRenderMenu(); fmSetBusy(); fmRenderTimeline();
}
function fmResetView() {
  FM.cards.clear(); FM.open = null; FM.eventsKey = null; FM.lastRecords = null;
  $("#fmCards").innerHTML = fmEmpty(false).replace("The last <code>19 02</code> read returned no DTC whose status matches the mask.", "Provoke a fault, then read the fault memory with <code>19 02</code>.");
  $("#fmCount").textContent = ""; $("#fmDrawer").classList.remove("open"); fmProgress("");
  $("#fmExchanges").innerHTML = `<div class="fm-quiet">Read, snapshot and clear requests appear here as they cross the bus.</div>`;
}
$("#fmRead").onclick = fmRead;
$("#fmClear").onclick = fmClear;
$("#fmProvoke").onclick = e => { e.stopPropagation(); fmToggleMenu($("#fmMenu").hidden); };
document.addEventListener("click", e => { if (!e.target.closest(".fm-provoke")) fmToggleMenu(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape") fmToggleMenu(false); });

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
