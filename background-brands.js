// Insta Handle Finder — brand contact finder (background runner).
//
// Give it a list of brand names; it gives back one row per brand: official website,
// public email addresses, phone numbers, the brand's social profiles, and the people
// named as founder / owner / CEO with the page each claim came from.
//
// Shape of a run, per brand (each step is one page load in one visible tab):
//
//   1. Google  "<brand>" official website contact email          -> website + socials
//   2. Google  site:linkedin.com "<brand>" (founder OR CEO ...)  -> owner names + profiles
//   3. Google  site:apollo.io "<brand>"                          -> apollo company page
//   4. the brand's own site: homepage, then up to N contact/about/team pages
//   5. optional: open the LinkedIn company page and the Apollo page themselves
//
// Steps 1-3 are what the *directories* say; step 4 is what the brand itself publishes.
// Step 4 is the one that actually produces addresses and numbers, which is why it runs
// even when the directory steps come back empty.
//
// Stance, same as every other runner in this extension: the user's own session, one
// visible tab, an honest delay between page loads, no proxies, no header spoofing, no
// CAPTCHA solving. A Google wall pauses the run and waits for a human. Only pages that
// are already public to a logged-out visitor are read; a login wall is recorded as a
// note on the row and the run moves on rather than trying to get around it.
//
// Division of labour: this file owns the queue, the merge, the dedupe and the output
// file. content-brand-fetch.js owns "what can be read off one page".

const BRANDS_STATE_KEY = "brandsRunState";
const BRANDS_ALARM = "brandsNextTask";
const BRANDS_TIMEOUT_ALARM = "brandsTaskTimeout";
const BRANDS_NOTIF_ID = "brands-pause";

// Guards. The panel offers smaller numbers; these only stop a hand-edited message from
// turning into a multi-hour unattended crawl.
const BRANDS_MAX_BRANDS = 300;
const BRANDS_MAX_SITE_PAGES = 8;
const BRANDS_INJECT_ATTEMPTS = 3;
// A website that never fires `complete` (chat widgets, long-poll analytics) must not
// hold the whole run. After this the page is injected anyway, and skipped if that fails.
const BRANDS_TASK_TIMEOUT_SEC = 45;
// chrome.alarms clamps a delay to ~30s, so short waits use setTimeout and the alarm is
// only the backstop for a service worker that got suspended mid-wait.
const BRANDS_TIMER_MAX_SEC = 25;

// Hosts that are never a brand's "official website", however high they rank. Split in
// two because they are treated differently: the aggregators still carry real contact
// details worth reading out of a snippet, the platforms do not.
const BRANDS_PLATFORM_HOSTS = [
  "google.com", "youtube.com", "youtu.be", "facebook.com", "instagram.com", "twitter.com",
  "x.com", "linkedin.com", "pinterest.com", "tiktok.com", "reddit.com", "quora.com",
  "wikipedia.org", "medium.com", "blogspot.com", "wordpress.com", "issuu.com", "scribd.com",
  "play.google.com", "apps.apple.com", "amazon.com", "amazon.in", "flipkart.com",
  "myntra.com", "ajio.com", "nykaa.com", "meesho.com", "etsy.com", "ebay.com",
];
// People-search databases. Their *public* pages name a company's leadership and its
// titles; the direct-dial numbers themselves sit behind a login and a credit, and this
// mode does not go there. So they are read for "who is the decision maker", and the
// number is then looked for on sources that actually publish one.
const BRANDS_LEADDB_HOSTS = [
  "apollo.io", "rocketreach.co", "lusha.com", "contactout.com", "easyleadz.com",
  "coresignal.com", "zoominfo.com", "signalhire.com",
];

// Company registries. For an Indian private limited these are the only public source
// that names the *board of directors* rather than whoever writes the LinkedIn posts,
// and the filings behind them are public record.
const BRANDS_REGISTRY_HOSTS = ["zaubacorp.com", "tofler.in", "indiafilings.com", "instafinancials.com"];

const BRANDS_DIRECTORY_HOSTS = [
  ...BRANDS_LEADDB_HOSTS,
  ...BRANDS_REGISTRY_HOSTS,
  "crunchbase.com", "owler.com", "pitchbook.com",
  "indiamart.com", "justdial.com", "sulekha.com", "tradeindia.com", "exportersindia.com",
  "glassdoor.com", "indeed.com", "ambitionbox.com", "yelp.com", "tripadvisor.com",
  "bloomberg.com", "dnb.com", "clutch.co", "goodfirms.co", "yellowpages.com",
];

// Roles worth keeping. A brand row is meant to answer "who do I contact", so a random
// intern on the company's LinkedIn page is noise; these are the titles that are not.
const BRANDS_ROLE_RE = /\b(founder|co-?founder|owner|proprietor|ceo|chief executive|managing director|director|partner|president|head|chairman|chairperson|cmo|cto|coo|cfo|vp|vice president|manager)\b/i;

// How senior a title is, most senior first. Used to sort the decision makers so the row's
// headline contact is the one worth calling, not whoever happened to be parsed first.
const BRANDS_ROLE_RANK = [
  [/\b(founder|co-?founder|owner|proprietor)\b/i, 100],
  [/\b(chairman|chairperson|managing director|\bmd\b|ceo|chief executive)\b/i, 90],
  [/\b(director|partner|president)\b/i, 70],
  [/\b(cto|cfo|coo|cmo|chief)\b/i, 60],
  [/\b(vp|vice president|head)\b/i, 45],
  [/\bmanager\b/i, 25],
];

function roleRank(title) {
  const text = String(title || "");
  for (const [pattern, rank] of BRANDS_ROLE_RANK) {
    if (pattern.test(text)) return rank;
  }
  return 0;
}

// A shared inbox is the company's, not a person's. Both are worth having, but only one
// of them answers "get me the owner", so they are never mixed in the output.
const BRANDS_ROLE_INBOX_RE =
  /^(info|hello|hi|contact|contactus|support|help|helpdesk|care|customercare|service|sales|enquiry|enquiries|inquiry|admin|office|team|mail|email|marketing|hr|careers|jobs|recruitment|press|media|billing|accounts|account|orders|order|feedback|reach|connect|business|bd|partner|partners|partnerships|wholesale|export|noreply)\b/i;

const BRANDS_CONFIDENCE_RANK = { high: 3, medium: 2, low: 1 };

// A number labelled "mobile"/"direct" on the page is a person's line; "reception" is not.
const BRANDS_PERSONAL_LINE_RE = /\b(mobile|cell|direct|dial|whatsapp|personal|founder|owner|proprietor|ceo|md|managing director|manager|director|partner|chairman)\b/i;
const BRANDS_OFFICE_LINE_RE = /\b(toll[\s-]?free|landline|office|reception|helpline|support|sales|customer care)\b/i;

function lineTypeOf(label) {
  const text = String(label || "");
  if (!text) return null;
  if (BRANDS_PERSONAL_LINE_RE.test(text)) return "personal";
  if (BRANDS_OFFICE_LINE_RE.test(text)) return "office";
  return null;
}

// ----------------------------------------------------------------------- state helpers

