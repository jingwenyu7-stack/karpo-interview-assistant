/**
 * Karpo Interview Assistant - Side Panel JS
 *
 * Handles:
 *  - Setup view: backend health check, session creation
 *  - Session view: tab switching, turn submission, real-time updates from WS
 *  - Completion view: persona report rendering
 */

// ============ State ============
const state = {
  backendUrl: "http://localhost:8000",
  sessionId: null,
  sessionStartTime: null,
  timerInterval: null,
  transcript: [],
  followups: [],
  coverageStats: null,
  pacing: null,
  profile: {},
  insights: [],
  quotes: [],
  totalCostUsd: 0,
  outline: null,
  collapsedModules: new Set(),
};

// ============ Storage helpers ============
async function loadStored() {
  const data = await chrome.storage.local.get([
    "karpo.backendUrl",
    "karpo.sessionId",
    "karpo.intervieweeName",
    "karpo.interviewerName",
  ]);
  if (data["karpo.backendUrl"]) state.backendUrl = data["karpo.backendUrl"];
  if (data["karpo.sessionId"]) state.sessionId = data["karpo.sessionId"];

  // Hydrate the form
  document.getElementById("backend-url").value = state.backendUrl;
  if (data["karpo.intervieweeName"]) {
    document.getElementById("interviewee-name").value = data["karpo.intervieweeName"];
  }
  if (data["karpo.interviewerName"]) {
    document.getElementById("interviewer-name").value = data["karpo.interviewerName"];
  }

  // If we have a stored session, try to resume
  if (state.sessionId) {
    await tryResumeSession(state.sessionId);
  }
}

async function tryResumeSession(sessionId) {
  try {
    const res = await fetch(`${state.backendUrl}/api/sessions/${sessionId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    hydrateFromSession(data);
    showView("session");
    connectWebSocket(sessionId);
    toast("Session resumed", "info");
  } catch (e) {
    console.warn("Resume failed; will start fresh:", e);
    await chrome.storage.local.remove("karpo.sessionId");
    state.sessionId = null;
  }
}

function hydrateFromSession(data) {
  state.transcript = data.transcript || [];
  state.followups = data.latest_followups || [];
  state.profile = data.profile || {};
  state.insights = data.insights || [];
  state.quotes = data.quotes || [];
  state.totalCostUsd = data.total_cost_usd || 0;
  state.sessionStartTime = data.started_at ? data.started_at * 1000 : Date.now();
  startTimer();
  renderAll();
  refreshCoverage();
}

// ============ Backend API ============
async function fetchHealth() {
  const url = document.getElementById("backend-url").value.trim() || state.backendUrl;
  try {
    const res = await fetch(`${url}/api/health`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function createSession(payload) {
  const url = document.getElementById("backend-url").value.trim() || state.backendUrl;
  state.backendUrl = url;
  await chrome.storage.local.set({
    "karpo.backendUrl": url,
    "karpo.intervieweeName": payload.interviewee_name,
    "karpo.interviewerName": payload.interviewer_name,
  });
  const res = await fetch(`${url}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Session creation failed: ${res.status}`);
  return res.json();
}

async function submitTurn(question, response) {
  const res = await fetch(`${state.backendUrl}/api/sessions/${state.sessionId}/turn`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      interviewer_question: question,
      interviewee_response: response,
      translate: true,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Turn failed: ${err}`);
  }
  return res.json();
}

async function closeSession() {
  const res = await fetch(`${state.backendUrl}/api/sessions/${state.sessionId}/close`, {
    method: "POST",
  });
  if (!res.ok) throw new Error(`Close failed: ${res.status}`);
  return res.json();
}

async function refreshCoverage() {
  if (!state.sessionId) return;
  try {
    const res = await fetch(`${state.backendUrl}/api/sessions/${state.sessionId}/coverage`);
    if (!res.ok) return;
    state.coverageStats = await res.json();
    renderCoverage();
  } catch {}
}

