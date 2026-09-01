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
  const indiaOnlyEl = document.getElementById("dcIndiaOnly");
  const unattendedEl = document.getElementById("dcUnattended");
  const runHoursEl = document.getElementById("dcRunHours");
  const runHoursRow = document.getElementById("dcRunHoursRow");
  const unattendedHintEl = document.getElementById("dcUnattendedHint");
  const deadlineLineEl = document.getElementById("dcDeadlineLine");
  const copyListEl = document.getElementById("dcCopyList");
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
  let unattendedTimer = null;
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

  // Mirrors inBandDiscoverRows()/indiaInBandDiscoverRows() in background-discover.js.
  // Duplicated rather than shared for the same reason normalizeHandle() is duplicated in
  // popup-profiles.js — the panel is a separate page from the worker and there is no
  // bundler here. The worker stays the authority: all three lists are written into the
  // downloaded file, and the clipboard is only ever a convenience copy of one of them.
  function deliveryRows(state, which) {
    const min = state.minFollowers == null ? 0 : state.minFollowers;
    const max = state.maxFollowers || Infinity;
    const rows = Object.values(state.candidates || {}).filter((row) => row && row.keep);
    if (which === "kept") return rows;
    const inBand = rows.filter(
      (row) =>
        typeof row.followers === "number" && row.followers >= min && row.followers <= max
    );
    return which === "india_band" ? inBand.filter((row) => row.india === "yes") : inBand;
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
        (row.india === "yes" ? " · IN" : "") +
        (row.category ? " · " + row.category : "");
      topEl.appendChild(li);
    }
  }

  function secondsLeft(state) {
    if (state.pauseReason !== "rate_limit" || !state.backoffUntilTs) return 0;
    return Math.max(0, Math.ceil((state.backoffUntilTs - Date.now()) / 1000));
  }

  // The one line that tells a returning user whether the overnight run is still going and
  // how much of its window is left. Also surfaces the auto-resume tally: an unattended run
  // that quietly rode out three rate limits is worth knowing about before starting another.
  function renderDeadline(state) {
    const active =
      state.unattended && state.deadlineTs && state.status !== "done" && state.status !== "idle";
    deadlineLineEl.classList.toggle("hidden", !active);

    if (active) {
      const minsLeft = Math.round((state.deadlineTs - Date.now()) / 60000);
      const left =
        minsLeft >= 60 ? Math.floor(minsLeft / 60) + "h " + (minsLeft % 60) + "m" : minsLeft + "m";
      deadlineLineEl.textContent =
        (minsLeft > 0 ? "Raat bhar mode — " + left + " baaki" : "Raat bhar mode — time poora") +
        (state.autoResumesUsed ? " · " + state.autoResumesUsed + " auto-resume" : "") +
        (state.stallRecoveries ? " · " + state.stallRecoveries + " restart" : "");
    }

    // Nothing else re-renders the panel while a run sits in a long batch delay, so the
    // countdown would freeze without its own tick.
    if (active && !unattendedTimer) {
      unattendedTimer = setInterval(() => {
        if (lastState) render(lastState);
      }, 30000);
    } else if (!active && unattendedTimer) {
      clearInterval(unattendedTimer);
      unattendedTimer = null;
    }
  }

  function syncUnattendedRows() {
    const on = unattendedEl.checked;
    runHoursRow.classList.toggle("hidden", !on);
    unattendedHintEl.classList.toggle("hidden", !on);
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
      (totals.kept || 0) +
      " · band me: " +
      (totals.inBand || 0) +
      " · India: " +
      (totals.indiaInBand || 0);

    renderDeadline(state);
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
    // Tied to the list actually selected, so the button is never live for a list that would
    // copy nothing — an empty India list is a real answer and should look like one.
    copyBtn.disabled = !deliveryRows(state, copyListEl.value).length;

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
      indiaOnlyEl.checked = state.indiaOnly === true;
      unattendedEl.checked = state.unattended === true;
      syncUnattendedRows();
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

  for (const el of [
    depthEl,
    maxCandidatesEl,
    minFollowersEl,
    maxFollowersEl,
    batchDelayEl,
    enrichEl,
    runHoursEl,
  ]) {
    el.addEventListener("input", () => {
      settingsEdited = true;
    });
  }

  unattendedEl.addEventListener("change", () => {
    settingsEdited = true;
    syncUnattendedRows();
  });

  indiaOnlyEl.addEventListener("change", () => {
    settingsEdited = true;
    // The dropdown follows the switch: asking for Indian creators and then copying the
    // all-countries list is never what somebody meant.
    copyListEl.value = indiaOnlyEl.checked ? "india_band" : "band";
    if (lastState) render(lastState);
  });

  copyListEl.addEventListener("change", () => {
    if (lastState) render(lastState);
  });

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

    // The one combination that guarantees a wasted night: both the follower band and the
    // India check need a follower count / bio / city, and only the detail pass fetches
    // those. Without it the run still works, but the two lists it was started for come back
    // empty — better to say so now than at 7am.
    if ((unattendedEl.checked || indiaOnlyEl.checked) && !enrichEl.checked) {
      const proceed = confirm(
        "Detail switch off hai.\n\nUske bina zyadatar candidate ka follower count aur bio " +
          "aata hi nahi, to 'band ke andar' aur 'India' dono list khaali rahengi.\n\n" +
          "Phir bhi chalayein?"
      );
      if (!proceed) return;
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
        indiaOnly: indiaOnlyEl.checked,
        unattended: unattendedEl.checked,
        runHours: Number(runHoursEl.value),
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
    const handles = deliveryRows(state, copyListEl.value)
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
    indiaOnlyEl.checked = false;
    unattendedEl.checked = false;
    runHoursEl.value = 8;
    copyListEl.value = "band";
    syncUnattendedRows();
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