function defaultBrandsState() {
  return {
    status: "idle", // idle | running | waiting_delay | paused | stopped | done
    brands: [], // display names, input order
    queue: [], // pending tasks
    current: null, // task in flight
    rows: {}, // brandKey -> row
    region: "",
    googleDelaySec: 15,
    pageDelaySec: 6,
    sitePages: 3,
    useLinkedin: true,
    useLeadDb: true, // Apollo, RocketReach, Lusha, ContactOut, EasyLeadz, CoreSignal — one query
    useRegistry: true, // Zauba/Tofler/IndiaFilings — the only public list of a board
    openProfiles: false, // also open those pages, not just read their snippets
    ownerOnly: false, // drop shared inboxes and switchboard numbers from the output
    hostAccess: false, // "<all_urls>" granted? without it, step 4 cannot run
    tabId: null,
    pendingInject: false,
    injectToken: 0,
    pauseReason: "",
    totals: { tasksDone: 0, tasksPlanned: 0, brandsDone: 0, emails: 0, phones: 0, people: 0, reachableOwners: 0 },
    savedFile: "",
    lastEvent: "",
    log: [],
    updatedAt: 0,
  };
}

async function getBrandsState() {
  const stored = await chrome.storage.local.get(BRANDS_STATE_KEY);
  return stored[BRANDS_STATE_KEY] || defaultBrandsState();
}

async function setBrandsState(patch) {
  const current = await getBrandsState();
  const next = { ...current, ...patch, updatedAt: Date.now() };
  if (patch.lastEvent) {
    next.log = [...(current.log || []), patch.lastEvent].slice(-50);
  }
  await chrome.storage.local.set({ [BRANDS_STATE_KEY]: next });
  return next;
}

// Same reason as every other runner here: state changes are read-modify-write, and tab
// events land while panel commands are still in flight.
let brandsStateChain = Promise.resolve();

function queueBrandsTask(task) {
  const run = brandsStateChain.then(task, task);
  brandsStateChain = run.then(
    () => undefined,
    () => undefined
  );
  return run;
}

function brandsStatusIsActive(status) {
  return status === "running" || status === "waiting_delay" || status === "paused";
}

function brandsSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------------ pure helpers
//
// Everything from here to "tab driving" is deliberately free of chrome.* calls: the
// merge rules are the part of this file most likely to be wrong, and a plain function
// can be exercised in a Node harness without a browser, a network or a storage stub.

function brandKeyOf(name) {
  return String(name || "").trim().toLowerCase();
}

