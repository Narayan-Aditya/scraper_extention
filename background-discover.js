// Insta Handle Finder — Instagram discovery runner (orchestrator).
//
// Loaded into the same service worker as background.js, and isolated the same way every
// other runner here is: its own storage key, its own tab, its own alarm and its own
// message namespace, so no two features can corrupt each other's state.
//
// What it is for: the Google runner finds handles from outside Instagram and does it
// badly for creators — a `site:instagram.com "<city>"` query carries no creator signal and
// Google dedupes site: results hard. This runner asks Instagram itself instead: given a
// seed creator, who does Instagram consider similar? That is a breadth-first walk of
// Instagram's own suggestion graph, and it is what this file owns.
//
// Division of labour: this file owns the frontier — which task next, how deep, what is a
// duplicate, what counts as a creator. The injected content-ig-discover.js owns how to ask
// Instagram one question. Keeping the frontier here means it survives the tab, and means
// the scoring is a pure function that a Node harness can test without a browser.
//
// Output is deliberately a *candidate list*, not profiles: the profile exporter already
// exists and does that job properly. Discovery hands it a ranked queue.
//
// Reuses from background-profiles.js (same worker scope, loaded first): downloadJson(),
// normalizeProfileHandle(), profileUrlFor().

const DISCOVER_STATE_KEY = "discoverRunState";
const DISCOVER_ALARM = "discoverNextBatch";
const DISCOVER_NOTIF_ID = "discover-pause";

const DISCOVER_INJECT_ATTEMPTS = 3;
const DISCOVER_RATE_LIMIT_BASE_MS = 60 * 1000;
const DISCOVER_RATE_LIMIT_MAX_MS = 15 * 60 * 1000;

// One injection handles this many frontier tasks before handing control back. Small enough
// that a crash or a closed tab loses almost nothing, large enough that we are not paying
// for an injection per request.
const DISCOVER_BATCH_SIZE = 8;
// Runaway guards. Both are reported when hit — this project does not silently truncate.
const DISCOVER_MAX_TASKS = 2000;
const DISCOVER_CANDIDATE_HARD_CAP = 5000;
// The neutral page the driven tab is parked on. Discovery never needs a *particular*
// profile open — every source is an API call — so one logged-in instagram.com page serves
// the whole run.
const DISCOVER_HOME_URL = "https://www.instagram.com/";

// A tab parked on the Instagram home feed is a normal logged-in page; the discovery
// requests are the same ones the app itself makes while you browse.

// ---------------------------------------------------------------------- state helpers

function defaultDiscoverState() {
  return {
    status: "idle", // idle | running | waiting_delay | paused | stopped | done
    phase: "", // "" | discovering | downloading
    pauseReason: "",
    tabId: null,
    pendingInject: false,
    injectToken: 0,

    // config
    seeds: [],
    maxDepth: 2,
    maxCandidates: 500,
    stepDelaySec: 4,
    batchDelaySec: 10,
    minFollowers: 1000,
    maxFollowers: 1000000,
    useChaining: true,
    // The listing sources answer thin. Without this second pass most candidates carry no
    // follower count, no category and no bio, and the score is mostly confidence-hole.
    enrich: true,
    enrichStarted: false,
    excludeHandles: [],
    downloadFolder: "", // "" = straight into Downloads
    // Set when the brief orchestrator started this run rather than the user.
    owner: null,

    // frontier
    queue: [], // tasks not yet handed to a batch
    activeBatch: [], // tasks handed out and not yet reported — requeued on pause
    deadSources: [],
    seenHandles: [], // every handle ever emitted, for dedupe
    plannedTaskKeys: [], // every task ever queued, so a cycle cannot re-queue one
    candidates: {}, // handle -> candidate record (scored)

    retryCount: 0,
    backoffUntilTs: 0,
    capped: null, // which runaway guard stopped the walk, if any
    totals: { tasksDone: 0, tasksPlanned: 0, candidates: 0, kept: 0 },
    lastEvent: "",
    log: [],
    updatedAt: 0,
  };
}

async function getDiscoverState() {
  const stored = await chrome.storage.local.get(DISCOVER_STATE_KEY);
  return stored[DISCOVER_STATE_KEY] || defaultDiscoverState();
}

async function setDiscoverState(patch) {
  const current = await getDiscoverState();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  if (patch.lastEvent) {
    next.log = [...(current.log || []), patch.lastEvent].slice(-50);
  }
  await chrome.storage.local.set({ [DISCOVER_STATE_KEY]: next });
  return next;
}

// Same reason as the profile runner: every handler is read-modify-write on one state
// object, and task reports interleave with panel commands. Without serialising them one
// update silently overwrites the other.
let discoverStateChain = Promise.resolve();

