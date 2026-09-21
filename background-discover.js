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
// The supervisor. Only armed for an unattended run, and it is a *periodic* alarm rather
// than three one-shot ones on purpose: it re-reads the whole state each tick and decides
// what the run needs, so a tick that never fired (laptop asleep) costs nothing — the next
// one sees the same situation and acts on it.
const DISCOVER_WATCHDOG_ALARM = "discoverWatchdog";
const DISCOVER_NOTIF_ID = "discover-pause";

const DISCOVER_INJECT_ATTEMPTS = 3;
const DISCOVER_RATE_LIMIT_BASE_MS = 60 * 1000;
const DISCOVER_RATE_LIMIT_MAX_MS = 15 * 60 * 1000;

const DISCOVER_WATCHDOG_MINUTES = 2;
// Only a rate limit is ever auto-resumed, and only once its full backoff has elapsed. That
// is waiting a block out, which is exactly what the human would have been doing — it is not
// evasion, and the distinction is the whole reason the other pause reasons are excluded. A
// login wall, a 403 and a checkpoint all need a person, and clicking past them
// automatically would be working around a block rather than respecting it.
const DISCOVER_MAX_AUTO_RESUMES = 4;
// A silently dead batch (discarded tab, crashed page) is a mechanical failure, not a block,
// so recovering from it is just re-doing work that never happened. Still bounded: if it
// keeps happening something is wrong that a restart will not fix.
const DISCOVER_MAX_STALL_RECOVERIES = 20;
const DISCOVER_MAX_RUN_HOURS = 14;

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
    // Delivery-side preference only. It never gates `keep` and never gates the walk: most
    // listing records carry no bio, no city and no phone, so requiring India evidence to
    // chain from an account would collapse the frontier on the first hop. Geography comes
    // from the seeds; this decides which handles the run *hands over* at the end.
    indiaOnly: false,

    // Unattended ("raat bhar") operation. Off by default: this project's whole stance is
    // that a run stops and waits for a human, and this is the single place that is relaxed
    // — narrowly, and only for the one failure that clears itself with time.
    unattended: false,
    deadlineTs: 0, // 0 = no deadline; otherwise stop and save at this timestamp
    autoResumesUsed: 0,
    stallRecoveries: 0,

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
    totals: { tasksDone: 0, tasksPlanned: 0, candidates: 0, kept: 0, inBand: 0, indiaInBand: 0 },
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
    const intent =
      COLLAB_INTENT_RE.test(bio) ||
      EMAIL_RE.test(bio) ||
      Boolean(candidate.email) ||
      Boolean(candidate.phone);
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
// Rejects private accounts unconditionally and enforces follower bounds when measured.
function keepDiscoverCandidate(candidate, scored, threshold, minFollowers, maxFollowers) {
  if (candidate.is_private === true) return false;
  if (candidate.signals && candidate.signals.is_private === true) return false;
  if (typeof candidate.followers === "number") {
    const min = typeof minFollowers === "number" ? minFollowers : 1000;
    const max = typeof maxFollowers === "number" ? maxFollowers : Infinity;
    if (candidate.followers < min || candidate.followers > max) return false;
  }
  if (scored && scored.score == null) return true;
  return scored && scored.score >= threshold;
}

const DISCOVER_KEEP_THRESHOLD = 50;

// --------------------------------------------------------------------- india & contact detection
//
// Same null rule as the scorer, for the same reason: this looks for *positive* evidence
// that an account is Indian and never reads the opposite out of silence. Most listing
// records carry no bio, no city and no phone, so an account with nothing to go on comes
// back "unknown" — calling those foreign would throw away most of a run, and calling them
// Indian would make the list a lie. The verdict is therefore only ever "yes" or "unknown",
// and the delivery list asks for "yes".

// The scripts written in India. Unlike a place name these do not collide with anywhere
// foreign, so one of them on its own is enough.
const INDIC_SCRIPT_RE =
  /[ऀ-ॿঀ-৿਀-੿઀-૿଀-୿஀-௿ఀ-౿ಀ-೿ഀ-ൿ]/;
