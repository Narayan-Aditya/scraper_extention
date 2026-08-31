// Side panel logic for the campaign-brief mode.
//
// Wrapped in an IIFE like every other panel file: popup.js and the four other feature
// panels share this page's global scope, and none of them may clobber another's names.
//
// The panel does the *reading* of the brief (brief-parse.js) and shows the result as
// editable text before anything runs. The worker re-validates what it is sent and owns
// the run itself — so a parser that guesses wrong costs the user an edit, never a bad
// crawl they could not see coming.

(function () {
  const briefTextEl = document.getElementById("brBriefText");
  const fileEl = document.getElementById("brFile");
  const parseBtn = document.getElementById("brParseBtn");
  const planEl = document.getElementById("brPlan");
  const warningsEl = document.getElementById("brWarnings");
  const seedsEl = document.getElementById("brSeeds");
  const creatorsEl = document.getElementById("brCreators");
  const postsEl = document.getElementById("brPosts");
  const folderEl = document.getElementById("brFolder");
  const minFollowersEl = document.getElementById("brMinFollowers");
  const maxFollowersEl = document.getElementById("brMaxFollowers");
  const depthEl = document.getElementById("brDepth");
  const maxCandidatesEl = document.getElementById("brMaxCandidates");
  const delayEl = document.getElementById("brDelay");
  const startBtn = document.getElementById("brStartBtn");
  const stopBtn = document.getElementById("brStopBtn");
  const resumeBtn = document.getElementById("brResumeBtn");
  const pauseBanner = document.getElementById("brPauseBanner");
  const pauseDetailEl = document.getElementById("brPauseDetail");
  const statusLineEl = document.getElementById("brStatusLine");
  const subStatusEl = document.getElementById("brSubStatus");
  const pickedEl = document.getElementById("brPicked");
  const logEl = document.getElementById("brLog");
  const resetBtn = document.getElementById("brResetBtn");
  const modeDot = document.getElementById("briefModeDot");

  // Files this panel can actually read. Anything else has to be pasted — there is no PDF
  // or .docx parser here, and pretending to read one would produce silent nonsense.
  const READABLE_EXT = /\.(txt|md|markdown|text|csv|json)$/i;

  let plan = null;
  let editedFields = false;
  let lastBrief = null;

  // --------------------------------------------------------------------------- helpers

  function send(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  // Mirrors parsePostLimit() in popup-profiles.js — same rule, same wording, so "MAX"
  // means the same thing in both places.
  function parsePostLimit(raw) {
    const value = String(raw == null ? "" : raw).trim();
    if (!value || value.toUpperCase() === "MAX") return null;
    if (!/^\d+$/.test(value)) return undefined;
    const count = Number(value);
    return count >= 1 ? count : undefined;
  }

  function compact(number) {
    const value = Number(number);
    if (!Number.isFinite(value)) return "?";
    if (value >= 1000000) return (value / 1000000).toFixed(value % 1000000 ? 1 : 0) + "M";
    if (value >= 1000) return (value / 1000).toFixed(value % 1000 ? 1 : 0) + "K";
    return String(value);
  }

  function folderNameFor(brand) {
    const slug = String(brand || "campaign")
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 40);
    return "brief_" + (slug || "campaign") + "_" + new Date().toISOString().slice(0, 10);
  }

  // ---------------------------------------------------------------------- brief reading

  function renderPlan(parsed) {
    planEl.classList.remove("hidden");
    planEl.innerHTML = "";

    const rows = [
      ["Brand", parsed.brand || "—"],
      ["Platform", parsed.platform || "—"],
      ["Niche", parsed.niches.map((niche) => niche.id).join(", ") || "—"],
      ["Cities", parsed.cities.join(", ") || "—"],
      [
        "Followers",
        compact(parsed.minFollowers) + "–" + compact(parsed.maxFollowers) + " (" + parsed.bandSource + ")",
      ],
      ["Creators", parsed.creatorCount == null ? "—" : String(parsed.creatorCount)],
      ["Language", parsed.languages.join(", ") || "—"],
      ["Brand handles", parsed.brandHandles.length ? "@" + parsed.brandHandles.join(", @") : "—"],
    ];
    for (const [label, value] of rows) {
      const line = document.createElement("p");
      const strong = document.createElement("b");
      strong.textContent = label + ": ";
      line.appendChild(strong);
      line.appendChild(document.createTextNode(value));
      planEl.appendChild(line);
    }

    warningsEl.innerHTML = "";
    warningsEl.classList.toggle("hidden", !parsed.warnings.length);
    for (const warning of parsed.warnings) {
      const item = document.createElement("li");
      item.textContent = warning;
      warningsEl.appendChild(item);
    }
  }

  function applyParsed(parsed) {
    plan = parsed;
    renderPlan(parsed);
    seedsEl.value = parsed.seeds.join("\n");
    // Never overwrite numbers the user has already touched — a re-parse after an edit
    // would otherwise quietly undo it.
    if (!editedFields) {
      if (parsed.creatorCount) creatorsEl.value = parsed.creatorCount;
      minFollowersEl.value = parsed.minFollowers;
      maxFollowersEl.value = parsed.maxFollowers;
      folderEl.value = folderNameFor(parsed.brand);
    }
  }

  parseBtn.addEventListener("click", () => {
    const text = briefTextEl.value.trim();
    if (!text) {
      alert("Pehle brief paste karo ya file choose karo.");
      return;
    }
    applyParsed(BriefParse.parseBrief(text));
  });

  fileEl.addEventListener("change", () => {
    const file = fileEl.files && fileEl.files[0];
    if (!file) return;
    if (!READABLE_EXT.test(file.name)) {
      alert(
        "Sirf .txt / .md / .csv / .json padh sakte hain.\n\nPDF ya Word file ka text copy " +
          "karke box me paste kar do — waise hi kaam karega."
      );
      fileEl.value = "";
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      briefTextEl.value = String(reader.result || "");
      applyParsed(BriefParse.parseBrief(briefTextEl.value));
    };
    reader.onerror = () => alert("File padhi nahi ja saki.");
    reader.readAsText(file);
  });

  for (const element of [creatorsEl, postsEl, folderEl, minFollowersEl, maxFollowersEl]) {
    element.addEventListener("input", () => {
      editedFields = true;
    });
  }

  // ------------------------------------------------------------------------- rendering

  const STATUS_LABELS = {
    idle: "Idle",
    stopped: "Stopped",
    done: "Done",
    paused: "Paused — dhyan chahiye",
  };

  const PHASE_LABELS = {
    discovering: "creators dhoondh rahe hain",
    exporting: "chune hue creators ke posts nikaal rahe hain",
    finishing: "summary file likh rahe hain",
  };

  function statusText(state) {
    if (state.status === "running") {
      return "Chal raha hai — " + (PHASE_LABELS[state.phase] || state.phase || "");
    }
    return STATUS_LABELS[state.status] || state.status;
  }

  function renderPicked(state) {
    const rows = state.picked || [];
    pickedEl.classList.toggle("hidden", !rows.length);
    pickedEl.innerHTML = "";
    for (const row of rows) {
      const done = (state.exported || []).find((entry) => entry.handle === row.handle);
      const item = document.createElement("li");
      item.className = done ? (done.complete ? "ok" : "warn") : "";
      item.textContent =
        (done ? (done.complete ? "✓ " : "⚠ ") : "• ") +
        "@" +
        row.handle +
        " (" +
        compact(row.followers) +
        " followers, score " +
        (row.score == null ? "?" : row.score) +
        (done ? ", " + done.posts + " posts" : "") +
        ")";
      pickedEl.appendChild(item);
    }
  }

  function render(state) {
    if (!state) return;
    lastBrief = state;

    const running = state.status === "running";
    const resumable = state.status === "paused" || (state.status === "stopped" && !!state.phase);

    startBtn.disabled = running;
    stopBtn.classList.toggle("hidden", !running);
    pauseBanner.classList.toggle("hidden", !resumable);
    if (resumable) pauseDetailEl.textContent = state.lastEvent || "";

    statusLineEl.textContent = statusText(state);
    renderPicked(state);

    logEl.innerHTML = "";
    (state.log || [])
      .slice(-20)
      .reverse()
      .forEach((entry) => {
        const item = document.createElement("li");
        item.textContent = entry;
        logEl.appendChild(item);
      });

    if (!editedFields && state.status !== "idle") {
      if (state.creatorCount) creatorsEl.value = state.creatorCount;
      postsEl.value = state.postLimit ? String(state.postLimit) : "MAX";
      if (state.folder) folderEl.value = state.folder;
    }
    if (!seedsEl.value && state.seeds && state.seeds.length) {
      seedsEl.value = state.seeds.join("\n");
    }

    renderModeDot(state.status);
  }

  // The two sub-runners keep their own detailed state. Rather than copying their progress
  // into the brief state (and doubling every write), the panel reads theirs directly and
  // shows it as a second line under the brief's own status.
  function renderSubStatus(kind, sub) {
    if (!lastBrief || lastBrief.status !== "running") {
      subStatusEl.textContent = "";
      return;
    }
    if (kind === "discover" && lastBrief.phase === "discovering" && sub) {
      const totals = sub.totals || {};
      subStatusEl.textContent =
        "Discovery: " +
        (totals.tasksDone || 0) +
        "/" +
        (totals.tasksPlanned || 0) +
        " steps · " +
        (totals.candidates || 0) +
        " candidates · " +
        (totals.kept || 0) +
        " creator-jaise";
    }
    if (kind === "profiles" && lastBrief.phase === "exporting" && sub) {
      const totals = sub.totals || {};
      subStatusEl.textContent =
        "Export: " +
        (totals.accountsDone || 0) +
        "/" +
        (sub.accounts ? sub.accounts.length : 0) +
        " creator · " +
        (totals.postsFetched || 0) +
        " posts";
    }
  }

  // Mirrors renderModeDot() in popup-profiles.js, which owns the switcher itself.
  function renderModeDot(status) {
    const active = status === "running" || status === "paused";
    modeDot.classList.toggle("hidden", !active);
    modeDot.classList.toggle("paused", status === "paused");
  }

  // --------------------------------------------------------------------------- actions

  startBtn.addEventListener("click", async () => {
    const seeds = seedsEl.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (!seeds.length) {
      alert('Koi seed nahi hai. "Brief padho" dabao, ya seeds khud likh do.');
      return;
    }

    const creatorCount = Number(creatorsEl.value);
    if (!Number.isFinite(creatorCount) || creatorCount < 1) {
      alert("Kitne creator chahiye — kam se kam 1 daalo.");
      return;
    }
    const postLimit = parsePostLimit(postsEl.value);
    if (postLimit === undefined) {
      alert('Posts per creator me ya to ek number daalo (jaise 10), ya "MAX".');
      return;
    }

    const minFollowers = Math.max(0, Number(minFollowersEl.value) || 0);
    const maxFollowers = Number(maxFollowersEl.value) || 1000000;
    if (maxFollowers <= minFollowers) {
      alert("Max followers, min se zyada hona chahiye.");
      return;
    }

    const estimate = seeds.length + creatorCount;
    const proceed = confirm(
      seeds.length +
        " seed se creators dhoondhenge, phir top " +
        creatorCount +
        " creator ke " +
        (postLimit ? postLimit : "saare") +
        " posts export honge.\n\nSab kuch Downloads/" +
        (folderEl.value || folderNameFor(plan && plan.brand)) +
        "/ me jayega.\n\nYeh " +
        estimate +
        "+ steps ka Instagram crawl hai — chalu karein?"
    );
    if (!proceed) return;

    const delay = Math.max(2, Number(delayEl.value) || 4);
    render(
      await send({
        type: "BRIEF_START",
        briefText: briefTextEl.value,
        plan,
        brand: plan ? plan.brand : "",
        folder: folderEl.value || folderNameFor(plan && plan.brand),
        seeds,
        excludes: plan ? plan.excludes : [],
        creatorCount,
        postLimit,
        minFollowers,
        maxFollowers,
        maxDepth: Number(depthEl.value),
        maxCandidates: Number(maxCandidatesEl.value),
        stepDelaySec: delay,
        batchDelaySec: Math.max(5, delay * 2),
        pageDelaySec: delay,
        accountDelaySec: Math.max(3, delay * 2),
      })
    );
  });

  stopBtn.addEventListener("click", async () => {
    render(await send({ type: "BRIEF_STOP" }));
  });

  resumeBtn.addEventListener("click", async () => {
    render(await send({ type: "BRIEF_RESUME" }));
  });

  resetBtn.addEventListener("click", async () => {
    const proceed = confirm(
      "Brief run ka status clear ho jayega (downloaded files safe rehti hain). Reset karein?"
    );
    if (!proceed) return;
    const state = await send({ type: "BRIEF_RESET" });
    editedFields = false;
    subStatusEl.textContent = "";
    render(state);
  });

  // ---------------------------------------------------------------------------- wiring

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.briefRunState) render(changes.briefRunState.newValue);
    if (changes.discoverRunState) renderSubStatus("discover", changes.discoverRunState.newValue);
    if (changes.profileRunState) renderSubStatus("profiles", changes.profileRunState.newValue);
  });

  (async function init() {
    render(await send({ type: "BRIEF_GET_STATE" }));
    const stored = await chrome.storage.local.get(["discoverRunState", "profileRunState"]);
    renderSubStatus("discover", stored.discoverRunState);
    renderSubStatus("profiles", stored.profileRunState);
  })();
})();