function queueDiscoverTask(task) {
  const run = discoverStateChain.then(task, task);
  discoverStateChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function discoverSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------------ seed parsing

// The three seed forms, kept unambiguous on purpose so the panel can explain them in one
// line and a user never has to guess which one their input became:
//   @handle / instagram.com/handle -> walk that account's similar-accounts graph
//   #tag                           -> harvest the authors on that hashtag
//   anything else                  -> Instagram search for that phrase
// A bare word with no prefix is a search term, never a handle: "mumbaifoodblogger" is far
// more often a phrase someone typed than an account they meant.
function parseDiscoverSeeds(lines) {
  const tasks = [];
  const keys = new Set();
  let skipped = 0;

  for (const raw of Array.isArray(lines) ? lines : []) {
    if (typeof raw !== "string" || !raw.trim()) continue;
    const value = raw.trim();

    let task = null;
    if (value.startsWith("#")) {
      const tag = value.slice(1).trim().toLowerCase().replace(/[^a-z0-9_]/g, "");
      if (tag) task = { kind: "hashtag", tag, depth: 0, key: "hashtag:" + tag };
    } else if (value.startsWith("@") || value.toLowerCase().includes("instagram.com")) {
      const handle = normalizeProfileHandle(value);
      if (handle) {
        task = { kind: "chain", handle, userId: null, depth: 0, key: "chain:" + handle };
      }
    } else {
      const term = value.replace(/\s+/g, " ");
      task = { kind: "search", term, depth: 0, key: "search:" + term.toLowerCase() };
    }

    if (!task) {
      skipped += 1;
      continue;
    }
    if (keys.has(task.key)) continue;
    keys.add(task.key);
    tasks.push(task);
  }

  return { tasks, skipped };
}

// --------------------------------------------------------------------------- scoring
//
// A pure function on purpose: it is the one piece of judgement in this runner, and a Node
// harness can exercise every branch of it without a browser or a network.
//
// The null rule: a signal the source did not supply is *not counted at all* — it neither
// rewards nor penalises. So the score is a percentage of the evidence that actually
// existed, and `known` says how much evidence that was. Defaulting a missing follower
// count to zero would bury every candidate a listing happened to be terse about; defaulting
// it to "fine" would promote them. Neither is honest, so absence abstains.

const CREATOR_CATEGORY_RE =
  /(creator|blogger|vlogger|influencer|public figure|artist|musician|comedian|photograph|model|athlete|author|writer|entertain|media|personal blog|dancer|chef)/i;
const COLLAB_INTENT_RE =
  /(collab|colab|pr\s*friendly|brand deal|paid promo|paid partnership|dm for|for promo|barter|enquir|bookings?|book me|business enquiry|contact for)/i;
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

function scoreDiscoverCandidate(candidate, opts) {
  const minFollowers = (opts && opts.minFollowers) || 0;
  const maxFollowers = (opts && opts.maxFollowers) || Infinity;

  let points = 0;
  let max = 0;
  const signals = {};

  // Follower band. The single strongest creator signal when it is present: the micro/mid
  // influencer window the user set. Just outside it still scores, because a band is a
  // preference, not a fact about the account.
  if (typeof candidate.followers === "number") {
    max += 35;
    const followers = candidate.followers;
    if (followers >= minFollowers && followers <= maxFollowers) {
      points += 35;
      signals.followers = "in_band";
    } else if (followers >= minFollowers / 3 && followers <= maxFollowers * 3) {
      points += 15;
      signals.followers = "near_band";
    } else {
      signals.followers = "out_of_band";
    }
  }

  // Follower/following ratio separates an account people follow from an account that
  // follows people. Only computable when both halves are known, which in practice means
  // after enrichment.
  if (typeof candidate.followers === "number" && typeof candidate.following === "number") {
    max += 15;
    // following === 0 is a real answer, not a division error: an account with followers and
    // no outgoing follows is as one-directional as it gets.
    const ratio = candidate.following === 0 ? Infinity : candidate.followers / candidate.following;
    if (ratio >= 3) {
      points += 15;
      signals.ratio = "high";
    } else if (ratio >= 1) {
      points += 9;
      signals.ratio = "mid";
    } else {
      points += 3;
      signals.ratio = "low";
    }
  }

  // Private accounts are not what a discovery run is looking for — nothing about them can
  // be exported later — but "private" is still evidence, not a disqualification.
  if (typeof candidate.is_private === "boolean") {
    max += 20;
    if (!candidate.is_private) points += 20;
    signals.is_private = candidate.is_private;
  }

  if (candidate.category) {
    max += 20;
    const creatorish = CREATOR_CATEGORY_RE.test(String(candidate.category));
    points += creatorish ? 20 : 5;
    signals.category = creatorish ? "creator" : "other";
  }

  // An account that barely posts is not a creator yet, whatever its follower count says.
  if (typeof candidate.posts_count === "number") {
    max += 10;
    if (candidate.posts_count >= 20) {
      points += 10;
      signals.posts = "active";
    } else if (candidate.posts_count >= 5) {
      points += 5;
      signals.posts = "thin";
    } else {
      signals.posts = "empty";
    }
  }

  if (typeof candidate.is_verified === "boolean") {
    max += 10;
    // Unverified is the norm for a micro creator, so it keeps most of the credit; the
    // badge is a bonus, not a gate.
    points += candidate.is_verified ? 10 : 3;
    signals.is_verified = candidate.is_verified;
  }

  // Bonus-only signals. A listing that omits external_url looks identical to an account
  // that has none, so their absence must never subtract.
  if (candidate.external_url) {
    max += 10;
    points += 10;
    signals.external_url = true;
  }

  if (typeof candidate.biography === "string" && candidate.biography.trim()) {
    max += 15;
    const bio = candidate.biography;
    const intent = COLLAB_INTENT_RE.test(bio) || EMAIL_RE.test(bio);
    points += intent ? 15 : 2;
    signals.bio_intent = intent;
  }

  return {
    // null, not 0: "we could not tell" and "we looked and it is bad" are different answers
    // and the panel shows them differently.
    score: max > 0 ? Math.round((points / max) * 100) : null,
    known: max,
    signals,
  };
}

// Keep-decision, separate from the score so the two can be reasoned about independently.
// An unknown score is kept: discovery's job is to produce candidates worth checking, and
// a terse listing is not evidence against an account.
function keepDiscoverCandidate(candidate, scored, threshold) {
  if (candidate.is_private === true) return false;
  if (scored.score == null) return true;
  return scored.score >= threshold;
}

const DISCOVER_KEEP_THRESHOLD = 50;
// Request budget for the enrichment pass. It is one request per candidate, so an
// unbounded pass on a 5000-candidate run is exactly the storm this project refuses to
// make. Anything past the cap is reported, not silently dropped.
const DISCOVER_MAX_ENRICH = 400;

// /info/ is strictly richer than a listing record, but a null in it still means "this
// source did not say" — so a field is only overwritten when the new answer actually
// exists. Provenance (who found this, at what depth) always stays with the original.
function mergeDiscoverCandidate(existing, incoming) {
  const pick = (key) =>
    incoming[key] == null || incoming[key] === "" ? existing[key] : incoming[key];
  const num = (key) => (typeof incoming[key] === "number" ? incoming[key] : existing[key]);
  const bool = (key) => (typeof incoming[key] === "boolean" ? incoming[key] : existing[key]);

  return {
    ...existing,
    user_id: existing.user_id || incoming.user_id || null,
    full_name: pick("full_name"),
    biography: pick("biography"),
    category: pick("category"),
    external_url: pick("external_url"),
    followers: num("followers"),
    following: num("following"),
    posts_count: num("posts_count"),
    is_private: bool("is_private"),
    is_verified: bool("is_verified"),
    is_business: bool("is_business"),
  };
}

// Which candidates earn a detail request: kept ones only, best-scored first, and only
// those actually missing what /info/ would add. Re-asking for data we already hold is a
// request spent for nothing.
function buildDiscoverEnrichQueue(state) {
  const rows = Object.values(state.candidates || {}).filter(
    (row) => row.keep && !row.enriched && row.followers == null
  );
  rows.sort((a, b) => (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score));
  const slice = rows.slice(0, DISCOVER_MAX_ENRICH);
  return {
    tasks: slice.map((row) => ({
      kind: "enrich",
      handle: row.handle,
      userId: row.user_id || null,
      depth: row.depth,
      key: "enrich:" + row.handle,
    })),
    dropped: rows.length - slice.length,
  };
}

function countDiscoverKept(candidates) {
  return Object.values(candidates || {}).filter((row) => row.keep).length;
}

// ------------------------------------------------------------------- run-state controls

function discoverStatusIsActive(status) {
  return status === "running" || status === "waiting_delay" || status === "paused";
}

async function enterDiscoverPause(reason, detail) {
  await chrome.alarms.clear(DISCOVER_ALARM);
  chrome.action.setBadgeText({ text: "⏸" });
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });

  const prior = await getDiscoverState();
  // Whatever the batch had not reported yet goes back to the front of the queue, so Resume
  // repeats exactly the tasks that did not happen and none of the ones that did.
  const queue = [...(prior.activeBatch || []), ...(prior.queue || [])];

  const patch = {
    status: "paused",
    pauseReason: reason,
    pendingInject: false,
    queue,
    activeBatch: [],
    lastEvent: detail,
  };

  if (reason === "rate_limit") {
    const retryCount = (prior.retryCount || 0) + 1;
    const waitMs = Math.min(
      DISCOVER_RATE_LIMIT_BASE_MS * Math.pow(2, retryCount - 1),
      DISCOVER_RATE_LIMIT_MAX_MS
    );
    patch.retryCount = retryCount;
    patch.backoffUntilTs = Date.now() + waitMs;
    patch.lastEvent = detail + " (" + Math.round(waitMs / 60000) + " min baad Resume kar sakte ho)";
  }

  await setDiscoverState(patch);

  chrome.notifications.create(DISCOVER_NOTIF_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Instagram Discovery — Paused",
    message: patch.lastEvent,
    priority: 2,
    requireInteraction: true,
  });
}