function brandSlug(name) {
  return String(name || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hostOfUrl(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch (e) {
    return "";
  }
}

function hostMatches(host, list) {
  if (!host) return false;
  return list.some((entry) => host === entry || host.endsWith("." + entry));
}

function isPlatformHost(host) {
  return hostMatches(host, BRANDS_PLATFORM_HOSTS);
}

function isDirectoryHost(host) {
  return hostMatches(host, BRANDS_DIRECTORY_HOSTS);
}

function googleSearchUrl(query) {
  const params = new URLSearchParams({ q: query, num: "20" });
  return "https://www.google.com/search?" + params.toString();
}

function defaultBrandRow(brand) {
  return {
    brand,
    key: brandKeyOf(brand),
    website: null,
    linkedin_company: null,
    apollo_url: null,
    lead_db_pages: [], // [{ host, url }] — where a name was read, so a claim can be checked
    registry_pages: [],
    emails: [],
    phones: [],
    socials: {},
    people: [],
    pages_seen: [],
    notes: [],
    site_pages_done: 0,
    status: "pending",
  };
}

// Dedupe by value, but let a better-sourced sighting upgrade one already on the row:
// the same address found first in loose page text and later in a mailto: link is one
// address that we are now more sure about, not two.
function mergeContactValues(existing, incoming, cap) {
  const byValue = new Map();
  for (const item of existing || []) byValue.set(item.value, item);
  for (const item of incoming || []) {
    if (!item || !item.value) continue;
    const prior = byValue.get(item.value);
    if (!prior) {
      if (byValue.size >= cap) continue;
      byValue.set(item.value, item);
      continue;
    }
    const priorRank = BRANDS_CONFIDENCE_RANK[prior.confidence] || 0;
    const nextRank = BRANDS_CONFIDENCE_RANK[item.confidence] || 0;
    if (nextRank > priorRank) byValue.set(item.value, { ...item, source_url: prior.source_url || item.source_url });
  }
  return Array.from(byValue.values()).sort(
    (a, b) => (BRANDS_CONFIDENCE_RANK[b.confidence] || 0) - (BRANDS_CONFIDENCE_RANK[a.confidence] || 0)
  );
}

function mergePeople(existing, incoming, cap) {
  const byName = new Map();
  for (const person of existing || []) byName.set(person.name.toLowerCase(), person);
  for (const person of incoming || []) {
    if (!person || !person.name) continue;
    const key = person.name.toLowerCase();
    const prior = byName.get(key);
    if (!prior) {
      if (byName.size >= cap) continue;
      byName.set(key, person);
      continue;
    }
    // Keep the richer record: a name from a website's team page plus a title and a
    // profile URL from LinkedIn is one person described twice.
    byName.set(key, {
      ...prior,
      title: roleRank(person.title) > roleRank(prior.title) ? person.title : prior.title || person.title || "",
      url: prior.url || person.url || null,
      emails: mergeContactValues(prior.emails || [], person.emails || [], 5),
      phones: mergeContactValues(prior.phones || [], person.phones || [], 5),
      confidence:
        (BRANDS_CONFIDENCE_RANK[person.confidence] || 0) > (BRANDS_CONFIDENCE_RANK[prior.confidence] || 0)
          ? person.confidence
          : prior.confidence,
    });
  }
  return Array.from(byName.values());
}

// Does this address belong to this person? Only structural matches count — the local part
// has to be built out of their name. "ravi.sharma@acme.com" is Ravi Sharma's; "info@" is
// nobody's; "sales@" is not the sales head's. Guessing beyond this would invent contacts,
// which is the one thing a lead list must never do.
function emailBelongsToPerson(email, name) {
  const local = String(email || "").split("@")[0].toLowerCase().replace(/[^a-z0-9]/g, "");
  if (!local || local.length < 3) return false;
  // A shared inbox is never a person's, however the name-match falls out. Without this,
  // a parsed "title" that reads like a name — "Sales Head", "Support Manager" — would
  // claim sales@ / support@ and the row would present a department as the owner.
  if (BRANDS_ROLE_INBOX_RE.test(local)) return false;
  const parts = String(name || "")
    .toLowerCase()
    .split(/\s+/)
    .map((part) => part.replace(/[^a-z]/g, ""))
    .filter((part) => part.length > 1);
  if (!parts.length) return false;

  const first = parts[0];
  const last = parts[parts.length - 1];
  const candidates = new Set();
  if (first.length >= 3) candidates.add(first);
  if (last.length >= 3) candidates.add(last);
  if (parts.length > 1) {
    candidates.add(first + last);
    candidates.add(last + first);
    candidates.add(first[0] + last);
    candidates.add(last + first[0]);
    candidates.add(first + last[0]);
  }
  return candidates.has(local);
}

// Splits what the run collected into "this is a person's" and "this is the company's",
// and hands every person the contacts that are provably theirs. Pure, and the part of the
// file most worth testing: the whole owner-vs-reception distinction lives here.
function attributeBrandContacts(row) {
  const people = (row.people || []).map((person) => ({
    ...person,
    emails: [...(person.emails || [])],
    phones: [...(person.phones || [])],
  }));

  const claimedEmails = new Set();
  const claimedPhones = new Set();
  for (const person of people) {
    for (const item of person.emails) claimedEmails.add(item.value);
    for (const item of person.phones) claimedPhones.add(item.value);
  }

  // Name-shaped addresses found anywhere on the brand's pages get handed to their owner.
  for (const email of row.emails || []) {
    for (const person of people) {
      if (!emailBelongsToPerson(email.value, person.name)) continue;
      if (!person.emails.some((item) => item.value === email.value)) {
        person.emails.push({ ...email, how: email.how + "+name_match" });
      }
      claimedEmails.add(email.value);
    }
  }

  const isPersonalEmail = (email) =>
    claimedEmails.has(email.value) || !BRANDS_ROLE_INBOX_RE.test(email.value.split("@")[0]);
  const isPersonalPhone = (phone) => claimedPhones.has(phone.value) || lineTypeOf(phone.label) === "personal";

  const rank = (person) => roleRank(person.title) + (person.phones.length ? 5 : 0) + (person.emails.length ? 3 : 0);
  const decisionMakers = people
    .filter((person) => roleRank(person.title) > 0 || person.source !== "site_text")
    .sort((a, b) => rank(b) - rank(a));

  return {
    decision_makers: decisionMakers,
    // Everything not tied to a person, kept because a shared inbox is still a way in —
    // it is just labelled as one rather than passed off as the owner's.
    company_emails: (row.emails || []).filter((email) => !isPersonalEmail(email)),
    company_phones: (row.phones || []).filter((phone) => !isPersonalPhone(phone)),
    unattributed_personal_emails: (row.emails || []).filter(
      (email) => isPersonalEmail(email) && !claimedEmails.has(email.value)
    ),
    unattributed_personal_phones: (row.phones || []).filter(
      (phone) => isPersonalPhone(phone) && !claimedPhones.has(phone.value)
    ),
  };
}

// "Ravi Sharma - Founder & CEO - Acme Foods | LinkedIn" is the shape Google prints for a
// profile result, and it is the whole reason this mode can name an owner without ever
// logging in to LinkedIn or opening a profile page. Every people-search site prints a
// variation of it, so the suffixes and the "Email & Phone Number" filler they bolt on are
// stripped before the same split runs.
const BRANDS_TITLE_SUFFIX_RE =
  /\s*[|·–-]\s*(LinkedIn|Apollo\.io|Apollo|RocketReach|Lusha|ContactOut|EasyLeadz|CoreSignal|ZoomInfo|SignalHire|Zauba\s*Corp|Tofler|IndiaFilings)\s*$/gi;
const BRANDS_TITLE_FILLER_RE =
  /\b(email\s*(&|and)?\s*phone\s*number|phone\s*number\s*(&|and)?\s*email|contact\s*(info|information|details)|email\s*address|direct\s*dial|mobile\s*number)\b/gi;

function parsePersonResultTitle(title) {
  let cleaned = String(title || "");
  // Twice: "… | Founder @ Acme | RocketReach" carries two suffix-shaped tails.
  cleaned = cleaned.replace(BRANDS_TITLE_SUFFIX_RE, "").replace(BRANDS_TITLE_SUFFIX_RE, "");
  cleaned = cleaned.replace(BRANDS_TITLE_FILLER_RE, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return null;

  const parts = cleaned
    .split(/\s+[-–—|·]\s+|\s+@\s+|\s+\bat\b\s+/i)
    .map((part) => part.trim())
    .filter(Boolean);
  const name = (parts[0] || "").replace(/\s*\(.*?\)\s*/g, "").replace(/[,;:]+$/, "").trim();
  if (!name || name.length > 60 || /\d/.test(name)) return null;
  if (name.split(/\s+/).length > 5) return null;
  const role = parts.slice(1).find((part) => BRANDS_ROLE_RE.test(part)) || "";
  return { name, title: role.slice(0, 80) };
}

// The brand's own site, chosen from a Google page. Ranking beats "first result": a
// domain that spells the brand is right far more often than whatever ranked top, and
// platforms/aggregators are never it however high they sit.
function pickWebsite(results, brand) {
  const slug = brandSlug(brand);
  let best = null;
  let bestScore = -1;
  for (let index = 0; index < results.length; index++) {
    const result = results[index];
    const host = result.host || hostOfUrl(result.url);
    if (!host || isPlatformHost(host) || isDirectoryHost(host)) continue;

    const hostSlug = brandSlug(host.split(".")[0]);
    let score = 0;
    if (slug && hostSlug === slug) score += 60;
    else if (slug && hostSlug.includes(slug)) score += 40;
    else if (slug && brandSlug(host).includes(slug)) score += 30;
    if (/\.(com|in|co|net|org|io|shop|store)$/.test(host)) score += 5;
    score += Math.max(0, 20 - index); // rank still matters, it is just not decisive

    if (score > bestScore) {
      bestScore = score;
      best = result;
    }
  }
  // Nothing scored on the name at all: a top-ranked non-platform result is a guess, so
  // it is taken but the row records how it was chosen.
  if (!best) return null;
  return {
    url: "https://" + (best.host || hostOfUrl(best.url)) + "/",
    host: best.host || hostOfUrl(best.url),
    matched_name: bestScore >= 30,
  };
}

// A snippet's contact details belong to the result they were printed under. Accepting
// them unconditionally would put a competitor's email on the row, so a snippet only
// counts when the result is plausibly *about this brand*.
function snippetIsAboutBrand(result, brand, websiteHost) {
  const host = result.host || hostOfUrl(result.url);
  if (websiteHost && host === websiteHost) return true;
  const slug = brandSlug(brand);
  if (!slug) return false;
  if (brandSlug(host).includes(slug)) return true;
  return brandSlug(result.title || "").includes(slug);
}

// A social *profile*, not a post, a video, a person's own account or a share link. Google
// returns all of those from a brand query, and putting an employee's /in/ URL in the row's
// "linkedin" field would be worse than leaving it empty.
const BRANDS_NON_PROFILE_PATH_RE = /\/(p|reel|reels|tv|stories|posts|status|watch|video|videos|shorts|photo|events|jobs|in|pulse|groups|hashtag)(\/|$)/i;

function looksLikeSocialProfile(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, "");
    if (!path || path === "/") return false;
    if (BRANDS_NON_PROFILE_PATH_RE.test(path)) return false;
    return path.split("/").filter(Boolean).length <= 2;
  } catch (e) {
    return false;
  }
}

function socialNetworkOf(url) {
  const host = hostOfUrl(url);
  if (!host) return null;
  if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
  if (/(^|\.)(facebook\.com|fb\.com)$/.test(host)) return "facebook";
  if (/(^|\.)(twitter\.com|x\.com)$/.test(host)) return "twitter";
  if (/(^|\.)(youtube\.com|youtu\.be)$/.test(host)) return "youtube";
  if (/(^|\.)tiktok\.com$/.test(host)) return "tiktok";
  if (/(^|\.)linkedin\.com$/.test(host)) return "linkedin";
  if (/(^|\.)pinterest\./.test(host)) return "pinterest";
  if (/(^|\.)(wa\.me|whatsapp\.com)$/.test(host)) return "whatsapp";
  if (/(^|\.)(t\.me|telegram\.me)$/.test(host)) return "telegram";
  return null;
}

// First sighting wins. A brand's own website links its real profile; a later page
// linking some other account should not overwrite it.
function addSocial(socials, url) {
  const network = socialNetworkOf(url);
  if (!network || !looksLikeSocialProfile(url)) return socials;
  if (socials[network]) return socials;
  return { ...socials, [network]: url };
}

// -------------------------------------------------------------- digesting a SERP page

// Returns { row, followUps, note } — a new row object and any page tasks the results
// earned. Pure, so the whole Google-reading half of this mode is testable on fixtures.
function digestSerpResult(row, task, results, options) {
  let next = { ...row };
  const followUps = [];
  const emails = [];
  const phones = [];
  let people = [];

  if (task.purpose === "site" && !next.website) {
    const site = pickWebsite(results, row.brand);
    if (site) {
      next.website = site.url;
      if (!site.matched_name) {
        next.notes = [...next.notes, "website naam se match nahi hua — Google ke top result se liya (" + site.host + ")"];
      }
    }
  }

  const websiteHost = hostOfUrl(next.website || "");

  for (const result of results) {
    const host = result.host || hostOfUrl(result.url);
    if (!host) continue;

    if (!next.linkedin_company && /(^|\.)linkedin\.com$/.test(host) && /\/company\//.test(result.url)) {
      next.linkedin_company = result.url;
    }
    if (!next.apollo_url && /(^|\.)apollo\.io$/.test(host) && /\/(companies|organizations)\//.test(result.url)) {
      next.apollo_url = result.url;
    }
    // One page per database, kept as evidence: the row should say where a name was read,
    // and a human checking a claim needs the link.
    if (hostMatches(host, BRANDS_LEADDB_HOSTS) && !next.lead_db_pages.some((entry) => entry.host === host)) {
      next.lead_db_pages = [...next.lead_db_pages, { host, url: result.url }].slice(0, 8);
    }
    if (hostMatches(host, BRANDS_REGISTRY_HOSTS) && !next.registry_pages.some((entry) => entry.host === host)) {
      next.registry_pages = [...next.registry_pages, { host, url: result.url }].slice(0, 4);
    }

    // Profile links found on a SERP are the brand's own accounts often enough to be
    // worth keeping, and they are the cheapest social data in the whole run.
    if (isPlatformHost(host)) {
      next.socials = addSocial(next.socials, result.url);
    }

    // Every people-search site has a person-page URL shape; they all end up here so one
    // rule decides what counts as a named decision maker.
    const isPersonPage =
      /linkedin\.com\/in\//.test(result.url) ||
      /\/(people|person|profile|directory|contact)\//i.test(result.url) ||
      hostMatches(host, BRANDS_LEADDB_HOSTS);
    if (isPersonPage) {
      const parsed = parsePersonResultTitle(result.title);
      // Only leadership. Without this the searches return every employee whose profile
      // mentions the brand, and the row stops answering "who do I contact".
      if (parsed && (BRANDS_ROLE_RE.test(parsed.title) || BRANDS_ROLE_RE.test(result.title || ""))) {
        people.push({
          name: parsed.name,
          title: parsed.title,
          url: result.url,
          source: /linkedin/.test(host) ? "linkedin_snippet" : brandSlug(host.split(".")[0]) + "_snippet",
          confidence: "medium",
          // The number these sites show in a snippet is masked ("+91 98***10"), so the
          // phone cleaner drops it. Anything that survives was printed in full.
          emails: (result.emails || []).map((value) => ({ value, confidence: "medium", how: "person_snippet" })),
          phones: (result.phones || []).map((item) => ({
            value: item.value,
            label: item.label || "",
            confidence: "medium",
            how: "person_snippet",
          })),
        });
      }
    }

    if (!snippetIsAboutBrand(result, row.brand, websiteHost)) continue;
    const how = isDirectoryHost(host) ? "directory_snippet" : "google_snippet";
    for (const email of result.emails || []) {
      emails.push({ value: email, confidence: "medium", how, source_url: result.url });
    }
    for (const phone of result.phones || []) {
      phones.push({
        value: phone.value,
        label: phone.label || "",
        confidence: "low",
        how,
        source_url: result.url,
      });
    }
  }

  next.emails = mergeContactValues(next.emails, emails, 30);
  next.phones = mergeContactValues(next.phones, phones, 20);
  next.people = mergePeople(next.people, people, 12);

  // Follow-ups. The homepage is queued as soon as a website is known; the LinkedIn and
  // Apollo pages only when the user asked for them, because both are login-walled often
  // enough that opening them is usually a wasted page load.
  if (task.purpose === "site" && next.website && !next.pages_seen.includes(next.website)) {
    if (options.hostAccess) {
      followUps.push({ kind: "page", source: "site", brand: row.brand, url: next.website });
    } else {
      next.notes = [...next.notes, "website mila par site-access permission nahi hai — page khola nahi gaya"];
    }
  }
  if (options.openProfiles && task.purpose === "people" && next.linkedin_company) {
    followUps.push({ kind: "page", source: "linkedin", brand: row.brand, url: next.linkedin_company });
  }
  // The people-search pages are opened only on request: what they publish for free is the
  // name and the title, which the snippet already gave us, and the number is behind their
  // paywall either way. Two pages max, so a brand cannot cost six page loads for nothing.
  if (options.openProfiles && task.purpose === "leaddb" && options.hostAccess) {
    for (const page of next.lead_db_pages.slice(0, 2)) {
      followUps.push({ kind: "page", source: "leaddb", brand: row.brand, url: page.url });
    }
  }
  // Registry pages are different: they are fully public, and the directors table is the
  // one place a board is actually listed. Worth a page load whenever the toggle is on.
  if (task.purpose === "registry" && next.registry_pages.length) {
    if (options.hostAccess) {
      followUps.push({ kind: "page", source: "registry", brand: row.brand, url: next.registry_pages[0].url });
    } else {
      next.notes = [...next.notes, "registry page mila par site-access permission nahi hai — directors table nahi padha"];
    }
  }

  return { row: next, followUps };
}

// -------------------------------------------------------------- digesting a real page

function digestPageResult(row, task, result, options) {
  let next = { ...row };
  const followUps = [];
  const pageUrl = result.pageUrl || task.url;

  next.pages_seen = next.pages_seen.includes(pageUrl) ? next.pages_seen : [...next.pages_seen, pageUrl];
  if (task.source === "site") next.site_pages_done = (next.site_pages_done || 0) + 1;

  if (result.loginWall) {
    next.notes = [
      ...next.notes,
      result.loginWall === "linkedin_login"
        ? "LinkedIn page login maang raha tha — chhod diya"
        : "Apollo page login maang raha tha — chhod diya",
    ];
    return { row: next, followUps };
  }

  // Only the brand's own site speaks for the brand. On a LinkedIn, Apollo, RocketReach or
  // Zauba page the footer belongs to *that company* — merging it would file
  // "support@rocketreach.co" as the brand's support address, which is worse than useless.
  // Those pages are read for the people they name and for anything on a different domain.
  const thirdParty = task.source !== "site";
  const pageHost = hostOfUrl(pageUrl);
  const notThisPage = (item) => !thirdParty || !String(item.value || "").endsWith("@" + pageHost);

  const emails = (result.emails || []).filter(notThisPage).map((item) => ({ ...item, source_url: pageUrl }));
  const phones = (thirdParty ? [] : result.phones || []).map((item) => ({ ...item, source_url: pageUrl }));
  next.emails = mergeContactValues(next.emails, emails, 30);
  next.phones = mergeContactValues(next.phones, phones, 20);

  if (!thirdParty) {
    for (const social of result.socials || []) {
      next.socials = addSocial(next.socials, social.url);
    }
  }

  const personSource = thirdParty ? task.source + "_page" : "site";
  const people = (result.people || [])
    .filter((person) => person && person.name)
    .map((person) => ({
      name: person.name,
      title: person.title || "",
      url: null,
      source: person.source === "jsonld" ? personSource + "_jsonld" : personSource + "_text",
      confidence: person.confidence || "low",
      // A contact found inside a person's own card survives even on a third-party page:
      // the directors table on a registry page is exactly that, and it is the point.
      emails: (person.emails || []).filter(notThisPage).map((item) => ({ ...item, source_url: pageUrl })),
      phones: (person.phones || []).map((item) => ({ ...item, source_url: pageUrl })),
    }));
  next.people = mergePeople(next.people, people, 20);

  // Contact/about/team pages, but only from the brand's own site and only up to the
  // budget the user set — a big site's "about" menu can otherwise fan out forever.
  if (task.source === "site" && next.site_pages_done < options.sitePages) {
    const budget = options.sitePages - next.site_pages_done;
    const scored = (result.internalLinks || [])
      .filter((url) => !next.pages_seen.includes(url))
      .map((url) => ({ url, rank: /contact/i.test(url) ? 0 : /about|team|leadership|management|founder/i.test(url) ? 1 : 2 }))
      .sort((a, b) => a.rank - b.rank)
      .slice(0, budget);
    for (const entry of scored) {
      followUps.push({ kind: "page", source: "site", brand: row.brand, url: entry.url });
    }
  }

  return { row: next, followUps };
}

// ------------------------------------------------------------------- queue management

// One Google query per *kind* of source, not per site. Asking the six people-search
// databases separately would be six searches a brand — sixty for a ten-brand list, and a
// CAPTCHA long before the end. `(site:a OR site:b OR ...)` gets the same results in one.
function orSites(hosts) {
  return "(" + hosts.map((host) => "site:" + host).join(" OR ") + ")";
}

function planBrandTasks(brand, options) {
  const quoted = '"' + brand + '"';
  const region = options.region ? " " + options.region : "";
  const roles = '(founder OR CEO OR owner OR director OR "managing director" OR manager)';
  const tasks = [
    { kind: "serp", purpose: "site", brand, query: quoted + " official website contact email" + region },
  ];
  if (options.useLinkedin) {
    tasks.push({ kind: "serp", purpose: "people", brand, query: "site:linkedin.com " + quoted + " " + roles + region });
  }
  if (options.useLeadDb) {
    tasks.push({ kind: "serp", purpose: "leaddb", brand, query: orSites(BRANDS_LEADDB_HOSTS) + " " + quoted + " " + roles });
  }
  if (options.useRegistry) {
    tasks.push({
      kind: "serp",
      purpose: "registry",
      brand,
      query: orSites(BRANDS_REGISTRY_HOSTS) + " " + quoted + " directors",
    });
  }
  return tasks.map((task) => ({ ...task, url: googleSearchUrl(task.query) }));
}

// Follow-ups belong to the brand that earned them, so they go in *before* the next
// brand's searches. Otherwise a 50-brand run would do 150 Google searches first and only
// then start opening websites, and stopping halfway would leave every row half-built.
function insertBrandTasks(queue, brand, tasks) {
  if (!tasks.length) return queue;
  const key = brandKeyOf(brand);
  let insertAt = 0;
  for (let index = queue.length - 1; index >= 0; index--) {
    if (brandKeyOf(queue[index].brand) === key) {
      insertAt = index + 1;
      break;
    }
  }
  const next = queue.slice();
  next.splice(insertAt, 0, ...tasks);
  return next;
}

function describeBrandsTask(task) {
  if (!task) return "-";
  if (task.kind === "serp") {
    const label = task.purpose === "site" ? "website" : task.purpose === "people" ? "log" : "apollo";
    return task.brand + " — Google (" + label + ")";
  }
  return task.brand + " — " + (task.source === "site" ? "website page" : task.source) + " (" + hostOfUrl(task.url) + ")";
}

// ------------------------------------------------------------------------ permissions
//
// Reading a brand's own website means injecting into an arbitrary host, which needs
// "<all_urls>". That is a big permission to hold permanently for a run the user may
// never do, so it is optional and asked for from the panel. Without it the Google half
// still works and every skipped site page is recorded on the row.

async function hasBrandsHostAccess() {
  try {
    return await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch (e) {
    return false;
  }
}

// -------------------------------------------------------------------------- tab driving

async function openBrandsTab(state) {
  const url = state.current && state.current.url;
  if (!url) return null;
  const token = (state.injectToken || 0) + 1;

  let tabId = state.tabId;
  if (tabId != null) {
    try {
      await chrome.tabs.update(tabId, { url, active: true });
    } catch (e) {
      tabId = null; // tab is gone; fall through and make a new one
    }
  }
  if (tabId == null) {
    const tab = await chrome.tabs.create({ url, active: true });
    tabId = tab.id;
    try {
      await chrome.sidePanel.open({ tabId });
    } catch (e) {
      // panel may already be open, or the user-gesture window expired — non-fatal
    }
  }

  await setBrandsState({ tabId, injectToken: token, pendingInject: true });
  scheduleBrandsTimeout();
  return tabId;
}

async function injectBrandsFetcher(tabId, task) {
  let lastError = null;
  for (let attempt = 1; attempt <= BRANDS_INJECT_ATTEMPTS; attempt++) {
    try {
      // executeScript cannot pass arguments to a `files` injection, so the job is seeded
      // into the isolated world first — both injections share that world's `window`.
      await chrome.scripting.executeScript({
        target: { tabId },
        func: (seed) => {
          window.__BRD_JOB__ = seed;
        },
        args: [{ kind: task.kind, brand: task.brand, source: task.source || null }],
      });
      const injections = await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content-brand-fetch.js"],
      });
      const result = injections && injections[0] ? injections[0].result : null;
      if (result) return { ok: true, result };
      lastError = new Error("page returned nothing");
    } catch (e) {
      lastError = e;
    }
    if (attempt < BRANDS_INJECT_ATTEMPTS) await brandsSleep(1200 * attempt);
  }
  return { ok: false, error: lastError && lastError.message ? lastError.message : "injection failed" };
}

