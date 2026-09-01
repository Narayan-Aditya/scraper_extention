// Insta Handle Finder — Instagram discovery fetcher (content script).
//
// Injected into the driven instagram.com tab by background-discover.js. Where
// content-ig-fetch.js answers "give me everything about ONE account", this answers
// "give me NEW accounts worth looking at": it walks Instagram's own suggestion graph
// with the user's own session and reports candidate handles back to the worker.
//
// Same stance as every other runner here — no proxies, no spoofed headers, no hidden
// tabs, no CAPTCHA solving. A wall pauses the run and waits for the user; it is never
// hammered and never auto-retried.
//
// Division of labour: the worker owns the frontier (which tasks, in what order, how deep,
// dedupe, scoring). This file owns *how to ask Instagram one question* and hands back raw
// candidates. It processes a whole batch of tasks per injection rather than one per tab
// navigation, because a discovery task is a single request — re-navigating the tab for
// each one would be pure overhead.
//
// Why the request plumbing below is duplicated from content-ig-fetch.js instead of shared:
// there is no bundler in this project, and a `files:` injection runs the moment it lands,
// so content-ig-fetch.js cannot be pulled in without also starting a profile crawl. The
// same trade-off is already documented on normalizeHandle() in popup-profiles.js.

(function () {
  // ----------------------------------------------------------------- endpoint constants
  //
  // UNVERIFIED, all of them except TOPSEARCH_PATH (which content-ig-fetch.js already uses
  // to resolve a user id). Instagram's private endpoints are undocumented and rotate, so
  // everything here is written to *degrade*: a source that 404s or answers in a shape we
  // cannot read is switched off for the rest of the run and the other sources carry it —
  // rather than failing the run, or re-trying a dead path once per frontier node.

  const FALLBACK_APP_ID = "936619743392459";
  const LEGACY_APP_ID = "1217981644879628";
  // Instagram's own "suggested for you" carousel. The highest-yield source: one request
  // per known creator returns a batch of accounts Instagram itself considers similar.
  const CHAINING_PATH = "/api/v1/discover/chaining/?target_id=";
  const TOPSEARCH_PATH = "/web/search/topsearch/?context=blended&include_reel=false&query=";
  const TAG_INFO_PATH = "/api/v1/tags/web_info/?tag_name=";
  // Second-pass detail. The mobile-shaped user record carries follower_count, category and
  // biography — the three signals the listing sources usually leave out — and it is the one
  // profile endpoint that does NOT break on Instagram's retired business-category asset
  // (see the SCHEMA_ERROR_RE note in content-ig-fetch.js).
  const USER_INFO_PATH = "/api/v1/users/"; // + <numeric id> + "/info/"
  // A plausible fifth source — a city's location page, then the authors of its top posts —
  // is left out of v1 because turning a place name into a location id needs a *second*
  // unverified endpoint. Kept here so adding it later stays a one-line change:
  // const LOCATION_SECTIONS_PATH = "/api/v1/locations/"; // + <id> + "/sections/"

  const SCHEMA_ERROR_RE = /cannot use this schema|has been deleted\. you cannot/i;

  // Failures that mean *our access* is the problem rather than this one endpoint. Every
  // source would hit the same thing, so these stop the batch instead of disabling a source.
  const WALL_REASONS = new Set([
    "login_wall",
    "challenge",
    "rate_limit",
    "forbidden",
    "wrong_origin",
    "network",
  ]);

  const NETWORK_ATTEMPTS = 3;
  const STOP_CHECK_MS = 500;
  // How many structural failures a source is allowed before it is declared dead for the
  // run. One is not enough: a single mistyped hashtag 404s without saying anything about
  // the endpoint. Two in a row is the endpoint.
  const SOURCE_FAILURE_LIMIT = 2;
  // Runaway guards for the deep walk below. A malformed or enormous response must not be
  // able to hang the tab, and no single task may flood the frontier.
  const WALK_NODE_CAP = 40000;
  const WALK_DEPTH_CAP = 12;
  const CANDIDATES_PER_TASK_CAP = 200;

  const IGNORED_HANDLES = new Set([
    "p", "reel", "reels", "stories", "explore", "tv", "direct",
    "accounts", "about", "developer", "legal", "terms", "privacy", "help",
  ]);
  const HANDLE_RE = /^[a-z0-9._]{1,30}$/;

  const job = window.__IGD_JOB__;
  if (!job || !Array.isArray(job.tasks) || !job.tasks.length) return;

  // Re-injection guard, same as content-ig-fetch.js: the worker re-injects on resume and
  // the previous loop may still be parked in a sleep. Each loop exits the moment a newer
  // one takes over, so two loops can never report into the same run.
  const runToken = job.runToken;
  window.__IGD_RUN_TOKEN__ = runToken;
  window.__IGD_STOP__ = false;

  function isCurrent() {
    return window.__IGD_RUN_TOKEN__ === runToken && !window.__IGD_STOP__;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Sleeps in slices so a Stop lands within half a second instead of after the full delay.
  async function pacedSleep(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      if (!isCurrent()) return false;
      await sleep(Math.min(STOP_CHECK_MS, until - Date.now()));
    }
    return isCurrent();
  }

  function jitter(baseMs) {
    return Math.max(0, baseMs + baseMs * (Math.random() * 0.4 - 0.2)); // +/-20%
  }

  async function report(type, payload) {
    try {
      const ack = await chrome.runtime.sendMessage(Object.assign({ type }, payload));
      // The worker answers { abort:true } when this run is no longer the live one
      // (stopped, reset, or superseded) — stop pulling data nobody will store.
      if (ack && ack.abort) window.__IGD_STOP__ = true;
      return ack;
    } catch (e) {
      // Worker gone / extension reloaded mid-run. Nothing can receive results any more.
      window.__IGD_STOP__ = true;
      return null;
    }
  }

  // ------------------------------------------------------------------ request plumbing

  function readCookie(name) {
    const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : null;
  }

  // ds_user_id is the logged-in marker Instagram leaves readable to page JS (sessionid is
  // httpOnly and invisible from here). Used only to sharpen a message, never to block a
  // request — Instagram has tightened these flags before.
  function looksLoggedIn() {
    return !!readCookie("ds_user_id");
  }

  function fail(reason, detail, httpStatus) {
    let text = detail || "";
    // The two blocks that look identical in the response body but need opposite actions.
    if (reason === "login_wall" || reason === "rate_limit") {
      text += looksLoggedIn()
        ? " [tab logged in dikh raha hai — matlab yeh temporary block hai, login problem nahi]"
        : " [is tab me ds_user_id cookie nahi mili — pehle Instagram me login check karo]";
    }
    return report("IGD_ERROR", {
      reason,
      detail: text,
      httpStatus: httpStatus == null ? null : httpStatus,
    });
  }

  function detectAppId() {
    // Instagram ships its own app id in the page bundle; using the page's value keeps us in
    // step when it rotates. The constants are only the fallback.
    try {
      const html = document.documentElement ? document.documentElement.innerHTML : "";
      const match = html.match(/"X-IG-App-ID"\s*:\s*"(\d+)"/) || html.match(/appId"\s*:\s*"(\d+)"/);
      if (match) return match[1];
    } catch (e) {
      // Huge or detached DOM — fall through to the constant.
    }
    return FALLBACK_APP_ID;
  }

  const APP_ID = detectAppId();
  const APP_ID_CANDIDATES = [APP_ID, FALLBACK_APP_ID, LEGACY_APP_ID].filter(
    (id, index, list) => id && list.indexOf(id) === index
  );

  function requestHeaders(appId) {
    const out = {
      "x-ig-app-id": appId || APP_ID,
      "x-requested-with": "XMLHttpRequest",
    };
    const csrf = readCookie("csrftoken");
    if (csrf) out["x-csrftoken"] = csrf;
    return out;
  }

  function onInstagram() {
    return /(^|\.)instagram\.com$/i.test(location.hostname);
  }

  function looksLikeLoginWall() {
    const path = location.pathname.toLowerCase();
    return path.startsWith("/accounts/login") || path.startsWith("/challenge");
  }

  function classify(status, text) {
    const lowered = (text || "").toLowerCase();
    if (lowered.includes("challenge_required") || lowered.includes("checkpoint_required")) {
      return "challenge";
    }
    // Instagram answers an *unauthenticated* private-API call with a rate-limit sentence,
    // and only the require_login flag beside it says what is actually wrong. Read before
    // the sentence, or the user is sent off to wait out a block that waiting never clears.
    if (/"require_login"\s*:\s*true/.test(lowered) || lowered.includes("login_required")) {
      return "login_wall";
    }
    if (lowered.includes("please wait a few minutes") || lowered.includes("rate limit")) {
      return "rate_limit";
    }
    // Before the status codes: a retired-asset error can arrive as a 400 or a 5xx, and
    // treating the 5xx flavour as transient would burn three retries on a response shape
    // that is never coming back.
    if (SCHEMA_ERROR_RE.test(lowered)) return "endpoint_shape";
    if (status === 401) return "login_wall";
    if (status === 403) return "forbidden";
    if (status === 429) return "rate_limit";
    if (status === 404) return "not_found";
    if (status >= 500) return "network";
    return "endpoint_shape";
  }

  // Returns { ok:true, data } or { ok:false, reason, status, detail }.
  // Retries only genuinely transient failures (thrown fetch, 5xx) — an auth wall or a
  // rate limit is never hammered.
  async function getJson(path, opts) {
    const appId = (opts && opts.appId) || null;
    let lastDetail = "";
    for (let attempt = 1; attempt <= NETWORK_ATTEMPTS; attempt++) {
      if (!isCurrent()) return { ok: false, reason: "stopped", status: null, detail: "" };

      if (!onInstagram()) {
        return { ok: false, reason: "wrong_origin", status: null, detail: location.href };
      }
      if (looksLikeLoginWall()) {
        return { ok: false, reason: "login_wall", status: null, detail: location.pathname };
      }

      let res;
      try {
        res = await fetch(path, { headers: requestHeaders(appId), credentials: "include" });
      } catch (e) {
        lastDetail = e && e.message ? e.message : String(e);
        if (attempt < NETWORK_ATTEMPTS) {
          if (!(await pacedSleep(1000 * Math.pow(2, attempt)))) {
            return { ok: false, reason: "stopped", status: null, detail: "" };
          }
          continue;
        }
        return { ok: false, reason: "network", status: null, detail: lastDetail };
      }

      let text = "";
      try {
        text = await res.text();
      } catch (e) {
        text = "";
      }

      if (!res.ok) {
        const reason = classify(res.status, text);
        if (reason === "network" && attempt < NETWORK_ATTEMPTS) {
          if (!(await pacedSleep(1000 * Math.pow(2, attempt)))) {
            return { ok: false, reason: "stopped", status: null, detail: "" };
          }
          continue;
        }
        return { ok: false, reason, status: res.status, detail: text.slice(0, 200) };
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        // A 200 that isn't JSON is almost always an HTML login/challenge interstitial.
        return {
          ok: false,
          reason: classify(200, text),
          status: 200,
          detail: "response was not JSON",
        };
      }

      return { ok: true, data };
    }
    return { ok: false, reason: "network", status: null, detail: lastDetail };
  }

  // ------------------------------------------------------------------ user extraction

  function numOrNull(value) {
    return typeof value === "number" && isFinite(value) ? value : null;
  }

  function boolOrNull(value) {
    // A listing that simply does not carry the flag must stay unknown. Defaulting it to
    // false would let a private account score as public, which is the one mistake that
    // wastes a whole profile fetch later.
    return typeof value === "boolean" ? value : null;
  }

  // Maps one user-ish node from any of these responses into the candidate shape the worker
  // stores. Anything the source did not supply stays null — never guessed, never zero.
  function mapCandidate(node) {
    const username = typeof node.username === "string" ? node.username.toLowerCase() : "";
    if (!HANDLE_RE.test(username) || IGNORED_HANDLES.has(username)) return null;

    const rawId = node.pk != null ? node.pk : node.pk_id != null ? node.pk_id : node.id;
    const userId = rawId == null ? null : String(rawId);
    // An id must actually be an id. Some nodes carry a string `id` that is a media
    // shortcode or a section key, and feeding that to /info/ later would 404 forever.
    const cleanId = userId && /^\d{1,25}$/.test(userId) ? userId : null;

    return {
      handle: username,
      user_id: cleanId,
      full_name: typeof node.full_name === "string" ? node.full_name : null,
      biography: typeof node.biography === "string" ? node.biography : null,
      is_private: boolOrNull(node.is_private),
      is_verified: boolOrNull(node.is_verified),
      is_business: boolOrNull(node.is_business),
      category:
        node.category || node.business_category_name || node.category_name || null,
      followers: numOrNull(node.follower_count),
      following: numOrNull(node.following_count),
      posts_count: numOrNull(node.media_count),
      external_url: node.external_url || null,
      profile_pic_url: node.profile_pic_url || null,
      // Location-ish fields, UNVERIFIED like everything else from these endpoints and
      // absent from the listing sources entirely — only /info/ carries them, and only for
      // professional accounts that actually filled them in. They exist so the worker can
      // look for *positive* evidence that an account is Indian; a null here means "this
      // source did not say", never "not Indian".
      //
      // The phone *number* is deliberately not carried across. The country code answers
      // the only question being asked, and the rest is somebody's contact detail that has
      // no business sitting in an exported candidate list.
      city_name: typeof node.city_name === "string" ? node.city_name : null,
      phone_country_code:
        node.public_phone_country_code == null
          ? null
          : String(node.public_phone_country_code),
    };
  }

  // Instagram nests user records at a different depth in every one of these responses:
  // topsearch puts them under users[].user, chaining under users[], a tag page under
  // several layers of sections/media/user. Rather than hard-coding four shapes that each
  // break independently, walk the response and pick up anything that looks like a user
  // record. A false positive is cheap — the worker re-validates the handle and the scorer
  // drops what is not a creator — while a shape change that silently yields nothing is not.
  function harvestUsers(root) {
    const out = [];
    const seen = new Set();
    const visited = new Set();
    let nodes = 0;

    const stack = [{ value: root, depth: 0 }];
    while (stack.length) {
      const { value, depth } = stack.pop();
      if (!value || typeof value !== "object") continue;
      if (depth > WALK_DEPTH_CAP) continue;
      if (++nodes > WALK_NODE_CAP) break;
      // Instagram's payloads contain shared/back-references; without this a cyclic graph
      // walks forever.
      if (visited.has(value)) continue;
      visited.add(value);

      if (Array.isArray(value)) {
        for (const item of value) stack.push({ value: item, depth: depth + 1 });
        continue;
      }

      if (typeof value.username === "string") {
        const candidate = mapCandidate(value);
        if (candidate && !seen.has(candidate.handle)) {
          seen.add(candidate.handle);
          out.push(candidate);
          if (out.length >= CANDIDATES_PER_TASK_CAP) break;
        }
        // Deliberately no `continue`: a user node can itself contain nested users (a post
        // author carrying tagged users, for instance).
      }

      for (const key of Object.keys(value)) {
        stack.push({ value: value[key], depth: depth + 1 });
      }
    }

    return { candidates: out, capped: out.length >= CANDIDATES_PER_TASK_CAP };
  }

  // --------------------------------------------------------------------------- sources
  //
  // Each returns { ok:true, candidates, note? } or a getJson-shaped failure. None of them
  // pauses or reports on its own — runTask() decides what a failure means.

  // Handle -> numeric id, via the search endpoint. Chaining needs an id and seeds arrive as
  // handles. Cached for the batch because a frontier commonly revisits the same account.
  const idCache = new Map();

  async function resolveUserId(handle) {
    if (idCache.has(handle)) return { ok: true, userId: idCache.get(handle) };

    const res = await getJson(TOPSEARCH_PATH + encodeURIComponent(handle));
    if (!res.ok) return res;

    const { candidates } = harvestUsers(res.data);
    for (const candidate of candidates) {
      if (candidate.handle === handle && candidate.user_id) {
        idCache.set(handle, candidate.user_id);
        return { ok: true, userId: candidate.user_id, candidate };
      }
    }
    return {
      ok: false,
      reason: "not_found",
      status: 200,
      detail: "topsearch me @" + handle + " nahi mila",
    };
  }

  async function runSearchTask(task) {
    const res = await getJson(TOPSEARCH_PATH + encodeURIComponent(task.term));
    if (!res.ok) return res;
    const { candidates, capped } = harvestUsers(res.data);
    return {
      ok: true,
      candidates,
      note: capped ? "search \"" + task.term + "\" pe " + CANDIDATES_PER_TASK_CAP + " ka cap laga" : "",
    };
  }

  async function runChainTask(task) {
    let userId = task.userId || null;
    if (!userId) {
      const resolved = await resolveUserId(task.handle);
      if (!resolved.ok) return resolved;
      userId = resolved.userId;
      // The search hop is a request too — pace it like any other.
      if (!(await pacedSleep(jitter(job.stepDelayMs)))) {
        return { ok: false, reason: "stopped", status: null, detail: "" };
      }
    }

    // web_profile_info is serialised per app id and chaining may well be too, so the same
    // ladder content-ig-fetch.js uses for profiles applies here: try each known id before
    // calling the source broken.
    let last = null;
    for (const appId of APP_ID_CANDIDATES) {
      const res = await getJson(CHAINING_PATH + encodeURIComponent(userId), { appId });
      if (res.ok) {
        const { candidates, capped } = harvestUsers(res.data);
        // The seed itself is usually the first entry in its own similar-accounts list.
        const filtered = candidates.filter((candidate) => candidate.handle !== task.handle);
        return {
          ok: true,
          userId,
          candidates: filtered,
          note: capped ? "@" + task.handle + " pe " + CANDIDATES_PER_TASK_CAP + " ka cap laga" : "",
        };
      }
      last = res;
      if (WALL_REASONS.has(res.reason) || res.reason === "stopped") return res;
      if (!(await pacedSleep(jitter(job.stepDelayMs)))) {
        return { ok: false, reason: "stopped", status: null, detail: "" };
      }
    }
    return last;
  }

  async function runHashtagTask(task) {
    const res = await getJson(TAG_INFO_PATH + encodeURIComponent(task.tag));
    if (!res.ok) return res;
    const { candidates, capped } = harvestUsers(res.data);
    return {
      ok: true,
      candidates,
      note: capped ? "#" + task.tag + " pe " + CANDIDATES_PER_TASK_CAP + " ka cap laga" : "",
    };
  }

  // Second pass over a candidate we already have. The listing sources answer with a thin
  // record — often no follower count, no category, no bio — which leaves the scorer with
  // almost nothing to weigh. One /info/ request per kept candidate fills exactly those
  // fields in. It is the expensive half of the run, which is why the panel makes it a
  // switch rather than always doing it.
  async function runEnrichTask(task) {
    let userId = task.userId || null;
    if (!userId) {
      const resolved = await resolveUserId(task.handle);
      if (!resolved.ok) return resolved;
      userId = resolved.userId;
      if (!(await pacedSleep(jitter(job.stepDelayMs)))) {
        return { ok: false, reason: "stopped", status: null, detail: "" };
      }
    }

    const res = await getJson(USER_INFO_PATH + encodeURIComponent(userId) + "/info/");
    if (!res.ok) return res;

    const user = res.data && res.data.user;
    if (!user) {
      return { ok: false, reason: "endpoint_shape", status: 200, detail: "info response me user nahi mila" };
    }
    // The id may have come from a search hop, so confirm whose record came back before any
    // of it is merged into this handle's candidate.
    const returned = String(user.username || "").toLowerCase();
    if (returned && returned !== task.handle) {
      return {
        ok: false,
        reason: "endpoint_shape",
        status: 200,
        detail: "id " + userId + " @" + returned + " ka nikla, @" + task.handle + " ka nahi",
      };
    }

    const candidate = mapCandidate(user);
    if (!candidate) {
      return { ok: false, reason: "endpoint_shape", status: 200, detail: "info user record padha nahi gaya" };
    }
    return { ok: true, userId, candidates: [candidate] };
  }

  const SOURCES = {
    search: runSearchTask,
    chain: runChainTask,
    hashtag: runHashtagTask,
    enrich: runEnrichTask,
  };

  // ------------------------------------------------------------------------ batch loop

  (async function run() {
    if (!onInstagram()) {
      await fail("wrong_origin", "Tab instagram.com pe nahi hai (" + location.href + ")");
      return;
    }
    if (looksLikeLoginWall()) {
      await fail("login_wall", "Instagram login page dikh raha hai");
      return;
    }

    // Sources the worker already knows are dead, carried in so a resumed batch does not
    // re-discover the same breakage.
    const dead = new Set(Array.isArray(job.deadSources) ? job.deadSources : []);
    const failures = new Map();

    for (let index = 0; index < job.tasks.length; index++) {
      if (!isCurrent()) return;
      const task = job.tasks[index];
      const source = SOURCES[task.kind];

      if (!source || dead.has(task.kind)) {
        await report("IGD_TASK_DONE", {
          taskKey: task.key,
          ok: false,
          reason: source ? "source_disabled" : "unknown_source",
          detail: task.kind,
          candidates: [],
        });
        continue;
      }

      const result = await source(task);

      if (result.reason === "stopped") return;

      if (result.ok) {
        failures.delete(task.kind);
        const ack = await report("IGD_TASK_DONE", {
          taskKey: task.key,
          ok: true,
          reason: null,
          detail: result.note || "",
          userId: result.userId || task.userId || null,
          candidates: result.candidates,
        });
        if (!ack || ack.ok === false) return;
      } else if (WALL_REASONS.has(result.reason)) {
        // Access problem, not an endpoint problem: every remaining task would hit the same
        // wall, so hand it to the worker as a pause and stop the batch here. The worker
        // still holds every task that has not reported, so Resume loses nothing.
        await fail(result.reason, result.detail, result.status);
        return;
      } else {
        // Structural failure (endpoint_shape / not_found). One is a bad input; two in a row
        // is the endpoint itself, and re-trying it once per frontier node would be exactly
        // the request storm this project refuses to make.
        const count = (failures.get(task.kind) || 0) + 1;
        failures.set(task.kind, count);
        if (count >= SOURCE_FAILURE_LIMIT) {
          dead.add(task.kind);
          await report("IGD_SOURCE_DEAD", {
            source: task.kind,
            detail:
              task.kind +
              " source ne lagataar " +
              count +
              " baar galat jawab diya (" +
              result.reason +
              (result.status ? " " + result.status : "") +
              ") — is run me ise band kar rahe hain",
          });
        }
        const ack = await report("IGD_TASK_DONE", {
          taskKey: task.key,
          ok: false,
          reason: result.reason,
          detail: result.detail || "",
          candidates: [],
        });
        if (!ack || ack.ok === false) return;
      }

      if (index < job.tasks.length - 1) {
        if (!(await pacedSleep(jitter(job.stepDelayMs)))) return;
      }
    }

    await report("IGD_BATCH_DONE", {});
  })();
})();
