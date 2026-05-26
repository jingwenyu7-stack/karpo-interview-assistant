// mic-grant.js — external script (inline scripts are blocked by MV3 CSP)
const btn = document.getElementById('grant-btn');
const status = document.getElementById('status');

function setStatus(text, cls) {
  status.textContent = text;
  status.className = 'status ' + cls;
}

btn.addEventListener('click', async () => {
  btn.disabled = true;
  setStatus('Requesting microphone… Look for the prompt at the top of this window.', 'pending');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    });
    // immediately stop — we only needed the permission
    stream.getTracks().forEach((t) => t.stop());
    setStatus('✓ Microphone access granted! Closing this window…', 'success');
    try {
      chrome.runtime.sendMessage({ type: 'mic_permission_granted' });
    } catch {}
    setTimeout(() => window.close(), 1200);
  } catch (e) {
    btn.disabled = false;
    setStatus(`✗ ${e.name || 'Error'}: ${e.message || e}`, 'error');
  }
});