// ---------------------------------------------------------------------------- pausing

const BRANDS_PAUSE_MESSAGES = {
  sorry_url: "Google ne block kar diya — tab me CAPTCHA solve karke Resume dabao.",
  recaptcha_dom: "Google pe CAPTCHA aa gaya — solve karke Resume dabao.",
  marker_text: "Google ne unusual traffic bola — thoda ruk ke Resume dabao (delay badha do).",
  injection_failed: "Google page pe script chal nahi payi — tab check karke Resume dabao.",
};

async function enterBrandsPause(reason, detail) {
  await chrome.alarms.clear(BRANDS_ALARM);
  await chrome.alarms.clear(BRANDS_TIMEOUT_ALARM);
  chrome.action.setBadgeText({ text: "⏸" });
  chrome.action.setBadgeBackgroundColor({ color: "#d93025" });
  const message = detail || BRANDS_PAUSE_MESSAGES[reason] || "Brand run ruk gaya (" + reason + ")";
  await setBrandsState({ status: "paused", pauseReason: reason, pendingInject: false, lastEvent: message });
  chrome.notifications.create(BRANDS_NOTIF_ID, {
    type: "basic",
    iconUrl: chrome.runtime.getURL("icons/icon128.png"),
    title: "Brands → contacts — Paused",
    message,
    priority: 2,
    requireInteraction: true,
  });
}

