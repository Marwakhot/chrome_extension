const setupView = document.getElementById("setupView");
const lockedView = document.getElementById("lockedView");
const expiredView = document.getElementById("expiredView");
const durationSelect = document.getElementById("duration");
const customDurationInput = document.getElementById("customDuration");
const startBtn = document.getElementById("startBtn");
const stopBtn = document.getElementById("stopBtn");
const countdownEl = document.getElementById("countdown");

let tickInterval = null;

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function showView(view) {
  for (const el of [setupView, lockedView, expiredView]) {
    el.classList.remove("visible");
  }
  view.classList.add("visible");
}

function formatRemaining(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function stopTicking() {
  if (tickInterval) {
    clearInterval(tickInterval);
    tickInterval = null;
  }
}

async function refresh() {
  const { session } = (await sendMessage({ type: "GET_SESSION" })) || {};

  stopTicking();

  if (session && Date.now() < session.endTime) {
    showView(lockedView);
    const tick = () => {
      const remaining = session.endTime - Date.now();
      if (remaining <= 0) {
        stopTicking();
        refresh();
        return;
      }
      countdownEl.textContent = formatRemaining(remaining);
    };
    tick();
    tickInterval = setInterval(tick, 1000);
  } else if (session) {
    // Session object exists but has expired — background will clear it
    // on its own via the alarm; show a brief "complete" state meanwhile.
    showView(expiredView);
  } else {
    showView(setupView);
  }
}

durationSelect.addEventListener("change", () => {
  const isCustom = durationSelect.value === "custom";
  customDurationInput.classList.toggle("visible", isCustom);
  if (isCustom) customDurationInput.focus();
});

function getSelectedDurationMinutes() {
  if (durationSelect.value === "custom") {
    const value = Math.floor(Number(customDurationInput.value));
    if (!Number.isFinite(value) || value < 1 || value > 1440) return null;
    return value;
  }
  return Number(durationSelect.value);
}

startBtn.addEventListener("click", async () => {
  const durationMinutes = getSelectedDurationMinutes();
  if (durationMinutes === null) {
    customDurationInput.focus();
    customDurationInput.reportValidity?.();
    return;
  }
  startBtn.disabled = true;
  try {
    await sendMessage({ type: "START_SESSION", durationMinutes });
  } finally {
    startBtn.disabled = false;
  }
  refresh();
});

// The stop button is permanently disabled while locked — this handler
// exists only as defense in depth. The background service worker is the
// real enforcement point and will reject any STOP_SESSION message sent
// before endTime.
stopBtn.addEventListener("click", async () => {
  await sendMessage({ type: "STOP_SESSION" });
  refresh();
});

refresh();
