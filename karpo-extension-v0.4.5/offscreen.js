/**
 * Karpo Audio Capture — Offscreen Document
 *
 * Lives outside the service worker so it can use the Web Audio API & MediaStreams.
 *
 * Roles:
 *   - "interviewee": tab audio (remote Meet participants), via tabCapture stream id
 *   - "interviewer": local microphone, via getUserMedia
 *
 * Each role has:
 *   1. A MediaStream
 *   2. An AudioContext + PCMWorklet that emits Int16 mono 16kHz frames
 *   3. A WebSocket to ws://<backend>/ws/audio/<sessionId>/<role>
 *
 * Tab audio playback: tabCapture mutes the original tab by default. We re-route
 * the captured stream to an AudioContext destination so the interviewer can
 * still hear the conversation.
 */

const PIPELINES = {};   // role → { ctx, source, node, stream, ws, statePoll }

function log(...args) {
  console.log("[Karpo Offscreen]", ...args);
}

function postBack(payload) {
  // Only the background SW listens.
  chrome.runtime.sendMessage(payload).catch(() => {});
}

function buildWsUrl(backendUrl, sessionId, role) {
  const base = (backendUrl || "http://localhost:8000").replace(/^http/, "ws").replace(/\/$/, "");
  return `${base}/ws/audio/${encodeURIComponent(sessionId)}/${role}`;
}

async function buildPipeline({ role, stream, sessionId, backendUrl, playback }) {
  // AudioContext sample rate is platform-dependent; worklet handles resampling.
  const ctx = new AudioContext();
  await ctx.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));

  const source = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "karpo-pcm-worklet", {
    numberOfInputs: 1,
    numberOfOutputs: 0,
  });
  source.connect(node);

  // If this is the tab-capture stream, also pipe to speakers so the user
  // can still hear the call. Microphone NEVER gets piped (echo).
  if (playback) {
    const passthroughGain = ctx.createGain();
    passthroughGain.gain.value = 1.0;
    source.connect(passthroughGain).connect(ctx.destination);
  }

  // Open backend WS
  const wsUrl = buildWsUrl(backendUrl, sessionId, role);
  const ws = new WebSocket(wsUrl);
  ws.binaryType = "arraybuffer";

  let totalBytes = 0;
  let connected = false;

  ws.onopen = () => {
    connected = true;
    log(`WS open role=${role}`);
    postBack({ event: "audio_state", payload: { role, state: "streaming" } });
  };
  ws.onclose = () => {
    connected = false;
    log(`WS close role=${role} (sent ${totalBytes} bytes)`);
    postBack({ event: "audio_state", payload: { role, state: "stopped", bytes: totalBytes } });
  };
  ws.onerror = (e) => {
    log(`WS error role=${role}`, e);
    postBack({ event: "audio_state", payload: { role, state: "error" } });
  };
  ws.onmessage = (m) => {
    // Backend doesn't currently push back on this socket; sessions WS is the channel.
    log(`WS msg role=${role}`, m.data);
  };

  // Pipe PCM frames from the worklet → WS
  node.port.onmessage = (evt) => {
    if (!connected) return;
    const buffer = evt.data; // ArrayBuffer of Int16
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(buffer);
      totalBytes += buffer.byteLength;
    }
  };

  PIPELINES[role] = { ctx, source, node, stream, ws, totalBytes: () => totalBytes };
  postBack({ event: "audio_state", payload: { role, state: "starting" } });
}

async function stopPipeline(role) {
  const p = PIPELINES[role];
  if (!p) return;
  try { p.node.disconnect(); } catch {}
  try { p.source.disconnect(); } catch {}
  try { p.stream.getTracks().forEach((t) => t.stop()); } catch {}
  try {
    if (p.ws.readyState === WebSocket.OPEN) p.ws.send("stop");
    p.ws.close();
  } catch {}
  try { await p.ctx.close(); } catch {}
  delete PIPELINES[role];
  log(`stopped pipeline role=${role}`);
}

async function startTabCapture({ sessionId, backendUrl }) {
  if (PIPELINES.interviewee) {
    await stopPipeline("interviewee");
  }
  log("requesting display media (user picks Meet tab + 'share tab audio')");
  // Use the standard Web API instead of chrome.tabCapture — this avoids the
  // activeTab quirk where side-panel button clicks don't grant tabCapture.
  // The browser shows its native picker; user must select the Meet tab AND
  // check "Also share tab audio".
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: true,                  // required by spec, we ignore the video track
    audio: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      sampleRate: 16000,
    },
    // Hint: prefer tabs in the picker (Chrome-specific hint, ignored elsewhere)
    selfBrowserSurface: "exclude",
    surfaceSwitching: "exclude",
    systemAudio: "exclude",
  });

  // Verify we actually got an audio track — if user shared without "tab audio",
  // there will be no audio track and we should abort with a clear error.
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    stream.getTracks().forEach((t) => t.stop());
    throw new Error(
      "No audio shared. You must check 'Also share tab audio' in the share dialog."
    );
  }
  // Stop the video track — we only need audio. Saves CPU and avoids the
  // "Chrome is sharing this tab" banner from being more intrusive.
  stream.getVideoTracks().forEach((t) => t.stop());

  // Build a new audio-only MediaStream for the pipeline.
  const audioStream = new MediaStream(audioTracks);

  await buildPipeline({
    role: "interviewee",
    stream: audioStream,
    sessionId,
    backendUrl,
    playback: true,    // keep audio audible to interviewer
  });
}

async function startMicCapture({ sessionId, backendUrl }) {
  if (PIPELINES.interviewer) {
    await stopPipeline("interviewer");
  }
  log("requesting microphone");
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    video: false,
  });
  await buildPipeline({
    role: "interviewer",
    stream,
    sessionId,
    backendUrl,
    playback: false,
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.target !== "offscreen") return false;

  (async () => {
    try {
      if (msg.action === "start_tab") {
        await startTabCapture(msg);
        sendResponse({ ok: true });
      } else if (msg.action === "start_mic") {
        await startMicCapture(msg);
        sendResponse({ ok: true });
      } else if (msg.action === "stop") {
        await stopPipeline(msg.role);
        sendResponse({ ok: true });
      } else if (msg.action === "stop_all") {
        await stopPipeline("interviewer");
        await stopPipeline("interviewee");
        sendResponse({ ok: true });
      } else if (msg.action === "status") {
        sendResponse({
          ok: true,
          roles: Object.keys(PIPELINES),
        });
      } else {
        sendResponse({ ok: false, error: "unknown action" });
      }
    } catch (err) {
      log("action failed:", msg.action, err);
      sendResponse({ ok: false, error: err.message || String(err) });
    }
  })();
  return true; // async sendResponse
});

log("ready");
