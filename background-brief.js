// Insta Handle Finder — campaign-brief runner (orchestrator of orchestrators).
//
// One brief in, one folder out: discovery finds creators that fit the brief, the profile
// exporter pulls the first N of them with a post budget, and every file lands in the same
// download folder.
//
// This runner owns *sequencing and selection only*. It does not talk to Instagram at all
// — it drives the two runners that already do, by calling their start/resume/stop
// functions directly (importScripts puts all three in one worker scope) and watching their
// storage keys for the transitions it cares about. Anything about *how* to crawl stays in
// background-discover.js and background-profiles.js, so a fix there fixes it here too.
//
// The sub-runs it starts are tagged `owner: "brief"`. If a run it is waiting on comes back
// untagged, the user started something by hand on top of it — that is a pause with a clear
// message, never a silent hand-off to somebody else's results.

const BRIEF_STATE_KEY = "briefRunState";
const BRIEF_NOTIF_ID = "brief-pause";
const BRIEF_OWNER = "brief";

// Guards. The panel offers far smaller numbers; these only stop an absurd value from a
// hand-edited message turning into a very long unattended crawl.
const BRIEF_MAX_CREATORS = 50;

// ---------------------------------------------------------------------- state helpers

function defaultBriefState() {
  return {
    status: "idle", // idle | running | paused | stopped | done
    phase: "", // "" | discovering | exporting | finishing
    pauseReason: "",
    brand: "",
    folder: "",
    creatorCount: 2,
    postLimit: 10, // per creator; null = MAX
    minFollowers: 1000,
    maxFollowers: 1000000,
    pageDelaySec: 3,
    accountDelaySec: 8,
    seeds: [],
    plan: null, // the parsed brief, as edited in the panel
    picked: [], // [{ handle, followers, score, ... }] chosen for export
    exported: [], // [{ handle, postCount, complete, reason }] once the export finishes
    filesWritten: [],
    lastEvent: "",
    log: [],
    updatedAt: 0,
  };
}

async function getBriefState() {
  const stored = await chrome.storage.local.get(BRIEF_STATE_KEY);
  return stored[BRIEF_STATE_KEY] || defaultBriefState();
}

async function setBriefState(patch) {
  const current = await getBriefState();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  if (patch.lastEvent) {
    next.log = [...(current.log || []), patch.lastEvent].slice(-50);
  }
  await chrome.storage.local.set({ [BRIEF_STATE_KEY]: next });
  return next;
}

// Same reason as every other runner here: state changes are read-modify-write, and the
// storage watcher fires while panel commands are in flight.
let briefStateChain = Promise.resolve();