async function loadOutline() {
  try {
    const res = await fetch(`${state.backendUrl}/api/outline`);
    if (res.ok) state.outline = await res.json();
  } catch (e) {
    console.warn("Failed to load outline:", e);
  }
}

// ============ WebSocket ============
function connectWebSocket(sessionId) {
  chrome.runtime.sendMessage({ type: "connect_session", sessionId });
}

// Listen for events forwarded from background
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.event) return false;
  handleBackendEvent(msg.event, msg.payload);
  return false;
});

function handleBackendEvent(event, payload) {
  switch (event) {
    case "ws_connected":
      updateConnectionStatus(true);
      break;
    case "ws_disconnected":
    case "ws_error":
      updateConnectionStatus(false);
      break;
    case "turn_added":
      state.transcript.push(payload);
      renderTranscript();
      break;
    case "translation_ready":
      // Find the turn by id and update zh
      const turn = state.transcript.find((t) => t.turn_id === payload.turn_id);
      if (turn) {
        turn.zh = payload.zh;
        renderTranscript();
      }
      break;
    case "coverage_update":
      state.coverageStats = payload.stats;
      state.pacing = payload.pacing;
      renderCoverage();
      renderLive(); // pacing banner shows on Live too
      if (payload.missed_opportunity) {
        toast(`⚠️ Missed: ${payload.missed_opportunity}`, "info");
      }
      break;
    case "profile_update":
      state.profile = payload.profile || state.profile;
      if (payload.new_insights) {
        state.insights.push(...payload.new_insights);
      }
      state.quotes = payload.quotes || state.quotes;
      renderProfile();
      break;
    case "followups_ready":
      state.followups = payload.followups || [];
      renderLive();
      break;
    case "live_transcript":
      handleLiveTranscript(payload);
      break;
    case "audio_stream_started":
      setAudioDotState(payload.role, "active");
      toast(`🎙️ ${payload.role === "interviewer" ? "Mic" : "Tab audio"} stream started`, "success");
      break;
    case "audio_stream_ended":
      setAudioDotState(payload.role, "off");
      break;
    case "audio_state":
      // From offscreen → background → here. payload: { role, state, ... }
      if (payload.state === "streaming") setAudioDotState(payload.role, "active");
      else if (payload.state === "stopped") setAudioDotState(payload.role, "off");
      else if (payload.state === "error") {
        setAudioDotState(payload.role, "error");
        toast(`⚠️ ${payload.role} stream error`, "error");
      }
      break;
  }
}

// === Live transcript handling ===
const liveBuffers = { interviewer: "", interviewee: "" };

function handleLiveTranscript({ role, text, is_final }) {
  const liveBox = document.getElementById("live-transcript");
  liveBox.classList.remove("hidden");

  if (is_final) {
    liveBuffers[role] = (liveBuffers[role] + " " + text).trim();
  }
  const display = is_final ? liveBuffers[role] : (liveBuffers[role] + " " + text).trim();

  const elId = role === "interviewer" ? "live-interviewer" : "live-interviewee";
  const el = document.getElementById(elId);
  if (el) {
    el.textContent = display || "…";
    el.classList.toggle("final", is_final);
  }
}

function clearLiveTranscript(role) {
  liveBuffers[role] = "";
  const elId = role === "interviewer" ? "live-interviewer" : "live-interviewee";
  const el = document.getElementById(elId);
  if (el) {
    el.textContent = "…";
    el.classList.remove("final");
  }
}

// === Audio control wiring ===
function setAudioDotState(role, state /* "off" | "active" | "error" */) {
  const dotId = role === "interviewer" ? "dot-mic" : "dot-tab";
  const labelId = role === "interviewer" ? "audio-label-mic" : "audio-label-tab";
  const dot = document.getElementById(dotId);
  const label = document.getElementById(labelId);
  if (!dot || !label) return;
  dot.classList.remove("active", "error");
  if (state === "active") dot.classList.add("active");
  if (state === "error") dot.classList.add("error");
  const friendly = role === "interviewer" ? "Mic" : "Tab";
  label.textContent = `${friendly}: ${state === "active" ? "live" : state === "error" ? "err" : "off"}`;
}

