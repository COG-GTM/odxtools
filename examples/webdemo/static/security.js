"use strict";
// Security Access tab: UDS 0x27 seed & key against the demo PDX extension
// (somersault_security.pdx). Builds on the helpers of app.js ($, esc, api,
// S, sendLive, connectLive, updateLiveChartOptions, bytesHtml, chartHtml)
// and talks to the ECU exclusively through sendLive(), so the Live ECU
// transaction log and CAN trace stay in sync.
(() => {
  const CHART = "security_chart", PROTECTED = "headstand";
  const SHOWN = new Set(["security_request_seed", "security_send_key", PROTECTED, "session_stop"]);
  const MASK = 0x5A5A5A5A, ROT = 3, RING = 2 * Math.PI * 28;
  const SA = {layer: null, precond: [], st: null, seed: null, key: null, wrong: false, phase: null, busy: false, computing: null, chartKey: "", label: "", demoDb: null};
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const hx = b => b.toString(16).toUpperCase().padStart(2, "0");
  const toBytes = h => (h.match(/../g) || []).map(x => parseInt(x, 16));

  // MODELED demo algorithm, not a real OEM algorithm: key = rotl32(seed ^ 0x5A5A5A5A, 3)
  function demoKey(seed) {
    const s = ((seed[0] << 24) | (seed[1] << 16) | (seed[2] << 8) | seed[3]) >>> 0;
    const x = (s ^ MASK) >>> 0, r = ((x << ROT) | (x >>> (32 - ROT))) >>> 0;
    const bytes = n => [n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
    return {mask: bytes(MASK), xor: bytes(x), key: bytes(r)};
  }

  const secLayer = () => S.summary?.layers.find(l => l.variant_type === "ECU-VARIANT" && l.services.some(s => s.name === "security_send_key"));
  const live = () => (SA.st && SA.st.layer === SA.layer && S.live && S.db === SA.st.db) ? SA.st : null;

  // ---------------------------------------------------------------- pipeline boxes
  const cells = (bytes, cls = "") => `<div class="pcells">${(bytes || [null, null, null, null]).map((b, i) =>
    `<span class="pcell ${b === null ? "empty" : "in " + cls}" style="animation-delay:${i * 90}ms">${b === null ? "&ndash;" : esc(hx(b))}</span>`).join("")}</div>`;
  function setSeed(seed, note) {
    $("#pSeed .pbytes").innerHTML = cells(seed);
    $("#pSeed .pfoot").textContent = note || "";
    $("#pSeed").classList.toggle("filled", !!seed);
  }
  function setKey(key, note, cls = "") {
    $("#pKey .pbytes").innerHTML = cells(key, cls);
    $("#pKey .pfoot").textContent = note || "";
    $("#pKey").className = "pbox" + (key ? " filled" : "") + (cls ? " " + cls : "");
  }
  function setAlgo(seed) {
    const box = $("#pAlgo .steps");
    if (!seed) { box.innerHTML = `<div class="muted small sa-wait">Waiting for a seed&hellip;</div>`; $("#pAlgo").classList.remove("filled"); return null; }
    const k = demoKey(seed);
    const rows = [["seed", seed, ""], ["\u2295 mask", k.mask, "mask"], ["= xor", k.xor, ""], ["rotl 3", k.key, "result"]];
    box.innerHTML = rows.map(([label, bytes, cls], r) => `<div class="step" style="animation-delay:${r * 260}ms"><span class="sl">${esc(label)}</span>${bytes.map((b, i) =>
      `<span class="pcell in ${cls}" style="animation-delay:${r * 260 + i * 60}ms">${esc(hx(b))}</span>`).join("")}</div>`).join("") +
      `<div class="muted small sa-note">byte-wise XOR, then the 32-bit word is rotated left by 3 bits: the top 3 bits wrap around to the bottom</div>`;
    $("#pAlgo").classList.add("filled");
    return k.key;
  }
  function clearPipeline() { SA.seed = SA.key = SA.computing = null; SA.wrong = false; setSeed(null); setAlgo(null); setKey(null); }

  // ---------------------------------------------------------------- exchanges
  function nrcInfo(resp) {
    const code = parseInt(resp.hex.slice(4, 6), 16);
    const name = resp.coding_object && !resp.coding_object.startsWith("UDS") ? resp.coding_object : (resp.params?.nrc || "negative response");
    return {code: isNaN(code) ? "?" : "0x" + hx(code), name};
  }
  function addExchange(t) {
    const tl = $("#saTimeline"); tl.querySelector(".sa-none")?.remove();
    const resp = t.response, el = document.createElement("div");
    const kind = t.blocked ? "blocked" : !resp ? "neg" : resp.kind === "positive" ? "pos" : "neg";
    el.className = "sa-x new " + kind;
    const change = !t.blocked && t.state_before !== t.state_after ? `<span class="badge req">${esc(t.state_before)} &rarr; ${esc(t.state_after)}</span>` : "";
    let answer;
    if (t.blocked) answer = `<div class="sa-blocked">Blocked, not sent: odxtools <code>StateMachine</code> found no applicable PRE-CONDITION-STATE-REF for <b>${esc(t.service)}</b> in state <b>${esc(t.state_before)}</b> of ${esc(t.chart)}</div>`;
    else if (!resp) answer = `<div class="sa-nrc"><div class="code">&ndash;</div><div><b>Timeout</b><div class="muted small">no response from the ECU</div></div></div>`;
    else if (resp.kind === "positive") answer = `<div class="dir">ECU &rarr; tester <span class="badge pos">positive</span> <span class="muted small">${esc(resp.coding_object)}</span></div>${bytesHtml(resp)}`;
    else { const n = nrcInfo(resp); answer = `<div class="sa-nrc"><div class="code">${esc(n.code)}</div><div><b>${esc(n.name)}</b><div class="muted small">negative response &middot; decoded by odxtools from the ODX NEG-RESPONSE</div></div></div>${bytesHtml(resp)}`; }
    el.innerHTML = `<div class="hd"><span class="mono muted">#${esc(t.seq)}</span><b>${esc(t.service || t.request.coding_object)}</b>${change}<span class="muted small">${t.blocked ? "" : esc(t.latency_ms) + " ms"}</span></div>
      <div class="dir">tester &rarr; ECU <span class="badge req">request</span> <span class="muted small">${esc(t.request.coding_object || "")}</span></div>${bytesHtml(t.request)}
      <div class="resp">${answer}</div>`;
    tl.prepend(el);
    while (tl.children.length > 30) tl.lastChild.remove();
  }
  function emptyTimeline() { $("#saTimeline").innerHTML = `<div class="sa-none"><div class="sa-illu"><i></i><i></i><i></i></div><b>No security exchanges yet</b><span class="muted small">Request a seed to start the 0x27 handshake.</span></div>`; }

  // follow every exchange, also those sent from the Live ECU tab
  function observe(t) {
    const resp = t.response, pos = resp?.kind === "positive";
    if (t.service === "security_request_seed" && pos) {
      const seed = toBytes(resp.hex.slice(4, 12));
      SA.seed = seed.some(b => b) ? seed : null; SA.key = SA.computing = null; SA.wrong = false;
      setSeed(seed, SA.seed ? "random, fresh for every request" : "all zero: the ECU is already unlocked (ISO 14229-1)");
      setAlgo(null); setKey(null);
    } else if (t.service === "security_send_key" && resp) {
      if (pos) { SA.seed = null; setKey(SA.key, "accepted by the ECU", "ok"); }
      else {
        const n = nrcInfo(resp);
        if (n.code === "0x36") SA.seed = null;
        setKey(SA.key, `rejected: ${n.code} ${n.name}`, "bad");
      }
    } else if (t.service === "session_stop" && pos) clearPipeline();
    $("#saProtLast").innerHTML = t.service !== PROTECTED ? $("#saProtLast").innerHTML
      : t.blocked ? `Last attempt #${esc(t.seq)}: <b class="bad">blocked</b> by the state chart, nothing was sent`
      : `Last attempt #${esc(t.seq)}: sent, ECU answered <b class="${pos ? "ok" : "bad"}">${esc(resp?.coding_object || "nothing")}</b>`;
  }

  // ---------------------------------------------------------------- state rendering
  const TEXT = {
    locked: ["Locked", "Protected services are blocked by the ODX state chart until a valid key is sent."],
    unlocking: ["Verifying key\u2026", "security_send_key is travelling over ISO-TP to the ECU."],
    unlocked: ["Unlocked", "security_chart is in state unlocked: protected services are allowed."],
    lockedout: ["Locked out", "3 wrong keys: modeled time delay, the ECU answers 0x37 RequiredTimeDelayNotExpired."],
    offline: ["Not connected", "Connect to the virtual ECU to start."],
  };
  function render() {
    const st = live(), ecu = st?.ecu || {};
    const chartState = st?.charts?.[CHART] || "locked";
    const delay = ecu.delay_remaining || 0, total = ecu.delay_total || 10;
    const state = !st ? "offline" : SA.phase || (delay > 0 ? "lockedout" : chartState === "unlocked" ? "unlocked" : "locked");
    $("#saPadlock").setAttribute("class", "padlock " + state);
    if (SA.label !== state) {
      SA.label = state;
      for (const [id, txt] of [["#saStateLabel", TEXT[state][0]], ["#saStateSub", TEXT[state][1]]]) {
        const el = $(id); el.textContent = txt; el.classList.remove("swap"); void el.offsetWidth; el.classList.add("swap");
      }
    }
    const attempts = ecu.attempts || 0, max = ecu.max_attempts || 3;
    $$(".sa-dots i").forEach((d, i) => d.classList.toggle("on", i < attempts));
    $("#saAttempts").textContent = st ? `${attempts} of ${max} \u00b7 ECU reports ${ecu.locked === false ? "unlocked" : "locked"} (modeled)` : "\u2013";
    const ring = $("#saRing .prog");
    ring.style.strokeDasharray = RING; ring.style.strokeDashoffset = RING * (1 - (delay > 0 ? delay / total : 0));
    $("#saRing").classList.toggle("run", delay > 0);
    $("#saRingText").textContent = delay > 0 ? `${Math.ceil(delay)} s` : `${total} s`;
    $("#saRingLabel").textContent = delay > 0 ? "Modeled delay running" : "Delay starts after 3 wrong keys";

    $("#saConn").innerHTML = st ? `<span class="pill on">Connected</span> ${esc(st.layer)} &middot; tester &rarr; ECU <code>${esc(hex2(st.rx_id))}</code> &middot; ECU &rarr; tester <code>${esc(hex2(st.tx_id))}</code>`
      : `<span class="pill off">Not connected</span> Connect to <b>${esc(SA.layer || "an ECU variant")}</b>; the Live ECU tab shares this session.`;
    $("#saConnect").textContent = st ? "Reconnect" : "Connect";
    $("#saSeed").disabled = SA.busy; $("#saWrong").disabled = SA.busy; $("#saTry").disabled = SA.busy; $("#saStop").disabled = SA.busy;
    $("#saCompute").disabled = SA.busy || !!SA.computing || !SA.seed;
    $("#saSend").disabled = SA.busy || !!SA.computing || !SA.key || SA.wrong || !SA.seed;

    const need = SA.precond.map(r => r.split(".").pop());
    const allowed = !need.length || need.includes(chartState);
    $("#saProtBadge").textContent = allowed ? "Allowed" : "Blocked";
    $("#saProtBadge").className = "sa-verdict " + (allowed ? "ok" : "bad");
    $("#saProtRule").innerHTML = `ODX PRE-CONDITION-STATE-REF: <b>${esc(CHART)}</b> must be <b>${esc(need.join(" / ") || "any")}</b> &middot; now <b>${esc(chartState)}</b>`;

    const sc = secLayer()?.state_charts.find(c => c.name === CHART);
    const lt = S.lastTrans?.chart === CHART ? S.lastTrans : null;
    const key = JSON.stringify([sc?.name, chartState, lt]);
    if (sc && key !== SA.chartKey) { SA.chartKey = key; $("#saChart").innerHTML = chartHtml(sc, chartState, lt, "ar3"); }
  }

  // ---------------------------------------------------------------- actions
  async function ensureLive() {
    if (live()) return;
    $("#liveLayer").value = SA.layer; updateLiveChartOptions();
    await connectLive();
  }
  async function act(fn) {
    if (SA.busy || !SA.layer) return;
    SA.busy = true; render();
    try { await ensureLive(); await fn(); }
    catch (e) { errorCard(e.message); }
    finally { SA.busy = false; render(); }
  }
  async function send(body) {
    const tx = await sendLive(body);
    if (!tx) errorCard("The request was not sent, see the Live ECU transaction log.");
    return tx;
  }
  function errorCard(msg) {
    $("#saTimeline .sa-none")?.remove();
    const el = document.createElement("div"); el.className = "sa-x new neg";
    el.innerHTML = `<div class="sa-nrc"><div class="code">!</div><div><b>Request failed</b><div class="muted small">${esc(msg)}</div></div></div>`;
    $("#saTimeline").prepend(el);
  }
  const sendKey = (key, wrong) => act(async () => {
    SA.key = key; SA.wrong = wrong;
    setKey(key, wrong ? "deliberately altered key" : "computed by the tester", wrong ? "bad" : "");
    SA.phase = "unlocking"; render();
    try { await Promise.all([send({service: "security_send_key", params: {security_key: key.map(hx).join("")}}), sleep(wrong ? 250 : 700)]); }
    finally { SA.phase = null; }
  });

  $("#saConnect").onclick = () => { if (!SA.layer) return; $("#liveLayer").value = SA.layer; updateLiveChartOptions(); connectLive(); };
  $("#saOpenDemo").onclick = () => { if (SA.demoDb) { $("#dbSelect").value = SA.demoDb; openDb(SA.demoDb); } };
  $("#saSeed").onclick = () => act(() => send({service: "security_request_seed"}));
  $("#saCompute").onclick = () => {
    if (!SA.seed || SA.busy || SA.computing) return;
    const seed = SA.seed, key = setAlgo(seed), token = SA.computing = {};
    SA.key = key; SA.wrong = false; render();
    setTimeout(() => {
      if (SA.computing !== token) return;
      SA.computing = null;
      if (SA.seed === seed && SA.key === key) setKey(key, "computed by the tester");
      render();
    }, 1150);
  };
  $("#saSend").onclick = () => SA.key && sendKey(SA.key, false);
  $("#saWrong").onclick = () => {
    const key = SA.seed ? demoKey(SA.seed).key : [0, 0, 0, 0];
    key[3] ^= 0xA5;
    sendKey(key, true);
  };
  $("#saTry").onclick = () => act(() => send({service: PROTECTED, params: {duration: "3"}}));
  $("#saStop").onclick = () => act(() => send({service: "session_stop"}));

  // ---------------------------------------------------------------- app.js events
  document.addEventListener("db-opened", async () => {
    const l = secLayer(); SA.layer = l?.name || null; SA.precond = []; SA.chartKey = "";
    $("#saEmpty").hidden = !!SA.layer; $("#saBody").hidden = !SA.layer; $("#saConnect").hidden = !SA.layer;
    clearPipeline(); emptyTimeline();
    const db = S.db;
    const dbs = await api("/api/databases").catch(() => []);
    if (db !== S.db) return;
    SA.demoDb = dbs.find(d => d.demo_extension)?.name || null;
    $("#saOpenDemo").hidden = !SA.demoDb;
    const ext = dbs.find(d => d.name === S.db)?.demo_extension;
    let hdr = $("#hdrRibbon");
    if (!hdr) { hdr = document.createElement("span"); hdr.id = "hdrRibbon"; hdr.className = "sa-hdr-ribbon"; hdr.textContent = "Demo PDX extension"; $(".dbbar").insertBefore(hdr, $("#loadInfo")); }
    hdr.hidden = !ext; hdr.title = ext || "";
    $("#saRibbon").hidden = !ext; $("#saRibbon").title = ext || "";
    if (SA.layer) {
      const d = await api(`/api/db/${encodeURIComponent(db)}/layer/${encodeURIComponent(SA.layer)}/service/${PROTECTED}`).catch(() => null);
      if (db === S.db) SA.precond = d?.preconditions || [];
    }
    render();
  });
  document.addEventListener("live-session", e => {
    SA.st = e.detail;
    if (!e.detail || e.detail.layer === SA.layer) { clearPipeline(); emptyTimeline(); $("#saProtLast").textContent = "Not tried yet."; }
    render();
  });
  // Reset ECU drops the pending seed on the ECU side, so drop it here, too
  document.addEventListener("live-reset", e => {
    if (e.detail?.layer === SA.layer) { clearPipeline(); render(); }
  });
  document.addEventListener("live-status", e => {
    const {st, fresh} = e.detail; SA.st = st;
    if (st.layer === SA.layer) for (const t of fresh) if (SHOWN.has(t.service)) { addExchange(t); observe(t); }
    render();
  });
  clearPipeline(); emptyTimeline();
})();