function scheduleDiscoverAlarm(baseSeconds) {
  const jitter = baseSeconds * (Math.random() * 0.4 - 0.2); // +/-20%, same as every runner here
  const delaySeconds = Math.max(1, baseSeconds + jitter);
  chrome.alarms.create(DISCOVER_ALARM, { delayInMinutes: delaySeconds / 60 });
}

// ------------------------------------------------------------------------- output file

function discoverFilename() {
  return "ig-discovery_" + new Date().toISOString().slice(0, 10) + ".json";
}

// Ranked best-first, because the whole point of the file is a queue somebody works through
// top-down and eventually stops reading.
function buildDiscoverJson(state, options) {
  const complete = !!(options && options.complete);
  const rows = Object.values(state.candidates || {});
  rows.sort((a, b) => {
    // Unknown scores sink below scored ones rather than sorting as zero — they are not
    // "bad", they are "unrated", and burying them under real rejects would be wrong too.
    const left = a.score == null ? -1 : a.score;
    const right = b.score == null ? -1 : b.score;
    if (right !== left) return right - left;
    return (b.followers || 0) - (a.followers || 0);
  });

  return JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      complete,
      incomplete_reason: complete ? null : (options && options.reason) || "incomplete",
      // Named so a file read months later still explains how it was produced.
      seeds: state.seeds,
      settings: {
        max_depth: state.maxDepth,
        max_candidates: state.maxCandidates,
        follower_band: [state.minFollowers, state.maxFollowers],
        keep_threshold: DISCOVER_KEEP_THRESHOLD,
        chaining_enabled: state.useChaining,
        enrich_enabled: state.enrich,
        excluded_handles: state.excludeHandles.length,
      },
      runaway_guard_hit: state.capped,
      sources_disabled: state.deadSources,
      totals: state.totals,
      candidates: rows,
      // The one line most users actually want: paste straight into the Instagram profiles
      // tab.
      kept_handles: rows.filter((row) => row.keep).map((row) => row.handle),
    },
    null,
    2
  );
}