// ------------------------------------------------------------------------- scheduling

function scheduleBrandsTimeout() {
  chrome.alarms.create(BRANDS_TIMEOUT_ALARM, { delayInMinutes: BRANDS_TASK_TIMEOUT_SEC / 60 });
}

// Short waits run on a timer because chrome.alarms clamps anything under ~30s, and a
// 4-second page delay stretched to 30 would turn a 20-brand run into an hour. The alarm
// is still set as a backstop: if the worker is suspended mid-wait the timer dies with it
// and the alarm is what brings the run back.
function scheduleBrandsNext(delaySec) {
  const seconds = Math.max(1, delaySec);
  chrome.alarms.create(BRANDS_ALARM, { delayInMinutes: Math.max(seconds, 30) / 60 });
  if (seconds <= BRANDS_TIMER_MAX_SEC) {
    setTimeout(() => {
      queueBrandsTask(async () => {
        const state = await getBrandsState();
        if (state.status !== "waiting_delay") return; // alarm or a command got here first
        await chrome.alarms.clear(BRANDS_ALARM);
        await setBrandsState({ status: "running" });
        await pumpBrandsTask();
      }).catch(() => undefined);
    }, seconds * 1000);
  }
}

async function scheduleNextBrandsTask() {
  const state = await getBrandsState();
  if (state.status !== "running") return;
  const nextTask = (state.queue || [])[0];
  if (!nextTask) {
    await finishBrandsRun();
    return;
  }
  const delay = nextTask.kind === "serp" ? state.googleDelaySec : state.pageDelaySec;
  await setBrandsState({ status: "waiting_delay" });
  scheduleBrandsNext(delay);
}

