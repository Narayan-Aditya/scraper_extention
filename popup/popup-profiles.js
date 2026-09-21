// Side panel logic for the Instagram profile exporter, plus the mode switcher.
//
// Wrapped in an IIFE: keeps all globals scoped and safe.

(function () {
  const accountsEl = document.getElementById("igAccounts");
  const fileInputEl = document.getElementById("igFileInput");
  const uploadBtn = document.getElementById("igUploadBtn");
  const fileLoadedBadge = document.getElementById("igFileLoadedBadge");
  const skipHistoryEl = document.getElementById("igSkipHistory");
  const historyCountEl = document.getElementById("igHistoryCount");
  const clearHistoryBtn = document.getElementById("igClearHistoryBtn");
  const microBreaksEl = document.getElementById("igMicroBreaks");

  const pageDelayEl = document.getElementById("igPageDelay");
  const accountDelayEl = document.getElementById("igAccountDelay");
  const startDateEl = document.getElementById("igStartDate");
  const delayWarningEl = document.getElementById("igDelayWarning");
  const startBtn = document.getElementById("igStartBtn");
  const stopBtn = document.getElementById("igStopBtn");
  const resumeBtn = document.getElementById("igResumeBtn");
  const pauseBanner = document.getElementById("igPauseBanner");
  const pauseDetailEl = document.getElementById("igPauseDetail");
  const statusLineEl = document.getElementById("igStatusLine");
  const totalsLineEl = document.getElementById("igTotalsLine");
  const completedEl = document.getElementById("igCompleted");
  const logEl = document.getElementById("igLog");
  const downloadBtn = document.getElementById("igDownloadBtn");
  const resetBtn = document.getElementById("igResetBtn");

  // Mode switcher definitions
  const MODES = ["profiles", "discover", "brief", "youtube"];
  const modeButtons = {
    profiles: document.getElementById("modeProfilesBtn"),
    discover: document.getElementById("modeDiscoverBtn"),
    brief: document.getElementById("modeBriefBtn"),
    youtube: document.getElementById("modeYoutubeBtn"),
  };
  const profileDot = document.getElementById("profileModeDot");
  const discoverDot = document.getElementById("discoverModeDot");
  const briefDot = document.getElementById("briefModeDot");
  const youtubeDot = document.getElementById("youtubeModeDot");

  let accountsEdited = false;
  let settingsEdited = false;
  let countdownTimer = null;
  let lastState = null;
  let fileAccountsList = null;

  // --------------------------------------------------------------------- input parsing

  const IGNORED_HANDLES = new Set([
    "p", "reel", "reels", "stories", "explore", "tv", "direct",
    "accounts", "about", "developer", "legal", "terms", "privacy", "help",
  ]);
  const HANDLE_RE = /^[a-z0-9._]{1,30}$/;

  function normalizeHandle(raw) {
    if (typeof raw !== "string") return null;
    let value = raw.trim();
    if (!value) return null;
    if (value.startsWith("@")) value = value.slice(1);

    if (/^https?:\/\//i.test(value) || value.toLowerCase().includes("instagram.com")) {
      let url;
      try {
        url = new URL(/^https?:\/\//i.test(value) ? value : "https://" + value);
      } catch (e) {
        return null;
      }
      const host = url.hostname.toLowerCase().replace(/^www\./, "");
      if (host !== "instagram.com" && host !== "instagr.am") return null;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 1) return null;
      try {
        value = decodeURIComponent(parts[0]);
      } catch (e) {
        value = parts[0];
      }
    }

    value = value.toLowerCase();
    if (IGNORED_HANDLES.has(value) || !HANDLE_RE.test(value)) return null;
    return value;
  }

  function parseAccounts(text) {
    const seen = new Set();
    const accounts = [];
    let skipped = 0;
    for (const raw of text.split(/[\n,]+/)) {
      if (!raw.trim()) continue;
      const handle = normalizeHandle(raw);
      if (!handle) {
        skipped += 1;
        continue;
      }
      if (seen.has(handle)) continue;
      seen.add(handle);
      accounts.push(handle);
    }
    return { accounts, skipped };
  }

  function parseStartDate(raw) {
    const value = String(raw == null ? "" : raw).trim();
    if (!value) return null; // null = no date cutoff

    const ddmmyyyy = value.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
    if (ddmmyyyy) {
      const day = parseInt(ddmmyyyy[1], 10);
      const month = parseInt(ddmmyyyy[2], 10) - 1;
      const year = parseInt(ddmmyyyy[3], 10);
      const d = new Date(year, month, day);
      if (!isNaN(d.getTime())) {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, "0");
        const dt = String(d.getDate()).padStart(2, "0");
        return `${y}-${m}-${dt}`;
      }
    }

    const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (iso) {
      const d = new Date(value + "T00:00:00");
      if (!isNaN(d.getTime())) return value;
    }

    const d = new Date(value);
    if (!isNaN(d.getTime())) {
      const y = d.getFullYear();
      const m = String(d.getMonth() + 1).padStart(2, "0");
      const dt = String(d.getDate()).padStart(2, "0");
      return `${y}-${m}-${dt}`;
    }

    return undefined;
  }

  // ------------------------------------------------------------------------- rendering

  const STATUS_LABELS = {
    idle: "Idle",
    stopped: "Stopped",
    done: "Done",
    paused: "Paused — dhyan chahiye",
  };

  const PHASE_LABELS = {
    resolving: "profile nikaal rahe hain",
    paginating: "posts nikaal rahe hain",
    banking: "bank ho raha hai",
    downloading: "ZIP ban rahi hai",
    micro_break: "☕ safety coffee break",
  };

  function statusText(state) {
    const total = state.accounts ? state.accounts.length : 0;
    const position = Math.min(state.accountIndex + 1, total || 1);
    const handle = state.current && state.current.handle ? "@" + state.current.handle : "-";

    if (state.status === "running") {
      const phase = PHASE_LABELS[state.phase] || "chal raha hai";
      const pages =
        state.phase === "paginating" && state.current.pagesFetched
          ? ", page " + state.current.pagesFetched
          : "";
      return "Account " + position + "/" + total + " " + handle + " — " + phase + pages;
    }
    if (state.status === "waiting_delay") {
      const nextHandle = state.accounts[state.accountIndex];
      if (state.phase === "micro_break") {
        return "☕ Coffee Break (Safety Rest) — agla: @" + (nextHandle || "-");
      }
      return "Ruke hue (" + (state.accountDelaySec || 4) + "s) — agla: @" + (nextHandle || "-");
    }
    return STATUS_LABELS[state.status] || state.status;
  }

  function renderCompleted(state) {
    const entries = state.completed || [];
    completedEl.classList.toggle("hidden", !entries.length);
    completedEl.innerHTML = "";
    for (const entry of entries) {
      const li = document.createElement("li");
      if (entry.complete) {
        li.className = "ok";
        li.textContent = "✓ @" + entry.handle + " (" + entry.postCount + " posts)";
      } else if (entry.reason === "not_found") {
        li.className = "bad";
        li.textContent = "✗ @" + entry.handle + " (nahi mila)";
      } else {
        li.className = "warn";
        li.textContent =
          "⚠ @" + entry.handle + " (" + (entry.reason || "adhoora") + ", " + entry.postCount + " posts)";
      }
      completedEl.appendChild(li);
    }
  }

  function secondsLeft(state) {
    if (state.pauseReason !== "rate_limit" || !state.backoffUntilTs) return 0;
    return Math.max(0, Math.ceil((state.backoffUntilTs - Date.now()) / 1000));
  }

  function renderResume(state) {
    const wait = secondsLeft(state);
    resumeBtn.disabled = wait > 0;
    resumeBtn.textContent = wait > 0 ? "Resume (" + wait + "s)" : "Resume";

    if (wait > 0 && !countdownTimer) {
      countdownTimer = setInterval(() => {
        if (lastState) renderResume(lastState);
      }, 1000);
    } else if (wait <= 0 && countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function render(state) {
    if (!state) return;
    lastState = state;

    const running = state.status === "running" || state.status === "waiting_delay";
    const paused = state.status === "paused";
    const resumable = paused || (state.status === "stopped" && !!state.current.handle);

    startBtn.disabled = running;
    stopBtn.classList.toggle("hidden", !running);
    pauseBanner.classList.toggle("hidden", !resumable);
    if (resumable) {
      pauseDetailEl.textContent = state.lastEvent || "";
      renderResume(state);
    }

    statusLineEl.textContent = statusText(state);
    totalsLineEl.textContent =
      "Accounts: " +
      (state.totals ? state.totals.accountsDone : 0) +
      "/" +
      (state.accounts ? state.accounts.length : 0) +
      " · posts: " +
      (state.totals ? state.totals.postsFetched : 0) +
      (state.startDate ? " · from " + state.startDate : "");

    if (historyCountEl) {
      historyCountEl.textContent = (state.historyCount || 0).toLocaleString();
    }

    renderCompleted(state);

    logEl.innerHTML = "";
    (state.log || [])
      .slice(-20)
      .reverse()
      .forEach((entry) => {
        const li = document.createElement("li");
        li.textContent = entry;
        logEl.appendChild(li);
      });

    const hasBanked = !!(state.completedFiles && state.completedFiles.length > 0);
    const hasCurrent = !!(state.current && state.current.profile);
    downloadBtn.disabled = !hasBanked && !hasCurrent;
    const bankedCount = (state.completedFiles ? state.completedFiles.length : 0) + (hasCurrent && !hasBanked ? 1 : 0);
    downloadBtn.textContent = bankedCount > 0 ? "Download ZIP (" + bankedCount + ")" : "Download ZIP";

    if (!accountsEdited && state.accounts && state.accounts.length) {
      accountsEl.value = state.accounts.join("\n");
    }
    if (!settingsEdited) {
      if (state.pageDelaySec) pageDelayEl.value = state.pageDelaySec;
      if (state.accountDelaySec) accountDelayEl.value = state.accountDelaySec;
      startDateEl.value = state.startDate || "";
    }

    renderModeDot(profileDot, state.status);
  }

  // ---------------------------------------------------------------------- mode switcher

  function applyMode(mode) {
    const active = MODES.includes(mode) ? mode : "profiles";
    for (const name of MODES) {
      document.body.classList.toggle("mode-" + name, name === active);
      if (modeButtons[name]) modeButtons[name].classList.toggle("active", name === active);
    }
  }

  function setMode(mode) {
    applyMode(mode);
    chrome.storage.local.set({ uiMode: mode });
  }

  function renderModeDot(dot, status) {
    if (!dot) return;
    const active = status === "running" || status === "waiting_delay" || status === "paused";
    dot.classList.toggle("hidden", !active);
    dot.classList.toggle("paused", status === "paused");
  }

  for (const name of MODES) {
    if (modeButtons[name]) {
      modeButtons[name].addEventListener("click", () => setMode(name));
    }
  }

  // --------------------------------------------------------------------------- actions

  function send(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  accountsEl.addEventListener("input", () => {
    accountsEdited = true;
    fileAccountsList = null;
    fileLoadedBadge.classList.add("hidden");
  });

  uploadBtn.addEventListener("click", () => {
    fileInputEl.click();
  });

  fileInputEl.addEventListener("change", async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;

    try {
      const text = await file.text();
      const { accounts, skipped } = parseAccounts(text);
      if (!accounts.length) {
        alert("File me koi valid Instagram handle ya URL nahi mila.");
        return;
      }

      fileAccountsList = accounts;
      accountsEdited = true;
      fileLoadedBadge.textContent = `${accounts.length.toLocaleString()} handles loaded`;
      fileLoadedBadge.classList.remove("hidden");

      // Show preview of first 30 in textarea so DOM does not freeze for 14k lines
      const preview = accounts.slice(0, 30).join("\n");
      const moreText = accounts.length > 30 ? `\n...aur ${accounts.length - 30} accounts file se loaded hain.` : "";
      accountsEl.value = preview + moreText;
    } catch (err) {
      alert("File read karne me error: " + (err && err.message ? err.message : String(err)));
    }
  });

  clearHistoryBtn.addEventListener("click", async () => {
    const proceed = confirm("Saved scraped history database clear karni hai?");
    if (!proceed) return;
    const state = await send({ type: "PROFILE_CLEAR_HISTORY" });
    render(state);
  });

  pageDelayEl.addEventListener("input", () => {
    settingsEdited = true;
    delayWarningEl.classList.toggle("hidden", Number(pageDelayEl.value) >= 2);
  });

  accountDelayEl.addEventListener("input", () => {
    settingsEdited = true;
  });

  startDateEl.addEventListener("input", () => {
    settingsEdited = true;
  });

  startBtn.addEventListener("click", async () => {
    let rawAccounts = [];
    if (fileAccountsList && fileAccountsList.length > 0) {
      rawAccounts = fileAccountsList;
    } else {
      const { accounts, skipped } = parseAccounts(accountsEl.value);
      rawAccounts = accounts;
      if (skipped) {
        const proceed = confirm(
          skipped +
            " line samajh nahi aayi (post/reel link ya galat format) — woh skip ho jayengi.\n\n" +
            accounts.length +
            " account(s) ke saath start karein?"
        );
        if (!proceed) return;
      }
    }

    if (!rawAccounts.length) {
      alert("Kam se kam ek sahi Instagram profile URL ya handle daalo.");
      return;
    }

    const startDate = parseStartDate(startDateEl.value);
    if (startDate === undefined) {
      alert("Start date format samajh nahi aayi. Date picker use karein ya YYYY-MM-DD format daalein.");
      return;
    }

    const pageDelaySec = Math.max(1, Number(pageDelayEl.value) || 2);
    const accountDelaySec = Math.max(2, Number(accountDelayEl.value) || 4);
    const skipHistory = skipHistoryEl ? skipHistoryEl.checked : true;
    const enableMicroBreaks = microBreaksEl ? microBreaksEl.checked : true;

    accountsEdited = false;
    settingsEdited = false;
    fileAccountsList = null;
    fileLoadedBadge.classList.add("hidden");

    render(
      await send({
        type: "PROFILE_START",
        accounts: rawAccounts,
        pageDelaySec,
        accountDelaySec,
        startDate,
        skipHistory,
        enableMicroBreaks,
      })
    );
  });

  stopBtn.addEventListener("click", async () => {
    render(await send({ type: "PROFILE_STOP" }));
  });

  resumeBtn.addEventListener("click", async () => {
    render(await send({ type: "PROFILE_RESUME" }));
  });

  downloadBtn.addEventListener("click", async () => {
    render(await send({ type: "PROFILE_DOWNLOAD_CURRENT" }));
  });

  resetBtn.addEventListener("click", async () => {
    const proceed = confirm(
      "Instagram run ka saara collected data clear ho jayega (jo file download ho chuki hai woh safe hai). Reset karein?"
    );
    if (!proceed) return;
    const state = await send({ type: "PROFILE_RESET" });
    accountsEdited = false;
    settingsEdited = false;
    fileAccountsList = null;
    fileLoadedBadge.classList.add("hidden");
    accountsEl.value = "";
    pageDelayEl.value = 2;
    accountDelayEl.value = 4;
    startDateEl.value = "";
    delayWarningEl.classList.add("hidden");
    render(state);
  });

  // ---------------------------------------------------------------------------- wiring

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.profileRunState) render(changes.profileRunState.newValue);
    if (changes.youtubeRunState && changes.youtubeRunState.newValue) {
      renderModeDot(youtubeDot, changes.youtubeRunState.newValue.status);
    }
    if (changes.discoverRunState && changes.discoverRunState.newValue) {
      renderModeDot(discoverDot, changes.discoverRunState.newValue.status);
    }
    if (changes.briefRunState && changes.briefRunState.newValue) {
      renderModeDot(briefDot, changes.briefRunState.newValue.status);
    }
  });

  (async function init() {
    const stored = await chrome.storage.local.get([
      "uiMode",
      "profileRunState",
      "youtubeRunState",
      "discoverRunState",
      "briefRunState",
    ]);
    const initialMode = MODES.includes(stored.uiMode) ? stored.uiMode : "profiles";
    applyMode(initialMode);
    if (stored.youtubeRunState) renderModeDot(youtubeDot, stored.youtubeRunState.status);
    if (stored.discoverRunState) renderModeDot(discoverDot, stored.discoverRunState.status);
    if (stored.briefRunState) renderModeDot(briefDot, stored.briefRunState.status);
    render(await send({ type: "PROFILE_GET_STATE" }));
  })();
})();