function queueBriefTask(task) {
  const run = briefStateChain.then(task, task);
  briefStateChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

// ------------------------------------------------------------------------ output files

function briefFolderName(brand) {
  const slug = safeDownloadFolder(brand) || "campaign";
  return "brief_" + slug + "_" + new Date().toISOString().slice(0, 10);
}

async function writeBriefFile(state, name, payload) {
  try {
    await downloadJson(withDownloadFolder(state.folder, name), JSON.stringify(payload, null, 2));
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

// Ranking is the one judgement call this file makes, so it is a pure function: a Node
// harness can exercise every branch without a browser, a network or a storage stub.
//
// Band first, then score. The brief asked for a follower range, and an account measured
// outside it is a worse pick than a strong one inside it however well it scores on bio and
// category. Unmeasured accounts sort between the two: "we could not tell" is not evidence
// of being out of band, and it is not evidence of being in it either.
function briefBandRank(row, min, max) {
  if (typeof row.followers !== "number") return 1;
  return row.followers >= min && row.followers <= max ? 2 : 0;
}

function rankBriefCandidates(candidates, options) {
  const min = Number(options.minFollowers) || 0;
  const max = Number(options.maxFollowers) || Infinity;
  const count = Math.max(1, Number(options.count) || 1);

  const rows = Object.values(candidates || {}).filter((row) => row && row.handle);
  const ranked = rows
    .map((row) => ({ row, band: briefBandRank(row, min, max) }))
    .sort((a, b) => {
      if (b.band !== a.band) return b.band - a.band;
      const keep = (b.row.keep ? 1 : 0) - (a.row.keep ? 1 : 0);
      if (keep) return keep;
      const left = a.row.score == null ? -1 : a.row.score;
      const right = b.row.score == null ? -1 : b.row.score;
      if (right !== left) return right - left;
      return (b.row.followers || 0) - (a.row.followers || 0);
    })
    .map((entry) => ({ ...entry.row, band_fit: entry.band === 2 ? "in_band" : entry.band === 1 ? "unknown" : "out_of_band" }));

  // Private accounts cannot be exported at all — the profile runner would save a profile
  // with no posts and call it partial. They stay in the file, flagged, so a human can see
  // them and decide; they are simply never one of the N.
  const picked = ranked.filter((row) => !row.is_private).slice(0, count);
  return { ranked, picked };
}

// --------------------------------------------------------------------- panel commands

async function startBriefRun(msg) {
  // Both sub-runners are single-tab, single-run. Starting on top of a live one would
  // silently discard whatever the user already had going.
  const [discover, profiles] = await Promise.all([getDiscoverState(), getProfileState()]);
  if (discoverStatusIsActive(discover.status)) {
    await setBriefState({
      status: "idle",
      lastEvent: "IG discovery ka run pehle se chal raha hai — usse rok ya reset karke phir Start karo",
    });
    return;
  }
  if (profileStatusIsActive(profiles.status)) {
    await setBriefState({
      status: "idle",
      lastEvent: "Instagram profiles ka run pehle se chal raha hai — usse rok ya reset karke phir Start karo",
    });
    return;
  }

  const seeds = (Array.isArray(msg.seeds) ? msg.seeds : [])
    .map((line) => String(line || "").trim())
    .filter(Boolean);
  if (!seeds.length) {
    await setBriefState({
      status: "idle",
      lastEvent: "Koi seed nahi bana — brief padho ya seeds khud likh do",
    });
    return;
  }

  const plan = msg.plan && typeof msg.plan === "object" ? msg.plan : null;
  const brand = String(msg.brand || (plan && plan.brand) || "").slice(0, 60);
  const folder = safeDownloadFolder(msg.folder) || briefFolderName(brand);
  const creatorCount = Math.max(1, Math.min(BRIEF_MAX_CREATORS, Number(msg.creatorCount) || 1));
  const postLimit = normalizePostLimit(msg.postLimit);
  const minFollowers = Math.max(0, Number(msg.minFollowers) || 0);
  const maxFollowers = Math.max(minFollowers + 1, Number(msg.maxFollowers) || 1000000);
  const pageDelaySec = Math.max(2, Number(msg.pageDelaySec) || 3);
  const accountDelaySec = Math.max(3, Number(msg.accountDelaySec) || 8);

  chrome.notifications.clear(BRIEF_NOTIF_ID);

  const fresh = {
    ...defaultBriefState(),
    status: "running",
    phase: "discovering",
    brand,
    folder,
    creatorCount,
    postLimit,
    pageDelaySec,
    accountDelaySec,
    seeds,
    plan,
    minFollowers,
    maxFollowers,
    lastEvent:
      "Start: " +
      seeds.length +
      " seed, " +
      creatorCount +
      " creator chahiye, har ek se " +
      (postLimit ? postLimit + " posts" : "saare posts") +
      " → " +
      folder +
      "/",
    updatedAt: Date.now(),
  };
  fresh.log = [fresh.lastEvent];
  await chrome.storage.local.set({ [BRIEF_STATE_KEY]: fresh });

  // Written before any request goes out, so even a run that dies on the first wall leaves
  // behind exactly what it was going to do.
  const planFile = await writeBriefFile(fresh, "_brief-plan.json", {
    generated_at: new Date().toISOString(),
    brand,
    folder,
    creator_count: creatorCount,
    posts_per_creator: postLimit,
    discovery_settings: {
      seeds,
      excludes: Array.isArray(msg.excludes) ? msg.excludes : [],
      follower_band: [minFollowers, maxFollowers],
      max_depth: Number(msg.maxDepth),
      max_candidates: Number(msg.maxCandidates),
    },
    parsed_plan: plan,
    brief_text: typeof msg.briefText === "string" ? msg.briefText : "",
  });
  await setBriefState({
    filesWritten: planFile.ok ? ["_brief-plan.json"] : [],
    lastEvent: planFile.ok
      ? "Plan file save ho gayi — ab creators dhoond rahe hain"
      : "Plan file save nahi hui (" + planFile.error + ") — discovery phir bhi chala rahe hain",
  });

  await startDiscoverRun({
    seeds,
    excludes: Array.isArray(msg.excludes) ? msg.excludes : [],
    maxDepth: msg.maxDepth,
    maxCandidates: msg.maxCandidates,
    stepDelaySec: msg.stepDelaySec,
    batchDelaySec: msg.batchDelaySec,
    minFollowers,
    maxFollowers,
    useChaining: true,
    // The band is the brief's own requirement, and the score leans on follower count
    // hardest — a run without enrichment could not tell a 5K account from a 500K one.
    enrich: true,
    downloadFolder: folder,
    owner: BRIEF_OWNER,
  });
}

async function enterBriefPause(reason, detail) {
  await setBriefState({ status: "paused", pauseReason: reason, lastEvent: detail });
  chrome.notifications.create(BRIEF_NOTIF_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Brief run — Paused",
    message: detail,
    priority: 2,
    requireInteraction: true,
  });
}

async function resumeBriefRun() {
  const state = await getBriefState();
  if (state.status !== "paused" && state.status !== "stopped") return;
  chrome.notifications.clear(BRIEF_NOTIF_ID);

  if (state.phase === "discovering") {
    const discover = await getDiscoverState();
    if (discover.owner !== BRIEF_OWNER) {
      await setBriefState({
        lastEvent: "Discovery run ab brief ka nahi raha — Reset karke naya brief run chalao",
      });
      return;
    }
    // Brief goes back to running *before* the sub-run does, so the watcher is listening
    // by the time the first update lands.
    await setBriefState({ status: "running", pauseReason: "", lastEvent: "Resume — discovery" });
    await resumeDiscoverRun();
    return;
  }

  if (state.phase === "exporting") {
    const profiles = await getProfileState();
    if (profiles.owner !== BRIEF_OWNER) {
      await setBriefState({
        lastEvent: "Export run ab brief ka nahi raha — Reset karke naya brief run chalao",
      });
      return;
    }
    await setBriefState({ status: "running", pauseReason: "", lastEvent: "Resume — export" });
    await resumeProfileRun();
    return;
  }

  await setBriefState({ lastEvent: "Yahan se resume karne layak kuch nahi — Reset karo" });
}

async function stopBriefRun() {
  const state = await getBriefState();
  chrome.notifications.clear(BRIEF_NOTIF_ID);
  if (state.phase === "discovering") await stopDiscoverRun();
  if (state.phase === "exporting") await stopProfileRun();
  await setBriefState({
    status: "stopped",
    lastEvent: "Brief run rok diya — jo file download ho chuki hain woh safe hain",
  });
}

async function resetBriefRun() {
  chrome.notifications.clear(BRIEF_NOTIF_ID);
  const fresh = { ...defaultBriefState(), updatedAt: Date.now() };
  await chrome.storage.local.set({ [BRIEF_STATE_KEY]: fresh });
  return fresh;
}

// ------------------------------------------------------------------- phase transitions

async function briefPickAndExport(brief, discover) {
  const { ranked, picked } = rankBriefCandidates(discover.candidates, {
    minFollowers: brief.minFollowers,
    maxFollowers: brief.maxFollowers,
    count: brief.creatorCount,
  });

  const shortlist = await writeBriefFile(brief, "_shortlist.json", {
    generated_at: new Date().toISOString(),
    brand: brief.brand,
    asked_for: brief.creatorCount,
    picked_count: picked.length,
    follower_band: [brief.minFollowers, brief.maxFollowers],
    // Said plainly in the file itself, because the brief asks for a gender split and this
    // tool cannot honour it: gender is not something a profile reliably states.
    selection_note:
      "Auto-pick = follower band fit, phir discovery score. Gender, brand suitability aur " +
      "content quality yahan se khud judge karo — 'ranked' me poori list hai.",
    picked,
    ranked,
  });

  const files = [...(brief.filesWritten || [])];
  if (shortlist.ok) files.push("_shortlist.json");

  if (!picked.length) {
    await setBriefState({
      status: "done",
      phase: "",
      picked: [],
      filesWritten: files,
      lastEvent:
        "Discovery me koi export karne layak creator nahi mila (" +
        Object.keys(discover.candidates || {}).length +
        " candidate dekhe) — seeds badal ke dobara try karo",
    });
    return;
  }

  await setBriefState({
    phase: "exporting",
    picked,
    filesWritten: files,
    lastEvent:
      picked.length +
      " creator chune: @" +
      picked.map((row) => row.handle).join(", @") +
      " — ab inke posts nikaal rahe hain",
  });

  const refreshed = await getBriefState();
  await startProfileRun({
    accounts: picked.map((row) => row.handle),
    postLimit: refreshed.postLimit,
    pageDelaySec: refreshed.pageDelaySec,
    accountDelaySec: refreshed.accountDelaySec,
    downloadFolder: refreshed.folder,
    owner: BRIEF_OWNER,
  });
}

async function finishBriefRun(brief, profiles) {
  const exported = (profiles.completed || []).map((entry) => ({
    handle: entry.handle,
    posts: entry.postCount,
    complete: !!entry.complete,
    reason: entry.reason || null,
    source: entry.source || null,
  }));
  const done = exported.filter((entry) => entry.complete).length;

  await setBriefState({ phase: "finishing", exported });
  const state = await getBriefState();

  const summary = await writeBriefFile(state, "_summary.json", {
    generated_at: new Date().toISOString(),
    brand: state.brand,
    folder: state.folder,
    creators_asked: state.creatorCount,
    posts_per_creator: state.postLimit,
    creators_exported: done,
    creators: state.picked.map((row) => {
      const outcome = exported.find((entry) => entry.handle === row.handle) || null;
      return {
        handle: row.handle,
        profile_url: "https://www.instagram.com/" + row.handle + "/",
        followers: row.followers == null ? null : row.followers,
        score: row.score == null ? null : row.score,
        band_fit: row.band_fit || null,
        category: row.category || null,
        file: outcome ? row.handle + ".json" : null,
        posts_exported: outcome ? outcome.posts : 0,
        complete: outcome ? outcome.complete : false,
        reason: outcome ? outcome.reason : "export nahi hua",
      };
    }),
  });

  const files = [...(state.filesWritten || [])];
  if (summary.ok) files.push("_summary.json");

  chrome.action.setBadgeText({ text: "✓" });
  chrome.action.setBadgeBackgroundColor({ color: "#188038" });
  await setBriefState({
    status: "done",
    phase: "",
    filesWritten: files,
    lastEvent:
      "Ho gaya — " +
      done +
      "/" +
      state.picked.length +
      " creator export hue, sab kuch " +
      state.folder +
      "/ folder me hai",
  });
}

// A sub-run that stopped being ours is the one case worth spelling out: the user started
// a manual discovery/profile run on top of this one, so its results answer their question,
// not the brief's.
async function briefHijacked(which) {
  await enterBriefPause(
    "hijacked",
    which + " run manually replace ho gaya — brief run yahin ruk gaya hai. Reset karke naya brief run chalao."
  );
}

async function onDiscoverStateChanged(discover) {
  if (!discover) return;
  const brief = await getBriefState();
  if (brief.status !== "running" || brief.phase !== "discovering") return;

  if (discover.owner !== BRIEF_OWNER) {
    await briefHijacked("IG discovery");
    return;
  }
  if (discover.status === "paused") {
    await enterBriefPause(
      discover.pauseReason || "discovery_paused",
      "Discovery rukhi: " + (discover.lastEvent || "wajah IG discovery tab me dekho")
    );
    return;
  }
  if (discover.status === "stopped") {
    await setBriefState({ status: "stopped", lastEvent: "Discovery rok di gayi — brief run bhi ruka" });
    return;
  }
  if (discover.status !== "done") return;

  await briefPickAndExport(brief, discover);
}

async function onProfileStateChanged(profiles) {
  if (!profiles) return;
  const brief = await getBriefState();
  if (brief.status !== "running" || brief.phase !== "exporting") return;

  if (profiles.owner !== BRIEF_OWNER) {
    await briefHijacked("Instagram profiles");
    return;
  }
  if (profiles.status === "paused") {
    await enterBriefPause(
      profiles.pauseReason || "export_paused",
      "Export rukha: " + (profiles.lastEvent || "wajah Instagram profiles tab me dekho")
    );
    return;
  }
  if (profiles.status === "stopped") {
    await setBriefState({ status: "stopped", lastEvent: "Export rok diya gaya — brief run bhi ruka" });
    return;
  }
  if (profiles.status !== "done") return;

  await finishBriefRun(brief, profiles);
}

// ----------------------------------------------------------------------- event wiring

// Watching storage rather than being called back: both sub-runners already write every
// transition there, an MV3 worker can be torn down between two phases, and a top-level
// storage listener is what wakes it again. No polling, and no new coupling inside the
// runners themselves.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[DISCOVER_STATE_KEY]) {
    queueBriefTask(() => onDiscoverStateChanged(changes[DISCOVER_STATE_KEY].newValue));
  }
  if (changes[PROFILE_STATE_KEY]) {
    queueBriefTask(() => onProfileStateChanged(changes[PROFILE_STATE_KEY].newValue));
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;
  if (!msg.type.startsWith("BRIEF_")) return false;

  queueBriefTask(async () => {
    switch (msg.type) {
      case "BRIEF_START":
        await startBriefRun(msg);
        break;
      case "BRIEF_RESUME":
        await resumeBriefRun();
        break;
      case "BRIEF_STOP":
        await stopBriefRun();
        break;
      case "BRIEF_RESET":
        await resetBriefRun();
        break;
      default: // BRIEF_GET_STATE and anything unknown just read the state back
        break;
    }
  })
    .catch(() => undefined)
    .then(async () => {
      sendResponse(await getBriefState());
    });
  return true;
});
