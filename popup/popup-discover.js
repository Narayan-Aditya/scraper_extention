// Side panel logic for the Instagram discovery mode.
//
// Wrapped in an IIFE for the same reason popup-profiles.js is: popup.js runs in this same
// page and owns a pile of top-level names, so keeping everything private here means no two
// features can clobber each other's globals. The mode switcher itself still lives in
// popup-profiles.js — this file only draws its own tab dot.

(function () {
  const seedsEl = document.getElementById("dcSeeds");
  const excludesEl = document.getElementById("dcExcludes");
  const depthEl = document.getElementById("dcDepth");
  const maxCandidatesEl = document.getElementById("dcMaxCandidates");
  const minFollowersEl = document.getElementById("dcMinFollowers");
  const maxFollowersEl = document.getElementById("dcMaxFollowers");
  const stepDelayEl = document.getElementById("dcStepDelay");
  const batchDelayEl = document.getElementById("dcBatchDelay");
  const enrichEl = document.getElementById("dcEnrich");
  const delayWarningEl = document.getElementById("dcDelayWarning");
  const startBtn = document.getElementById("dcStartBtn");
  const stopBtn = document.getElementById("dcStopBtn");
  const resumeBtn = document.getElementById("dcResumeBtn");
  const pauseBanner = document.getElementById("dcPauseBanner");
  const pauseDetailEl = document.getElementById("dcPauseDetail");
  const statusLineEl = document.getElementById("dcStatusLine");
  const totalsLineEl = document.getElementById("dcTotalsLine");
  const topEl = document.getElementById("dcTop");
  const logEl = document.getElementById("dcLog");
  const downloadBtn = document.getElementById("dcDownloadBtn");
  const copyBtn = document.getElementById("dcCopyBtn");
  const resetBtn = document.getElementById("dcResetBtn");
  const discoverDot = document.getElementById("discoverModeDot");

  let seedsEdited = false;
  let settingsEdited = false;
  let countdownTimer = null;
  let lastState = null;

  // ------------------------------------------------------------------------- rendering

  const STATUS_LABELS = {
    idle: "Idle",
    stopped: "Stopped",
    done: "Done",
    paused: "Paused — dhyan chahiye",
  };

  const PHASE_LABELS = {
    discovering: "naye account dhoondh rahe hain",
    enriching: "candidates ki detail nikaal rahe hain",
    downloading: "file save ho rahi hai",
  };

  function statusText(state) {
    const totals = state.totals || {};
    if (state.status === "running") {
      const phase = PHASE_LABELS[state.phase] || "chal raha hai";
      return "Task " + (totals.tasksDone || 0) + "/" + (totals.tasksPlanned || 0) + " — " + phase;
    }
    if (state.status === "waiting_delay") {
      const left = (state.queue || []).length;
      return "Ruke hue — " + left + " task baaki";
    }
    return STATUS_LABELS[state.status] || state.status;
  }

  function formatFollowers(value) {
    if (typeof value !== "number") return "?";
    if (value >= 1000000) return (value / 1000000).toFixed(1).replace(/\.0$/, "") + "M";
    if (value >= 1000) return Math.round(value / 1000) + "K";
    return String(value);
  }

  // The top of the ranked list, so the panel shows what the run is actually producing
  // rather than only a counter. Same styling as the other modes' completed lists.
  function renderTop(state) {
    const rows = Object.values(state.candidates || {})
      .filter((row) => row.keep)
      .sort((a, b) => {
        const left = a.score == null ? -1 : a.score;
        const right = b.score == null ? -1 : b.score;
        if (right !== left) return right - left;
        return (b.followers || 0) - (a.followers || 0);
      })
      .slice(0, 10);

    topEl.classList.toggle("hidden", !rows.length);
    topEl.innerHTML = "";
    for (const row of rows) {
      const li = document.createElement("li");
      // An unrated candidate is not a bad one — it is one nothing could be measured about,
      // so it gets its own colour rather than being drawn as a low score.
      li.className = row.score == null ? "warn" : row.score >= 70 ? "ok" : "";
      li.textContent =
        (row.score == null ? "?" : row.score) +
        " · @" +
        row.handle +
        " · " +
        formatFollowers(row.followers) +
        (row.category ? " · " + row.category : "");
      topEl.appendChild(li);
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

    // Only tick while a cool-down is actually counting down.
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
    // "Stopped" is resumable too — the frontier survived, so offer Resume rather than
    // making the user re-walk from the seeds.
    const pending = (state.queue || []).length + (state.activeBatch || []).length;
    const resumable = paused || (state.status === "stopped" && pending > 0);

    startBtn.disabled = running;
    stopBtn.classList.toggle("hidden", !running);
    pauseBanner.classList.toggle("hidden", !resumable);
    if (resumable) {
      pauseDetailEl.textContent = state.lastEvent || "";
      renderResume(state);
    }

    statusLineEl.textContent = statusText(state);
    const totals = state.totals || {};
    totalsLineEl.textContent =
      "Tasks: " +
      (totals.tasksDone || 0) +
      "/" +
      (totals.tasksPlanned || 0) +
      " · candidates: " +
      (totals.candidates || 0) +
      " · creator-jaise: " +
      (totals.kept || 0);

    renderTop(state);

    logEl.innerHTML = "";
    (state.log || [])
      .slice(-20)
      .reverse()
      .forEach((entry) => {
        const li = document.createElement("li");
        li.textContent = entry;
        logEl.appendChild(li);
      });

    const hasResults = (totals.candidates || 0) > 0;
    downloadBtn.disabled = !hasResults;
    copyBtn.disabled = !(totals.kept || 0);

    // Same guard the other modes use: never overwrite what the user is mid-way typing.
    if (!seedsEdited && state.seeds && state.seeds.length) {
      seedsEl.value = state.seeds.join("\n");
    }
    if (!settingsEdited) {
      if (state.maxDepth != null) depthEl.value = state.maxDepth;
      if (state.maxCandidates) maxCandidatesEl.value = state.maxCandidates;
      if (state.minFollowers != null) minFollowersEl.value = state.minFollowers;
      if (state.maxFollowers) maxFollowersEl.value = state.maxFollowers;
      if (state.stepDelaySec) stepDelayEl.value = state.stepDelaySec;
      if (state.batchDelaySec) batchDelayEl.value = state.batchDelaySec;
      enrichEl.checked = state.enrich !== false;
    }

    renderModeDot(state.status);
  }

  // Mirrors renderModeDot() in popup-profiles.js, which owns the switcher itself.
  function renderModeDot(status) {
    const active = status === "running" || status === "waiting_delay" || status === "paused";
    discoverDot.classList.toggle("hidden", !active);
    discoverDot.classList.toggle("paused", status === "paused");
  }

  // --------------------------------------------------------------------------- actions

  function send(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  function lines(text) {
    return String(text || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  seedsEl.addEventListener("input", () => {
    seedsEdited = true;
  });

  excludesEl.addEventListener("input", () => {
    seedsEdited = true;
  });

  stepDelayEl.addEventListener("input", () => {
    settingsEdited = true;
    delayWarningEl.classList.toggle("hidden", Number(stepDelayEl.value) >= 4);
  });

  for (const el of [depthEl, maxCandidatesEl, minFollowersEl, maxFollowersEl, batchDelayEl, enrichEl]) {
    el.addEventListener("input", () => {
      settingsEdited = true;
    });
  }

  startBtn.addEventListener("click", async () => {
    const seeds = lines(seedsEl.value);
    if (!seeds.length) {
      alert("Kam se kam ek seed daalo — search phrase, @handle ya #tag.");
      return;
    }

    const minFollowers = Math.max(0, Number(minFollowersEl.value) || 0);
    const maxFollowers = Number(maxFollowersEl.value) || 1000000;
    if (maxFollowers <= minFollowers) {
      alert("Max followers, min followers se zyada hona chahiye.");
      return;
    }

    seedsEdited = false;
    settingsEdited = false;

    render(
      await send({
        type: "DISCOVER_START",
        seeds,
        excludes: lines(excludesEl.value),
        maxDepth: Number(depthEl.value),
        maxCandidates: Number(maxCandidatesEl.value),
        minFollowers,
        maxFollowers,
        stepDelaySec: Number(stepDelayEl.value),
        batchDelaySec: Number(batchDelayEl.value),
        enrich: enrichEl.checked,
      })
    );
  });

  stopBtn.addEventListener("click", async () => {
    render(await send({ type: "DISCOVER_STOP" }));
  });

  resumeBtn.addEventListener("click", async () => {
    render(await send({ type: "DISCOVER_RESUME" }));
  });

  downloadBtn.addEventListener("click", async () => {
    render(await send({ type: "DISCOVER_DOWNLOAD" }));
  });

  copyBtn.addEventListener("click", async () => {
    const state = lastState || (await send({ type: "DISCOVER_GET_STATE" }));
    const handles = Object.values(state.candidates || {})
      .filter((row) => row.keep)
      .sort((a, b) => (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score))
      .map((row) => "@" + row.handle);

    if (!handles.length) return;
    try {
      await navigator.clipboard.writeText(handles.join("\n"));
      copyBtn.textContent = handles.length + " copy ho gaye";
    } catch (e) {
      // Clipboard can be refused when the panel does not have focus; say so instead of
      // failing silently.
      copyBtn.textContent = "Copy nahi hua";
    }
    setTimeout(() => {
      copyBtn.textContent = "Handles copy";
    }, 2000);
  });

  resetBtn.addEventListener("click", async () => {
    const proceed = confirm(
      "Discovery run ka saara collected data clear ho jayega (download ki hui file safe hai). Reset karein?"
    );
    if (!proceed) return;
    const state = await send({ type: "DISCOVER_RESET" });
    seedsEdited = false;
    settingsEdited = false;
    seedsEl.value = "";
    excludesEl.value = "";
    depthEl.value = 2;
    maxCandidatesEl.value = 500;
    minFollowersEl.value = 1000;
    maxFollowersEl.value = 1000000;
    stepDelayEl.value = 4;
    batchDelayEl.value = 10;
    enrichEl.checked = true;
    delayWarningEl.classList.add("hidden");
    render(state);
  });

  // ---------------------------------------------------------------------------- wiring

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.discoverRunState) {
      render(changes.discoverRunState.newValue);
    }
  });

  (async function init() {
    render(await send({ type: "DISCOVER_GET_STATE" }));
  })();
})();
