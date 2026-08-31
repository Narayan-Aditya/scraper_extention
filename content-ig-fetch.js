// Insta Handle Finder — Instagram profile/posts fetcher, injected into the driven
// instagram.com tab.
//
// Why the pagination loop lives HERE and not in the service worker: an MV3 worker is
// killed after ~30s idle, so a multi-minute paginated crawl cannot own its own timers.
// The page context can. This script drives the whole account, reporting each page back
// to the worker, which persists the cursor — so a crash, a closed tab or a sleeping
// worker never costs more than the page in flight.
//
// Deliberately does NOT: spoof headers or user-agent, use a proxy, bypass a checkpoint,
// or silently retry through a rate limit. It uses the user's own logged-in session as-is
// and surfaces every block to the UI as a resumable pause.

(function () {
  // Instagram's public web app ids. Kept here as named constants because these private
  // endpoints are undocumented and rotate — this and the paths below are the one-line
  // updates to make when the API shape drifts.
  const FALLBACK_APP_ID = "936619743392459";
  // The older public web app id. web_profile_info is serialised per app id, so when the
  // current one hits a retired-field error (see SCHEMA_ERROR_RE) the same request under
  // the legacy id frequently still comes back clean.
  const LEGACY_APP_ID = "1217981644879628";
  const PROFILE_PATH = "/api/v1/users/web_profile_info/?username=";
  const USER_INFO_PATH = "/api/v1/users/"; // + <numeric id> + "/info/"
  const TOPSEARCH_PATH = "/web/search/topsearch/?context=blended&include_reel=false&query=";
  const FEED_PATH = "/api/v1/feed/user/";
  const GRAPHQL_PATH = "/graphql/query/";
  // Long-lived query hashes for edge_owner_to_timeline_media, tried in order.
  const GRAPHQL_HASHES = [
    "e769aa130647d2354c40ea6a439bfc08",
    "472f257a40c653c64c666ce877d59d2b",
    "003056d32c2554def87228bc3fd9668a",
  ];

  // Instagram's own serialiser 400s when a response field's backing asset has been
  // retired — e.g. "Asset asset://laser.provider/ig_business_category_subvertical has
  // been deleted. You cannot use this schema", which web_profile_info throws for many
  // business accounts. The account is fine and we are not blocked; only this one
  // response shape is broken, so the answer is a different endpoint — never a retry and
  // never a pause.
  const SCHEMA_ERROR_RE = /cannot use this schema|has been deleted\. you cannot/i;

  // Failures that mean *our access* is the problem. Every profile source would hit the
  // same thing, so the chain stops instead of burning requests against a wall.
  const WALL_REASONS = new Set(["login_wall", "challenge", "rate_limit", "forbidden", "wrong_origin", "network"]);

  const PAGE_SIZE = 33;
  const GRAPHQL_PAGE_SIZE = 50;
  const HARD_PAGE_CAP = 500; // runaway guard, ~16k posts
  const NETWORK_ATTEMPTS = 3;
  const STOP_CHECK_MS = 500;

  const job = window.__IG_JOB__;
  if (!job || !job.handle) return; // seeded by the worker right before injection

  // Re-injection guard: the worker re-injects on resume, and the old loop may still be
  // parked in a sleep. Each loop captures its token and exits the moment a newer one
  // takes over, so two loops can never report into the same account.
  const runToken = job.runToken;
  window.__IG_RUN_TOKEN__ = runToken;
  window.__IG_STOP__ = false;

  function isCurrent() {
    return window.__IG_RUN_TOKEN__ === runToken && !window.__IG_STOP__;
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
      const ack = await chrome.runtime.sendMessage(
        Object.assign({ type, handle: job.handle }, payload)
      );
      // The worker answers { abort:true } when this run is no longer the live one
      // (stopped, reset, or superseded) — stop pulling data nobody will store.
      if (ack && ack.abort) window.__IG_STOP__ = true;
      return ack;
    } catch (e) {
      // Worker gone / extension reloaded mid-run. Nothing can receive results any more.
      window.__IG_STOP__ = true;
      return null;
    }
  }

  // ds_user_id is the logged-in marker Instagram leaves readable to page JS (sessionid is
  // httpOnly and invisible from here). Its presence is proof of a logged-in tab; its
  // absence is only a strong hint, since Instagram has tightened these flags before — so
  // it is used to sharpen a message, never to block a request on its own.
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
    return report("IG_ERROR", {
      reason,
      detail: text,
      httpStatus: httpStatus == null ? null : httpStatus,
    });
  }

  // ---------------------------------------------------------------- request plumbing

  function readCookie(name) {
    const match = document.cookie.match(new RegExp("(?:^|; )" + name + "=([^;]*)"));
    return match ? decodeURIComponent(match[1]) : "";
  }

  // Prefers the app id the page itself is using; falls back to the known public one.
  function detectAppId() {
    try {
      const html = document.documentElement.innerHTML;
      const match =
        html.match(/"X-IG-App-ID"\s*:\s*"(\d+)"/) || html.match(/"appId"\s*:\s*"(\d+)"/);
      if (match) return match[1];
    } catch (e) {
      // innerHTML on a huge document can throw under memory pressure — constant is fine
    }
    return FALLBACK_APP_ID;
  }

  const APP_ID = detectAppId();

  // The app ids to try, page-detected one first, deduped.
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
    const host = location.hostname.toLowerCase().replace(/^www\./, "");
    return host === "instagram.com" || host.endsWith(".instagram.com");
  }

  function looksLikeLoginWall() {
    return /^\/accounts\/(login|onetap)/.test(location.pathname);
  }

  // Classifies a response body once, so a 200-with-error and a 400-challenge are told
  // apart without re-reading the stream.
  function classify(status, text) {
    const lowered = (text || "").toLowerCase();
    if (lowered.includes("challenge_required") || lowered.includes("checkpoint_required")) {
      return "challenge";
    }
    // Instagram answers an *unauthenticated* private-API call with a rate-limit sentence
    // — "Please wait a few minutes before trying again." — and only the require_login
    // flag sitting next to it says what is actually wrong. This has to be read before the
    // sentence is, or the user gets sent off to wait out a block that waiting never
    // clears.
    if (/"require_login"\s*:\s*true/.test(lowered) || lowered.includes("login_required")) {
      return "login_wall";
    }
    if (lowered.includes("please wait a few minutes") || lowered.includes("rate limit")) {
      return "rate_limit";
    }
    // Checked before the status codes: a retired-asset error can arrive as a 400 or a
    // 5xx, and treating the 5xx flavour as transient would waste three retries on a
    // response shape that will never come back.
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

  // ------------------------------------------------------------------ field mapping

  function isoFromUnix(seconds) {
    const n = Number(seconds);
    if (!n || !isFinite(n)) return null;
    const d = new Date(n * 1000);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }

  function bestCandidate(list) {
    if (!Array.isArray(list) || !list.length) return null;
    let best = null;
    for (const candidate of list) {
      if (!candidate || !candidate.url) continue;
      if (!best || (Number(candidate.width) || 0) > (Number(best.width) || 0)) best = candidate;
    }
    return best ? best.url : null;
  }

  function mediaTypeName(code) {
    if (code === 1) return "image";
    if (code === 2) return "video";
    if (code === 8) return "carousel";
    return "unknown";
  }

  function mapChild(item) {
    if (!item) return null;
    return {
      media_type: mediaTypeName(item.media_type),
      display_url: bestCandidate(item.image_versions2 && item.image_versions2.candidates),
      video_url: bestCandidate(item.video_versions),
    };
  }

  function mapTaggedUsers(item) {
    const tags = item && item.usertags && Array.isArray(item.usertags.in) ? item.usertags.in : [];
    const names = [];
    for (const tag of tags) {
      const name = tag && tag.user && tag.user.username;
      if (name && !names.includes(name)) names.push(name);
    }
    return names;
  }

  function mapLocation(location) {
    if (!location) return null;
    return {
      name: location.name || null,
      pk: location.pk != null ? String(location.pk) : location.id != null ? String(location.id) : null,
    };
  }

  // Feed-API item -> our post schema.
  function mapPost(item) {
    if (!item || (item.pk == null && item.id == null)) return null;
    const id = String(item.pk != null ? item.pk : item.id);
    const shortcode = item.code || null;
    const type = mediaTypeName(item.media_type);
    const children = Array.isArray(item.carousel_media)
      ? item.carousel_media.map(mapChild).filter(Boolean)
      : null;

    let viewCount = null;
    if (typeof item.play_count === "number") viewCount = item.play_count;
    else if (typeof item.view_count === "number") viewCount = item.view_count;

    return {
      id,
      shortcode,
      url: shortcode ? "https://www.instagram.com/p/" + shortcode + "/" : null,
      taken_at: isoFromUnix(item.taken_at),
      media_type: type,
      is_video: type === "video",
      caption: item.caption && typeof item.caption.text === "string" ? item.caption.text : "",
      like_count: typeof item.like_count === "number" ? item.like_count : null,
      comment_count: typeof item.comment_count === "number" ? item.comment_count : null,
      view_count: viewCount,
      display_url: bestCandidate(item.image_versions2 && item.image_versions2.candidates),
      video_url: bestCandidate(item.video_versions),
      carousel_media: children && children.length ? children : null,
      location: mapLocation(item.location),
      tagged_users: mapTaggedUsers(item),
    };
  }

  // GraphQL node -> the same schema, so the output file looks identical whichever
  // source produced it (only the top-level `source` field differs).
  function mapGraphNode(node) {
    if (!node || node.id == null) return null;
    const typename = node.__typename || "";
    const type =
      typename === "GraphVideo" ? "video" : typename === "GraphSidecar" ? "carousel" : "image";
    const captionEdge =
      node.edge_media_to_caption &&
      Array.isArray(node.edge_media_to_caption.edges) &&
      node.edge_media_to_caption.edges[0];
    const childEdges =
      node.edge_sidecar_to_children && Array.isArray(node.edge_sidecar_to_children.edges)
        ? node.edge_sidecar_to_children.edges
        : [];

    const children = childEdges
      .map((edge) => {
        const child = edge && edge.node;
        if (!child) return null;
        return {
          media_type: child.is_video ? "video" : "image",
          display_url: child.display_url || null,
          video_url: child.video_url || null,
        };
      })
      .filter(Boolean);

    let likes = null;
    if (node.edge_liked_by && typeof node.edge_liked_by.count === "number") {
      likes = node.edge_liked_by.count;
    } else if (node.edge_media_preview_like && typeof node.edge_media_preview_like.count === "number") {
      likes = node.edge_media_preview_like.count;
    }

    return {
      id: String(node.id),
      shortcode: node.shortcode || null,
      url: node.shortcode ? "https://www.instagram.com/p/" + node.shortcode + "/" : null,
      taken_at: isoFromUnix(node.taken_at_timestamp),
      media_type: type,
      is_video: type === "video",
      caption: (captionEdge && captionEdge.node && captionEdge.node.text) || "",
      like_count: likes,
      comment_count:
        node.edge_media_to_comment && typeof node.edge_media_to_comment.count === "number"
          ? node.edge_media_to_comment.count
          : null,
      view_count: typeof node.video_view_count === "number" ? node.video_view_count : null,
      display_url: node.display_url || null,
      video_url: node.video_url || null,
      carousel_media: children.length ? children : null,
      location: mapLocation(node.location),
      tagged_users: [],
    };
  }

  // Every mapper below writes the same profile shape and stamps `profile_source`, so a
  // file built from a degraded fallback never silently passes for full web_profile_info
  // data — a null there means "not available from this source", not "zero".
  function mapProfile(user) {
    const count = (edge) => (edge && typeof edge.count === "number" ? edge.count : null);
    return {
      user_id: String(user.id),
      username: user.username || job.handle,
      full_name: user.full_name || "",
      biography: user.biography || "",
      external_url: user.external_url || null,
      is_private: !!user.is_private,
      is_verified: !!user.is_verified,
      is_business: !!user.is_business_account,
      category: user.category_name || user.business_category_name || user.category || null,
      followers: count(user.edge_followed_by),
      following: count(user.edge_follow),
      posts_count: count(user.edge_owner_to_timeline_media),
      profile_pic_url: user.profile_pic_url || null,
      profile_pic_url_hd: user.profile_pic_url_hd || user.profile_pic_url || null,
      profile_source: "web_profile_info",
    };
  }

  // /api/v1/users/<id>/info/ — the mobile-shaped user record. Carries everything the web
  // profile does except the seed posts, and notably does NOT include the business
  // category subvertical that breaks web_profile_info.
  function mapUserInfo(user, fallbackId) {
    const num = (value) => (typeof value === "number" ? value : null);
    const id =
      user.pk != null ? String(user.pk) : user.pk_id != null ? String(user.pk_id) : String(fallbackId);
    return {
      user_id: id,
      username: user.username || job.handle,
      full_name: user.full_name || "",
      biography: user.biography || "",
      external_url: user.external_url || null,
      is_private: !!user.is_private,
      is_verified: !!user.is_verified,
      is_business: !!user.is_business,
      category: user.category || user.business_category_name || null,
      followers: num(user.follower_count),
      following: num(user.following_count),
      posts_count: num(user.media_count),
      profile_pic_url: user.profile_pic_url || null,
      profile_pic_url_hd:
        (user.hd_profile_pic_url_info && user.hd_profile_pic_url_info.url) || user.profile_pic_url || null,
      profile_source: "user_info",
    };
  }

  // "12.3K" / "1,234" / "2.1M" -> a number. Abbreviated forms are rounded, which is why
  // the meta tag is preferred over the rendered header (it usually carries exact counts).
  function parseCountText(raw) {
    if (!raw) return null;
    const match = String(raw).trim().replace(/,/g, "").match(/^([\d.]+)\s*([kmb])?$/i);
    if (!match) return null;
    const value = parseFloat(match[1]);
    if (!isFinite(value)) return null;
    const unit = (match[2] || "").toLowerCase();
    const scale = unit === "k" ? 1e3 : unit === "m" ? 1e6 : unit === "b" ? 1e9 : 1;
    return Math.round(value * scale);
  }

  function metaContent(selector) {
    const el = document.querySelector(selector);
    return (el && el.getAttribute("content")) || "";
  }

  // Last-resort profile, read off the page Instagram already rendered for us. Thin by
  // design: counts and name come from the og: tags, everything the tags don't carry stays
  // null rather than being guessed.
  function profileFromDom(userId) {
    const description =
      metaContent('meta[property="og:description"]') || metaContent('meta[name="description"]');
    const grab = (label) => {
      const match = description.match(new RegExp("([\\d.,]+\\s*[kmb]?)\\s+" + label, "i"));
      return match ? parseCountText(match[1]) : null;
    };

    const title = metaContent('meta[property="og:title"]') || document.title || "";
    const nameMatch = title.match(/^(.*?)\s*\(@/);
    // Newer og:description tags read: `... - Name (@handle) on Instagram: "bio text"`.
    const bioMatch = description.match(/on Instagram:\s*["“]?([\s\S]*?)["”]?\s*$/i);
    const pic = metaContent('meta[property="og:image"]') || null;

    let bodyText = "";
    try {
      bodyText = (document.body && document.body.innerText) || "";
    } catch (e) {
      bodyText = "";
    }

    return {
      user_id: userId != null ? String(userId) : null,
      username: job.handle,
      full_name: nameMatch ? nameMatch[1].trim() : "",
      biography: bioMatch ? bioMatch[1].trim() : "",
      external_url: null,
      is_private: /this account is private/i.test(bodyText),
      is_verified: null, // the page shows a badge, but not one we can read reliably
      is_business: null,
      category: null,
      followers: grab("followers"),
      following: grab("following"),
      posts_count: grab("posts"),
      profile_pic_url: pic,
      profile_pic_url_hd: pic,
      profile_source: "dom",
    };
  }

  // web_profile_info already carries the first ~12 posts. Using them saves a request and
  // tells us straight away whether there is anything left to paginate.
  function extractSeedPosts(user) {
    const media = user && user.edge_owner_to_timeline_media;
    if (!media || !Array.isArray(media.edges)) return null;
    const posts = media.edges.map((edge) => mapGraphNode(edge && edge.node)).filter(Boolean);
    const info = media.page_info || {};
    return { posts, endCursor: info.end_cursor || null, hasNext: !!info.has_next_page };
  }

  // ------------------------------------------------------------------- profile step
  //
  // web_profile_info is the richest source (it alone carries the first page of posts) but
  // it is also the one that breaks: Instagram 400s it for many business accounts because
  // one of its own response fields was retired. So the profile is resolved the same way
  // the posts are — a chain, each link trading detail for a source that still answers,
  // ending at the rendered page itself. Only a wall (login, checkpoint, rate limit) stops
  // the chain early, because no source gets past those.

  // Finds the account's numeric id in the JSON Instagram embeds in the page it just
  // served us. Anchors on the username and takes the nearest id, because the field order
  // inside those blobs is not stable. tryUserInfo() re-checks the username on the way
  // back, so a wrong id from a neighbouring object can never become someone else's data.
  function userIdFromPage() {
    const escaped = job.handle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // Both plain and backslash-escaped JSON: these blobs are often JSON inside JSON.
    const usernameRe = new RegExp('\\\\?"username\\\\?"\\s*:\\s*\\\\?"' + escaped + '\\\\?"', "gi");
    const idRe = /\\?"(?:id|pk|pk_id)\\?"\s*:\s*\\?"?(\d{4,})\\?"?/;

    let scripts;
    try {
      scripts = Array.from(document.querySelectorAll("script"));
    } catch (e) {
      return null;
    }

    for (const script of scripts) {
      const text = script.textContent;
      if (!text || text.indexOf(job.handle) === -1) continue;
      usernameRe.lastIndex = 0;
      let hit;
      while ((hit = usernameRe.exec(text)) !== null) {
        const start = Math.max(0, hit.index - 600);
        const nearby = text.slice(start, hit.index + hit[0].length + 600);
        const match = nearby.match(idRe);
        if (match) return match[1];
      }
    }
    return null;
  }

  // The search endpoint answers with a numeric id when the profile page's own JSON does
  // not — it is a different service, so it survives web_profile_info's schema breakage.
  async function userIdFromSearch() {
    const res = await getJson(TOPSEARCH_PATH + encodeURIComponent(job.handle));
    if (!res.ok) return res;

    const users = res.data && Array.isArray(res.data.users) ? res.data.users : [];
    for (const entry of users) {
      const user = entry && entry.user;
      if (!user || String(user.username || "").toLowerCase() !== job.handle) continue;
      const pk = user.pk != null ? String(user.pk) : user.pk_id != null ? String(user.pk_id) : null;
      if (pk) return { ok: true, userId: pk };
    }
    return {
      ok: false,
      reason: "endpoint_shape",
      status: 200,
      detail: "topsearch me @" + job.handle + " nahi mila",
    };
  }

  async function tryWebProfileInfo(appId) {
    const res = await getJson(PROFILE_PATH + encodeURIComponent(job.handle), { appId });
    if (!res.ok) return res;

    const payload = res.data && res.data.data;
    // A 200 that explicitly says user:null is the one answer we trust as final — an HTTP
    // 404 from this endpoint is far more often the endpoint moving than the account being
    // gone, so that keeps walking the chain.
    if (payload && payload.user === null) {
      return {
        ok: false,
        definitive: true,
        reason: "not_found",
        status: 200,
        detail: "@" + job.handle + " ka koi profile nahi mila",
      };
    }

    const user = payload && payload.user;
    if (!user || user.id == null) {
      return { ok: false, reason: "endpoint_shape", status: 200, detail: "web_profile_info me data.user nahi mila" };
    }

    const profile = mapProfile(user);
    return {
      ok: true,
      profile,
      // A private account we don't follow simply has no readable posts — that's a skip,
      // not a failure, so the profile still gets saved.
      readable: !profile.is_private || user.followed_by_viewer === true,
      seed: extractSeedPosts(user),
    };
  }

  async function tryUserInfo(userId) {
    const res = await getJson(USER_INFO_PATH + encodeURIComponent(userId) + "/info/");
    if (!res.ok) return res;

    const user = res.data && res.data.user;
    if (!user) {
      return { ok: false, reason: "endpoint_shape", status: 200, detail: "info response me user nahi mila" };
    }
    // The id was inferred from page JSON, so confirm whose record came back before any of
    // it is written to @handle's file.
    const returned = String(user.username || "").toLowerCase();
    if (returned && returned !== job.handle) {
      return {
        ok: false,
        reason: "endpoint_shape",
        status: 200,
        // Flagged so the id is dropped rather than carried into pagination — feeding a
        // wrong id to /feed/user/ would file another account's posts under this handle.
        mismatchedId: true,
        detail: "id " + userId + " @" + returned + " ka nikla, @" + job.handle + " ka nahi",
      };
    }

    const profile = mapUserInfo(user, userId);
    const follows = !!(user.friendship_status && user.friendship_status.following);
    return { ok: true, profile, readable: !profile.is_private || follows, seed: null };
  }

  // `rejected` holds ids that /info/ proved belong to a different account, so the page
  // rescan cannot hand the same wrong id straight back.
  function tryDomProfile(userId, rejected) {
    let id = userId;
    if (id == null) {
      const found = userIdFromPage();
      if (found && !(rejected && rejected.has(found))) id = found;
    }
    const profile = profileFromDom(id);
    // Guard against "succeeding" on an interstitial: a real profile page always renders at
    // least a name, a follower count or an avatar.
    if (!profile.full_name && profile.followers == null && !profile.profile_pic_url) {
      return { ok: false, reason: "endpoint_shape", status: null, detail: "page pe profile render nahi hua" };
    }
    const hasPostLinks = !!document.querySelector('a[href*="/p/"], a[href*="/reel/"]');
    return { ok: true, profile, readable: !profile.is_private || hasPostLinks, seed: null };
  }

  async function resolveProfile() {
    const tried = [];
    const rejectedIds = new Set();
    let knownUserId = null;

    // Runs after every web_profile_info variant has failed: get an id from a source that
    // is not web_profile_info, then read the profile through the mobile-shaped endpoint.
    async function userInfoStrategy() {
      knownUserId = userIdFromPage();
      if (knownUserId) {
        tried.push("user id page JSON se mila (" + knownUserId + ")");
      } else {
        const search = await userIdFromSearch();
        if (!search.ok) return search;
        knownUserId = search.userId;
        tried.push("user id topsearch se mila (" + knownUserId + ")");
      }
      const attempt = await tryUserInfo(knownUserId);
      if (attempt.mismatchedId) {
        rejectedIds.add(knownUserId);
        knownUserId = null; // proven to be someone else's id
      }
      return attempt;
    }

    const strategies = APP_ID_CANDIDATES.map((appId) => ({
      name: "web_profile_info (app id " + appId + ")",
      run: () => tryWebProfileInfo(appId),
    }));
    strategies.push({ name: "users/<id>/info", run: userInfoStrategy });
    strategies.push({ name: "page DOM", run: async () => tryDomProfile(knownUserId, rejectedIds) });

    for (let index = 0; index < strategies.length; index++) {
      if (!isCurrent()) return null;
      const strategy = strategies[index];
      const attempt = await strategy.run();

      if (attempt.ok) {
        if (tried.length) {
          await report("IG_NOTE", {
            detail:
              "profile " + attempt.profile.profile_source + " se mila (" + tried.join(" | ") + ")",
          });
        }
        await report("IG_META", {
          userId: attempt.profile.user_id,
          profile: attempt.profile,
          readable: attempt.readable,
        });
        return { profile: attempt.profile, readable: attempt.readable, seed: attempt.seed };
      }

      if (attempt.reason === "stopped") return null;
      if (attempt.definitive) {
        await fail(attempt.reason, attempt.detail, attempt.status);
        return null;
      }

      tried.push(strategy.name + " → " + attempt.reason + (attempt.status ? " " + attempt.status : ""));
      if (WALL_REASONS.has(attempt.reason)) {
        await fail(attempt.reason, attempt.detail, attempt.status);
        return null;
      }
      if (index < strategies.length - 1 && !(await pacedSleep(jitter(job.pageDelayMs)))) return null;
    }

    await fail("profile_unavailable", tried.join(" | "), null);
    return null;
  }

  // ----------------------------------------------------------------- pagination step

  async function paginateFeed(userId, startCursor, seenIds, startPageIndex) {
    const seen = new Set(seenIds || []);
    let cursor = startCursor || null;
    let pageIndex = startPageIndex || 0;
    let emptyStreak = 0;
    // Counts pages this endpoint has actually delivered. The caller's pageIndex may
    // already be non-zero (seed page, or a resume), which says nothing about whether the
    // feed API itself has ever worked.
    let banked = 0;

    while (isCurrent()) {
      const path =
        FEED_PATH +
        encodeURIComponent(userId) +
        "/?count=" +
        PAGE_SIZE +
        (cursor ? "&max_id=" + encodeURIComponent(cursor) : "");

      const res = await getJson(path);
      if (!res.ok) {
        if (res.reason === "stopped") return "stopped";
        // The feed endpoint being gone entirely is the signal to try GraphQL — but only
        // before we have banked anything from it. A mid-crawl shape change is a real
        // failure the user should see rather than a silent source switch.
        if ((res.reason === "not_found" || res.reason === "endpoint_shape") && banked === 0) {
          return "fallback";
        }
        await fail(res.reason, res.detail, res.status);
        return "failed";
      }

      const data = res.data || {};
      if (!Array.isArray(data.items)) {
        if (banked === 0) return "fallback";
        await fail("endpoint_shape", "feed response me items[] nahi mila", 200);
        return "failed";
      }

      const fresh = [];
      for (const item of data.items) {
        const post = mapPost(item);
        if (!post || seen.has(post.id)) continue;
        seen.add(post.id);
        fresh.push(post);
      }

      const more = !!data.more_available;
      const nextCursor = data.next_max_id ? String(data.next_max_id) : null;

      if (!data.items.length) {
        // One empty page can be a hiccup; two in a row means we are done or the shape
        // changed. Never spin here.
        emptyStreak += 1;
        if (emptyStreak >= 2 || !more || !nextCursor) {
          await report("IG_DONE", { capped: false });
          return "done";
        }
      } else {
        emptyStreak = 0;
        banked += 1;
        if (fresh.length) {
          const ack = await report("IG_PAGE", {
            userId,
            posts: fresh,
            nextCursor,
            moreAvailable: more,
            pageIndex,
            source: "feed_api",
          });
          if (!ack || ack.ok === false) return "stopped";
        }
      }

      pageIndex += 1;
      cursor = nextCursor;

      if (!more || !cursor) {
        await report("IG_DONE", { capped: false });
        return "done";
      }
      if (pageIndex >= HARD_PAGE_CAP) {
        await report("IG_DONE", { capped: true });
        return "done";
      }
      if (!(await pacedSleep(jitter(job.pageDelayMs)))) return "stopped";
    }
    return "stopped";
  }

  // Fallback: classic edge_owner_to_timeline_media cursor pagination.
  async function paginateGraphql(userId, startCursor, seenIds, startPageIndex) {
    const seen = new Set(seenIds || []);
    let cursor = startCursor || null;
    let pageIndex = startPageIndex || 0;
    let hashIndex = 0;

    while (isCurrent()) {
      const variables = JSON.stringify({
        id: String(userId),
        first: GRAPHQL_PAGE_SIZE,
        after: cursor,
      });
      const path =
        GRAPHQL_PATH +
        "?query_hash=" +
        GRAPHQL_HASHES[hashIndex] +
        "&variables=" +
        encodeURIComponent(variables);

      const res = await getJson(path);
      if (!res.ok) {
        if (res.reason === "stopped") return "stopped";
        // A retired query_hash reads as a 404/400 — walk the list before giving up.
        const hashesLeft = hashIndex < GRAPHQL_HASHES.length - 1;
        if ((res.reason === "not_found" || res.reason === "endpoint_shape") && hashesLeft) {
          hashIndex += 1;
          if (!(await pacedSleep(jitter(job.pageDelayMs)))) return "stopped";
          continue;
        }
        if (res.reason === "not_found" || res.reason === "endpoint_shape") return "fallback";
        await fail(res.reason, res.detail, res.status);
        return "failed";
      }

      const media =
        res.data &&
        res.data.data &&
        res.data.data.user &&
        res.data.data.user.edge_owner_to_timeline_media;
      if (!media || !Array.isArray(media.edges)) {
        if (hashIndex < GRAPHQL_HASHES.length - 1) {
          hashIndex += 1;
          continue;
        }
        return "fallback";
      }

      const fresh = [];
      for (const edge of media.edges) {
        const post = mapGraphNode(edge && edge.node);
        if (!post || seen.has(post.id)) continue;
        seen.add(post.id);
        fresh.push(post);
      }

      const info = media.page_info || {};
      const more = !!info.has_next_page;
      const nextCursor = info.end_cursor || null;

      if (fresh.length) {
        const ack = await report("IG_PAGE", {
          userId,
          posts: fresh,
          nextCursor,
          moreAvailable: more,
          pageIndex,
          source: "graphql",
        });
        if (!ack || ack.ok === false) return "stopped";
      }

      pageIndex += 1;
      cursor = nextCursor;

      if (!more || !cursor) {
        await report("IG_DONE", { capped: false });
        return "done";
      }
      if (pageIndex >= HARD_PAGE_CAP) {
        await report("IG_DONE", { capped: true });
        return "done";
      }
      if (!(await pacedSleep(jitter(job.pageDelayMs)))) return "stopped";
    }
    return "stopped";
  }

  // Last resort: scroll the rendered grid and harvest shortcodes. Yields a reduced post
  // schema (no counts, no captions) but keeps the feature useful when both JSON paths
  // are gone. Tagged source:"dom" so the file never pretends to be complete data.
  async function harvestDom(userId) {
    const seen = new Set();
    const posts = [];
    let stagnantRounds = 0;
    let pageIndex = 0;

    while (isCurrent() && stagnantRounds < 3 && pageIndex < HARD_PAGE_CAP) {
      const before = posts.length;
      const anchors = Array.from(document.querySelectorAll("a[href]"));
      for (const anchor of anchors) {
        const match = (anchor.getAttribute("href") || "").match(/\/(?:p|reel)\/([A-Za-z0-9_-]+)/);
        if (!match) continue;
        const shortcode = match[1];
        if (seen.has(shortcode)) continue;
        seen.add(shortcode);
        posts.push({
          id: shortcode,
          shortcode,
          url: "https://www.instagram.com/p/" + shortcode + "/",
          taken_at: null,
          media_type: "unknown",
          is_video: null,
          caption: "",
          like_count: null,
          comment_count: null,
          view_count: null,
          display_url: null,
          video_url: null,
          carousel_media: null,
          location: null,
          tagged_users: [],
        });
      }

      if (posts.length > before) {
        const ack = await report("IG_PAGE", {
          userId,
          posts: posts.slice(before),
          nextCursor: null,
          moreAvailable: true,
          pageIndex,
          source: "dom",
        });
        if (!ack || ack.ok === false) return "stopped";
        stagnantRounds = 0;
      } else {
        stagnantRounds += 1;
      }

      pageIndex += 1;
      window.scrollTo(0, document.body.scrollHeight);
      if (!(await pacedSleep(Math.max(1200, jitter(job.pageDelayMs))))) return "stopped";
    }

    if (!isCurrent()) return "stopped";
    await report("IG_DONE", { capped: pageIndex >= HARD_PAGE_CAP });
    return "done";
  }

  // ------------------------------------------------------------------------ main run

  (async function run() {
    if (!onInstagram()) {
      await fail("wrong_origin", "Tab instagram.com pe nahi hai (" + location.href + ")");
      return;
    }
    if (looksLikeLoginWall()) {
      await fail("login_wall", "Instagram login page dikh raha hai");
      return;
    }

    let userId = job.userId || null;
    let seenIds = job.seenPostIds || [];
    const cursor = job.cursor || null;
    let pageIndex = job.pagesFetched || 0;

    // Fresh account: resolve the profile first. Resuming mid-account: the worker already
    // has it, so go straight back to the saved cursor.
    if (!userId) {
      const resolved = await resolveProfile();
      if (!resolved) return;
      if (!resolved.readable) return; // private — the worker records it and moves on
      userId = resolved.profile.user_id || null;

      const seed = resolved.seed;
      if (seed && seed.posts.length) {
        const ack = await report("IG_PAGE", {
          userId,
          posts: seed.posts,
          // The feed API carries its own cursor, so nothing to hand forward here.
          nextCursor: null,
          moreAvailable: true,
          pageIndex: 0,
          source: "web_profile_info",
        });
        if (!ack || ack.ok === false) return;
        seenIds = seed.posts.map((post) => post.id);
        // Keep the page counter honest: the seed page already counted as page 0.
        pageIndex = 1;
        // If the whole profile fits on that one page there is nothing left to paginate.
        if (!seed.hasNext) {
          await report("IG_DONE", { capped: false });
          return;
        }
      }
      if (!(await pacedSleep(jitter(job.pageDelayMs)))) return;
    }

    // Both JSON feeds address an account by numeric id. If only the DOM could tell us who
    // this is, the rendered grid is the only source left — go straight there rather than
    // requesting /feed/user/null/.
    let outcome;
    if (!userId) {
      await report("IG_NOTE", {
        detail: "user id kahin se nahi mila — sirf DOM scroll se posts nikaal rahe hain",
      });
      outcome = await harvestDom(null);
    } else {
      outcome = await paginateFeed(userId, cursor, seenIds, pageIndex);
    }

    if (outcome === "fallback") {
      await report("IG_NOTE", { detail: "feed API ne kaam nahi kiya — GraphQL try kar rahe hain" });
      outcome = await paginateGraphql(userId, null, seenIds, pageIndex);
    }
    if (outcome === "fallback") {
      await report("IG_NOTE", { detail: "GraphQL bhi fail — DOM scroll se shortcodes nikaal rahe hain" });
      outcome = await harvestDom(userId);
    }
    if (outcome === "fallback") {
      await fail("endpoint_shape", "feed API, GraphQL aur DOM — teeno fail ho gaye");
    }
  })();
})();
