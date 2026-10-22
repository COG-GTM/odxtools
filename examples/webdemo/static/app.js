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
  if (b.dataset.tab === "faults" && fmSupported() && !fmSessionOk()) connectLive();
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
  // with fault memory services, prefer the variant which can provoke every modeled fault
  const fmFull = ecus.find(l => [...FM_SERVICES, ...FM_FULL].every(n => l.services.some(s => s.name === n)));
  if (fmFull) $("#liveLayer").value = fmFull.name;
  updateLiveChartOptions();
  selectLayer(def.name);
  fmSyncDb();
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
$("#liveLayer").onchange = () => { updateLiveChartOptions(); fmSyncDb(); connectLive(); };
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
  drawChart();
  fmReset();
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
    $("#txlog").innerHTML = ""; $("#trace tbody").innerHTML = ""; $("#gauges").innerHTML = ""; $("#frameRate").textContent = "";
    drawChart(); fmReset();
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
  fmOnPoll(st.ecu);
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

// ---------------------------------------------------------------- fault memory
const FM_SERVICES = ["read_dtc_by_status_mask", "read_dtc_snapshot", "clear_dtcs"];
const FM_FULL = ["headstand", "set_operation_params", "do_forward_flips"];
const FM_MASK = "0xFF";
// ISO 14229-1 statusOfDTC, bit 0 ... bit 7
const ISO_BITS = [["TF", "testFailed"], ["TFTOC", "testFailedThisOperationCycle"], ["PDTC", "pendingDTC"], ["CDTC", "confirmedDTC"],
  ["TNCSLC", "testNotCompletedSinceLastClear"], ["TFSLC", "testFailedSinceLastClear"], ["TNCTOC", "testNotCompletedThisOperationCycle"], ["WIR", "warningIndicatorRequested"]];
const FM = {cards: new Map(), texts: {}, ecu: null, open: null, busy: false, tlKey: "", tlSeen: 0};
const dtcHex = c => "0x" + Number(c).toString(16).toUpperCase().padStart(6, "0");
const byteHex = n => "0x" + Number(n).toString(16).toUpperCase().padStart(2, "0");
const fmHas = n => !!liveLayerSummary()?.services.some(s => s.name === n);
const fmSupported = () => FM_SERVICES.every(fmHas);
// the live session must belong to the selected database and ECU variant
const fmSessionOk = () => !!S.live && S.live.db === S.db && S.live.layer === $("#liveLayer").value;
const fmProg = h => { $("#fmProgress").innerHTML = h; };

function fmSyncDb() {
  $("#fmLayer").innerHTML = $("#liveLayer").innerHTML; $("#fmLayer").value = $("#liveLayer").value;
  const dbHasFm = S.summary.layers.some(l => FM_SERVICES.every(n => l.services.some(s => s.name === n)));
  $("#demoRibbon").hidden = !(dbHasFm && /somersault_dtc/.test(S.db));
  const ok = fmSupported();
  $("#fmUnsupported").hidden = ok; $("#fmBody").hidden = !ok;
  ["#fmRead", "#fmClear", "#fmProvoke"].forEach(id => $(id).disabled = !ok);
  if (!ok) $("#fmUnsupported").innerHTML = `<b>No fault memory in this ECU description</b>${esc(S.db)} / ${esc($("#liveLayer").value)} defines no ReadDTCInformation and ClearDiagnosticInformation services.<br>Select <code>somersault_dtc.pdx</code> in the database picker to use the demo PDX extension.`;
  fmReset();
}
$("#fmLayer").onchange = () => { $("#liveLayer").value = $("#fmLayer").value; $("#liveLayer").onchange(); };

function fmReset() {
  FM.cards.clear(); FM.open = null; FM.tlKey = ""; FM.tlSeen = 0;
  $("#fmCards").innerHTML = ""; fmEmpty("Not read yet", `Press Read DTCs to send 19 02 ${FM_MASK.slice(2)} (reportDTCByStatusMask).`, true);
  $("#fmCount").textContent = ""; fmCloseDrawer(); fmProg("");
  $("#fmExchanges").innerHTML = `<div class="muted fmhint">Read, snapshot and clear requests appear here, and in the Live Virtual ECU CAN trace and transaction log.</div>`;
  $("#fmTimeline").innerHTML = `<div class="tl-idle">Connect to the virtual ECU to start the session timeline.</div>`;
}