const INDIA_FLAG_RE = /(?:🇮🇳|[\uD83C][\uDDEE][\uD83C][\uDDF3])/u;
const INDIA_PHONE_RE = /(?:\+\s?91[\s-]?\d{5}|\b\+?91[\s.-]?[6-9]\d{9}\b)/;
const INDIA_CONTACT_PHONE_RE =
  /(?:wa|whatsapp|call|contact|booking|enquiry|enquiries|dm|phone|ph|mob|biz)[\s:.-]*(?:\+?91[\s.-]?)?([6-9]\d{9})\b/i;
const INDIA_WORD_RE =
  /\b(india|indian|bharat|hindustan|desi|deshi|haryanvi|punjabi|marathi|bengali|gujarati|pahadi|pahari|bihari|kumaoni|garhwali|jaat|jatt|gujjar|gurjar|rajput|yadav|pandit|sardar|khalsa|hindustani|namaste|pranam)\b/i;
const INDIA_CULTURE_RE =
  /\b(ram\s*ram|jai\s*shree\s*ram|jai\s*sita\s*ram|jai\s*bajrang\s*bali|jai\s*mata\s*di|jai\s*bhole|har\s*har\s*mahadev|radhe\s*radhe|hare\s*krishna|jai\s*hind|vande\s*mataram|bharat\s*mata)\b/i;
const INDIA_MONEY_RE = /(₹|\brs\.?\s*\d|\binr\b)/i;

// Cities, states, common abbreviations and regions.
const INDIA_PLACES = [
  "mumbai", "bombay", "navi mumbai", "thane", "delhi", "gurgaon", "gurugram", "noida",
  "greater noida", "ghaziabad", "faridabad", "bengaluru", "bangalore", "hyderabad",
  "chennai", "madras", "kolkata", "calcutta", "pune", "ahmedabad", "surat", "jaipur",
  "lucknow", "kanpur", "nagpur", "indore", "bhopal", "patna", "vadodara", "ludhiana",
  "agra", "nashik", "rajkot", "varanasi", "srinagar", "amritsar", "jodhpur", "coimbatore",
  "kochi", "cochin", "thiruvananthapuram", "trivandrum", "mysuru", "mysore", "mangalore",
  "madurai", "visakhapatnam", "vizag", "vijayawada", "guwahati", "bhubaneswar",
  "dehradun", "chandigarh", "raipur", "ranchi", "jamshedpur", "udaipur", "jalandhar",
  "aurangabad", "shillong", "imphal", "gangtok", "siliguri", "kozhikode", "calicut",
  "thrissur", "tirupati", "salem", "jabalpur", "gwalior", "meerut", "allahabad",
  "prayagraj", "bareilly", "aligarh", "kota", "ajmer", "bikaner", "hubli", "belgaum",
  "warangal", "kolhapur", "solapur", "panaji", "pondicherry", "puducherry",
  "maharashtra", "karnataka", "kerala", "tamil nadu", "telangana", "andhra pradesh",
  "andhra", "gujarat", "rajasthan", "punjab", "haryana", "bihar", "odisha", "orissa",
  "assam", "jharkhand", "chhattisgarh", "uttarakhand", "himachal", "uttar pradesh",
  "madhya pradesh", "west bengal", "goa", "sikkim", "manipur", "meghalaya", "nagaland",
  "tripura", "mizoram", "arunachal", "ncr", "delhi ncr", "dilli", "mohali", "panchkula",
  "patiala", "bathinda", "rohtak", "hisar", "panipat", "sonipat", "karnal", "kurukshetra",
  "ambala", "jhajjar", "bhiwani", "rewari", "mathura", "vrindavan", "kashi", "banaras",
  "ayodhya", "gorakhpur", "jhansi", "alwar", "sikar", "ujjain", "haridwar", "rishikesh",
  "shimla", "manali", "dharamshala", "jammu", "bhavnagar", "jamnagar", "howrah", "cuttack",
  "puri", "guntur", "up", "mp", "hr", "pb", "rj", "uk", "hp", "mh", "gj", "dl", "blr",
  "bom", "del", "hyd"
];
const INDIA_PLACE_RE = new RegExp(
  "\\b(" + INDIA_PLACES.map((place) => place.replace(/ /g, "\\s+")).join("|") + ")\\b",
  "i"
);