// ------------------------------------------------------------------------- the pump

async function pumpBrandsTask() {
  const state = await getBrandsState();
  if (state.status !== "running") return;

  let current = state.current;
  if (!current) {
    const queue = (state.queue || []).slice();
    current = queue.shift();
    if (!current) {
      await finishBrandsRun();
      return;
    }
    await setBrandsState({ current, queue, lastEvent: describeBrandsTask(current) });
  }

  const refreshed = await getBrandsState();
  let tabId = null;
  try {
    tabId = await openBrandsTab(refreshed);
  } catch (e) {
    tabId = null;
  }
  // Nothing else is pending at this point — no alarm, no navigation — so a failure here
  // would leave the run sitting still forever if it were not turned into a pause.
  if (tabId == null) {
    await enterBrandsPause("no_tab", "Tab khul nahi paya — Resume dabao.");
  }
}

// Runs the injection for whatever the tab is currently showing and folds the answer into
// the row. Every exit path either schedules the next task or pauses; nothing may fall
// through, or the run would sit still with no alarm pending.
async function runBrandsTaskOnTab(tabId) {
  await chrome.alarms.clear(BRANDS_TIMEOUT_ALARM);
  const state = await getBrandsState();
  const task = state.current;
  if (!task) return;

  const injection = await injectBrandsFetcher(tabId, task);

  if (!injection.ok) {
    // A Google page that will not run the script is the run's spine — pause. Any other
    // page is one skippable source among several, so it is noted and stepped over.
    if (task.kind === "serp") {
      await enterBrandsPause("injection_failed", BRANDS_PAUSE_MESSAGES.injection_failed + " (" + injection.error + ")");
      return;
    }
    await noteBrandSkip(task, "page padhi nahi ja saki (" + injection.error + ")");
    await advanceBrandsTask();
    return;
  }

  const result = injection.result;
  if (result.blocked) {
    await enterBrandsPause(result.blockReason || "blocked");
    return;
  }

  await applyBrandsResult(task, result);
  await advanceBrandsTask();
}

async function noteBrandSkip(task, reason) {
  const state = await getBrandsState();
  const key = brandKeyOf(task.brand);
  const row = state.rows[key] || defaultBrandRow(task.brand);
  const next = {
    ...row,
    notes: [...row.notes, hostOfUrl(task.url) + ": " + reason].slice(-10),
    site_pages_done: task.source === "site" ? (row.site_pages_done || 0) + 1 : row.site_pages_done,
  };
  await setBrandsState({
    rows: { ...state.rows, [key]: next },
    lastEvent: task.brand + " — " + reason,
  });
}

async function applyBrandsResult(task, result) {
  const state = await getBrandsState();
  const key = brandKeyOf(task.brand);
  const row = state.rows[key] || defaultBrandRow(task.brand);
  const options = {
    hostAccess: state.hostAccess,
    openProfiles: state.openProfiles,
    sitePages: state.sitePages,
  };

  const digested =
    task.kind === "serp"
      ? digestSerpResult(row, task, result.results || [], options)
      : digestPageResult(row, task, result, options);

  const rows = { ...state.rows, [key]: digested.row };
  const queue = insertBrandTasks(state.queue || [], task.brand, digested.followUps);

  // A brand is finished the moment nothing in the queue belongs to it any more.
  const stillQueued = queue.some((entry) => brandKeyOf(entry.brand) === key);
  if (!stillQueued) rows[key] = { ...digested.row, status: "done" };

  const found = digested.row;
  const split = attributeBrandContacts(found);
  const reachable = split.decision_makers.filter((person) => person.phones.length || person.emails.length);
  const summary =
    task.brand +
    " — " +
    split.decision_makers.length +
    " decision maker" +
    (reachable.length ? " (" + reachable.length + " ka contact mila: " + reachable[0].name + ")" : " (kisi ka direct contact nahi)") +
    ", " +
    split.company_emails.length +
    " company email" +
    (found.website ? "" : ", website nahi mila");

  await setBrandsState({
    rows,
    queue,
    current: null,
    totals: {
      ...state.totals,
      tasksDone: (state.totals.tasksDone || 0) + 1,
      tasksPlanned: (state.totals.tasksPlanned || 0) + digested.followUps.length,
      brandsDone: Object.values(rows).filter((entry) => entry.status === "done").length,
      emails: Object.values(rows).reduce((sum, entry) => sum + entry.emails.length, 0),
      phones: Object.values(rows).reduce((sum, entry) => sum + entry.phones.length, 0),
      people: Object.values(rows).reduce((sum, entry) => sum + entry.people.length, 0),
      // The number that actually matters: brands where a *named* person can be reached.
      reachableOwners: Object.values(rows).filter((entry) =>
        attributeBrandContacts(entry).decision_makers.some((person) => person.phones.length || person.emails.length)
      ).length,
    },
    lastEvent: summary,
  });
}

// Drops whatever task was in flight and moves on. Used by both the happy path and the
// skip path, so "current" is cleared in exactly one place.
async function advanceBrandsTask() {
  const state = await getBrandsState();
  if (state.status !== "running") return;
  if (state.current) {
    await setBrandsState({
      current: null,
      totals: { ...state.totals, tasksDone: (state.totals.tasksDone || 0) + 1 },
    });
  }
  await scheduleNextBrandsTask();
}

// ------------------------------------------------------------------------- output file

