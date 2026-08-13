importScripts("utils/classifier.js");

const ALARM_NAME = "focusSessionExpiry";
const POST_LOAD_DELAY_MS = 10_000;

const DEFAULT_WHITELIST = [
  "google.com",
  "github.com",
  "stackoverflow.com",
  "developer.mozilla.org",
  "chrome.google.com",
  "chromewebstore.google.com",
  "localhost",
  "127.0.0.1"
];

// -----------------------------------------------------------------------
// Session state helpers
// -----------------------------------------------------------------------

async function getSession() {
  const { focusSession } = await chrome.storage.local.get("focusSession");
  return focusSession || null;
}

async function isFocusActive() {
  const session = await getSession();
  return !!session && Date.now() < session.endTime;
}

async function getWhitelist() {
  const { whitelist } = await chrome.storage.local.get("whitelist");
  return Array.isArray(whitelist) ? whitelist : DEFAULT_WHITELIST;
}

function hostnameFromUrl(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isWhitelisted(url, whitelist) {
  const hostname = hostnameFromUrl(url);
  if (!hostname) return true; // chrome://, file://, etc. — never touch
  return whitelist.some(
    (entry) => hostname === entry || hostname.endsWith(`.${entry}`)
  );
}

// -----------------------------------------------------------------------
// Session lifecycle
// -----------------------------------------------------------------------

async function startFocusSession(durationMinutes) {
  const existing = await getSession();
  if (existing && Date.now() < existing.endTime) {
    // Tamper prevention: an active session cannot be restarted/overwritten.
    return existing;
  }

  const startTime = Date.now();
  const endTime = startTime + durationMinutes * 60_000;
  const session = { startTime, endTime, durationMinutes, active: true };

  await chrome.storage.local.set({ focusSession: session });
  await chrome.alarms.create(ALARM_NAME, { when: endTime });

  return session;
}

async function endFocusSession() {
  await chrome.storage.local.set({
    focusSession: null
  });
  await chrome.alarms.clear(ALARM_NAME);
}

const EVAL_ALARM_PREFIX = "evalTab-";

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === ALARM_NAME) {
    await endFocusSession();
    return;
  }

  if (alarm.name.startsWith(EVAL_ALARM_PREFIX)) {
    const tabId = Number(alarm.name.slice(EVAL_ALARM_PREFIX.length));
    evaluateTab(tabId).catch((err) =>
      console.warn("[FocusMode] evaluateTab failed:", err)
    );
  }
});

// Recreate the alarm on browser/service-worker restart if a session is
// mid-flight, in case the alarm itself didn't survive.
chrome.runtime.onStartup.addListener(async () => {
  const session = await getSession();
  if (session && Date.now() < session.endTime) {
    await chrome.alarms.create(ALARM_NAME, { when: session.endTime });
  } else if (session) {
    await endFocusSession();
  }
});

// -----------------------------------------------------------------------
// Messaging with the popup (with tamper prevention on stop requests)
// -----------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case "START_SESSION": {
        const session = await startFocusSession(message.durationMinutes);
        sendResponse({ ok: true, session });
        break;
      }
      case "GET_SESSION": {
        const session = await getSession();
        sendResponse({ ok: true, session });
        break;
      }
      case "STOP_SESSION": {
        // Tamper prevention: refuse to stop an active, un-expired session.
        const session = await getSession();
        if (session && Date.now() < session.endTime) {
          sendResponse({
            ok: false,
            error: "Focus session is locked until it expires."
          });
          break;
        }
        await endFocusSession();
        sendResponse({ ok: true });
        break;
      }
      default:
        sendResponse({ ok: false, error: "Unknown message type." });
    }
  })();
  return true; // keep the message channel open for the async response
});

// -----------------------------------------------------------------------
// Tab classification pipeline
// -----------------------------------------------------------------------

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;

  console.log(
    `[FocusMode] tab ${tabId} finished loading ("${tab.title}"), scheduling check in ${POST_LOAD_DELAY_MS}ms`
  );

  // Use chrome.alarms instead of setTimeout: MV3 service workers can be
  // terminated after ~30s idle, which would silently cancel a pending
  // setTimeout before it ever fires. An alarm survives that and wakes the
  // service worker back up to run the check.
  chrome.alarms.create(`${EVAL_ALARM_PREFIX}${tabId}`, {
    when: Date.now() + POST_LOAD_DELAY_MS
  });
});

async function evaluateTab(tabId) {
  console.log(`[FocusMode] evaluateTab(${tabId}) firing`);

  // Re-check focus mode is still active after the delay.
  const active = await isFocusActive();
  console.log(`[FocusMode] focus session active? ${active}`);
  if (!active) return;

  // Re-check the tab still exists after the delay.
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    console.log(`[FocusMode] tab ${tabId} no longer exists, skipping`);
    return; // tab was closed/navigated away during the delay
  }

  console.log(`[FocusMode] evaluating tab ${tabId}: url="${tab.url}" title="${tab.title}"`);

  if (!tab.url || !tab.title) {
    console.log(`[FocusMode] tab ${tabId} missing url/title, skipping`);
    return;
  }
  if (self.FocusModeClassifier.isPlaceholderTitle(tab.title)) {
    console.log(`[FocusMode] tab ${tabId} has placeholder title, skipping`);
    return;
  }

  const whitelist = await getWhitelist();
  if (isWhitelisted(tab.url, whitelist)) {
    console.log(`[FocusMode] tab ${tabId} is whitelisted, skipping`);
    return;
  }

  const isDistraction = await self.FocusModeClassifier.classifyTitle(
    tab.title
  );
  console.log(`[FocusMode] tab ${tabId} classified as ${isDistraction ? "DISTRACTION" : "WORK"}`);

  if (isDistraction) {
    try {
      await chrome.tabs.remove(tabId);
      console.log(`[FocusMode] closed tab ${tabId}`);
    } catch (err) {
      console.log(`[FocusMode] failed to close tab ${tabId}:`, err);
    }
  }
}
