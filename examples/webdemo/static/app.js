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
  if (S.summary.demo_extension) {
    const best = [...ecus].sort((a, b) => fmTriggerCount(b) - fmTriggerCount(a))[0];
    if (best) $("#liveLayer").value = best.name;
  }
  updateLiveChartOptions();
  selectLayer(def.name);
  fmOnDb();
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

// repeated records ("dtc_records[1].dtc") share the colour of their parameter
const spanKey = p => p.replace(/\[\d+\]/g, "[]");
const spanLabel = p => { const m = p.match(/\[(\d+)\]\.([^.]+)$/); return m ? `${m[2]} #${+m[1] + 1}` : p.split(".").pop(); };
function bytesHtml(msg) {
  const bytes = msg.hex.match(/../g) || [];
  const colors = {}; (msg.spans || []).forEach(s => { const k = spanKey(s.param); if (!(k in colors)) colors[k] = PALETTE[Object.keys(colors).length % PALETTE.length]; });
  const owner = bytes.map((_, i) => (msg.spans || []).find(s => i >= s.start && i < s.start + s.length));
  return `<div class="bytes">${bytes.map((b, i) => {
    const o = owner[i], c = o ? colors[spanKey(o.param)] : "#9a9a9a";
    return `<div class="byte" style="background:${c};--i:${i}" title="byte ${i}${o ? " · " + esc(o.param) : ""}">${esc(b.toUpperCase())}<small>${o && o.start === i ? esc(spanLabel(o.param)) : "&nbsp;"}</small></div>`;
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
$("#liveLayer").onchange = () => { updateLiveChartOptions(); fmSyncLayer(); connectLive(); };
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
  S.gen++; S.after = Math.max(S.after, st.seq); S.live.charts = null; S.lastTrans = null; fmOnSession(S.live); poll();
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
  fmOnSession(st);
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
    drawChart();
    fmOnSession(null);
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
// DTC codes, texts and status bits are taken from the odxtools decode of
// the 0x19 responses; only the ISO 14229-1 bit abbreviations live here.
const ISO_BITS = {
  test_failed: ["TF", "testFailed"], test_failed_this_operation_cycle: ["TFTOC", "testFailedThisOperationCycle"],
  pending_dtc: ["PDTC", "pendingDTC"], confirmed_dtc: ["CDTC", "confirmedDTC"],
  test_not_completed_since_last_clear: ["TNCSLC", "testNotCompletedSinceLastClear"], test_failed_since_last_clear: ["TFSLC", "testFailedSinceLastClear"],
  test_not_completed_this_operation_cycle: ["TNCTOC", "testNotCompletedThisOperationCycle"], warning_indicator_requested: ["WIR", "warningIndicatorRequested"]};
const FM_STATUS_MASK = "0xFF";  // same as the ECU's DTCStatusAvailabilityMask
const FM_TRIGGERS = [
  {key: "overheat", label: "Overheat", sub: "single forward flips until the ECU answers too_hot", needs: ["do_forward_flips"]},
  {key: "dizzy", label: "Flip while dizzy", sub: "ten backward flips; the 10th is rejected for dizziness", needs: ["do_backward_flips"]},
  {key: "fire", label: "Fire-ring flip", sub: "fire ring on, then a flip that fails its soberness check", needs: ["set_operation_params", "do_forward_flips"]}];
S.fm = {read: false, records: [], ecu: null, sel: null, busy: false, events: 0, gen: 0};
const fmHex = c => "0x" + Number(c).toString(16).toUpperCase().padStart(6, "0");
const fmLayer = () => liveLayerSummary();
const fmHas = n => !!fmLayer()?.services.some(s => s.name === n);
const fmSupported = () => fmHas("read_dtc_by_status_mask");
function fmTriggerCount(l) { return FM_TRIGGERS.filter(t => t.needs.every(n => l.services.some(s => s.name === n))).length; }
function fmSyncLayer() {
  $("#fmLayer").innerHTML = $("#liveLayer").innerHTML; $("#fmLayer").value = $("#liveLayer").value;
  fmRenderMenu(); fmRenderSupport();
}
$("#fmLayer").onchange = () => { $("#liveLayer").value = $("#fmLayer").value; $("#liveLayer").onchange(); };

function fmOnDb() {
  const ext = S.summary.demo_extension;
  $("#fmRibbon").hidden = !ext;
  if (ext) $("#fmRibbonText").innerHTML = `${esc(S.db)} is generated by <code>${esc(ext.generator)}</code> and adds ${esc(ext.adds)} to the original somersault ODX. The bundled somersault.pdx is unchanged.`;
  fmSyncLayer(); fmOnSession(null);
}
function fmOnSession(st) {
  S.fm.gen++; S.fm.read = false; S.fm.records = []; S.fm.sel = null; S.fm.events = 0;
  $("#fmCards").innerHTML = ""; $("#fmDrawer").hidden = true; $("#fmDrawer").innerHTML = "";
  $("#fmTx").innerHTML = `<div class="fm-note muted">Read, snapshot and clear requests appear here once their CAN frames have arrived.</div>`;
  $("#fmTimeline .fm-marks").innerHTML = ""; $("#fmTimeline .fm-ticks").innerHTML = "";
  $("#fmConn").innerHTML = st ? `<span class="pill on">Connected</span> <span class="muted">${esc(st.layer)} · tester → ECU <code>${hex2(st.rx_id)}</code> · ECU → tester <code>${hex2(st.tx_id)}</code></span>`
    : `<span class="pill off">Not connected</span> <span class="muted">any action connects to the selected ECU variant</span>`;
  fmRenderCards(); fmRenderTimeline(st?.ecu || null);
}
function fmRenderSupport() {
  const ok = fmSupported();
  $("#fmBody").hidden = !ok; $("#fmUnsupported").hidden = ok;
  for (const id of ["#fmRead", "#fmClear", "#fmProvokeBtn"]) $(id).disabled = !ok;
  if (!ok) {
    const alt = [...$("#dbSelect").options].map(o => o.value).find(n => n.includes("dtc"));
    $("#fmUnsupported").innerHTML = `<h3>No fault memory in this database</h3><div class="fm-lede" style="margin:0 auto 18px">${esc(S.db)} / ${esc($("#liveLayer").value)} defines no DTC-DOP and no ReadDTCInformation service.</div>${alt ? `<button class="btn" id="fmUseDtc">Open ${esc(alt)}</button>` : ""}`;
    const b = $("#fmUseDtc"); if (b) b.onclick = () => { $("#dbSelect").value = alt; openDb(alt); };
  }
}
function fmRenderMenu() {
  $("#fmProvoke").innerHTML = FM_TRIGGERS.map(t => {
    const missing = t.needs.filter(n => !fmHas(n));
    return `<button role="menuitem" data-k="${esc(t.key)}" ${missing.length ? "disabled" : ""}>${esc(t.label)}<small>${missing.length ? `not possible: ${esc(missing.join(", "))} is NOT-INHERITED by ${esc($("#liveLayer").value)}` : esc(t.sub)}</small></button>`;
  }).join("");
  $$("#fmProvoke button").forEach(b => b.onclick = () => { fmMenu(false); fmProvoke(b.dataset.k); });
}
function fmMenu(open) { $("#fmProvoke").hidden = !open; $("#fmProvokeBtn").setAttribute("aria-expanded", String(open)); }
$("#fmProvokeBtn").onclick = e => { e.stopPropagation(); fmMenu($("#fmProvoke").hidden); };
document.addEventListener("click", e => { if (!e.target.closest(".fm-menu")) fmMenu(false); });
document.addEventListener("keydown", e => { if (e.key === "Escape") fmMenu(false); });

function fmOnPoll(ecu) {
  S.fm.ecu = ecu;
  fmRenderTimeline(ecu);
  // the occurrence counter is ECU-internal (not part of 0x19 02)
  for (const el of $$("#fmCards .fm-card")) {
    const e = ecu.fault_memory.find(f => f.trouble_code === +el.dataset.code);
    const o = $(".occ b", el); if (e && o && o.textContent !== String(e.occurrences)) o.textContent = e.occurrences;
  }
}

function fmRenderTimeline(ecu) {
  const tl = $("#fmTimeline"), marks = $(".fm-marks", tl), ticks = $(".fm-ticks", tl);
  const events = ecu?.fault_events || [];
  if (events.length < S.fm.events) marks.innerHTML = "";
  S.fm.events = events.length;
  const span = Math.max(30, Math.ceil(((ecu?.uptime_s || 0) + 5) / 15) * 15);
  const pos = t => `${Math.min(100, t / span * 100)}%`;
  const els = $$(".fm-mark", marks);
  events.forEach((ev, i) => {
    let m = els[i];
    if (!m) {
      m = document.createElement("div");
      m.className = "fm-mark " + ev.kind;
      m.innerHTML = ev.kind === "cleared" ? `<div class="tip"><b>Fault memory cleared</b>0x14 ClearDiagnosticInformation at t = ${esc(ev.t.toFixed(1))} s</div>`
        : `<span class="code">${esc(fmHex(ev.trouble_code))}</span><div class="tip"><b>${esc(fmHex(ev.trouble_code))} · ${esc(ev.text)}</b>${esc(ev.kind === "stored" ? "Stored" : "Updated, occurrence " + ev.occurrences)} at t = ${esc(ev.t.toFixed(1))} s<br>Trigger: ${esc(ev.trigger)}</div>`;
      m.setAttribute("aria-label", ev.kind === "cleared" ? "fault memory cleared" : `${fmHex(ev.trouble_code)} ${ev.text}: ${ev.trigger}`);
      marks.appendChild(m);
    }
    m.style.left = pos(ev.t);
  });
  // keep the codes of markers which are close together readable
  let last = -1e9; $$(".fm-mark:not(.cleared) .code", marks).forEach(c => { const x = parseFloat(c.parentElement.style.left); c.style.visibility = x - last < 4 ? "hidden" : ""; if (c.style.visibility === "") last = x; });
  let now = $(".fm-now", marks); if (!now) { now = document.createElement("div"); now.className = "fm-now"; now.title = "now"; marks.prepend(now); }
  now.style.left = pos(ecu?.uptime_s || 0);
  const tickHtml = Array.from({length: 7}, (_, i) => `<div class="fm-tick" style="left:${i / 6 * 100}%">${Math.round(i * span / 6)} s</div>`).join("");
  if (ticks.dataset.span !== String(span)) { ticks.innerHTML = tickHtml; ticks.dataset.span = span; }
  let empty = $(".fm-empty-line", tl);
  if (!events.length) { if (!empty) { empty = document.createElement("div"); empty.className = "fm-empty-line"; tl.appendChild(empty); } empty.textContent = ecu ? "No fault events yet. Use Provoke fault to drive the ECU into a fault condition." : "Not connected."; }
  else if (empty) empty.remove();
}

function fmBitsHtml(status) {
  const entries = Object.entries(status || {});
  const byte = entries.reduce((a, [, v], i) => a | ((v ? 1 : 0) << i), 0);
  return `<div class="fm-bits">${entries.map(([k, v], i) => {
    const [ab, name] = ISO_BITS[k] || [k, k];
    return `<span class="fm-bit${v ? " on" : ""}" data-bit="${esc(k)}" title="bit ${i} · ${esc(name)} (${esc(k)}) · ${v ? "set" : "not set"}">${esc(ab)}</span>`;
  }).join("")}<span class="sb">status 0x${byte.toString(16).toUpperCase().padStart(2, "0")}</span></div>`;
}
function fmCardHtml(r) {
  const d = r.dtc || {}, occ = S.fm.ecu?.fault_memory.find(f => f.trouble_code === d.trouble_code)?.occurrences;
  return `<div class="top"><div class="code">${esc(fmHex(d.trouble_code))}<small>${esc(d.short_name || "")}</small></div>
    <div class="occ" title="occurrence counter of the modeled ECU (not transmitted by 0x19 02)">occurrences<b>${esc(occ ?? "–")}</b></div></div>
    <div class="text">${esc(d.text || "(DTC not defined in the DTC-DOP)")}</div>${fmBitsHtml(r.status)}`;
}
function fmRenderCards(nrc) {
  const box = $("#fmCards");
  $$(".fm-empty,.fm-nrc", box).forEach(e => e.remove());
  const keep = new Set(S.fm.records.map(r => String(r.dtc?.trouble_code)));
  for (const el of $$(".fm-card:not(.out)", box)) {
    if (keep.has(el.dataset.code)) continue;
    el.classList.add("out");
    setTimeout(() => el.remove(), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 260);
  }
  for (const r of S.fm.records) {
    const code = String(r.dtc?.trouble_code);
    let el = $(`.fm-card[data-code="${CSS.escape(code)}"]:not(.out)`, box);
    if (!el) {
      el = document.createElement("div"); el.className = "fm-card"; el.dataset.code = code; el.tabIndex = 0;
      el.innerHTML = fmCardHtml(r);
      el.onclick = () => fmSnapshot(+el.dataset.code);
      el.onkeydown = e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fmSnapshot(+el.dataset.code); } };
      box.appendChild(el);
    } else {
      // cross-fade changed status bits in place
      for (const [k, v] of Object.entries(r.status || {})) { const b = $(`.fm-bit[data-bit="${CSS.escape(k)}"]`, el); if (b) { b.classList.toggle("on", !!v); b.title = b.title.replace(/(set|not set)$/, v ? "set" : "not set"); } }
      const byte = Object.values(r.status || {}).reduce((a, v, i) => a | ((v ? 1 : 0) << i), 0);
      const sb = $(".sb", el); if (sb) sb.textContent = `status 0x${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    el.classList.toggle("sel", S.fm.sel === +code);
  }
  if (nrc) box.insertAdjacentHTML("afterbegin", nrc);
  if (!S.fm.records.length && !nrc) {
    box.insertAdjacentHTML("beforeend", S.fm.read
      ? `<div class="fm-empty"><div class="ill"></div><b>No stored faults</b><span>The ECU reported no DTC matching status mask ${esc(FM_STATUS_MASK)}.</span></div>`
      : `<div class="fm-empty"><div class="ill"></div><b>Fault memory not read yet</b><span>Press Read DTCs to send 19 02 ${esc(FM_STATUS_MASK.slice(2))} to the ECU.</span></div>`);
  }
  if (S.fm.sel !== null && !keep.has(String(S.fm.sel))) fmCloseDrawer();
}