function fmOnPoll(ecu) {
  FM.ecu = ecu; if (!ecu || !$("#fmBody") || $("#fmBody").hidden) return;
  const L = ecu.limits, hot = ecu.temperature > L.temperature;
  $("#fmNow").innerHTML = `ECU now <span class="tag model">MODELED</span> <b>${ecu.temperature.toFixed(1)} °C</b> / ${L.temperature} °C${hot ? ` <span class="hot">HOT</span>` : ""} · dizziness <b>${ecu.dizziness.toFixed(0)}</b> / ${L.dizziness} · ${ecu.session_active ? "session active" : "no session"}`;
  fmTimeline(ecu);
  const occ = ecu.fault_memory?.occurrences || {};
  for (const [code, el] of FM.cards) { const o = $(".occ", el), v = occ[code] ?? "–"; if (o.textContent !== String(v)) o.textContent = v; }
}

function fmTimeline(ecu) {
  const fm = ecu.fault_memory || {}, ev = fm.events || [], T = Math.max(20, ecu.uptime || 0);
  const pct = t => (Math.min(1, t / T) * 100).toFixed(2) + "%";
  const codes = [...new Set(ev.filter(e => e.code != null).map(e => e.code))].sort((a, b) => a - b);
  const key = ev.length + "|" + codes.join(",") + "|" + Object.keys(FM.texts).length;
  const tl = $("#fmTimeline");
  if (key !== FM.tlKey) {
    FM.tlKey = key;
    const tip = (e, i) => {
      const side = e.t / T > .7 ? "r" : e.t / T < .2 ? "l" : "";
      return `<span class="tl-tip ${side}"><span class="k">${esc(e.kind.toUpperCase())} · t = ${esc(e.t.toFixed(1))} s · MODELED TRIGGER</span><b>${esc(dtcHex(e.code))}</b> ${esc(FM.texts[e.code] || "")}<br>${esc(e.trigger)}<br><span style="color:#9f9f9f">status ${esc(byteHex(e.status))} · occurrence ${esc(e.occurrences)}</span></span>`;
    };
    const lanes = codes.map(c => `<div class="tl-lane"><div class="tl-label" title="${esc(FM.texts[c] || "")}">${esc(dtcHex(c))}</div><div class="tl-track">${
      ev.map((e, i) => [e, i]).filter(([e]) => e.code === c).map(([e, i]) => `<span class="tl-mark ${esc(e.kind)}${i < FM.tlSeen ? " seen" : ""}" tabindex="0" data-t="${e.t}" style="left:${pct(e.t)}" aria-label="${esc(dtcHex(c))} ${esc(e.kind)} at ${esc(e.t.toFixed(1))} s: ${esc(e.trigger)}">${tip(e, i)}</span>`).join("")}</div></div>`).join("");
    const clears = ev.map((e, i) => [e, i]).filter(([e]) => e.kind === "cleared").map(([e, i]) => `<div class="tl-clear${i < FM.tlSeen ? " seen" : ""}" data-t="${e.t}" style="left:${pct(e.t)}" title="${esc(e.trigger)} at ${esc(e.t.toFixed(1))} s"><span>CLEARED</span></div>`).join("");
    tl.innerHTML = `<div class="tl-body">${lanes || `<div class="tl-idle">No fault events in this session yet. Use Provoke fault to drive the modeled ECU into a fault.</div>`}${clears}<div class="tl-now"></div><div class="tl-axis">${[0, .25, .5, .75, 1].map(f => `<span class="tl-tick" data-f="${f}" style="left:${f * 100}%"></span>`).join("")}</div></div>`;
    FM.tlSeen = ev.length;
  }
  $$("[data-t]", tl).forEach(el => el.style.left = pct(+el.dataset.t));
  $$(".tl-tick", tl).forEach(el => el.textContent = +el.dataset.f === 1 ? `now · ${(ecu.uptime || 0).toFixed(0)} s` : `${(T * el.dataset.f).toFixed(0)} s`);
}

