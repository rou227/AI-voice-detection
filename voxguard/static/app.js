/* VoxGuard dashboard controller: connects the Stitch UI to the backend (/ws/dashboard, /api/info). */
(() => {
  const $ = id => document.getElementById(id);
  const esc = t => String(t).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const STATE = { "AI-Cloned": "cloned", Human: "human", Uncertain: "uncertain" };
  const COLOR = { cloned: "#C05252", human: "#32805A", uncertain: "#C58B35" };
  const BADGE = { cloned: ["AI DETECTED", "#fef2f2"], human: ["HUMAN VOICE", "#f0fdf4"], uncertain: ["UNCERTAIN", "#fffbeb"] };
  const WHY = { cloned: "Unnaturally steady pitch & loudness (synthetic profile)",
                human: "Natural pitch / loudness variation", uncertain: "Mixed signals, still listening" };
  const S = { devices: {}, pinned: null, active: null, series: {}, history: [], rate: [], lastRow: {}, lastSpectrum: 0 };
  const sel = () => S.pinned || S.active;
  const mmss = s => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  // ---- switch off the template's fake simulation, fix nav tabs that had no view ------------
  window.startSimulation = window.toggleStreamSimulation = window.triggerSampleInference = () => {};
  const origSwitch = window.switchMainView;
  window.switchMainView = k => {
    origSwitch(k === "history" ? "history" : "dashboard");
    const target = { live: "live-call-centerpiece", devices: "device-panel" }[k];
    if (target) $(target).scrollIntoView({ behavior: "smooth", block: "start" });
  };
  window.resetCallSession = () => { S.pinned = null; S.series = {}; drawTimeline(); renderSelected(); };

  // ---- pairing modal: real QR + real URL ----------------------------------------------------
  let pairUrl = "";
  window.openPairModal = async () => {
    $("pair-modal").classList.remove("hidden");
    $("qr-img").src = "/qr?" + Date.now();
    try { pairUrl = (await (await fetch("/api/info")).json()).url; $("pair-url").textContent = pairUrl; } catch {}
  };
  window.copyPairUrl = () => {
    navigator.clipboard?.writeText(pairUrl);
    $("btn-copy-link").textContent = "Copied!";
    setTimeout(() => $("btn-copy-link").textContent = "Copy Link", 1500);
  };
  $("btn-copy-link").textContent = "Copy Link";

  // ---- websocket ------------------------------------------------------------------------------
  let ws, pinger;
  function connect() {
    ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws/dashboard`);
    ws.onopen = () => { setWs(true); pinger = setInterval(() => ws.readyState === 1 && ws.send(String(performance.now())), 2000); };
    ws.onclose = () => { setWs(false); clearInterval(pinger); setTimeout(connect, 1500); };
    ws.onmessage = e => handle(JSON.parse(e.data));
  }
  function setWs(on) {
    ["top-ws-indicator", "ws-sidebar-dot"].forEach(id => $(id).style.backgroundColor = on ? "#32805A" : "#C05252");
    $("top-ws-text").textContent = on ? "CONNECTED" : "RECONNECTING";
    if (!on) $("ws-sidebar-latency").textContent = "—";
  }

  function handle(m) {
    if (m.type === "pong") {
      const ms = Math.round(performance.now() - parseFloat(m.t));
      $("ws-sidebar-latency").textContent = $("conn-latency").textContent = ms + "ms";
    } else if (m.type === "devices") {
      S.devices = Object.fromEntries(m.devices.map(d => [d.id, { ...d, upAt: performance.now() - d.up * 1000 }]));
      if (!S.devices[S.pinned]) S.pinned = null;
      if (!S.devices[S.active]) S.active = m.devices[0]?.id || null;
      setStats(m.stats); renderDevices(); renderSelected();
    } else if (m.type === "spectrum") {
      if (m.device === sel()) { window.liveBands = m.bands; window.liveLevel = m.level_db; S.lastSpectrum = performance.now(); }
    } else if (m.type === "result") onResult(m);
  }

  function onResult(m) {
    const d = S.devices[m.device]; if (!d) return;
    Object.assign(d, { label: m.label, confidence: m.confidence, ai_score: m.ai_score });
    const listening = m.label === "Listening";
    if (!S.pinned && !listening && (!S.active || S.devices[S.active]?.label === "Listening")) S.active = m.device;
    (S.series[m.device] ||= []).push(listening ? null : m.ai_score);
    if (S.series[m.device].length > 240) S.series[m.device].shift();
    if (!listening) { S.rate.push(performance.now()); logRow(m, d); }
    setStats(m.stats); renderDevices();
    if (m.device === sel()) { applyResult(m); $("eng-latency").textContent = m.ms + "ms"; drawTimeline(); }
  }

  // ---- big monitor panel ------------------------------------------------------------------------
  function waiting(title, desc) {
    setVoiceState("analyzing");
    $("result-verdict-title").textContent = title;
    $("result-confidence-pill").textContent = "No speech";
    $("result-verdict-desc").textContent = desc;
    $("meter-bar").style.width = "0%";
    $("meter-val-text").textContent = "—";
    $("metric-anomaly-index").textContent = "Artifact Index: —";
    $("live-call-centerpiece").style.boxShadow = "";
    document.title = "VoxGuard - Live Voice Authenticity Dashboard";
  }

  function applyResult(m) {
    const st = STATE[m.label];
    if (!st) return waiting("LISTENING FOR VOICE…", "Put the call on speaker next to the phone. A verdict appears about 2 seconds after someone speaks.");
    setVoiceState(st);
    const f = m.features, word = { cloned: ["AI Spoof", "Cloned"], human: ["Human", "Organic"], uncertain: ["Low Confidence", "Marginal"] }[st];
    $("result-confidence-pill").textContent = `${m.confidence}% ${word[0]}`;
    $("meter-bar").style.width = m.confidence + "%";
    $("meter-val-text").textContent = `${m.confidence}% ${word[1]}`;
    $("metric-anomaly-index").textContent = `Artifact Index: ${(m.ai_score / 100).toFixed(2)}`;
    $("result-verdict-desc").textContent =
      `Pitch change ${f.pitch_var}¢/frame · waveform periodicity ${f.periodicity} · loudness change ${f.shimmer} dB. Synthetic voices are unnaturally steady.`;
    $("live-call-centerpiece").style.boxShadow = st === "cloned" ? "0 0 0 3px rgba(192,82,82,.45)" : "";
    document.title = st === "cloned" ? "⚠ AI VOICE DETECTED - VoxGuard" : "VoxGuard - Live Voice Authenticity Dashboard";
  }

  function renderSelected() {
    const d = S.devices[sel()];
    $("live-session").textContent = d ? `#call-${d.id}-live` : "no active call";
    $("live-sensor-name").textContent = d ? d.name : "Waiting for phone…";
    $("live-sensor-sub").textContent = d ? `${(d.sr / 1000).toFixed(1)} kHz · id ${d.id}` : "scan the QR code";
    $("conn-sr").textContent = $("eng-sr").textContent = d ? `${d.sr.toLocaleString()} Hz → 16 kHz` : "—";
    $("conn-state").textContent = d ? "• Connected" : "• No phone";
    $("timeline-device").textContent = d ? d.name : "no phone";
    window.liveBands = null;
    if (!d) { $("live-call-timer").textContent = "00:00"; waiting("WAITING FOR PHONE", "Click “Pair Phone”, scan the QR code with a phone and allow the microphone."); }
    else if (d.label === "Listening" || !d.label) waiting("LISTENING FOR VOICE…", "Put the call on speaker next to the phone. A verdict appears about 2 seconds after someone speaks.");
    drawTimeline();
  }

  // ---- connected phones panel + KPI tiles ------------------------------------------------------------
  function renderDevices() {
    const list = Object.values(S.devices), n = list.length;
    $("stat-devices-count").textContent = n === 1 ? "1 Phone" : `${n} Phones`;
    $("stat-devices-sub").textContent = n ? list.map(d => d.name).join(" · ") : "none connected";
    $("sidebar-device-count").textContent = n;
    $("device-panel-count").textContent = `(${n})`;
    $("top-phone-text").textContent = n === 0 ? "No phone" : n === 1 ? list[0].name : `${n} phones`;
    $("top-phone-indicator").style.backgroundColor = n ? "#278C87" : "#94a3b8";
    $("banner-status-desc").textContent = n ? `${n} phone${n > 1 ? "s" : ""} streaming live audio` : "Awaiting audio feed. Pair a phone with the QR code.";
    $("device-grid").innerHTML = n ? list.map(d => {
      const st = STATE[d.label], c = COLOR[st] || "#64748b", on = d.id === sel();
      return `<button data-id="${esc(d.id)}" class="text-left rounded border p-3 hover:bg-slate-50 transition-colors" style="border-color:${on ? "#3568A8" : "#DCE3EB"};${on ? "background:#F4F8FC" : ""}">
        <div class="flex items-center justify-between"><span class="font-semibold text-sm text-slate-800">${esc(d.name)}</span>
        <span class="px-2 py-0.5 rounded text-[10px] font-bold font-mono" style="background:${(BADGE[st] || ["", "#f1f5f9"])[1]};color:${c}">${st ? BADGE[st][0] : "LISTENING"}</span></div>
        <div class="text-[11px] font-mono text-slate-500 mt-1">id ${esc(d.id)} · ${(d.sr / 1000).toFixed(1)} kHz${S.pinned === d.id ? " · pinned" : on ? " · monitoring" : ""}</div>
        <div class="h-1.5 bg-slate-100 rounded mt-2 overflow-hidden"><div class="h-full" style="width:${d.ai_score || 0}%;background:${c}"></div></div>
        <div class="text-[10px] font-mono mt-1 text-slate-500">AI likelihood ${Math.round(d.ai_score || 0)}%</div></button>`;
    }).join("") : '<div class="text-xs text-slate-400 font-mono p-3">No phones connected. Click “Pair Phone” and scan the QR code.</div>';
    $("pair-state").textContent = n ? `${n} phone${n > 1 ? "s" : ""} connected` : "waiting for scan";
  }
  $("device-grid").onclick = e => {
    const id = e.target.closest("[data-id]")?.dataset.id; if (!id) return;
    S.pinned = S.pinned === id ? null : id; if (!S.pinned) S.active = id;
    renderDevices(); renderSelected();
  };

  function setStats(s) {
    if (!s) return;
    $("stat-total-packets").textContent = s.total.toLocaleString();
    $("stat-clone-rate").textContent = (s.total ? (100 * s.ai / s.total).toFixed(1) : 0) + "%";
    $("stat-human-ratio").textContent = (s.total ? (100 * s.human / s.total).toFixed(1) : 0) + "%";
    $("stat-ai-sub").textContent = s.ai; $("stat-human-sub").textContent = s.human;
  }

  // ---- tables + CSV --------------------------------------------------------------------------------------
  function logRow(m, d) {
    const st = STATE[m.label], prev = S.lastRow[m.device], now = Date.now();
    if (prev && prev.label === m.label && now - prev.t < 5000) return;          // log on change or every 5 s
    S.lastRow[m.device] = { label: m.label, t: now };
    S.history.unshift({ time: new Date(now).toLocaleTimeString(), device: d.name, id: d.id, label: BADGE[st][0], conf: m.confidence, why: WHY[st], st });
    S.history = S.history.slice(0, 500);
    const h = S.history[0];
    $("inferences-tbody").insertAdjacentHTML("afterbegin", `<tr class="hover:bg-slate-50/70"><td class="py-2.5 font-mono text-[11px] font-semibold text-slate-800">#${esc(h.id)} • ${esc(h.device)}</td>
      <td class="py-2.5 font-mono text-[11px] text-slate-600">Acoustic heuristic</td><td class="py-2.5 font-mono font-bold" style="color:${COLOR[st]}">${h.conf}%</td>
      <td class="py-2.5 text-slate-600 text-[11px]">${h.why}</td><td class="py-2.5 text-right"><span class="px-2 py-0.5 rounded text-[10px] font-bold font-mono" style="background:${BADGE[st][1]};color:${COLOR[st]}">${h.label}</span></td></tr>`);
    while ($("inferences-tbody").children.length > 6) $("inferences-tbody").lastChild.remove();
    renderHistory();
  }
  function renderHistory() {
    const q = $("history-search").value.toLowerCase();
    $("history-tbody").innerHTML = S.history.filter(h => !q || `${h.device} ${h.label}`.toLowerCase().includes(q)).map(h => `<tr class="hover:bg-slate-50/70">
      <td class="py-2.5 font-mono text-[11px]">${esc(h.time)}</td><td class="py-2.5"><span class="px-2 py-0.5 rounded text-[10px] font-bold font-mono" style="background:${BADGE[h.st][1]};color:${COLOR[h.st]}">${h.label}</span></td>
      <td class="py-2.5 font-mono font-bold" style="color:${COLOR[h.st]}">${h.conf}%</td><td class="py-2.5 text-slate-600">${h.why}</td>
      <td class="py-2.5 font-mono text-[11px]">${esc(h.device)} • ${esc(h.id)}</td><td></td></tr>`).join("");
  }
  $("history-search").oninput = renderHistory;
  $("btn-export").onclick = () => {
    const cell = v => { v = String(v); if (/^[=+\-@]/.test(v)) v = "'" + v; return `"${v.replace(/"/g, '""')}"`; };
    const csv = ["time,device,id,verdict,confidence,assessment", ...S.history.map(h => [h.time, h.device, h.id, h.label, h.conf, h.why].map(cell).join(","))].join("\n");
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([csv], { type: "text/csv" })), download: "voxguard-history.csv" });
    a.click(); URL.revokeObjectURL(a.href);
  };

  // ---- AI-likelihood timeline ----------------------------------------------------------------------------------
  function drawTimeline() {
    const cv = $("timeline"), dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = 140;
    if (!w) return;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext("2d"); g.scale(dpr, dpr);
    const y = v => h - 8 - (v / 100) * (h - 16);
    g.fillStyle = "rgba(192,82,82,.08)"; g.fillRect(0, y(100), w, y(60) - y(100));
    g.fillStyle = "rgba(50,128,90,.08)"; g.fillRect(0, y(40), w, y(0) - y(40));
    g.strokeStyle = "#DCE3EB"; g.setLineDash([4, 4]);
    [40, 60].forEach(v => { g.beginPath(); g.moveTo(0, y(v)); g.lineTo(w, y(v)); g.stroke(); });
    g.setLineDash([]); g.fillStyle = "#94a3b8"; g.font = "10px monospace"; g.fillText("AI > 60", 6, y(100) + 10); g.fillText("HUMAN < 40", 6, y(0) - 2);
    const pts = S.series[sel()] || [], step = w / 239;
    g.lineWidth = 2; g.beginPath(); let pen = false;
    pts.forEach((v, i) => {
      const x = w - (pts.length - 1 - i) * step;
      if (v == null) { pen = false; return; }
      g.strokeStyle = v >= 60 ? COLOR.cloned : v <= 40 ? COLOR.human : COLOR.uncertain;
      if (!pen) { g.moveTo(x, y(v)); pen = true; } else { g.lineTo(x, y(v)); g.stroke(); g.beginPath(); g.moveTo(x, y(v)); }
    });
  }
  window.addEventListener("resize", drawTimeline);

  // ---- housekeeping ticks ----------------------------------------------------------------------------------------
  setInterval(() => {
    if (performance.now() - S.lastSpectrum > 1500) window.liveBands = null;        // no audio: fall back to idle animation
    const d = S.devices[sel()];
    if (d) $("live-call-timer").textContent = mmss((performance.now() - d.upAt) / 1000);
    S.rate = S.rate.filter(t => performance.now() - t < 60000); $("stat-rate").textContent = S.rate.length;
  }, 500);

  renderDevices(); renderSelected(); connect();
})();