function fmNrcHtml(tx) {
  const r = tx?.response;
  if (!tx) return `<div class="fm-nrc"><span class="nm">Request failed</span><div>The server rejected the request, see the transaction log on Live Virtual ECU.</div></div>`;
  if (!r) return `<div class="fm-nrc"><span class="nm">${tx.blocked ? "Blocked by the ODX state chart" : "No response"}</span><div>${tx.blocked ? `No PRE-CONDITION-STATE-REF of ${esc(tx.service)} applies in state ${esc(tx.state_before)}.` : "The ECU did not answer within the timeout."}</div></div>`;
  const code = r.nrc?.code, name = r.nrc?.name || r.coding_object;
  return `<div class="fm-nrc"><span class="nm">${esc(name)}</span><span class="hx">${code != null ? "NRC 0x" + esc(code.toString(16).toUpperCase().padStart(2, "0")) : ""}</span>
    <div>${esc(r.kind.replace("_", " "))} response <code>${esc(spaced(r.hex))}</code>${r.coding_object && r.coding_object !== name ? ` · ODX ${esc(r.coding_object)}` : ""}</div></div>`;
}
function fmPair(tx, label) {
  const box = $("#fmTx"); $(".fm-note", box)?.remove();
  const el = document.createElement("div");
  const r = tx?.response, neg = !r || r.kind !== "positive";
  el.className = "fm-pair" + (neg ? " neg" : "");
  el.innerHTML = !tx ? fmNrcHtml(tx) : `<div class="hd"><b>${esc(label)}</b><span class="muted small">${esc(tx.service || "")} · ${esc(tx.frames ?? 0)} CAN frames · ${esc(tx.latency_ms)} ms</span></div>
    <div class="rw req"><span>REQ</span>${bytesHtml(tx.request)}</div>
    <div class="rw resp"><span>${r ? esc(r.kind === "positive" ? "POS" : "NEG") : "–"}</span>${r ? bytesHtml(r) : `<div class="muted small">${tx.blocked ? "not sent: blocked by the state chart" : "no response"}</div>`}</div>
    ${neg ? fmNrcHtml(tx) : ""}`;
  box.prepend(el);
  while (box.children.length > 30) box.lastChild.remove();
}
async function fmSend(body, label) {
  const gen = S.fm.gen;
  if (!S.live) { await connectLive(); }
  const tx = await sendLive(body);
  if (label && (gen === S.fm.gen || S.fm.gen === gen + 1)) fmPair(tx, label);
  return tx;
}
async function fmBusy(fn) {
  if (S.fm.busy) return; S.fm.busy = true;
  for (const id of ["#fmRead", "#fmClear", "#fmProvokeBtn"]) $(id).disabled = true;
  try { await fn(); } finally { S.fm.busy = false; fmRenderSupport(); $("#fmProgress").textContent = ""; }
}