// ============ Audio capture (runs inside the side panel) ============
// We do the audio capture HERE rather than in an offscreen document because
// (a) the side panel is a regular webpage with full DOM/media APIs, and
// (b) `getDisplayMedia` requires fresh user activation — keeping the call
// in the same DOM context as the click guarantees the gesture isn't lost
// across `chrome.runtime.sendMessage` hops.
const PIPELINES = {}; // role → { ctx, source, node, stream, ws }
let audioRunning = false;

function buildAudioWsUrl(backendUrl, sessionId, role) {
  const base = (backendUrl || "http://localhost:8000")
    .replace(/^http/, "ws")
    .replace(/\/$/, "");
  return `${base}/ws/audio/${encodeURIComponent(sessionId)}/${role}`;
}

async function buildAudioPipeline({ role, stream, sessionId, backendUrl, playback }) {
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "karpo-pcm-worklet", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  source.connect(node);
  if (playback) {
    // pipe tab audio to speakers so interviewer can hear the call
    source.connect(ctx.createGain()).connect(ctx.destination);
  }

  const ws = new WebSocket(buildAudioWsUrl(backendUrl, sessionId, role));
  ws.binaryType = "arraybuffer";
  let connected = false;
  ws.onopen = () => {
    connected = true;
    setAudioDotState(role, "active");
  };
  ws.onclose = () => {
    connected = false;
    setAudioDotState(role, "off");
  };
  ws.onerror = () => setAudioDotState(role, "error");

  node.port.onmessage = (evt) => {
    if (!connected) return;
    if (ws.readyState === WebSocket.OPEN) ws.send(evt.data);
  };

  // When the user revokes the share via Chrome's banner, the track ends.
  stream.getAudioTracks().forEach((t) => {
    t.onended = () => stopAudioPipeline(role);
  });

  PIPELINES[role] = { ctx, source, node, stream, ws };
}

async function stopAudioPipeline(role) {
  const p = PIPELINES[role];
  if (!p) return;
  try { p.node.disconnect(); } catch {}
  try { p.source.disconnect(); } catch {}
  try { p.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (p.ws.readyState === WebSocket.OPEN) p.ws.send("stop"); p.ws.close(); } catch {}
  try { await p.ctx.close(); } catch {}
  delete PIPELINES[role];
  setAudioDotState(role, "off");
}

async function startTabAudio() {
  // The browser shows its native "Choose what to share" picker.
  // User must select the Meet tab AND check "Also share tab audio".
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true, // required by spec; we discard the video track below
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
  });
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error("No audio shared. You must check 'Also share tab audio' in the dialog.");
  }
  // discard video, keep audio
  stream.getVideoTracks().forEach((t) => t.stop());
  const audioStream = new MediaStream(audioTracks);
  await buildAudioPipeline({
    role: "interviewee",
    stream: audioStream,
    sessionId: state.sessionId,
    backendUrl: state.backendUrl,
    playback: true,
  });
}

// Opens the dedicated mic-grant tab if permission isn't granted, then retries.
async function ensureMicPermissionViaGrantTab() {
  return new Promise((resolve, reject) => {
    let resolved = false;

    // Listen for the grant-tab to tell us permission was granted
    const onMsg = (msg) => {
      if (msg.type === "mic_permission_granted") {
        resolved = true;
        chrome.runtime.onMessage.removeListener(onMsg);
        resolve();
      }
    };
    chrome.runtime.onMessage.addListener(onMsg);

    // Open the grant page in a small focused popup window
    chrome.windows.create({
      url: chrome.runtime.getURL("mic-grant.html"),
      type: "popup",
      width: 540,
      height: 460,
      focused: true,
    }, (win) => {
      // If the user closes the window without granting, reject after a delay
      const winId = win?.id;
      const onClose = (closedId) => {
        if (closedId === winId && !resolved) {
          chrome.windows.onRemoved.removeListener(onClose);
          chrome.runtime.onMessage.removeListener(onMsg);
          reject(new Error("Permission grant window was closed before approval"));
        } else if (closedId === winId) {
          chrome.windows.onRemoved.removeListener(onClose);
        }
      };
      chrome.windows.onRemoved.addListener(onClose);
    });

    // Safety timeout
    setTimeout(() => {
      if (!resolved) {
        chrome.runtime.onMessage.removeListener(onMsg);
        reject(new Error("Timed out waiting for microphone permission"));
      }
    }, 60_000);
  });
}

