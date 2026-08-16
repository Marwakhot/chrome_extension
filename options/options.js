const blocklistInput = document.getElementById("blocklistInput");
const blocklistAddBtn = document.getElementById("blocklistAddBtn");
const blocklistItems = document.getElementById("blocklistItems");

const whitelistInput = document.getElementById("whitelistInput");
const whitelistAddBtn = document.getElementById("whitelistAddBtn");
const whitelistItems = document.getElementById("whitelistItems");

function normalizeDomain(raw) {
  let value = raw.trim().toLowerCase();
  if (!value) return null;

  // Allow pasting a full URL, and extract just the hostname.
  if (value.includes("://")) {
    try {
      value = new URL(value).hostname;
    } catch {
      return null;
    }
  } else {
    value = value.split("/")[0];
  }

  value = value.replace(/^www\./, "");
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$|^localhost$/.test(value)) return null;
  return value;
}

async function getList(key) {
  const result = await chrome.storage.local.get(key);
  return Array.isArray(result[key]) ? result[key] : [];
}

async function setList(key, list) {
  await chrome.storage.local.set({ [key]: list });
}

function renderList(listEl, items, storageKey) {
  listEl.innerHTML = "";
  if (items.length === 0) {
    const empty = document.createElement("li");
    empty.className = "empty-note";
    empty.textContent = "Nothing here yet.";
    empty.style.border = "none";
    empty.style.background = "transparent";
    listEl.appendChild(empty);
    return;
  }

  for (const domain of items) {
    const li = document.createElement("li");

    const span = document.createElement("span");
    span.className = "domain";
    span.textContent = domain;

    const removeBtn = document.createElement("button");
    removeBtn.textContent = "✕";
    removeBtn.title = `Remove ${domain}`;
    removeBtn.addEventListener("click", async () => {
      const current = await getList(storageKey);
      await setList(storageKey, current.filter((d) => d !== domain));
      refresh();
    });

    li.appendChild(span);
    li.appendChild(removeBtn);
    listEl.appendChild(li);
  }
}

async function refresh() {
  const [blocklist, whitelist] = await Promise.all([
    getList("customBlocklist"),
    getList("customWhitelist")
  ]);
  renderList(blocklistItems, blocklist, "customBlocklist");
  renderList(whitelistItems, whitelist, "customWhitelist");
}

async function addToList(inputEl, storageKey) {
  const domain = normalizeDomain(inputEl.value);
  if (!domain) {
    inputEl.focus();
    return;
  }
  const current = await getList(storageKey);
  if (!current.includes(domain)) {
    await setList(storageKey, [...current, domain]);
  }
  inputEl.value = "";
  inputEl.focus();
  refresh();
}

blocklistAddBtn.addEventListener("click", () => addToList(blocklistInput, "customBlocklist"));
whitelistAddBtn.addEventListener("click", () => addToList(whitelistInput, "customWhitelist"));

blocklistInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addToList(blocklistInput, "customBlocklist");
});
whitelistInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") addToList(whitelistInput, "customWhitelist");
});

refresh();