// Strong signals stand alone; weak ones need company. A rupee sign or a .in link is a real
// hint, but neither is rare enough outside India to convict on by itself — whereas a +91
// number, a Devanagari bio, or a verified Indian city is strong evidence.
const INDIA_WEAK_SIGNALS = new Set(["bio_money", "in_domain"]);

function extractCandidateContact(candidate) {
  const bio = typeof candidate.biography === "string" ? candidate.biography : "";

  let email =
    typeof candidate.email === "string" && candidate.email
      ? candidate.email.trim().toLowerCase()
      : null;
  if (!email && bio) {
    const m = bio.match(EMAIL_RE);
    if (m) email = m[0].toLowerCase();
  }

  let phone =
    typeof candidate.phone === "string" && candidate.phone
      ? candidate.phone.trim()
      : null;
  if (!phone && bio) {
    const contactM = bio.match(INDIA_CONTACT_PHONE_RE);
    if (contactM && contactM[1]) {
      phone = contactM[1];
    } else {
      const p91M = bio.match(INDIA_PHONE_RE);
      if (p91M) {
        phone = p91M[0].replace(/\s+/g, "");
      }
    }
  }

  return { email, phone };
}

function detectIndiaSignals(candidate) {
  const bio = typeof candidate.biography === "string" ? candidate.biography : "";
  const name = typeof candidate.full_name === "string" ? candidate.full_name : "";
  const city = typeof candidate.city_name === "string" ? candidate.city_name : "";
  const url = typeof candidate.external_url === "string" ? candidate.external_url : "";
  const signals = [];

  if (String(candidate.phone_country_code || "").replace(/\D/g, "") === "91") {
    signals.push("phone_country_code");
  }
  if (city && INDIA_PLACE_RE.test(city)) signals.push("city");
  if (INDIA_FLAG_RE.test(bio) || INDIA_FLAG_RE.test(name)) signals.push("flag");
  if (INDIC_SCRIPT_RE.test(bio) || INDIC_SCRIPT_RE.test(name)) signals.push("indic_script");
  if (INDIA_CULTURE_RE.test(bio) || INDIA_CULTURE_RE.test(name)) signals.push("culture");
  if (INDIA_CONTACT_PHONE_RE.test(bio) || INDIA_PHONE_RE.test(bio)) signals.push("bio_phone");
  if (INDIA_WORD_RE.test(bio)) signals.push("bio_india");
  if (INDIA_PLACE_RE.test(bio)) signals.push("bio_place");
  if (INDIA_MONEY_RE.test(bio)) signals.push("bio_money");

  const host = (url.match(/^https?:\/\/([^/?#]+)/i) || [])[1] || "";
  if (/\.in$/i.test(host.replace(/:\d+$/, ""))) signals.push("in_domain");

  const strong = signals.filter((signal) => !INDIA_WEAK_SIGNALS.has(signal)).length;
  return {
    india: strong >= 1 || signals.length >= 2 ? "yes" : "unknown",
    india_signals: signals,
  };
}

// Request budget for the enrichment pass. Dynamically scales with the requested max_candidates.
const DISCOVER_DEFAULT_MAX_ENRICH = 500;

// /info/ is strictly richer than a listing record, but a null in it still means "this
// source did not say" — so a field is only overwritten when the new answer actually
// exists. Provenance (who found this, at what depth) always stays with the original.
function mergeDiscoverCandidate(existing, incoming) {
  const pick = (key) =>
    incoming[key] == null || incoming[key] === "" ? existing[key] : incoming[key];
  const num = (key) => (typeof incoming[key] === "number" ? incoming[key] : existing[key]);
  const bool = (key) => (typeof incoming[key] === "boolean" ? incoming[key] : existing[key]);

  const merged = {
    ...existing,
    user_id: existing.user_id || incoming.user_id || null,
    full_name: pick("full_name"),
    biography: pick("biography"),
    category: pick("category"),
    external_url: pick("external_url"),
    email: pick("email"),
    phone: pick("phone"),
    // Only /info/ ever supplies these, so on a merge they are almost always the new half.
    city_name: pick("city_name"),
    phone_country_code: pick("phone_country_code"),
    followers: num("followers"),
    following: num("following"),
    posts_count: num("posts_count"),
    is_private: bool("is_private"),
    is_verified: bool("is_verified"),
    is_business: bool("is_business"),
  };

  const contacts = extractCandidateContact(merged);
  merged.email = contacts.email;
  merged.phone = contacts.phone;
  return merged;
}

// Which candidates earn a detail request: kept ones only, best-scored first, and only
// those actually missing what /info/ would add. Re-asking for data we already hold is a
// request spent for nothing.
function buildDiscoverEnrichQueue(state) {
  const rows = Object.values(state.candidates || {}).filter(
    (row) => row.keep && !row.enriched && row.followers == null
  );
  // Best-scored first, and — when the run asked for Indian creators — anything already
  // showing India evidence ahead of anything that does not. The detail pass is the scarcest
  // resource in a run (one request per candidate, hard-capped), so spending it on the
  // candidates most likely to survive the final filter is worth the extra comparison. Most
  // rows are "unknown" at this point, so this only ever promotes; nothing is demoted for
  // lacking evidence.
  const indiaFirst = !!state.indiaOnly;
  rows.sort((a, b) => {
    if (indiaFirst) {
      const byIndia = (b.india === "yes" ? 1 : 0) - (a.india === "yes" ? 1 : 0);
      if (byIndia) return byIndia;
    }
    return (b.score == null ? -1 : b.score) - (a.score == null ? -1 : a.score);
  });
  const enrichCap = Math.min(
    Math.max(state.maxCandidates || DISCOVER_DEFAULT_MAX_ENRICH, 500),
    DISCOVER_CANDIDATE_HARD_CAP
  );
  const slice = rows.slice(0, enrichCap);
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

// The delivery filter, deliberately separate from `keep`. `keep` answers "is this worth
// looking at" and is generous on purpose — an unmeasured account is not evidence against
// itself, so it stays. This answers the narrower question a file has to be able to promise:
// did we actually *measure* this account, and was it inside the band the user asked for.
// A null follower count fails that promise without being a rejection, so such a row is
// absent here and still present in kept_handles and in candidates.
function inBandDiscoverRows(rows, minFollowers, maxFollowers) {
  const min = typeof minFollowers === "number" ? minFollowers : 0;
  const max = typeof maxFollowers === "number" ? maxFollowers : Infinity;
  return (rows || []).filter(
    (row) =>
      row &&
      row.keep &&
      typeof row.followers === "number" &&
      row.followers >= min &&
      row.followers <= max
  );
}

// The list an overnight run actually exists to produce: kept, measured, inside the band,
// and with real evidence of being Indian. Layered on inBandDiscoverRows so the two filters
// can never drift apart, and narrower than either — an account missing any one of the four
// is absent here and still fully present in the file.
function indiaInBandDiscoverRows(rows, minFollowers, maxFollowers) {
  return inBandDiscoverRows(rows, minFollowers, maxFollowers).filter(
    (row) => row.india === "yes"
  );
}

// All three delivery counts in one pass, recounted rather than incremented: enrichment can
// flip any of them in either direction, so a running tally would drift away from what the
// file actually contains. The panel shows all three side by side because the gaps between
// them are the honest picture of a run — kept is "worth a look", in-band is "measured", and
// india-in-band is what the run was asked for.
function countDiscoverDelivery(candidates, minFollowers, maxFollowers) {
  const rows = Object.values(candidates || {});
  return {
    kept: rows.filter((row) => row && row.keep).length,
    inBand: inBandDiscoverRows(rows, minFollowers, maxFollowers).length,
    indiaInBand: indiaInBandDiscoverRows(rows, minFollowers, maxFollowers).length,
  };
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

  // Filter to only clean, qualified, non-private, in-band candidates
  const min = typeof state.minFollowers === "number" ? state.minFollowers : 1000;
  const max = typeof state.maxFollowers === "number" ? state.maxFollowers : Infinity;
  const qualifiedRows = rows.filter(
    (row) =>
      row &&
      row.keep &&
      !row.is_private &&
      (row.followers == null || (row.followers >= min && row.followers <= max)) &&
      (!state.indiaOnly || row.india === "yes")
  );

  const cleanHandles = qualifiedRows.map((row) => row.handle);

  return JSON.stringify(
    {
      generated_at: new Date().toISOString(),
      complete,
      incomplete_reason: complete ? null : (options && options.reason) || "incomplete",
      seeds: state.seeds,
      settings: {
        max_depth: state.maxDepth,
        max_candidates: state.maxCandidates,
        follower_band: [state.minFollowers, state.maxFollowers],
        keep_threshold: DISCOVER_KEEP_THRESHOLD,
        chaining_enabled: state.useChaining,
        enrich_enabled: state.enrich,
        excluded_handles: state.excludeHandles.length,
        india_only: !!state.indiaOnly,
        unattended: !!state.unattended,
      },
      runaway_guard_hit: state.capped,
      sources_disabled: state.deadSources,
      totals: {
        ...state.totals,
        candidates: qualifiedRows.length,
        kept: qualifiedRows.length,
        inBand: qualifiedRows.length,
        indiaInBand: qualifiedRows.filter((r) => r.india === "yes").length,
      },
      candidates: qualifiedRows,
      handles: cleanHandles,
      // Compatibility keys mapped to the same single verified list
      kept_handles: cleanHandles,
      in_band_handles: cleanHandles,
      india_in_band_handles: cleanHandles,
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
  await chrome.alarms.clear(DISCOVER_WATCHDOG_ALARM);
  const state = await setDiscoverState({ phase: "downloading" });
  const result = await saveDiscoverFile(state, { complete: !state.capped, reason });

  chrome.action.setBadgeText({ text: result.ok ? "✓" : "⚠" });
  chrome.action.setBadgeBackgroundColor({ color: result.ok ? "#188038" : "#d93025" });

  // All three counts, because the gaps between them are the honest summary of a run: kept
  // is what is worth a look, in-band is what could actually be measured against the band,
  // and india-in-band is what was asked for. Reporting only the last would hide how much
  // of the run went unmeasured.
  const counts = countDiscoverDelivery(
    state.candidates,
    state.minFollowers,
    state.maxFollowers
  );

  await setDiscoverState({
    status: "done",
    phase: "",
    pendingInject: false,
    activeBatch: [],
    lastEvent: result.ok
      ? "Ho gaya — " +
        counts.kept +
        " creator-jaise, " +
        counts.inBand +
        " band ke andar naape hue, " +
        counts.indiaInBand +
        " unme India wale (" +
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

  const unattended = msg.unattended === true;
  const runHours = Math.max(1, Math.min(DISCOVER_MAX_RUN_HOURS, Number(msg.runHours) || 8));

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
    indiaOnly: msg.indiaOnly === true,
    unattended,
    // Stored as an absolute timestamp rather than a duration to count down. Alarms are
    // missed while the laptop sleeps, so anything that counted ticks would drift past
    // morning by however long the machine was off.
    deadlineTs: unattended ? Date.now() + runHours * 60 * 60 * 1000 : 0,
    queue: tasks,
    plannedTaskKeys: tasks.map((task) => task.key),
    seenHandles: excludeHandles.slice(),
    totals: {
      tasksDone: 0,
      tasksPlanned: tasks.length,
      candidates: 0,
      kept: 0,
      inBand: 0,
      indiaInBand: 0,
    },
    lastEvent:
      "Start: " +
      tasks.length +
      " seed" +
      (skipped ? " (" + skipped + " line skip ki)" : "") +
      ", depth " +
      maxDepth +
      (excludeHandles.length ? ", " + excludeHandles.length + " handle exclude" : "") +
      (msg.indiaOnly === true ? ", sirf India" : "") +
      (unattended ? ", raat bhar mode (" + runHours + "h)" : ""),
    updatedAt: Date.now(),
  };
  fresh.log = [fresh.lastEvent];
  await chrome.storage.local.set({ [DISCOVER_STATE_KEY]: fresh });

  if (unattended) armDiscoverWatchdog();
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
  // Re-armed rather than assumed: a manual Resume can follow a stop, a browser restart or
  // a pause the watchdog gave up on, and in all three the periodic alarm is gone.
  if (state.unattended) armDiscoverWatchdog();
  await pumpDiscoverBatch();
}

async function stopDiscoverRun() {
  const state = await getDiscoverState();
  await chrome.alarms.clear(DISCOVER_ALARM);
  // Stop is a person saying stop. The watchdog does not get to overrule that, so it is
  // disarmed here rather than left to notice the status change on its next tick.
  await chrome.alarms.clear(DISCOVER_WATCHDOG_ALARM);
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
  await chrome.alarms.clear(DISCOVER_WATCHDOG_ALARM);
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

// ------------------------------------------------------------------ unattended watchdog

// How long a live batch may go quiet before it is presumed dead. It has to clear the
// longest *legitimate* silence comfortably: one chain task can be two paced requests, and
// a slow response adds network on top of that.
function discoverStallMs(state) {
  return Math.max(6 * 60 * 1000, (state.stepDelaySec || 4) * 8 * 1000);
}

function armDiscoverWatchdog() {
  chrome.alarms.create(DISCOVER_WATCHDOG_ALARM, {
    delayInMinutes: DISCOVER_WATCHDOG_MINUTES,
    periodInMinutes: DISCOVER_WATCHDOG_MINUTES,
  });
}

// The supervisor for an unattended run, and the only place this project acts on a stopped
// run without a human. It keeps no memory of its own: every tick re-derives what the run
// needs from the stored state, so a tick that never fired — laptop asleep, Chrome
// suspended — costs nothing, and the next one sees the same situation and handles it.
//
// Everything it does is something the user would have done by hand at 3am if they were
// awake. What it will not do is get past a block: a login wall, a 403 and a checkpoint all
// still sit there until a person deals with them.
async function runDiscoverWatchdog() {
  const state = await getDiscoverState();

  if (!state.unattended || !discoverStatusIsActive(state.status)) {
    await chrome.alarms.clear(DISCOVER_WATCHDOG_ALARM);
    return;
  }

  // 1. The deadline, checked first because "stop by morning" has to beat every recovery
  // below it. A run still limping along at 9am is worse than one that saved and stopped
  // at 7 — and the file only exists once the run finishes.
  if (state.deadlineTs && Date.now() >= state.deadlineTs) {
    await chrome.alarms.clear(DISCOVER_WATCHDOG_ALARM);
    await signalDiscoverStop(state.tabId);
    await setDiscoverState({
      lastEvent: "Raat wala time poora — file save karke band kar rahe hain",
    });
    await finishDiscoverRun("deadline");
    return;
  }

  // 2. A rate limit that has served its full cool-down. The one pause reason that is ever
  // resumed automatically, because waiting a block out is what a human would have done
  // anyway; see DISCOVER_MAX_AUTO_RESUMES for why the other reasons are excluded.
  if (state.status === "paused") {
    if (state.pauseReason !== "rate_limit") return;
    if (Date.now() < state.backoffUntilTs) return;
    const used = state.autoResumesUsed || 0;
    if (used >= DISCOVER_MAX_AUTO_RESUMES) return;
    await setDiscoverState({
      autoResumesUsed: used + 1,
      lastEvent:
        "Rate-limit cool-down poora — apne aap resume (" +
        (used + 1) +
        "/" +
        DISCOVER_MAX_AUTO_RESUMES +
        ")",
    });
    await resumeDiscoverRun();
    return;
  }

  // 3. A batch that stopped talking. Chrome discards a background tab under memory
  // pressure and the injected loop dies with it — no error, no onRemoved, nothing reported,
  // and the run sits at "running" until morning. Waiting longer never fixes it, so the
  // unreported tasks go back on the queue and the batch starts again. That is redoing work
  // which never happened, which is a different thing from retrying around a block.
  const idleMs = Date.now() - (state.updatedAt || 0);
  const stalled =
    (state.status === "running" && idleMs > discoverStallMs(state)) ||
    (state.status === "waiting_delay" &&
      idleMs > Math.max(discoverStallMs(state), (state.batchDelaySec || 10) * 3000));
  if (!stalled) return;

  if ((state.stallRecoveries || 0) >= DISCOVER_MAX_STALL_RECOVERIES) {
    await enterDiscoverPause(
      "stalled",
      "Batch baar-baar chup ho ja raha hai (" +
        DISCOVER_MAX_STALL_RECOVERIES +
        " baar restart kiya). Tab check karke Resume dabao."
    );
    return;
  }

  await setDiscoverState({
    status: "running",
    stallRecoveries: (state.stallRecoveries || 0) + 1,
    pendingInject: false,
    queue: [...(state.activeBatch || []), ...(state.queue || [])],
    activeBatch: [],
    lastEvent:
      "Batch " +
      Math.round(idleMs / 60000) +
      " min se chup tha (tab discard ya crash) — dobara chala rahe hain",
  });
  await pumpDiscoverBatch();
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
      // Re-run rather than carried over. /info/ is usually the first place a bio, a city or
      // a phone country code appears at all, so an account the listing left "unknown" is
      // very often decidable now — which is most of what this second pass is buying.
      const located = detectIndiaSignals(merged);
      candidates[finishedTask.handle] = {
        ...merged,
        score: scored.score,
        score_known_weight: scored.known,
        signals: scored.signals,
        india: located.india,
        india_signals: located.india_signals,
        keep: keepDiscoverCandidate(
          merged,
          scored,
          DISCOVER_KEEP_THRESHOLD,
          state.minFollowers,
          state.maxFollowers
        ),
        enriched: true,
      };
      note =
        "@" +
        finishedTask.handle +
        " detail mili — score " +
        (scored.score == null ? "?" : scored.score) +
        (located.india === "yes" ? ", India ✓" : "");
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
        ...countDiscoverDelivery(candidates, state.minFollowers, state.maxFollowers),
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
    if (raw && raw.is_private === true) continue;
    const contacts = extractCandidateContact(raw);
    const scored = scoreDiscoverCandidate({ ...raw, ...contacts }, scoreOpts);
    const keep = keepDiscoverCandidate(
      raw,
      scored,
      DISCOVER_KEEP_THRESHOLD,
      state.minFollowers,
      state.maxFollowers
    );
    // Usually "unknown" at this point — a chaining record rarely carries a bio, let alone a
    // city. It is computed anyway because a search or hashtag record sometimes does, and
    // the enrich pass re-runs it either way.
    const located = detectIndiaSignals(raw);

    const num = (value) => (typeof value === "number" ? value : null);
    const bool = (value) => (typeof value === "boolean" ? value : null);

    candidates[handle] = {
      handle,
      profile_url: profileUrlFor(handle),
      user_id: raw.user_id || null,
      full_name: raw.full_name || null,
      biography: typeof raw.biography === "string" ? raw.biography : null,
      email: contacts.email,
      phone: contacts.phone,
      followers: num(raw.followers),
      following: num(raw.following),
      posts_count: num(raw.posts_count),
      is_private: bool(raw.is_private),
      is_verified: bool(raw.is_verified),
      is_business: bool(raw.is_business),
      category: raw.category || null,
      external_url: raw.external_url || null,
      city_name: raw.city_name || null,
      phone_country_code: raw.phone_country_code || null,
      score: scored.score,
      score_known_weight: scored.known,
      signals: scored.signals,
      india: located.india,
      india_signals: located.india_signals,
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
    ...countDiscoverDelivery(candidates, state.minFollowers, state.maxFollowers),
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

  // A runaway guard stops the *walk*, not the run. Discovery tasks still queued would only
  // surface candidates there is no room left to store, so they are dropped — but the detail
  // pass is exactly what turns the candidates already held into ones with a follower count,
  // and finishing here would hand back a file where almost nothing is measured and the band
  // filter therefore matches almost nothing. `capped` still lands in the file as
  // runaway_guard_hit either way, so none of this is hidden.
  let queue = state.queue || [];
  if (state.capped && !state.enrichStarted && queue.length) {
    const dropped = queue.length;
    queue = [];
    await setDiscoverState({
      queue,
      lastEvent:
        (state.capped === "max_candidates"
          ? "Candidate cap (" + state.maxCandidates + ")"
          : "Task cap (" + DISCOVER_MAX_TASKS + ")") +
        " lag gaya — walk yahin rok rahe hain, " +
        dropped +
        " baaki task chhod diye (detail pass phir bhi chalega)",
    });
  }

  if (!queue.length) {
    // The frontier is drained. If enrichment is on, that is not the end of the run — it is
    // the start of the second pass, which turns thin listing records into scoreable ones.
    if (state.enrich && !state.enrichStarted) {
      // Re-read: the block above may have just rewritten the queue.
      const current = await getDiscoverState();
      const { tasks, dropped } = buildDiscoverEnrichQueue(current);
      await setDiscoverState({ enrichStarted: true });
      if (tasks.length) {
        await setDiscoverState({
          status: "waiting_delay",
          phase: "",
          activeBatch: [],
          queue: tasks,
          totals: {
            ...current.totals,
            tasksPlanned: current.totals.tasksPlanned + tasks.length,
          },
          lastEvent:
            "Discovery poori — ab " +
            tasks.length +
            " candidate ki detail nikaal rahe hain" +
            (dropped ? " (" + dropped + " enrich cap ke kaaran chhoot gaye)" : ""),
        });
        scheduleDiscoverAlarm(current.batchDelaySec);
        return { ok: true };
      }
    }
    await finishDiscoverRun(state.capped || "queue empty");
    return { ok: true };
  }

  await setDiscoverState({
    status: "waiting_delay",
    phase: "",
    activeBatch: [],
    lastEvent: "Batch poora — " + queue.length + " task baaki, thoda ruk ke aage",
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
  if (alarm.name === DISCOVER_WATCHDOG_ALARM) {
    // Serialised through the same chain as everything else: the watchdog rewrites the
    // frontier, and a tick landing in the middle of a task report would otherwise clobber
    // it — which is exactly the bug the chain exists to prevent.
    queueDiscoverTask(runDiscoverWatchdog).catch(() => undefined);
    return;
  }
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
    if (!discoverStatusIsActive(state.status)) return;

    await chrome.alarms.clear(DISCOVER_ALARM);

    // Unattended, a vanished tab is just something to fix. Chrome drops background tabs
    // under memory pressure and there is nobody awake to press Resume, so the unreported
    // tasks go back on the queue and a fresh tab is opened. Bounded by the same counter as
    // a stall, so a tab that cannot stay open does not respawn all night.
    if (state.unattended && (state.stallRecoveries || 0) < DISCOVER_MAX_STALL_RECOVERIES) {
      await setDiscoverState({
        status: "running",
        phase: "",
        pendingInject: false,
        tabId: null,
        stallRecoveries: (state.stallRecoveries || 0) + 1,
        queue: [...(state.activeBatch || []), ...(state.queue || [])],
        activeBatch: [],
        lastEvent: "Tab band ho gaya — raat wale mode me hain, naya tab khol ke aage chal rahe hain",
      });
      await pumpDiscoverBatch();
      return;
    }

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
  }).catch(() => undefined);
});
