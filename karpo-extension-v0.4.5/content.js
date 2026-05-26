/**
 * Karpo Interview Assistant - Content Script
 *
 * Injected into meet.google.com pages.
 * Currently lightweight: just detects Meet readiness and pings background.
 * Future: detect speaker changes via DOM mutation observer to enrich speaker labels.
 */

(function () {
  if (window.__karpoInjected) return;
  window.__karpoInjected = true;

  console.log("[Karpo CS] Content script loaded on", location.href);

  // Notify background that we're on a Meet page
  chrome.runtime.sendMessage({
    type: "meet_page_ready",
    url: location.href,
  }).catch(() => {});

  // Detect when a call actually starts (presence of the bottom toolbar is a good signal)
  const observer = new MutationObserver(() => {
    const inCall = !!document.querySelector('[data-call-ended]') === false &&
                   !!document.querySelector('[jsname="A5il2e"]'); // bottom toolbar
    if (inCall && !window.__karpoCallStarted) {
      window.__karpoCallStarted = true;
      console.log("[Karpo CS] Call detected as started");
      chrome.runtime.sendMessage({
        type: "meet_call_started",
        url: location.href,
      }).catch(() => {});
      observer.disconnect();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
})();