async function saveDiscoverFile(state, options) {
  try {
    await downloadJson(
      withDownloadFolder(state.downloadFolder, discoverFilename()),
      buildDiscoverJson(state, options)
    );
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function finishDiscoverRun(reason) {
  await chrome.alarms.clear(DISCOVER_ALARM);
  const state = await setDiscoverState({ phase: "downloading" });
  const result = await saveDiscoverFile(state, { complete: !state.capped, reason });

  chrome.action.setBadgeText({ text: result.ok ? "✓" : "⚠" });
  chrome.action.setBadgeBackgroundColor({ color: result.ok ? "#188038" : "#d93025" });

  await setDiscoverState({
    status: "done",
    phase: "",
    pendingInject: false,
    activeBatch: [],
    lastEvent: result.ok
      ? "Ho gaya — " +
        state.totals.kept +
        " creator handle mile (" +
        state.totals.candidates +
        " total dekhe), file download ho gayi"
      : "Discovery poori hui par file save nahi hui — " + result.error,
  });
}

// -------------------------------------------------------------------------- tab driving

async function openDiscoverTab(state) {
  const token = (state.injectToken || 0) + 1;

  let tabId = state.tabId;
  if (tabId != null) {
    try {
      const tab = await chrome.tabs.get(tabId);
      // Already parked on Instagram: re-navigating would throw away a warm page for
      // nothing, and `complete` would not fire again for the same URL.
      if (tab && /^https:\/\/(www\.)?instagram\.com\//i.test(tab.url || "")) {
        await chrome.tabs.update(tabId, { active: true });
        await setDiscoverState({ tabId, injectToken: token, pendingInject: false, status: "running" });
        return { tabId, ready: true };
      }
      await chrome.tabs.update(tabId, { url: DISCOVER_HOME_URL, active: true });
    } catch (e) {
      tabId = null; // tab is gone; fall through and make a new one
    }
  }
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url: DISCOVER_HOME_URL, active: true });
    tabId = tab.id;
  }

  await setDiscoverState({ tabId, injectToken: token, pendingInject: true, status: "running" });
  return { tabId, ready: false };
}

async function injectDiscoverFetcher(tabId, state) {
  const job = {
    tasks: state.activeBatch,
    deadSources: state.deadSources || [],
    stepDelayMs: Math.max(2, state.stepDelaySec) * 1000,
    runToken: state.injectToken,
  };

  let lastError = null;
  for (let attempt = 1; attempt <= DISCOVER_INJECT_ATTEMPTS; attempt++) {
    try {
      // executeScript cannot pass arguments to a `files` injection, so the job is seeded
      // into the isolated world first — both injections share that world's `window`.
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (seed) => {
          window.__IGD_JOB__ = seed;
          window.__IGD_STOP__ = false;
        },
        args: [job],
      });
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content-ig-discover.js"] });
      return true;
    } catch (e) {
      lastError = e;
      if (attempt < DISCOVER_INJECT_ATTEMPTS) await discoverSleep(1500 * attempt);
    }
  }

  await enterDiscoverPause(
    "injection_failed",
    "Discovery script tab pe chal nahi paaya " +
      DISCOVER_INJECT_ATTEMPTS +
      " koshish ke baad (" +
      (lastError && lastError.message ? lastError.message : "unknown") +
      "). Tab check karke Resume dabao."
  );
  return false;
}

async function signalDiscoverStop(tabId) {
  if (tabId == null) return;
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: () => {
        window.__IGD_STOP__ = true;
      },
    });
  } catch (e) {
    // Tab closed or navigated away — the loop is already gone.
  }
}