async function startMicAudio() {
  // Helper that just does getUserMedia + builds the pipeline. May throw.
  const attempt = async () => {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    await buildAudioPipeline({
      role: "interviewer",
      stream,
      sessionId: state.sessionId,
      backendUrl: state.backendUrl,
      playback: false,
    });
  };

  try {
    await attempt();
    return;
  } catch (firstErr) {
    console.warn(
      "[Karpo] mic via side panel failed:",
      firstErr?.name,
      firstErr?.message,
      "— opening grant popup"
    );
  }

  // Open the popup grant page — this guarantees the prompt is visible.
  // After the user clicks Allow, getUserMedia from side panel works.
  await ensureMicPermissionViaGrantTab();

  // Retry now that permission is granted
  await attempt();
}

async function toggleAudio() {
  const btn = document.getElementById("audio-toggle-btn");
  if (!state.sessionId) {
    toast("Create a session first", "error");
    return;
  }
  if (!audioRunning) {
    btn.disabled = true;
    btn.textContent = "Starting…";
    try {
      // SERIAL flow — running the two permission flows in parallel makes
      // the modal share dialog block our mic-grant popup. So:
      //   1) Tab first: user picks the Meet tab in Chrome's share dialog
      //   2) Mic second: side-panel getUserMedia, or popup-grant fallback
      const fmtErr = (e) => {
        if (!e) return "unknown";
        const name = e.name ? `${e.name}: ` : "";
        return `${name}${e.message || e}`;
      };

      let tabOk = false, micOk = false;
      try {
        await startTabAudio();
        tabOk = true;
      } catch (tabErr) {
        console.warn("[Karpo] tab failed:", tabErr);
        toast(`Tab audio unavailable — ${fmtErr(tabErr)}`, "error");
      }

      try {
        await startMicAudio();
        micOk = true;
      } catch (micErr) {
        console.warn("[Karpo] mic failed:", micErr);
        toast(`Mic unavailable — ${fmtErr(micErr)}`, "error");
      }

      if (!tabOk && !micOk) {
        throw new Error("Both tab audio and microphone failed to start.");
      }
      audioRunning = true;
      btn.classList.add("listening");
      btn.textContent = "⏹ Stop listening";
    } catch (e) {
      console.error("[Karpo] start audio failed:", e);
      toast(`Audio failed: ${e.message || e}`, "error");
      btn.textContent = "🎙️ Start listening";
    } finally {
      btn.disabled = false;
    }
  } else {
    btn.disabled = true;
    btn.textContent = "Stopping…";
    await stopAudioPipeline("interviewer");
    await stopAudioPipeline("interviewee");
    audioRunning = false;
    btn.classList.remove("listening");
    btn.textContent = "🎙️ Start listening";
    btn.disabled = false;
  }
}

// Bind audio toggle button after DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  const btn = document.getElementById("audio-toggle-btn");
  if (btn) btn.addEventListener("click", toggleAudio);
});

function updateConnectionStatus(connected) {
  const el = document.getElementById("connection-status");
  el.textContent = connected ? "Connected" : "Disconnected";
  el.classList.toggle("connected", connected);
  el.classList.toggle("disconnected", !connected);
}

// ============ View management ============
function showView(name) {
  document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
  document.getElementById(`view-${name}`).classList.remove("hidden");
}