// The output row, not the working row: the raw collection is folded into "here are the
// decision makers and their contacts" / "here is the company's shared line", which is the
// question the mode exists to answer. `owner_only` drops the second half entirely.
function presentBrandRow(row, ownerOnly) {
  const split = attributeBrandContacts(row);
  const best = split.decision_makers.find((person) => person.phones.length || person.emails.length) || null;

  const presented = {
    brand: row.brand,
    website: row.website,
    // The headline: one person, one number, one address — what a caller actually needs.
    best_contact: best
      ? {
          name: best.name,
          title: best.title || null,
          phone: best.phones.length ? best.phones[0].value : null,
          email: best.emails.length ? best.emails[0].value : null,
          profile: best.url || null,
          source: best.source,
        }
      : null,
    decision_makers: split.decision_makers,
    // Numbers/addresses that look personal but could not be tied to a name — usually a
    // mobile printed in a footer. Kept separate so nobody reads them as the owner's.
    unattributed_personal: {
      emails: split.unattributed_personal_emails,
      phones: split.unattributed_personal_phones,
    },
    socials: row.socials,
    linkedin_company: row.linkedin_company,
    apollo_url: row.apollo_url,
    lead_db_pages: row.lead_db_pages,
    registry_pages: row.registry_pages,
    pages_seen: row.pages_seen,
    notes: row.notes,
    status: row.status,
  };

  if (ownerOnly) {
    presented.company_contacts_dropped = split.company_emails.length + split.company_phones.length;
  } else {
    presented.company_contacts = { emails: split.company_emails, phones: split.company_phones };
  }
  return presented;
}

function brandRowsInOrder(state) {
  return (state.brands || []).map((brand) => state.rows[brandKeyOf(brand)] || defaultBrandRow(brand));
}

function presentedBrandRows(state) {
  return brandRowsInOrder(state).map((row) => presentBrandRow(row, !!state.ownerOnly));
}

function brandsPayload(state) {
  return {
    generated_at: new Date().toISOString(),
    region_hint: state.region || null,
    status: state.status,
    brands_requested: (state.brands || []).length,
    brands_complete: (state.totals && state.totals.brandsDone) || 0,
    owner_only: !!state.ownerOnly,
    sources: {
      google: true,
      brand_website: !!state.hostAccess,
      linkedin_search: !!state.useLinkedin,
      lead_databases: state.useLeadDb ? BRANDS_LEADDB_HOSTS : [],
      company_registries: state.useRegistry ? BRANDS_REGISTRY_HOSTS : [],
      profile_pages_opened: !!state.openProfiles,
    },
    rows: presentedBrandRows(state),
  };
}