// ------------------------------------------------------------------------ batch pump

// Takes the next slice of the frontier and runs it. The only place a batch is started, so
// start / resume / alarm all funnel through the same path.
async function pumpDiscoverBatch() {
  const state = await getDiscoverState();
  if (!discoverStatusIsActive(state.status) && state.status !== "running") return;

  let batch = state.activeBatch || [];
  if (!batch.length) {
    batch = (state.queue || []).slice(0, DISCOVER_BATCH_SIZE);
    if (!batch.length) {
      await finishDiscoverRun("queue empty");
      return;
    }
    await setDiscoverState({
      activeBatch: batch,
      queue: (state.queue || []).slice(batch.length),
      phase: state.enrichStarted ? "enriching" : "discovering",
      lastEvent: batch.length + " task chal rahe hain (" + describeTask(batch[0]) + " se shuru)",
    });
  }

  const refreshed = await getDiscoverState();
  const { tabId, ready } = await openDiscoverTab(refreshed);
  if (ready) {
    // The tab is already sitting on instagram.com, so onUpdated will never fire for it —
    // inject straight away instead of waiting for a load that is not coming.
    const current = await getDiscoverState();
    await injectDiscoverFetcher(tabId, current);
  }
}

function describeTask(task) {
  if (!task) return "-";
  if (task.kind === "chain") return "@" + task.handle;
  if (task.kind === "enrich") return "@" + task.handle + " (detail)";
  if (task.kind === "hashtag") return "#" + task.tag;
  if (task.kind === "search") return '"' + task.term + '"';
  return task.kind;
}

// --------------------------------------------------------------------- panel commands

async function startDiscoverRun(msg) {
  const { tasks, skipped } = parseDiscoverSeeds(msg.seeds);

  if (!tasks.length) {
    await setDiscoverState({
      status: "idle",
      lastEvent: "Koi sahi seed nahi mila — @handle, #tag ya search phrase daalo",
    });
    return;
  }

  await chrome.alarms.clear(DISCOVER_ALARM);
  chrome.notifications.clear(DISCOVER_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });

  // Depth 3 is the ceiling on purpose: each level multiplies the request count, and past
  // three hops the walk has usually left the niche the seeds described.
  // Written as an explicit finite check, not `|| 2`: depth 0 ("just the seeds") is a real
  // choice a user can make, and it is falsy, so the usual default-or idiom would silently
  // turn it into a two-level walk.
  const requestedDepth = Number(msg.maxDepth);
  const maxDepth = Math.max(0, Math.min(3, Number.isFinite(requestedDepth) ? requestedDepth : 2));

  // Handles the user has already exported or does not want back. Seeded straight into
  // seenHandles, so the dedupe that already exists drops them — no extra check in the hot
  // path, and a re-seen exclude can never re-enter the frontier either.
  const excludeHandles = [];
  for (const raw of Array.isArray(msg.excludes) ? msg.excludes : []) {
    const handle = normalizeProfileHandle(raw);
    if (handle && !excludeHandles.includes(handle)) excludeHandles.push(handle);
  }
  const maxCandidates = Math.max(
    50,
    Math.min(DISCOVER_CANDIDATE_HARD_CAP, Number(msg.maxCandidates) || 500)
  );
  const stepDelaySec = Math.max(2, Number(msg.stepDelaySec) || 4);
  const batchDelaySec = Math.max(5, Number(msg.batchDelaySec) || 10);
  const minFollowers = Math.max(0, Number(msg.minFollowers) || 0);
  const maxFollowers = Math.max(minFollowers + 1, Number(msg.maxFollowers) || 1000000);

  const fresh = {
    ...defaultDiscoverState(),
    status: "running",
    phase: "discovering",
    seeds: Array.isArray(msg.seeds) ? msg.seeds.filter((line) => line && line.trim()) : [],
    maxDepth,
    maxCandidates,
    stepDelaySec,
    batchDelaySec,
    minFollowers,
    maxFollowers,
    useChaining: msg.useChaining !== false,
    enrich: msg.enrich !== false,
    excludeHandles,
    downloadFolder: safeDownloadFolder(msg.downloadFolder),
    owner: msg.owner || null,
    queue: tasks,
    plannedTaskKeys: tasks.map((task) => task.key),
    seenHandles: excludeHandles.slice(),
    totals: { tasksDone: 0, tasksPlanned: tasks.length, candidates: 0, kept: 0 },
    lastEvent:
      "Start: " +
      tasks.length +
      " seed" +
      (skipped ? " (" + skipped + " line skip ki)" : "") +
      ", depth " +
      maxDepth +
      (excludeHandles.length ? ", " + excludeHandles.length + " handle exclude" : ""),
    updatedAt: Date.now(),
  };
  fresh.log = [fresh.lastEvent];
  await chrome.storage.local.set({ [DISCOVER_STATE_KEY]: fresh });

  await pumpDiscoverBatch();

  const state = await getDiscoverState();
  if (state.tabId != null) {
    try {
      await chrome.sidePanel.open({ tabId: state.tabId });
    } catch (e) {
      // Panel may already be open, or the user-gesture window expired — non-fatal.
    }
  }
}