async function fmRead() {
  const tx = await fmSend({service: "read_dtc_by_status_mask", params: {status_mask: FM_STATUS_MASK}}, "Read DTCs · 0x19 02");
  if (tx?.response?.kind === "positive") {
    S.fm.read = true; S.fm.records = tx.response.params.dtc_records || []; fmRenderCards();
  } else fmRenderCards(fmNrcHtml(tx));
}
$("#fmRead").onclick = () => fmBusy(fmRead);
$("#fmClear").onclick = () => fmBusy(async () => {
  const tx = await fmSend({service: "clear_dtcs"}, "Clear DTCs · 0x14");
  if (tx?.response?.kind === "positive") { S.fm.read = true; S.fm.records = []; fmRenderCards(); }
  else fmRenderCards(fmNrcHtml(tx));
});

function fmCloseDrawer() { S.fm.sel = null; $("#fmDrawer").hidden = true; $$("#fmCards .fm-card").forEach(c => c.classList.remove("sel")); }
async function fmSnapshot(code) {
  if (S.fm.busy) return;
  S.fm.sel = code; $$("#fmCards .fm-card").forEach(c => c.classList.toggle("sel", +c.dataset.code === code));
  await fmBusy(async () => {
    const tx = await fmSend({service: "read_dtc_snapshot", params: {dtc: String(code), record_number: "1"}}, `Snapshot ${fmHex(code)} · 0x19 04`);
    if (S.fm.sel !== code) return;
    const d = $("#fmDrawer"); d.hidden = false;
    const r = tx?.response;
    if (r?.kind !== "positive") { d.innerHTML = `<div class="hd"><h3>Snapshot record 0x01 · ${esc(fmHex(code))}</h3><button class="close">Close</button></div>${fmNrcHtml(tx)}`; }
    else {
      const sn = r.params.snapshot || {}, lim = S.fm.ecu?.limits || {temperature: 65, dizziness: 180};
      const dizzyLim = Math.round(lim.dizziness / 255 * 100);
      const g = (label, v, max, l, unit) => `<div class="gauge"><div class="lab"><span>${label}</span><span class="mono">${esc(v)}${unit}</span></div><div class="bar"><div class="fill" style="width:0%;background:${v >= l ? "#d92121" : v > l * .85 ? "#e09400" : "#000"}" data-w="${Math.min(100, v / max * 100)}"></div><div class="lim" style="left:${l / max * 100}%" title="limit ${l}${unit}"></div></div></div>`;
      d.innerHTML = `<div class="hd"><h3>Snapshot record 0x${esc(Number(r.params.record_number).toString(16).padStart(2, "0"))} · ${esc(fmHex(r.params.dtc?.trouble_code))} ${esc(r.params.dtc?.text || "")}</h3><button class="close">Close</button></div>
        <div class="muted small" style="margin:0">Frozen by the ECU when the fault was first stored · decoded by odxtools from the snapshot_record structure</div>
        <div class="fm-gauges">${g("Temperature", sn.temperature, 100, lim.temperature, " °C")}${g("Dizziness", sn.dizziness, 100, dizzyLim, " %")}</div>
        <div class="fm-facts"><span><b>${esc(sn.total_flips)}</b>total flips</span><span><b>${esc(sn.timestamp)} s</b>since connect</span>${fmBitsHtml(r.params.status)}</div>
        ${bytesHtml(r)}`;
      requestAnimationFrame(() => requestAnimationFrame(() => $$(".fill[data-w]", d).forEach(f => f.style.width = f.dataset.w + "%")));
    }
    $(".close", d).onclick = fmCloseDrawer;
  });
}

