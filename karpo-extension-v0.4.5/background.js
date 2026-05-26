/**
 * Karpo Interview Assistant - Background Service Worker
 *
 * Responsibilities:
 *  1. Open side panel when extension icon clicked
 *  2. Maintain WebSocket connection to backend for active session
 *  3. Route messages between side panel and content script
 *  4. Persist session ID in chrome.storage so reloads survive
 */

const STORAGE_KEYS = {
  BACKEND_URL: "karpo.backendUrl",
  SESSION_ID: "karpo.sessionId",
  IS_KARPO_USER: "karpo.isKarpoUser",
};

const DEFAULT_BACKEND_URL = "http://localhost:8000";

let activeWS = null;
let currentSessionId = null;

// === Side panel: open on icon click ===
chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("setPanelBehavior failed:", err));

// === Lifecycle ===
chrome.runtime.onInstalled.addListener(async () => {
  const settings = await chrome.storage.local.get([STORAGE_KEYS.BACKEND_URL]);
  if (!settings[STORAGE_KEYS.BACKEND_URL]) {
    await chrome.storage.local.set({ [STORAGE_KEYS.BACKEND_URL]: DEFAULT_BACKEND_URL });
  }
  console.log("[Karpo BG] Installed. Default backend:", DEFAULT_BACKEND_URL);
});

// === WebSocket management ===
async function connectWebSocket(sessionId) {
  if (!sessionId) return;

  // Close existing
  if (activeWS && activeWS.readyState === WebSocket.OPEN) {
    if (currentSessionId === sessionId) return; // already connected
    try { activeWS.close(); } catch {}
  }

  const { [STORAGE_KEYS.BACKEND_URL]: backendUrl } = await chrome.storage.local.get(STORAGE_KEYS.BACKEND_URL);
  const url = (backendUrl || DEFAULT_BACKEND_URL).replace(/^http/, "ws") + `/ws/sessions/${sessionId}`;

  console.log("[Karpo BG] Connecting WS:", url);
  currentSessionId = sessionId;

  try {
    activeWS = new WebSocket(url);
  } catch (err) {
    console.error("[Karpo BG] WS construction failed:", err);
    broadcastToSidePanel({ event: "ws_error", payload: { message: err.message } });
    return;
  }

  activeWS.onopen = () => {
    console.log("[Karpo BG] WS connected for session", sessionId);
    broadcastToSidePanel({ event: "ws_connected", payload: { sessionId } });
  };

  activeWS.onmessage = (msg) => {
    try {
      const data = JSON.parse(msg.data);
      // Forward all backend events to the side panel
      broadcastToSidePanel(data);
    } catch (e) {
      console.warn("[Karpo BG] Non-JSON WS message:", msg.data);
    }
  };

  activeWS.onerror = (err) => {
    console.error("[Karpo BG] WS error:", err);
    broadcastToSidePanel({ event: "ws_error", payload: { message: "Connection error" } });
  };

  activeWS.onclose = () => {
    console.log("[Karpo BG] WS closed");
    broadcastToSidePanel({ event: "ws_disconnected", payload: {} });
    activeWS = null;
  };
}

function broadcastToSidePanel(message) {
  // Side panel listens via chrome.runtime.onMessage
  chrome.runtime.sendMessage(message).catch(() => {
    // No active listener (side panel might be closed) — safe to ignore
  });
}

// === Offscreen document lifecycle ===
const OFFSCREEN_PATH = "offscreen.html";

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument?.()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ["USER_MEDIA"],     // covers tabCapture + getUserMedia
    justification: "Capture Meet tab audio + microphone, stream PCM to backend for STT.",
  });
  console.log("[Karpo BG] offscreen document created");
}

async function closeOffscreen() {
  try {
    if (await chrome.offscreen.hasDocument?.()) {
      await chrome.offscreen.closeDocument();
    }
  } catch (e) {
    console.warn("[Karpo BG] closeOffscreen:", e);
  }
}

async function getActiveMeetTabId() {
  // Prefer current active tab if it's Meet, else find any Meet tab.
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (active?.url?.includes("meet.google.com")) return active.id;
  const meets = await chrome.tabs.query({ url: "https://meet.google.com/*" });
  return meets[0]?.id;
}

async function startTabAudioCapture(sessionId, backendUrl) {
  // We no longer call chrome.tabCapture.getMediaStreamId — it requires
  // activeTab grant on the Meet tab, which side-panel button clicks don't
  // produce reliably. Instead the offscreen page uses getDisplayMedia() and
  // the user picks the Meet tab from Chrome's native share picker.
  await ensureOffscreen();
  return await chrome.runtime.sendMessage({
    target: "offscreen",
    action: "start_tab",
    sessionId,
    backendUrl,
  });
}

async function startMicAudioCapture(sessionId, backendUrl) {
  await ensureOffscreen();
  return await chrome.runtime.sendMessage({
    target: "offscreen",
    action: "start_mic",
    sessionId,
    backendUrl,
  });
}

async function stopAudio(role /* "interviewer" | "interviewee" | undefined */) {
  try {
    if (role) {
      return await chrome.runtime.sendMessage({ target: "offscreen", action: "stop", role });
    }
    return await chrome.runtime.sendMessage({ target: "offscreen", action: "stop_all" });
  } catch (e) {
    console.warn("[Karpo BG] stopAudio failed:", e);
  }
}

// === Message routing from side panel ===
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target === "offscreen") return false; // not for us

  if (msg.type === "connect_session" && msg.sessionId) {
    connectWebSocket(msg.sessionId);
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "disconnect_session") {
    if (activeWS) { try { activeWS.close(); } catch {} }
    activeWS = null;
    currentSessionId = null;
    sendResponse({ ok: true });
    return false;
  }
  if (msg.type === "get_status") {
    sendResponse({
      connected: activeWS && activeWS.readyState === WebSocket.OPEN,
      sessionId: currentSessionId,
    });
    return false;
  }
  if (msg.type === "start_audio") {
    (async () => {
      try {
        const { sessionId, backendUrl, captureTab = true, captureMic = true } = msg;
        if (captureTab) await startTabAudioCapture(sessionId, backendUrl);
        if (captureMic) await startMicAudioCapture(sessionId, backendUrl);
        sendResponse({ ok: true });
      } catch (e) {
        console.error("[Karpo BG] start_audio failed:", e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;  // async
  }
  if (msg.type === "stop_audio") {
    (async () => {
      await stopAudio(msg.role);
      // If both roles stopped, close the offscreen doc to save memory
      if (!msg.role) await closeOffscreen();
      sendResponse({ ok: true });
    })();
    return true;
  }
  if (msg.event === "audio_state") {
    // Forwarded from offscreen → broadcast to side panel
    broadcastToSidePanel(msg);
    return false;
  }
  return false;
});

// === Listen for Meet tab events (for future audio capture) ===
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url?.includes("meet.google.com")) {
    console.log("[Karpo BG] Meet tab ready:", tabId);
    broadcastToSidePanel({
      event: "meet_tab_detected",
      payload: { tabId, url: tab.url },
    });
  }
});