// Tab switching
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-content").forEach((c) => c.classList.add("hidden"));
    tab.classList.add("active");
    document.getElementById(`tab-${tab.dataset.tab}`).classList.remove("hidden");
  });
});

// ============ Render functions ============
function renderAll() {
  renderLive();
  renderCoverage();
  renderProfile();
  renderTranscript();
  updateCost();
}

function renderLive() {
  const container = document.getElementById("live-content");
  let html = "";

  // Pacing banner
  if (state.pacing) {
    const status = state.pacing.status || "on_track";
    const pct = Math.round((state.pacing.current_module_completion || 0) * 100);
    html += `<div class="pacing-banner ${status}">
      <div style="flex:1;">
        <strong>${formatPacingLabel(status)}</strong> · current module ${pct}% covered<br/>
        ${escapeHtml(state.pacing.suggested_action || "")}`;
    if (state.pacing.natural_transition_phrase) {
      html += `<div class="transition-phrase" data-copy="${escapeAttr(state.pacing.natural_transition_phrase)}">"${escapeHtml(state.pacing.natural_transition_phrase)}"</div>`;
    }
    html += `</div></div>`;
  }

  // Followups
  if (state.followups.length > 0) {
    html += `<div class="followup-section">
      <div class="followup-title">💡 Smart follow-ups (click to copy)</div>`;
    state.followups.forEach((f, i) => {
      const prioClass = f.priority === "high" ? "priority-high" : "";
      html += `<div class="followup-q ${prioClass}" data-copy="${escapeAttr(f.q)}">
        <div class="q-text">${i + 1}. ${escapeHtml(f.q)}</div>
        <div class="q-meta">
          ${f.priority === "high" ? '<span class="q-tag high">🔥 HIGH</span>' : ""}
          <span class="q-tag purpose">🎯 ${escapeHtml(f.purpose || "")}</span>
          ${f.outline_tag ? `<span class="q-tag">#${escapeHtml(f.outline_tag)}</span>` : ""}
        </div>
        ${f.rationale ? `<div class="q-rationale">${escapeHtml(f.rationale)}</div>` : ""}
      </div>`;
    });
    html += `</div>`;
  } else if (state.transcript.length === 0) {
    html += `<div class="empty-state">
      <div class="empty-icon">🎙️</div>
      <p>Submit the first turn below to see smart follow-ups.</p>
    </div>`;
  }

  // Recent transcript (last 2 items)
  if (state.transcript.length > 0) {
    html += `<div class="section-label">Recent dialogue</div>`;
    state.transcript.slice(-2).forEach((item) => {
      html += renderTranscriptItem(item);
    });
  }

  container.innerHTML = html;

  // Wire up click-to-copy
  container.querySelectorAll("[data-copy]").forEach((el) => {
    el.addEventListener("click", () => copyText(el.dataset.copy, el));
  });
}

function renderTranscriptItem(item) {
  const speakerLabel = item.speaker === "interviewee" ? "👤 Interviewee" : "🎙️ Interviewer";
  const time = item.time ? new Date(item.time).toLocaleTimeString() : "";
  return `<div class="transcript-item ${item.speaker}">
    <div class="transcript-meta"><span>${speakerLabel}</span><span>${time}</span></div>
    <div class="transcript-en">${escapeHtml(item.en || item.text || "")}</div>
    ${item.zh ? `<div class="transcript-zh">🌐 ${escapeHtml(item.zh)}</div>` : ""}
  </div>`;
}

function renderTranscript() {
  const container = document.getElementById("transcript-content");
  if (state.transcript.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📝</div><p>Transcript will appear here.</p>
    </div>`;
    return;
  }
  container.innerHTML = state.transcript.map(renderTranscriptItem).join("");
}

function renderCoverage() {
  const container = document.getElementById("coverage-content");
  const stats = state.coverageStats;

  if (!stats) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">📊</div><p>Coverage will populate as you interview.</p>
    </div>`;
    return;
  }

  // Update missing badge
  const missing = stats._overall?.missing_count ?? 0;
  const badge = document.getElementById("missing-count");
  badge.textContent = missing;
  badge.dataset.count = missing;

  let html = "";
  Object.entries(stats).forEach(([modId, mod]) => {
    if (modId === "_overall") return;
    const pct = mod.percent;
    const fillClass = pct < 30 ? "danger" : pct < 70 ? "warn" : "";
    const isCollapsed = state.collapsedModules.has(modId);

    html += `<div class="module-card">
      <div class="module-header" data-toggle-module="${modId}">
        <span class="module-name">${escapeHtml(mod.name)}</span>
        <span class="module-percent">${mod.covered}/${mod.total} · ${pct}%</span>
      </div>
      <div class="progress-bar"><div class="progress-fill ${fillClass}" style="width:${pct}%"></div></div>
      <div class="checkpoint-list ${isCollapsed ? "collapsed" : ""}">`;

    // Render all points (need outline data for labels)
    const moduleOutline = state.outline?.modules.find((m) => m.id === modId);
    if (moduleOutline) {
      moduleOutline.points.forEach((p) => {
        const isMissing = mod.missing.some((m) => m.id === p.id);
        const cls = isMissing ? "pending" : "done";
        const icon = isMissing ? "⏳" : "✅";
        const highValue = p.high_value ? "high-value" : "";
        html += `<div class="checkpoint ${cls} ${highValue}">
          <span>${icon}</span><span>${escapeHtml(p.label)}</span>
        </div>`;
      });
    }
    html += `</div></div>`;
  });

  container.innerHTML = html;

  // Wire up collapsible modules
  container.querySelectorAll("[data-toggle-module]").forEach((el) => {
    el.addEventListener("click", () => {
      const modId = el.dataset.toggleModule;
      if (state.collapsedModules.has(modId)) {
        state.collapsedModules.delete(modId);
      } else {
        state.collapsedModules.add(modId);
      }
      renderCoverage();
    });
  });
}

function renderProfile() {
  const container = document.getElementById("profile-content");
  const sections = Object.entries(state.profile).filter(([_, v]) => v && Object.keys(v).length > 0);

  if (sections.length === 0 && state.insights.length === 0) {
    container.innerHTML = `<div class="empty-state">
      <div class="empty-icon">👤</div><p>Profile extracts as you interview.</p>
    </div>`;
    return;
  }

  let html = "";

  // Insights first — most valuable
  if (state.insights.length > 0) {
    html += `<div class="section-label">🔥 Key Insights (Karpo product implications)</div>`;
    state.insights.forEach((ins) => {
      html += `<div class="insight-card">
        <div class="insight-headline">${escapeHtml(ins.headline || "")}</div>`;
      if (ins.verbatim_quote) {
        html += `<div class="insight-quote">"${escapeHtml(ins.verbatim_quote)}"</div>`;
      }
      if (ins.product_implication) {
        html += `<div class="insight-implication">💡 ${escapeHtml(ins.product_implication)}</div>`;
      }
      if (ins.relates_to_karpo_hypothesis) {
        html += `<div class="insight-tags"><span class="hypothesis-tag">${escapeHtml(ins.relates_to_karpo_hypothesis)}</span></div>`;
      }
      html += `</div>`;
    });
  }

  // Profile sections
  if (sections.length > 0) {
    html += `<div class="section-label">🧬 Extracted Profile</div>`;
    const sectionLabels = {
      identity: "Identity",
      living: "Living Situation",
      routine: "Routine",
      social: "Social",
      interests: "Interests",
      food: "Food",
      apps: "Apps",
      decision: "Decision Making",
      karpo_reactions: "Karpo Reactions",
    };
    sections.forEach(([sectionName, fields]) => {
      const label = sectionLabels[sectionName] || sectionName;
      html += `<div class="profile-section"><h4>${escapeHtml(label)}</h4>`;
      Object.entries(fields).forEach(([k, v]) => {
        html += renderProfileField(k, v);
      });
      html += `</div>`;
    });
  }

  // Verbatim quotes
  if (state.quotes.length > 0) {
    html += `<div class="section-label">💬 High-value Quotes</div>`;
    state.quotes.forEach((q) => {
      html += `<div class="quote-card">"${escapeHtml(q)}"</div>`;
    });
  }

  container.innerHTML = html;
}

function renderProfileField(name, value) {
  // Value can be: { value, confidence }, [...], or simple value
  let displayValue = "";
  let confidence = null;
  if (Array.isArray(value)) {
    displayValue = value.map((v) =>
      typeof v === "object" ? Object.values(v).filter(x => typeof x === "string").join(" · ") : String(v)
    ).join(", ");
  } else if (typeof value === "object" && value !== null) {
    if ("value" in value) {
      displayValue = formatVal(value.value);
      confidence = value.confidence;
    } else {
      displayValue = JSON.stringify(value);
    }
  } else {
    displayValue = formatVal(value);
  }
  const confidenceBadge = confidence
    ? `<span class="confidence-pill ${confidence}">${confidence}</span>`
    : "";
  return `<div class="profile-field">
    <span class="field-name">${escapeHtml(humanizeKey(name))}:</span>
    <span class="field-value">${escapeHtml(displayValue)}${confidenceBadge}</span>
  </div>`;
}

function formatVal(v) {
  if (v === null || v === undefined) return "—";
  if (typeof v === "boolean") return v ? "Yes" : "No";
  return String(v);
}

function humanizeKey(key) {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function formatPacingLabel(status) {
  return {
    on_track: "✅ On track",
    behind: "⚠️ Behind schedule",
    should_transition: "➡️ Time to transition",
    backtrack_needed: "🔙 Backtrack needed",
  }[status] || status;
}

// ============ Timer ============
function startTimer() {
  if (state.timerInterval) clearInterval(state.timerInterval);
  if (!state.sessionStartTime) state.sessionStartTime = Date.now();
  state.timerInterval = setInterval(() => {
    const sec = Math.floor((Date.now() - state.sessionStartTime) / 1000);
    const m = String(Math.floor(sec / 60)).padStart(2, "0");
    const s = String(sec % 60).padStart(2, "0");
    document.getElementById("timer").textContent = `${m}:${s}`;
  }, 1000);
}

function updateCost() {
  document.getElementById("cost-pill").textContent = `$${state.totalCostUsd.toFixed(3)}`;
}

// ============ Utilities ============
function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function copyText(text, el) {
  navigator.clipboard.writeText(text).then(() => {
    if (el) {
      const orig = el.style.background;
      el.style.background = "rgba(52,168,83,0.2)";
      setTimeout(() => (el.style.background = orig), 400);
    }
    toast("Copied!", "success");
  });
}

function toast(msg, type = "info") {
  const container = document.getElementById("toast-container");
  const el = document.createElement("div");
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = "0";
    setTimeout(() => el.remove(), 300);
  }, 2500);
}

// ============ Event handlers ============
document.getElementById("check-health").addEventListener("click", async () => {
  const hint = document.getElementById("health-status");
  hint.textContent = "Checking...";
  hint.className = "field-hint";
  const result = await fetchHealth();
  if (result.ok) {
    const probs = result.data.problems || [];
    if (probs.length === 0) {
      hint.textContent = "✓ Backend OK — all models configured";
      hint.className = "field-hint ok";
    } else {
      hint.textContent = `⚠ Backend reachable but: ${probs.join(" / ")}`;
      hint.className = "field-hint err";
    }
  } else {
    hint.textContent = `✗ Cannot reach backend: ${result.error}`;
    hint.className = "field-hint err";
  }
});

document.getElementById("start-session-btn").addEventListener("click", async () => {
  const intervieweeName = document.getElementById("interviewee-name").value.trim() || "Anonymous";
  const interviewerName = document.getElementById("interviewer-name").value.trim() || "Researcher";
  const isKarpoUser = document.getElementById("is-karpo-user").value;

  const btn = document.getElementById("start-session-btn");
  btn.disabled = true;
  btn.textContent = "Creating session...";

  try {
    const result = await createSession({
      interviewee_name: intervieweeName,
      interviewer_name: interviewerName,
      is_karpo_user: isKarpoUser,
    });

    state.sessionId = result.session_id;
    state.sessionStartTime = Date.now();
    await chrome.storage.local.set({ "karpo.sessionId": state.sessionId });

    await loadOutline();
    showView("session");
    startTimer();
    connectWebSocket(state.sessionId);
    refreshCoverage();
    renderAll();
    toast(`Session ${state.sessionId} created`, "success");
  } catch (e) {
    toast(`Failed: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Start Session";
  }
});