async function fmRecover() {
  if (!S.live) await connectLive();
  try { await api(`/api/live/recover?session=${S.live.session}`, {method: "POST"}); } catch (e) { addTxError(e.message); }
  await poll();
}
async function fmEnsureSession() {
  if (S.fm.ecu?.session_active) return;
  await sendLive({service: "session_start", params: {bribe: "1"}});
}
async function fmProvoke(key) {
  await fmBusy(async () => {
    const t = FM_TRIGGERS.find(x => x.key === key), prog = $("#fmProgress");
    prog.textContent = `Provoking "${t.label}": the acrobat rests first (modeled, no UDS) …`;
    await fmRecover(); await fmEnsureSession();
    const flip = (dir, sob, n) => sendLive({service: `do_${dir}_flips`, params: {[`${dir}_soberness_check`]: sob, num_flips: String(n)}});
    if (key === "overheat") {
      for (let i = 1; i <= 30; i++) {
        const tx = await flip("forward", "0x12", 1);
        prog.textContent = `Provoking "${t.label}": forward flip ${i} · ${S.fm.ecu?.temperature ?? "?"} °C`;
        if (!tx || tx.response?.kind === "global_negative" || (tx.response && tx.response.kind !== "positive")) break;
        await sleep(90);
      }
    } else if (key === "dizzy") {
      prog.textContent = `Provoking "${t.label}": 10 backward flips …`;
      await flip("backward", "0x12", 10);
    } else if (key === "fire") {
      prog.textContent = `Provoking "${t.label}": fire ring on, flip with soberness 0x42 …`;
      await sendLive({service: "set_operation_params", params: {use_fire_ring: "true"}});
      await sleep(250);
      await flip("forward", "0x42", 1);
      await sleep(250);
      await sendLive({service: "set_operation_params", params: {use_fire_ring: "false"}});
    }
    await poll();
  });
}

loadDatabases().then(() => {
  const t = location.hash.slice(1); const b = $(`#tabs button[data-tab="${t}"]`); if (b) b.click();
  if (t === "compare") $("#cmpGo").click();
  if (t === "decode") decodeNow();
  if (t === "live" || t === "faults") connectLive();
});