// a two-row request/response byte strip that fills in once the CAN frames arrived
const fmLabel = p => p.replace(/^dtcs\[(\d+)\]\.(.*)$/, (_, i, n) => `${n} #${+i + 1}`).replace(/^snapshot\./, "");
function fmBytes(msg, delay) {
  const spans = msg.detail_spans || msg.spans || [], bytes = msg.hex.match(/../g) || [];
  const groups = [...new Set(spans.map(s => s.group || s.param))];
  return `<div class="bytes">${bytes.map((b, i) => {
    const o = spans.find(s => i >= s.start && i < s.start + s.length);
    const c = o ? PALETTE[groups.indexOf(o.group || o.param) % PALETTE.length] : "#9a9a9a";
    return `<div class="byte" style="background:${c};--i:${i};--d:${delay}ms" title="byte ${i}${o ? " · " + esc(o.param) : ""}">${esc(b.toUpperCase())}<small>${o && o.start === i ? esc(fmLabel(o.param)) : "&nbsp;"}</small></div>`;
  }).join("")}</div>`;
}
function fmNrcHtml(tx) {
  if (!tx) return `<div class="nrc"><b>Request failed</b><span class="muted">the server did not return a transaction</span></div>`;
  if (tx.blocked) return `<div class="nrc"><b>Blocked by the state chart</b><span class="muted">no PRE-CONDITION-STATE-REF of ${esc(tx.service)} applies in ${esc(tx.state_before)}</span></div>`;
  const r = tx.response; if (!r) return `<div class="nrc"><b>Timeout</b><span class="muted">no response on the CAN bus</span></div>`;
  const code = r.nrc ? byteHex(r.nrc.code) : (r.hex.length >= 6 ? byteHex(parseInt(r.hex.slice(4, 6), 16)) : "");
  return `<div class="nrc"><b>${esc(r.nrc?.name || r.coding_object)}</b><span>NRC ${esc(code)}</span><span class="muted">${esc(r.coding_object)} · ${esc(spaced(r.hex))}</span></div>`;
}
function fmSummary(tx) {
  const p = tx.response.params || {};
  if (tx.service === "read_dtc_by_status_mask") return `<div class="summary"><b>${(p.dtcs || []).length}</b> DTC(s) match status mask ${esc(byteHex(tx.request.params.status_mask ?? 255))} · status availability mask ${esc(byteHex(p.status_availability_mask))}</div>`;
  if (tx.service === "read_dtc_snapshot") return `<div class="summary">Snapshot record <b>${esc(byteHex(p.record_number))}</b> of <b>${esc(dtcHex(p.dtc?.trouble_code))}</b> ${esc(p.dtc?.text || "")}</div>`;
  if (tx.service === "clear_dtcs") return `<div class="summary">Fault memory cleared (group of DTC 0xFFFFFF = all groups)</div>`;
  return "";
}
async function sendFm(body, title) {
  const box = $("#fmExchanges"); $(".fmhint", box)?.remove();
  const el = document.createElement("div"); el.className = "fmx";
  el.innerHTML = `<div class="fmx-hd"><b>${esc(title)}</b><span class="muted small">sending</span></div><div class="pending"><i></i><i></i><i></i> waiting for the ISO-TP frames on the virtual CAN bus</div>`;
  box.prepend(el); while (box.children.length > 8) box.lastChild.remove();
  const tx = await sendLive(body);
  const r = tx?.response, ok = r?.kind === "positive";
  el.classList.add(ok ? "pos" : "neg");
  if (tx) el.innerHTML = `<div class="fmx-hd"><b>${esc(tx.service || tx.request.coding_object || title)}</b><span class="muted small">${tx.blocked ? "not sent" : `${esc(tx.frames ?? "?")} CAN frames · ${esc(tx.latency_ms)} ms`}</span></div>
    <div class="pair-row"><span class="dir">REQ →</span>${fmBytes(tx.request, 0)}</div>
    <div class="pair-row"><span class="dir">← RESP</span>${r ? fmBytes(r, (tx.request.hex.length / 2) * 28 + 160) : `<div class="pending">${tx.blocked ? "not sent" : "no response"}</div>`}</div>
    ${ok ? fmSummary(tx) : fmNrcHtml(tx)}`;
  else el.innerHTML = `<div class="fmx-hd"><b>${esc(title)}</b></div>${fmNrcHtml(tx)}`;
  return tx;
}