async function resumeDiscoverRun() {
  const state = await getDiscoverState();
  if (state.status !== "paused" && state.status !== "stopped") return;
  if (!state.queue.length && !state.activeBatch.length) {
    await setDiscoverState({ lastEvent: "Kuch baaki nahi hai — Reset karke naya run chalao" });
    return;
  }

  if (state.pauseReason === "rate_limit" && Date.now() < state.backoffUntilTs) {
    const secondsLeft = Math.ceil((state.backoffUntilTs - Date.now()) / 1000);
    await setDiscoverState({ lastEvent: "Abhi " + secondsLeft + "s aur ruko — rate limit cool-down" });
    return;
  }

  chrome.notifications.clear(DISCOVER_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });

  await setDiscoverState({
    status: "running",
    pauseReason: "",
    lastEvent: "Resume — " + (state.queue.length + state.activeBatch.length) + " task baaki",
  });
  await pumpDiscoverBatch();
}

async function stopDiscoverRun() {
  const state = await getDiscoverState();
  await chrome.alarms.clear(DISCOVER_ALARM);
  chrome.notifications.clear(DISCOVER_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await signalDiscoverStop(state.tabId);
  // Same as a pause: unreported tasks go back so a later Resume repeats only those.
  await setDiscoverState({
    status: "stopped",
    phase: "",
    pendingInject: false,
    queue: [...(state.activeBatch || []), ...(state.queue || [])],
    activeBatch: [],
    lastEvent: "Run rok diya — ab tak mile " + state.totals.candidates + " candidate safe hain",
  });
}

async function resetDiscoverRun() {
  const state = await getDiscoverState();
  await chrome.alarms.clear(DISCOVER_ALARM);
  chrome.notifications.clear(DISCOVER_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await signalDiscoverStop(state.tabId);
  await chrome.storage.local.set({ [DISCOVER_STATE_KEY]: defaultDiscoverState() });
}

async function downloadDiscoverPartial() {
  const state = await getDiscoverState();
  if (!state.totals.candidates) {
    await setDiscoverState({ lastEvent: "Abhi kuch download karne layak nahi hai" });
    return;
  }
  const result = await saveDiscoverFile(state, {
    complete: false,
    reason: "partial: " + (state.pauseReason || state.status),
  });
  await setDiscoverState({
    lastEvent: result.ok ? "Partial file download ho gayi" : "Download fail hua — " + result.error,
  });
}

// ------------------------------------------------------ content-script report handlers

function isLiveDiscoverReport(state) {
  return state.status === "running";
}

// Merges one task's candidates into the run: dedupe, score, and decide whether each one
// earns a place on the frontier.
async function handleDiscoverTaskDone(msg) {
  const state = await getDiscoverState();
  if (!isLiveDiscoverReport(state)) return { ok: false, abort: true };

  const activeBatch = (state.activeBatch || []).filter((task) => task.key !== msg.taskKey);
  const finishedTask = (state.activeBatch || []).find((task) => task.key === msg.taskKey) || null;
  const scoreOpts = { minFollowers: state.minFollowers, maxFollowers: state.maxFollowers };

  // An enrich task is not discovery: it re-answers a candidate we already hold, so it
  // merges and re-scores in place instead of walking the dedupe/frontier path below —
  // which would drop it as a duplicate of itself.
  if (finishedTask && finishedTask.kind === "enrich") {
    const candidates = { ...state.candidates };
    const existing = candidates[finishedTask.handle];
    const incoming = msg.ok && Array.isArray(msg.candidates) ? msg.candidates[0] : null;
    let note;

    if (existing && incoming) {
      const merged = mergeDiscoverCandidate(existing, incoming);
      const scored = scoreDiscoverCandidate(merged, scoreOpts);
      candidates[finishedTask.handle] = {
        ...merged,
        score: scored.score,
        score_known_weight: scored.known,
        signals: scored.signals,
        keep: keepDiscoverCandidate(merged, scored, DISCOVER_KEEP_THRESHOLD),
        enriched: true,
      };
      note =
        "@" +
        finishedTask.handle +
        " detail mili — score " +
        (scored.score == null ? "?" : scored.score);
    } else {
      // The candidate keeps whatever the listing gave it; `enriched` stays false so the
      // file says plainly that this row was never filled in.
      note =
        "@" + finishedTask.handle + " ki detail nahi mili (" + (msg.reason || "unknown") + ")";
    }

    await setDiscoverState({
      activeBatch,
      candidates,
      totals: {
        ...state.totals,
        tasksDone: state.totals.tasksDone + 1,
        kept: countDiscoverKept(candidates),
      },
      lastEvent: note,
    });
    return { ok: true };
  }

  const seen = new Set(state.seenHandles || []);
  const planned = new Set(state.plannedTaskKeys || []);
  const candidates = { ...state.candidates };
  const queue = [...(state.queue || [])];
  const depth = finishedTask ? finishedTask.depth : 0;

  let added = 0;
  let kept = 0;
  let capped = state.capped;

  for (const raw of Array.isArray(msg.candidates) ? msg.candidates : []) {
    // The content script already filtered, but it runs in a page we do not control — the
    // worker validates anything it is about to store.
    const handle = normalizeProfileHandle(raw && raw.handle);
    if (!handle || seen.has(handle)) continue;

    if (Object.keys(candidates).length >= state.maxCandidates) {
      capped = capped || "max_candidates";
      break;
    }

    seen.add(handle);
    const scored = scoreDiscoverCandidate(raw, scoreOpts);
    const keep = keepDiscoverCandidate(raw, scored, DISCOVER_KEEP_THRESHOLD);

    const num = (value) => (typeof value === "number" ? value : null);
    const bool = (value) => (typeof value === "boolean" ? value : null);

    candidates[handle] = {
      handle,
      profile_url: profileUrlFor(handle),
      user_id: raw.user_id || null,
      full_name: raw.full_name || null,
      biography: typeof raw.biography === "string" ? raw.biography : null,
      followers: num(raw.followers),
      following: num(raw.following),
      posts_count: num(raw.posts_count),
      is_private: bool(raw.is_private),
      is_verified: bool(raw.is_verified),
      is_business: bool(raw.is_business),
      category: raw.category || null,
      external_url: raw.external_url || null,
      score: scored.score,
      score_known_weight: scored.known,
      signals: scored.signals,
      keep,
      enriched: false,
      found_via: finishedTask ? describeTask(finishedTask) : "unknown",
      found_kind: finishedTask ? finishedTask.kind : null,
      depth,
    };
    added += 1;
    if (keep) kept += 1;

    // Frontier growth. Only accounts that look like creators are worth a chaining request,
    // and only while there is depth left — otherwise one bad seed drags the whole run into
    // a neighbourhood nobody asked for.
    const chainKey = "chain:" + handle;
    if (
      state.useChaining &&
      keep &&
      depth < state.maxDepth &&
      !planned.has(chainKey) &&
      !(state.deadSources || []).includes("chain")
    ) {
      if (planned.size >= DISCOVER_MAX_TASKS) {
        capped = capped || "max_tasks";
      } else {
        planned.add(chainKey);
        queue.push({
          kind: "chain",
          handle,
          userId: raw.user_id || null,
          depth: depth + 1,
          key: chainKey,
        });
      }
    }
  }

  const totals = {
    tasksDone: state.totals.tasksDone + 1,
    tasksPlanned: planned.size,
    candidates: state.totals.candidates + added,
    // Recounted rather than incremented: enrichment can flip a candidate's keep decision
    // either way, so a running tally would drift away from the file's own contents.
    kept: countDiscoverKept(candidates),
  };

  const label = finishedTask ? describeTask(finishedTask) : msg.taskKey;
  const outcome = msg.ok
    ? label + ": " + added + " naye (" + kept + " creator-jaise)"
    : label + " fail — " + (msg.reason || "unknown") + (msg.detail ? " (" + msg.detail + ")" : "");

  await setDiscoverState({
    activeBatch,
    queue,
    seenHandles: Array.from(seen),
    plannedTaskKeys: Array.from(planned),
    candidates,
    totals,
    capped,
    lastEvent: outcome + (msg.detail && msg.ok ? " — " + msg.detail : ""),
  });

  return { ok: true };
}

async function handleDiscoverSourceDead(msg) {
  const state = await getDiscoverState();
  if (!isLiveDiscoverReport(state)) return { ok: false, abort: true };

  const deadSources = state.deadSources.includes(msg.source)
    ? state.deadSources
    : [...state.deadSources, msg.source];
  // Drop everything queued for a source that cannot answer, rather than walking the whole
  // frontier just to fail each task individually.
  const queue = state.queue.filter((task) => task.kind !== msg.source);

  await setDiscoverState({
    deadSources,
    queue,
    lastEvent: msg.detail || msg.source + " source band kar diya",
  });
  return { ok: true };
}

async function handleDiscoverBatchDone() {
  const state = await getDiscoverState();
  if (!isLiveDiscoverReport(state)) return { ok: false, abort: true };

  if (state.capped) {
    await setDiscoverState({
      lastEvent:
        state.capped === "max_candidates"
          ? "Candidate cap (" + state.maxCandidates + ") lag gaya — walk yahin rok rahe hain"
          : "Task cap (" + DISCOVER_MAX_TASKS + ") lag gaya — walk yahin rok rahe hain",
    });
    await finishDiscoverRun(state.capped);
    return { ok: true };
  }

  if (!state.queue.length) {
    // The frontier is drained. If enrichment is on, that is not the end of the run — it is
    // the start of the second pass, which turns thin listing records into scoreable ones.
    if (state.enrich && !state.enrichStarted) {
      const { tasks, dropped } = buildDiscoverEnrichQueue(state);
      await setDiscoverState({ enrichStarted: true });
      if (tasks.length) {
        await setDiscoverState({
          status: "waiting_delay",
          phase: "",
          activeBatch: [],
          queue: tasks,
          totals: { ...state.totals, tasksPlanned: state.totals.tasksPlanned + tasks.length },
          lastEvent:
            "Discovery poori — ab " +
            tasks.length +
            " candidate ki detail nikaal rahe hain" +
            (dropped ? " (" + dropped + " enrich cap ke kaaran chhoot gaye)" : ""),
        });
        scheduleDiscoverAlarm(state.batchDelaySec);
        return { ok: true };
      }
    }
    await finishDiscoverRun("queue empty");
    return { ok: true };
  }

  await setDiscoverState({
    status: "waiting_delay",
    phase: "",
    activeBatch: [],
    lastEvent: "Batch poora — " + state.queue.length + " task baaki, thoda ruk ke aage",
  });
  scheduleDiscoverAlarm(state.batchDelaySec);
  return { ok: true };
}

async function handleDiscoverError(msg) {
  const state = await getDiscoverState();
  if (!isLiveDiscoverReport(state)) return { ok: false, abort: true };

  const text = DISCOVER_PAUSE_MESSAGES[msg.reason] || "Discovery ruk gayi (" + msg.reason + ")";
  await enterDiscoverPause(msg.reason, text + (msg.detail ? " — " + msg.detail : ""));
  return { ok: true, abort: true };
}

const DISCOVER_PAUSE_MESSAGES = {
  login_wall:
    "Instagram ne login maanga (401). Us tab me check karo ki tum logged in ho — agar ho, to yeh temporary API block hai, 10-15 min ruk ke Resume karo.",
  forbidden: "Instagram ne request block ki (403). Thoda ruk ke Resume karo.",
  rate_limit: "Rate limit lag gaya — kuch minute ruko, phir Resume.",
  challenge: "Instagram ne verification maanga — tab me clear karke Resume dabao.",
  network: "Network gir gaya — internet check karke Resume dabao.",
  wrong_origin: "Tab instagram.com pe nahi tha — Resume se dobara khol ke try karo.",
};

// ----------------------------------------------------------------------- event wiring

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return false;

  if (msg.type.startsWith("DISCOVER_")) {
    queueDiscoverTask(async () => {
      switch (msg.type) {
        case "DISCOVER_START":
          await startDiscoverRun(msg);
          break;
        case "DISCOVER_RESUME":
          await resumeDiscoverRun();
          break;
        case "DISCOVER_STOP":
          await stopDiscoverRun();
          break;
        case "DISCOVER_RESET":
          await resetDiscoverRun();
          break;
        case "DISCOVER_DOWNLOAD":
          await downloadDiscoverPartial();
          break;
        default: // DISCOVER_GET_STATE and anything unknown just read the state back
          break;
      }
    })
      .catch(() => undefined)
      .then(async () => {
        sendResponse(await getDiscoverState());
      });
    return true;
  }

  if (msg.type.startsWith("IGD_")) {
    queueDiscoverTask(async () => {
      switch (msg.type) {
        case "IGD_TASK_DONE":
          return handleDiscoverTaskDone(msg);
        case "IGD_SOURCE_DEAD":
          return handleDiscoverSourceDead(msg);
        case "IGD_BATCH_DONE":
          return handleDiscoverBatchDone();
        case "IGD_ERROR":
          return handleDiscoverError(msg);
        case "IGD_NOTE":
          await setDiscoverState({ lastEvent: msg.detail || "" });
          return { ok: true };
        default:
          return { ok: true };
      }
    })
      .then(
        (result) => sendResponse(result || { ok: true }),
        (e) =>
          // An orchestrator bug must not leave the content script hanging on an ack.
          sendResponse({ ok: false, abort: true, error: e && e.message ? e.message : String(e) })
      );
    return true;
  }

  return false; // not ours
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  queueDiscoverTask(async () => {
    const state = await getDiscoverState();
    if (state.status !== "running" || tabId !== state.tabId || !state.pendingInject) return;

    const url = tab && tab.url ? tab.url : "";
    if (!/^https:\/\/(www\.)?instagram\.com\//i.test(url)) {
      // Chrome fires `complete` for about:blank on a fresh tab before the real navigation.
      return;
    }

    await setDiscoverState({ pendingInject: false });
    const refreshed = await getDiscoverState();
    await injectDiscoverFetcher(tabId, refreshed);
  }).catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== DISCOVER_ALARM) return;
  queueDiscoverTask(async () => {
    const state = await getDiscoverState();
    if (state.status !== "waiting_delay") return;
    await setDiscoverState({ status: "running" });
    await pumpDiscoverBatch();
  }).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  queueDiscoverTask(async () => {
    const state = await getDiscoverState();
    if (state.tabId !== tabId) return;
    if (discoverStatusIsActive(state.status)) {
      await chrome.alarms.clear(DISCOVER_ALARM);
      chrome.action.setBadgeText({ text: "" });
      await setDiscoverState({
        status: "stopped",
        phase: "",
        pendingInject: false,
        tabId: null,
        queue: [...(state.activeBatch || []), ...(state.queue || [])],
        activeBatch: [],
        lastEvent: "Tab band ho gaya — jo mila woh safe hai, Resume se aage chalega",
      });
    }
  }).catch(() => undefined);
});