function csvCell(value) {
  const text = value == null ? "" : String(value);
  return '"' + text.replace(/"/g, '""') + '"';
}

// Owner first, deliberately: the first five columns are the ones a caller reads, and
// everything else is there to be checked, not scanned.
function brandsCsv(state) {
  const ownerOnly = !!state.ownerOnly;
  const header = [
    "brand", "owner_name", "owner_title", "owner_phone", "owner_email", "owner_profile",
    "all_decision_makers", "other_person_phones", "other_person_emails",
  ];
  if (!ownerOnly) header.push("company_phones", "company_emails");
  header.push("website", "linkedin_company", "apollo", "instagram", "facebook", "sources_checked", "notes");

  const lines = [header.map(csvCell).join(",")];
  for (const row of presentedBrandRows(state)) {
    const best = row.best_contact;
    const cells = [
      row.brand,
      best ? best.name : (row.decision_makers[0] && row.decision_makers[0].name) || "",
      best ? best.title || "" : (row.decision_makers[0] && row.decision_makers[0].title) || "",
      best ? best.phone || "" : "",
      best ? best.email || "" : "",
      best ? best.profile || "" : "",
      row.decision_makers.map((person) => person.name + (person.title ? " (" + person.title + ")" : "")).join("; "),
      row.unattributed_personal.phones.map((item) => item.value).join("; "),
      row.unattributed_personal.emails.map((item) => item.value).join("; "),
    ];
    if (!ownerOnly) {
      cells.push(
        row.company_contacts.phones.map((item) => item.value).join("; "),
        row.company_contacts.emails.map((item) => item.value).join("; ")
      );
    }
    cells.push(
      row.website || "",
      row.linkedin_company || "",
      row.apollo_url || "",
      row.socials.instagram || "",
      row.socials.facebook || "",
      [...row.lead_db_pages, ...row.registry_pages].map((page) => page.host).join("; "),
      row.notes.join(" | ")
    );
    lines.push(cells.map(csvCell).join(","));
  }
  return lines.join("\r\n");
}

async function writeBrandsFile(state, format) {
  const stamp = new Date().toISOString().slice(0, 10);
  const name = "brands_contacts_" + stamp + (format === "csv" ? ".csv" : ".json");
  const body = format === "csv" ? brandsCsv(state) : JSON.stringify(brandsPayload(state), null, 2);
  const mime = format === "csv" ? "text/csv" : "application/json";
  try {
    await downloadJson(name, body, mime);
    return { ok: true, name };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

async function downloadBrandsPartial(format) {
  const state = await getBrandsState();
  const result = await writeBrandsFile(state, format);
  await setBrandsState({
    savedFile: result.ok ? result.name : state.savedFile,
    lastEvent: result.ok ? result.name + " download ho gayi" : "File save nahi hui — " + result.error,
  });
}

async function finishBrandsRun() {
  await chrome.alarms.clear(BRANDS_ALARM);
  await chrome.alarms.clear(BRANDS_TIMEOUT_ALARM);
  chrome.action.setBadgeText({ text: "✓" });
  chrome.action.setBadgeBackgroundColor({ color: "#188038" });

  const state = await getBrandsState();
  const rows = { ...state.rows };
  for (const brand of state.brands || []) {
    const key = brandKeyOf(brand);
    rows[key] = { ...(rows[key] || defaultBrandRow(brand)), status: "done" };
  }
  await setBrandsState({ rows, current: null, queue: [] });

  const finalState = await getBrandsState();
  const result = await writeBrandsFile(finalState, "json");
  await setBrandsState({
    status: "done",
    pendingInject: false,
    savedFile: result.ok ? result.name : "",
    totals: { ...finalState.totals, brandsDone: (finalState.brands || []).length },
    lastEvent: result.ok
      ? "Ho gaya — " +
        (finalState.brands || []).length +
        " brand me se " +
        (finalState.totals.reachableOwners || 0) +
        " ka named decision maker contact ke saath mila, file download ho gayi"
      : "Sab brand ho gaye par file save nahi hui — " + result.error,
  });
}

// ---------------------------------------------------------------------- panel commands

function parseBrandList(list) {
  const seen = new Set();
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const brand = String(raw || "").trim().replace(/\s+/g, " ").slice(0, 80);
    if (!brand) continue;
    const key = brandKeyOf(brand);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(brand);
    if (out.length >= BRANDS_MAX_BRANDS) break;
  }
  return out;
}

async function startBrandsRun(msg) {
  const brands = parseBrandList(msg.brands);
  if (!brands.length) {
    await setBrandsState({ status: "idle", lastEvent: "Kam se kam ek brand ka naam daalo" });
    return;
  }

  await chrome.alarms.clear(BRANDS_ALARM);
  await chrome.alarms.clear(BRANDS_TIMEOUT_ALARM);
  chrome.notifications.clear(BRANDS_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });

  const hostAccess = await hasBrandsHostAccess();
  const options = {
    region: String(msg.region || "").trim().slice(0, 40),
    useLinkedin: msg.useLinkedin !== false,
    useLeadDb: msg.useLeadDb !== false,
    useRegistry: msg.useRegistry !== false,
    openProfiles: !!msg.openProfiles,
    ownerOnly: !!msg.ownerOnly,
    sitePages: Math.max(1, Math.min(BRANDS_MAX_SITE_PAGES, Number(msg.sitePages) || 3)),
    googleDelaySec: Math.max(8, Number(msg.googleDelaySec) || 15),
    pageDelaySec: Math.max(2, Number(msg.pageDelaySec) || 6),
  };

  const queue = [];
  const rows = {};
  for (const brand of brands) {
    rows[brandKeyOf(brand)] = defaultBrandRow(brand);
    queue.push(...planBrandTasks(brand, options));
  }

  const fresh = {
    ...defaultBrandsState(),
    ...options,
    status: "running",
    brands,
    queue,
    rows,
    hostAccess,
    totals: { tasksDone: 0, tasksPlanned: queue.length, brandsDone: 0, emails: 0, phones: 0, people: 0, reachableOwners: 0 },
    lastEvent:
      brands.length +
      " brand, " +
      queue.length +
      " search plan hue" +
      (hostAccess ? "" : " — site access nahi hai, brand ki apni website nahi khulegi"),
    log: [],
    updatedAt: Date.now(),
  };
  fresh.log = [fresh.lastEvent];
  await chrome.storage.local.set({ [BRANDS_STATE_KEY]: fresh });

  await pumpBrandsTask();
}

async function resumeBrandsRun() {
  const state = await getBrandsState();
  if (state.status !== "paused" && state.status !== "stopped") return;
  chrome.notifications.clear(BRANDS_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await setBrandsState({
    status: "running",
    pauseReason: "",
    hostAccess: await hasBrandsHostAccess(),
    lastEvent: "Resume — " + describeBrandsTask(state.current || (state.queue || [])[0]),
  });
  await pumpBrandsTask();
}

async function stopBrandsRun() {
  await chrome.alarms.clear(BRANDS_ALARM);
  await chrome.alarms.clear(BRANDS_TIMEOUT_ALARM);
  chrome.notifications.clear(BRANDS_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await setBrandsState({
    status: "stopped",
    pendingInject: false,
    lastEvent: "Run roka gaya — jo mila woh safe hai, Resume se aage chalega",
  });
}

async function resetBrandsRun() {
  await chrome.alarms.clear(BRANDS_ALARM);
  await chrome.alarms.clear(BRANDS_TIMEOUT_ALARM);
  chrome.notifications.clear(BRANDS_NOTIF_ID);
  chrome.action.setBadgeText({ text: "" });
  await chrome.storage.local.set({ [BRANDS_STATE_KEY]: defaultBrandsState() });
}

// ----------------------------------------------------------------------- event wiring

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string" || !msg.type.startsWith("BRANDS_")) return false;

  queueBrandsTask(async () => {
    switch (msg.type) {
      case "BRANDS_START":
        await startBrandsRun(msg);
        break;
      case "BRANDS_RESUME":
        await resumeBrandsRun();
        break;
      case "BRANDS_STOP":
        await stopBrandsRun();
        break;
      case "BRANDS_RESET":
        await resetBrandsRun();
        break;
      case "BRANDS_DOWNLOAD":
        await downloadBrandsPartial(msg.format === "csv" ? "csv" : "json");
        break;
      case "BRANDS_SYNC_ACCESS":
        await setBrandsState({ hostAccess: await hasBrandsHostAccess() });
        break;
      default: // BRANDS_GET_STATE and anything unknown just read the state back
        break;
    }
  })
    .catch(() => undefined)
    .then(async () => {
      sendResponse(await getBrandsState());
    });
  return true; // keep the message channel open for the async response
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  queueBrandsTask(async () => {
    const state = await getBrandsState();
    if (state.status !== "running" || tabId !== state.tabId || !state.pendingInject) return;
    const url = tab && tab.url ? tab.url : "";
    // Chrome fires `complete` for about:blank on a fresh tab before the real navigation.
    if (!url || url === "about:blank") return;

    await setBrandsState({ pendingInject: false });
    await runBrandsTaskOnTab(tabId);
  }).catch(() => undefined);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BRANDS_TIMEOUT_ALARM) {
    queueBrandsTask(async () => {
      const state = await getBrandsState();
      if (state.status !== "running" || !state.pendingInject || state.tabId == null) return;
      // The page never reported `complete` — chat widgets and long-poll analytics can
      // keep a tab "loading" forever. Whatever rendered by now is worth reading, so it
      // is injected anyway; if that fails too, runBrandsTaskOnTab skips it.
      await setBrandsState({
        pendingInject: false,
        lastEvent: describeBrandsTask(state.current) + " — page poora load nahi hua, jo mila wahi padh rahe hain",
      });
      await runBrandsTaskOnTab(state.tabId);
    }).catch(() => undefined);
    return;
  }

  if (alarm.name !== BRANDS_ALARM) return;
  queueBrandsTask(async () => {
    const state = await getBrandsState();
    if (state.status !== "waiting_delay") return;
    await setBrandsState({ status: "running" });
    await pumpBrandsTask();
  }).catch(() => undefined);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  queueBrandsTask(async () => {
    const state = await getBrandsState();
    if (state.tabId !== tabId || !brandsStatusIsActive(state.status)) return;
    await chrome.alarms.clear(BRANDS_ALARM);
    await chrome.alarms.clear(BRANDS_TIMEOUT_ALARM);
    chrome.action.setBadgeText({ text: "" });
    await setBrandsState({
      status: "stopped",
      pendingInject: false,
      tabId: null,
      // The task in flight goes back on the queue, so Resume redoes it rather than
      // silently losing the page it was on.
      queue: state.current ? [state.current, ...(state.queue || [])] : state.queue,
      current: null,
      lastEvent: "Tab band ho gaya — jo mila woh safe hai, Resume se aage chalega",
    });
  }).catch(() => undefined);
});

chrome.notifications.onClicked.addListener((notificationId) => {
  if (notificationId !== BRANDS_NOTIF_ID) return;
  (async () => {
    const state = await getBrandsState();
    if (state.tabId == null) return;
    try {
      await chrome.tabs.update(state.tabId, { active: true });
      const tab = await chrome.tabs.get(state.tabId);
      if (tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
    } catch (e) {
      // tab may already be gone; nothing to focus
    }
    chrome.notifications.clear(BRANDS_NOTIF_ID);
  })();
});

// Granting site access mid-run should start working immediately, not at the next Start.
chrome.permissions.onAdded.addListener(() => {
  queueBrandsTask(async () => {
    const state = await getBrandsState();
    if (state.status === "idle") return;
    const hostAccess = await hasBrandsHostAccess();
    if (hostAccess && !state.hostAccess) {
      await setBrandsState({ hostAccess, lastEvent: "Site access mil gaya — ab brand ki website bhi khulegi" });
    }
  }).catch(() => undefined);
});

chrome.permissions.onRemoved.addListener(() => {
  queueBrandsTask(async () => {
    await setBrandsState({ hostAccess: await hasBrandsHostAccess() });
  }).catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  queueBrandsTask(async () => {
    const state = await getBrandsState();
    if (state.status === "running" || state.status === "waiting_delay") {
      await setBrandsState({
        status: "stopped",
        pendingInject: false,
        lastEvent: "Browser restart hua — Resume dabao ya partial download kar lo",
      });
    }
  }).catch(() => undefined);
});