function fmEmpty(title, sub, now) {
  const show = () => { const box = $("#fmCards"); if (box.querySelector(".dtc:not(.leaving)") || box.querySelector(".cards-empty")) return;
    box.insertAdjacentHTML("beforeend", `<div class="cards-empty"><div class="line"></div><b>${esc(title)}</b><span>${esc(sub)}</span></div>`); };
  if (now) show(); else setTimeout(show, 280);
}
function fmCardHtml(d) {
  return `<div class="dtc-top"><span class="dtc-hex">${esc(dtcHex(d.trouble_code))}</span><span class="badge">${esc(d.display_trouble_code || d.short_name)}</span></div>
    <div class="dtc-text">${esc(d.text)}</div>
    <div class="dtc-meta"><span title="Counted by the modeled ECU (not transmitted by 19 02)">Occurrences <b class="occ">–</b></span><span>ODX level ${esc(d.level ?? "–")}</span></div>
    <div class="chips">${ISO_BITS.map(([a, n], i) => `<span class="bit" data-bit="${i}" title="bit ${i} · ${esc(n)}">${esc(a)}</span>`).join("")}</div>
    <div class="dtc-foot">Read snapshot record 0x01 &rarr;</div>`;
}
function fmRenderCards(records, emptyTitle = "No stored faults", emptySub = `0 DTCs match status mask ${FM_MASK}. The fault memory is empty.`) {
  const box = $("#fmCards"); $$(".cards-empty", box).forEach(e => e.remove());
  const seen = new Set(); let fresh = 0;
  for (const rec of records) {
    const d = rec.dtc, code = d.trouble_code; seen.add(code); FM.texts[code] = d.text;
    let el = FM.cards.get(code);
    if (!el) {
      el = document.createElement("button"); el.className = "dtc"; el.type = "button";
      el.style.animationDelay = `${fresh++ * 80}ms`; el.innerHTML = fmCardHtml(d);
      el.onclick = () => fmSnapshot(code); box.appendChild(el); FM.cards.set(code, el);
    }
    el.dataset.short = d.short_name;
    Object.values(rec.status || {}).forEach((v, i) => { const chip = $(`.bit[data-bit="${i}"]`, el); if (chip) { chip.classList.toggle("on", !!v); chip.title = `bit ${i} · ${ISO_BITS[i][1]} = ${v}`; } });
  }
  for (const [code, el] of [...FM.cards]) if (!seen.has(code)) {
    FM.cards.delete(code); el.classList.add("leaving"); setTimeout(() => el.remove(), 260);
    if (FM.open === code) fmCloseDrawer();
  }
  if (!records.length) fmEmpty(emptyTitle, emptySub);
  $("#fmCount").textContent = `${records.length} stored · status mask ${FM_MASK}`;
  if (FM.ecu) fmOnPoll(FM.ecu);
}
async function fmRead() {
  const tx = await sendFm({service: "read_dtc_by_status_mask", params: {status_mask: FM_MASK}}, "read_dtc_by_status_mask");
  if (tx?.response?.kind === "positive") fmRenderCards(tx.response.params.dtcs || []);
}
async function fmClear() {
  const tx = await sendFm({service: "clear_dtcs", params: {}}, "clear_dtcs");
  if (tx?.response?.kind === "positive") { fmCloseDrawer(); fmRenderCards([], "Fault memory cleared", "14 FF FF FF was acknowledged with 54. Read DTCs again to confirm."); $("#fmCount").textContent = "cleared"; }
}
function fmCloseDrawer() { FM.open = null; $("#fmDrawer").classList.remove("open"); FM.cards.forEach(c => c.classList.remove("active")); }
function fmGauge(label, v, max, lim, unit) {
  const over = v > lim;
  return `<div class="gauge"><div class="lab"><span>${esc(label)}</span><span class="mono">${esc(v)}${esc(unit)}${over ? ` <span class="over">over ${esc(lim)}${esc(unit)} limit</span>` : ""}</span></div><div class="bar"><div class="fill" style="width:${Math.min(100, v / max * 100)}%;background:#000"></div><div class="lim" style="left:${lim / max * 100}%" title="limit ${esc(lim)}${esc(unit)}"></div></div></div>`;
}
async function fmSnapshot(code) {
  const el = FM.cards.get(code); if (!el) return;
  FM.open = code; FM.cards.forEach((c, k) => c.classList.toggle("active", k === code));
  const tx = await sendFm({service: "read_dtc_snapshot", params: {dtc: el.dataset.short, record_number: "1"}}, "read_dtc_snapshot");
  if (FM.open !== code) return;
  const r = tx?.response, d = $("#fmDrawer");
  const head = (t, sub) => `<div class="drawer-hd"><div><h3>${esc(t)}</h3><div class="t">${esc(dtcHex(code))} &nbsp;${esc(sub)}</div></div><button class="drawer-x" type="button" aria-label="Close snapshot">&times;</button></div>`;
  if (r?.kind !== "positive") d.innerHTML = `<div class="drawer-in">${head("Snapshot not available", FM.texts[code] || "")}${fmNrcHtml(tx)}</div>`;
  else {
    const p = r.params, s = p.snapshot, L = FM.ecu?.limits || {temperature: 100, dizziness: 255};
    const status = Object.values(p.status || {}).reduce((a, v, i) => a | (v ? 1 << i : 0), 0);
    d.innerHTML = `<div class="drawer-in">${head(`Snapshot record ${byteHex(p.record_number)} · freeze frame`, p.dtc.text)}
      <div class="snapgrid">${fmGauge("Temperature at fault", s.temperature, 100, L.temperature, " °C")}${fmGauge("Dizziness at fault", +s.dizziness.toFixed(1), 100, +(L.dizziness / 255 * 100).toFixed(1), " %")}</div>
      <div class="snapstats"><div><div class="v">${esc(s.total_flips)}</div><div class="l">Total flips</div></div><div><div class="v">${esc(s.timestamp)} s</div><div class="l">Since connect</div></div><div><div class="v mono">${esc(byteHex(status))}</div><div class="l">statusOfDTC</div></div></div>
      <h3>Raw response <span class="muted small">decoded by odxtools via the DTC-DOP and the snapshot structure</span></h3>${fmBytes(r, 0)}</div>`;
  }
  $(".drawer-x", d).onclick = fmCloseDrawer;
  d.classList.add("open");
}