document.getElementById("submit-turn-btn").addEventListener("click", async () => {
  const q = document.getElementById("interviewer-question").value.trim();
  const r = document.getElementById("interviewee-response").value.trim();
  if (!r) {
    toast("Please enter the interviewee response", "error");
    return;
  }

  const btn = document.getElementById("submit-turn-btn");
  const label = btn.querySelector(".btn-label");
  const spinner = btn.querySelector(".btn-spinner");
  btn.disabled = true;
  label.textContent = "Processing...";
  spinner.classList.remove("hidden");

  try {
    const result = await submitTurn(q || "(continued)", r);
    if (result?.session_state?.total_cost_usd !== undefined) {
      state.totalCostUsd = result.session_state.total_cost_usd;
      updateCost();
    }
    // Clear inputs
    document.getElementById("interviewer-question").value = "";
    document.getElementById("interviewee-response").value = "";
    toast("Turn processed", "success");
  } catch (e) {
    toast(`Error: ${e.message}`, "error");
  } finally {
    btn.disabled = false;
    label.textContent = "Submit turn";
    spinner.classList.add("hidden");
  }
});

document.getElementById("end-session-btn").addEventListener("click", async () => {
  if (!confirm("End the interview and generate the persona report?")) return;

  const preview = document.getElementById("report-preview");
  preview.textContent = "Generating persona report — this may take 10-15 seconds...";
  showView("complete");

  document.getElementById("complete-stats").textContent =
    `${state.transcript.length} turns · Total cost: $${state.totalCostUsd.toFixed(3)}`;

  try {
    const result = await closeSession();
    preview.textContent = result.report_markdown || "(no report content)";
    chrome.runtime.sendMessage({ type: "disconnect_session" });
    await chrome.storage.local.remove("karpo.sessionId");
    toast("Report generated", "success");
  } catch (e) {
    preview.textContent = `Error generating report: ${e.message}`;
    toast(`Error: ${e.message}`, "error");
  }
});

document.getElementById("copy-report-btn").addEventListener("click", () => {
  const text = document.getElementById("report-preview").textContent;
  navigator.clipboard.writeText(text);
  toast("Report copied to clipboard", "success");
});

document.getElementById("new-session-btn").addEventListener("click", () => {
  // Reset state
  state.sessionId = null;
  state.transcript = [];
  state.followups = [];
  state.coverageStats = null;
  state.pacing = null;
  state.profile = {};
  state.insights = [];
  state.quotes = [];
  state.totalCostUsd = 0;
  if (state.timerInterval) clearInterval(state.timerInterval);
  showView("setup");
});

document.getElementById("settings-btn").addEventListener("click", () => {
  if (state.sessionId) {
    if (confirm("Disconnect and return to setup? (Session state will be cleared)")) {
      chrome.runtime.sendMessage({ type: "disconnect_session" });
      chrome.storage.local.remove("karpo.sessionId");
      state.sessionId = null;
      showView("setup");
    }
  } else {
    showView("setup");
  }
});

// ============ Init ============
(async function init() {
  await loadStored();
  if (!state.sessionId) {
    showView("setup");
  }
})();