// recipes which drive the modeled ECU into each fault
const fmFlips = (n, sob = "0x12") => sendLive({service: "do_forward_flips", params: {forward_soberness_check: sob, num_flips: String(n)}});
const fmNow = async () => { await poll(); return FM.ecu; };
async function fmCoolDown() {
  for (let i = 0; i < 80; i++) {
    const e = await fmNow(); if (!e || e.temperature <= e.limits.temperature) return;
    fmProg(`Waiting for the acrobat to cool down: <b>${esc(e.temperature.toFixed(1))} °C</b> &gt; ${esc(e.limits.temperature)} °C limit <span class="tag model">MODELED</span> cooling 0.5 °C/s`);
    await sleep(500);
  }
}
async function fmSession() { await fmCoolDown(); const e = await fmNow(); if (!e?.session_active) await sendLive({service: "session_start", params: {bribe: "1"}}); }
const RECIPES = [
  {id: "overheat", title: "Overheat", desc: "Repeated forward flips until the temperature crosses the limit", needs: ["do_forward_flips"], async run() {
    await fmSession();
    if (fmHas("set_operation_params") && FM.ecu?.fire_ring) await sendLive({service: "set_operation_params", params: {use_fire_ring: "false"}});
    for (let i = 0; i < 200; i++) {
      const e = await fmNow(); if (!e || e.temperature > e.limits.temperature) return;
      const n = Math.min(5, Math.ceil((e.limits.temperature - e.temperature) / 2.5) + 1);
      if (e.dizziness + 14 * n >= e.limits.dizziness) { fmProg(`Waiting until the acrobat is less dizzy: <b>${esc(e.dizziness.toFixed(0))}</b> + ${n} flips would exceed ${esc(e.limits.dizziness)} <span class="tag model">MODELED</span>`); await sleep(500); continue; }
      fmProg(`Flipping: ${n} forward flips at ${esc(e.temperature.toFixed(1))} °C`); await fmFlips(n); await sleep(350);
    }
  }},
  {id: "dizzy", title: "Flip while dizzy", desc: "A long headstand, then forward flips until the acrobat refuses", needs: ["headstand", "do_forward_flips"], async run() {
    await fmSession();
    let e = await fmNow();
    if (e.dizziness < e.limits.dizziness && e.dizziness <= e.limits.dizziness / 2) {
      fmProg("Headstand: the acrobat gets dizzy without heating up");
      await sendLive({service: "headstand", params: {duration: String(Math.min(255, Math.ceil((e.limits.dizziness - e.dizziness) * 2)))}}); await sleep(350);
    }
    for (let i = 0; i < 4; i++) {
      e = await fmNow(); if (e.temperature > e.limits.temperature) await fmCoolDown();
      const need = Math.max(0, Math.ceil((e.limits.dizziness - e.dizziness) / 14));
      fmProg(`Flipping while dizzy: ${Math.min(need, 9) + 1} forward flips at dizziness ${esc(e.dizziness.toFixed(0))}`);
      const tx = await fmFlips(Math.min(need, 9) + 1); await sleep(350);
      if (tx?.response?.params?.reason === 1) return;
    }
  }},
  {id: "fire", title: "Fire-ring flip", desc: "Fire ring on, then a flip which fails its soberness check", needs: ["set_operation_params", "do_forward_flips"], async run() {
    await fmSession();
    fmProg("Fire ring on"); await sendLive({service: "set_operation_params", params: {use_fire_ring: "true"}}); await sleep(350);
    fmProg("Flip through the fire ring with soberness check 0x42"); await fmFlips(1, "0x42"); await sleep(350);
    await sendLive({service: "set_operation_params", params: {use_fire_ring: "false"}});
  }},
];
function fmMenu() {
  $("#fmMenu").innerHTML = RECIPES.map(r => {
    const missing = r.needs.filter(n => !fmHas(n));
    return `<button class="menu-item" role="menuitem" data-r="${esc(r.id)}"${missing.length ? " disabled" : ""}><b>${esc(r.title)}</b><span>${esc(r.desc)}</span>${missing.length ? `<span class="why">needs ${esc(missing.join(", "))}, which ${esc($("#liveLayer").value)} does not offer</span>` : ""}</button>`;
  }).join("");
  $$("#fmMenu .menu-item").forEach(b => b.onclick = () => fmRun(RECIPES.find(r => r.id === b.dataset.r)));
}
function fmMenuOpen(open) { $("#fmMenu").hidden = !open; $("#fmProvoke").setAttribute("aria-expanded", String(open)); if (open) fmMenu(); }
$("#fmProvoke").onclick = e => { e.stopPropagation(); fmMenuOpen($("#fmMenu").hidden); };
document.addEventListener("click", e => { if (!e.target.closest(".menu")) fmMenuOpen(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape") fmMenuOpen(false); });
async function fmLocked(fn) {
  if (FM.busy) return; FM.busy = true; ["#fmRead", "#fmClear", "#fmProvoke"].forEach(id => $(id).disabled = true);
  try { if (!fmSessionOk()) await connectLive(); await fn(); }
  finally { FM.busy = false; ["#fmRead", "#fmClear", "#fmProvoke"].forEach(id => $(id).disabled = !fmSupported()); }
}
function fmRun(r) {
  fmMenuOpen(false);
  fmLocked(async () => { fmProg(`Provoking: <b>${esc(r.title)}</b>`); await r.run(); fmProg(`<b>${esc(r.title)}</b> done. The MODELED trigger is on the timeline; press Read DTCs to read what the ECU stored.`); });
}
$("#fmRead").onclick = () => fmLocked(fmRead);
$("#fmClear").onclick = () => fmLocked(fmClear);

loadDatabases().then(() => {
  const t = location.hash.slice(1); const b = $(`#tabs button[data-tab="${t}"]`); if (b) b.click();
  if (t === "compare") $("#cmpGo").click();
  if (t === "decode") decodeNow();
  if (t === "live" || t === "faults") connectLive();
});
