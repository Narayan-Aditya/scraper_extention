// Insta Handle Finder — brand contact extractor (content script).
//
// Injected by background-brands.js into whichever page the driven tab is showing:
// a Google results page, a brand's own website, a LinkedIn company page or an
// apollo.io company/people page. It returns *one page's worth* of evidence as its
// completion value; the worker owns the queue, the merge and the dedupe.
//
// Same stance as every other runner here — the user's own logged-in session, one
// visible tab, no proxies, no spoofed headers, no CAPTCHA solving. A Google block
// pauses the run and waits for a human; it is never hammered and never auto-retried.
//
// Everything below reads only what the page already rendered for the user. There is no
// private-endpoint poking in this file: for contact data the *public* surfaces (mailto:
// links, tel: links, schema.org JSON-LD, the footer) are both the highest-yield and the
// least fragile, so there is nothing to gain from anything cleverer.

(function () {
  const job = window.__BRD_JOB__ || {};

  // ------------------------------------------------------------------ small utilities

  function textOf(node) {
    if (!node) return "";
    const value = node.innerText || node.textContent || "";
    return value.replace(/\s+/g, " ").trim();
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    } catch (e) {
      return "";
    }
  }

  function uniq(list, keyFn) {
    const seen = new Set();
    const out = [];
    for (const item of list) {
      const key = keyFn ? keyFn(item) : item;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  // ------------------------------------------------------------------ block detection
  //
  // Ported from content-scraper.js so both Google readers agree on what a wall looks
  // like. Extended with the two login walls this mode can hit.

  function detectBlock() {
    const href = location.href.toLowerCase();
    if (href.includes("/sorry/") || location.pathname.toLowerCase().startsWith("/sorry")) {
      return "sorry_url";
    }
    if (document.querySelector("#captcha-form, iframe[src*='recaptcha'], .g-recaptcha")) {
      return "recaptcha_dom";
    }
    const text = (document.body ? document.body.innerText : "").toLowerCase();
    const markers = ["our systems have detected unusual traffic", "automated queries", "not a robot"];
    if (markers.some((marker) => text.includes(marker))) return "marker_text";
    return null;
  }

  // A login wall is not a block: it costs nothing, it is not a rate limit, and the run
  // should keep going without it. It is reported as a note on the row instead.
  function detectLoginWall() {
    const href = location.href.toLowerCase();
    if (/linkedin\.com\/(authwall|login|uas\/login|checkpoint)/.test(href)) return "linkedin_login";
    if (/apollo\.io\/(login|sign-in)/.test(href)) return "apollo_login";
    const text = (document.body ? document.body.innerText : "").slice(0, 4000).toLowerCase();
    if (href.includes("linkedin.com") && /sign in to see|join linkedin to see|sign up to see/.test(text)) {
      return "linkedin_login";
    }
    return null;
  }

  // ------------------------------------------------------------- email / phone mining

  const EMAIL_RE = /[a-z0-9](?:[a-z0-9._%+-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z]{2,24})+/gi;

  // Addresses that are on the page but are never the lead: build tooling, analytics,
  // stock placeholders, and the "@2x.png" style filenames that look like an address to
  // a regex. Kept as a host/pattern list rather than a heuristic so a real address at a
  // weird domain is never silently dropped.
  const EMAIL_HOST_BLOCK = /(^|\.)(sentry\.io|wixpress\.com|example\.(com|org|net)|domain\.com|yourdomain\.com|email\.com|godaddy\.com|w3\.org|schema\.org|jquery\.com)$/i;
  const EMAIL_JUNK_RE = /\.(png|jpe?g|gif|svg|webp|css|js|woff2?|ttf)$|^[0-9a-f]{16,}@|@\d+x\.|^(no-?reply|donotreply|do-not-reply)@|sentry/i;

  function cleanEmail(raw) {
    let value = String(raw || "").trim().toLowerCase();
    value = value.replace(/^mailto:/, "").split("?")[0];
    value = value.replace(/[.,;:)\]}'"<>]+$/, "");
    if (!value.includes("@") || value.length > 120) return null;
    if (EMAIL_JUNK_RE.test(value)) return null;
    const domain = value.split("@")[1] || "";
    if (!domain || EMAIL_HOST_BLOCK.test(domain)) return null;
    return value;
  }

  // Phones are the noisy field: any page with prices, dates, PIN codes or order ids will
  // hand a loose regex a dozen fake numbers. So the strict rule is digit count, and every
  // number carries where it came from — `tel:` and JSON-LD are trustworthy, loose page
  // text is explicitly marked so a human can tell the difference in the output file.
  const PHONE_TEXT_RE = /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,5}\)[\s.-]?)?\d[\d\s.-]{7,16}\d/g;

  // The word printed next to a number is the only thing on a public page that separates a
  // decision-maker's direct line from the reception desk. It is captured, never guessed:
  // an unlabelled number stays unlabelled rather than being called a mobile.
  const PHONE_LABEL_RE =
    /\b(mobile|cell|direct|dial|whatsapp|personal|founder|owner|proprietor|ceo|md|managing director|manager|director|partner|chairman|toll[\s-]?free|landline|office|reception|helpline|support|sales|customer care)\b/i;

  function labelNear(text, index) {
    const before = String(text || "").slice(Math.max(0, index - 60), index);
    const match = before.match(PHONE_LABEL_RE);
    return match ? match[0].toLowerCase() : "";
  }

  function cleanPhone(raw) {
    const value = String(raw || "").replace(/^tel:/i, "").trim();
    const plus = value.startsWith("+");
    const digits = value.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) return null;
    // 20240115-style dates and 8-digit ids arrive as one unbroken run; a real number
    // written without separators is nearly always given with a country code.
    if (!plus && !/[\s().-]/.test(value) && digits.length < 10) return null;
    if (/^(19|20)\d{6}$/.test(digits)) return null; // yyyymmdd
    if (/^(\d)\1+$/.test(digits)) return null; // 0000000000
    return (plus ? "+" : "") + digits;
  }

  function minePhonesFromText(text) {
    const source = String(text || "");
    const out = [];
    PHONE_TEXT_RE.lastIndex = 0;
    let match;
    while ((match = PHONE_TEXT_RE.exec(source)) !== null) {
      if (out.length >= 40) break;
      const phone = cleanPhone(match[0]);
      if (phone) out.push({ value: phone, label: labelNear(source, match.index) });
    }
    return out;
  }

  // ------------------------------------------------------------------ social profiles

  const SOCIAL_HOSTS = [
    { key: "instagram", re: /(^|\.)instagram\.com$/ },
    { key: "facebook", re: /(^|\.)(facebook\.com|fb\.com)$/ },
    { key: "twitter", re: /(^|\.)(twitter\.com|x\.com)$/ },
    { key: "linkedin", re: /(^|\.)linkedin\.com$/ },
    { key: "youtube", re: /(^|\.)(youtube\.com|youtu\.be)$/ },
    { key: "tiktok", re: /(^|\.)tiktok\.com$/ },
    { key: "pinterest", re: /(^|\.)pinterest\.(com|co\.uk|in)$/ },
    { key: "whatsapp", re: /(^|\.)(wa\.me|whatsapp\.com)$/ },
    { key: "telegram", re: /(^|\.)(t\.me|telegram\.me)$/ },
  ];

  // Share widgets point at the social network too, and they are about *this page*, not
  // about the brand. Dropping them here keeps a footer's "share on Facebook" out of the
  // row's facebook field.
  const SHARE_RE = /\/(sharer|share|intent|share_channel|dialog)\b|[?&](u|url|text)=/i;

  function classifySocial(url) {
    const host = hostOf(url);
    if (!host) return null;
    const match = SOCIAL_HOSTS.find((entry) => entry.re.test(host));
    if (!match) return null;
    if (SHARE_RE.test(url)) return null;
    let path;
    try {
      path = new URL(url).pathname.replace(/\/+$/, "");
    } catch (e) {
      return null;
    }
    if (!path || path === "/") return null; // bare homepage link, tells us nothing
    return { network: match.key, url: url.split("?")[0].split("#")[0] };
  }

  // --------------------------------------------------------------------- people names

  const ROLE_RE = /\b(founder|co-?founder|owner|proprietor|ceo|chief executive|managing director|director|partner|president|chairman|chairperson|head of|cmo|cto|coo|cfo|marketing head|brand manager|manager)\b/i;

  // Registry and directory tables print names in caps. Stored as written they read as
  // shouting in the output file and never match an email built from the same name.
  function tidyName(value) {
    const trimmed = String(value || "").trim();
    if (!/[a-z]/.test(trimmed)) {
      return trimmed
        .toLowerCase()
        .replace(/(^|[\s'.-])([a-z])/g, (whole, lead, letter) => lead + letter.toUpperCase());
    }
    return trimmed;
  }
  // A human name as written on an about/team page: 2-4 capitalised words, no digits.
  const NAME_RE = /^[A-Z][a-zA-Z'.-]{1,20}(?: [A-Z][a-zA-Z'.-]{1,20}){1,3}$/;

  function looksLikeName(value) {
    const trimmed = String(value || "").trim();
    if (!NAME_RE.test(trimmed)) return null;
    if (ROLE_RE.test(trimmed)) return null; // "Managing Director" is two capitals too
    return tidyName(trimmed);
  }

  // The point of the whole mode: a number printed *inside a person's card* belongs to that
  // person, while the same number in the footer belongs to the company. So the card is
  // walked outward only as far as it stays small — the moment the enclosing element holds
  // the whole page, the connection between name and number is gone and nothing is claimed.
  function personCardContacts(node) {
    let card = node;
    for (let step = 0; step < 3 && card.parentElement; step++) {
      const parentText = textOf(card.parentElement);
      if (!parentText || parentText.length > 400) break;
      card = card.parentElement;
    }

    const emails = [];
    const phones = [];

    const links = typeof card.querySelectorAll === "function" ? card.querySelectorAll("a[href]") : [];
    for (const link of links) {
      const raw = link.getAttribute("href") || "";
      if (/^mailto:/i.test(raw)) {
        const email = cleanEmail(raw);
        if (email) emails.push({ value: email, confidence: "high", how: "person_card_mailto" });
      } else if (/^tel:/i.test(raw)) {
        const phone = cleanPhone(raw);
        if (phone) phones.push({ value: phone, label: "", confidence: "high", how: "person_card_tel" });
      }
    }

    const cardText = textOf(card).slice(0, 400);
    for (const email of uniq((cardText.match(EMAIL_RE) || []).map(cleanEmail).filter(Boolean))) {
      emails.push({ value: email, confidence: "medium", how: "person_card_text" });
    }
    for (const phone of minePhonesFromText(cardText)) {
      phones.push({ value: phone.value, label: phone.label, confidence: "medium", how: "person_card_text" });
    }

    return {
      emails: uniq(emails, (item) => item.value).slice(0, 3),
      phones: uniq(phones, (item) => item.value).slice(0, 3),
    };
  }

  // Team/about pages are the only place a website names its owner, and they are written
  // a hundred different ways. Rather than guess at markup, this looks for a role word in
  // a short block of text and takes the name sitting next to it — "Name, Role", "Role:
  // Name", or a name in the neighbouring element (card layouts).
  function minePeopleFromDom() {
    const out = [];
    const nodes = document.querySelectorAll(
      "h1,h2,h3,h4,h5,h6,p,li,span,div,figcaption,strong,em,td,dt,dd"
    );
    let scanned = 0;
    for (const node of nodes) {
      if (out.length >= 12 || scanned > 4000) break;
      // Only leaf-ish blocks: a wrapper <div> holding the whole page would match every
      // role word on it and attribute them all to one stray name.
      if (node.children && node.children.length > 3) continue;
      const text = textOf(node);
      if (!text || text.length > 120) continue;
      scanned += 1;
      const role = text.match(ROLE_RE);
      if (!role) continue;

      const roleWord = role[0];
      let name = null;

      // "Ravi Sharma, Founder" / "Ravi Sharma - Founder" / "Ravi Sharma | CEO"
      for (const part of text.split(/\s*[,|–—-]\s*/)) {
        const candidate = looksLikeName(part.trim());
        if (candidate) {
          name = candidate;
          break;
        }
      }
      // "Founder: Ravi Sharma"
      if (!name) {
        const colon = text.match(/:\s*([^,;|]+)$/);
        if (colon) name = looksLikeName(colon[1]);
      }
      // Card layouts put the name in a sibling element, usually just above the role.
      if (!name && node.previousElementSibling) name = looksLikeName(textOf(node.previousElementSibling));
      if (!name && node.nextElementSibling) name = looksLikeName(textOf(node.nextElementSibling));
      if (!name && node.parentElement) {
        const heading = node.parentElement.querySelector("h1,h2,h3,h4,h5,strong,b");
        if (heading) name = looksLikeName(textOf(heading));
      }
      if (!name) continue;

      const contacts = personCardContacts(node);
      out.push({
        name,
        title: roleWord,
        source: "site_text",
        confidence: "low",
        emails: contacts.emails,
        phones: contacts.phones,
      });
    }
    return uniq(out, (person) => person.name.toLowerCase());
  }

  // -------------------------------------------------------------------------- JSON-LD
  //
  // The single highest-quality source on a business website: schema.org Organization /
  // LocalBusiness blocks carry telephone, email, sameAs (the brand's own social links)
  // and sometimes founder — all stated by the site owner rather than inferred by us.

  function walkJsonLd(node, sink, depth) {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) {
      for (const item of node) walkJsonLd(item, sink, depth + 1);
      return;
    }
    if (typeof node !== "object") return;

    if (typeof node.email === "string") sink.emails.push(node.email);
    if (typeof node.telephone === "string") sink.phones.push(node.telephone);
    if (typeof node.name === "string" && /organization|localbusiness|corporation|store/i.test(String(node["@type"] || ""))) {
      sink.orgNames.push(node.name);
    }
    const sameAs = node.sameAs;
    if (typeof sameAs === "string") sink.urls.push(sameAs);
    else if (Array.isArray(sameAs)) {
      for (const item of sameAs) if (typeof item === "string") sink.urls.push(item);
    }

    for (const key of ["founder", "founders", "employee", "employees", "member"]) {
      const value = node[key];
      const people = Array.isArray(value) ? value : value ? [value] : [];
      for (const person of people) {
        if (person && typeof person === "object" && typeof person.name === "string") {
          const fallbackTitle = key.startsWith("founder") ? "Founder" : "";
          // A Person block's own telephone/email is the cleanest owner contact there is:
          // the site owner stated it, and stated whose it is.
          const personEmail = cleanEmail(person.email);
          const personPhone = cleanPhone(person.telephone);
          sink.people.push({
            name: tidyName(person.name).slice(0, 80),
            title: String(person.jobTitle || fallbackTitle).slice(0, 60),
            source: "jsonld",
            confidence: "high",
            emails: personEmail ? [{ value: personEmail, confidence: "high", how: "person_jsonld" }] : [],
            phones: personPhone ? [{ value: personPhone, label: "", confidence: "high", how: "person_jsonld" }] : [],
          });
        } else if (typeof person === "string" && looksLikeName(person)) {
          sink.people.push({
            name: looksLikeName(person),
            title: key.startsWith("founder") ? "Founder" : "",
            source: "jsonld",
            confidence: "high",
            emails: [],
            phones: [],
          });
        }
      }
    }

    for (const key of Object.keys(node)) {
      if (key === "@context") continue;
      const child = node[key];
      if (child && typeof child === "object") walkJsonLd(child, sink, depth + 1);
    }
  }

  function readJsonLd() {
    const sink = { emails: [], phones: [], urls: [], people: [], orgNames: [] };
    const blocks = document.querySelectorAll('script[type="application/ld+json"]');
    let parsed = 0;
    for (const block of blocks) {
      if (parsed >= 12) break;
      parsed += 1;
      try {
        walkJsonLd(JSON.parse(block.textContent || "{}"), sink, 0);
      } catch (e) {
        // Hand-written JSON-LD is frequently invalid; one bad block must not cost the
        // page its other blocks.
      }
    }
    return sink;
  }

  // ---------------------------------------------------------------- Google SERP parse

  // Result containers Google actually ships today, widest first. The anchor-with-an-h3
  // rule below is what really finds results; these are only used to locate the snippet
  // that belongs to a given link.
  const RESULT_BLOCK_SELECTOR = "div.MjjYud, div.g, div.tF2Cxc, div[data-hveid]";

  function unwrapGoogleHref(href) {
    try {
      const url = new URL(href, "https://www.google.com");
      if (url.pathname === "/url") return url.searchParams.get("q") || url.searchParams.get("url") || "";
      if (!/^https?:$/.test(url.protocol)) return "";
      if (/(^|\.)google\.[a-z.]+$/.test(url.hostname.toLowerCase())) return "";
      return url.href;
    } catch (e) {
      return "";
    }
  }

  function scrapeSerp() {
    const root = document.querySelector("#search, #rso, #main") || document.body;
    const anchors = root ? Array.from(root.querySelectorAll("a[href]")) : [];

    const results = [];
    const seen = new Set();
    for (const anchor of anchors) {
      if (results.length >= 30) break;
      const heading = anchor.querySelector("h3");
      if (!heading) continue; // link is not a result title (sitelink, image, nav chrome)
      const url = unwrapGoogleHref(anchor.getAttribute("href") || "");
      if (!url) continue;
      const key = url.split("#")[0];
      if (seen.has(key)) continue;
      seen.add(key);

      const block = anchor.closest(RESULT_BLOCK_SELECTOR);
      const title = textOf(heading).slice(0, 200);
      let snippet = "";
      if (block) {
        snippet = textOf(block);
        if (snippet.startsWith(title)) snippet = snippet.slice(title.length).trim();
        snippet = snippet.slice(0, 600);
      }

      // Contact details are attributed to the result they were printed under, never to
      // the page as a whole — a SERP mixes a dozen companies, and an unattributed email
      // is worse than no email.
      const emails = uniq((snippet.match(EMAIL_RE) || []).map(cleanEmail).filter(Boolean));
      const phones = uniq(minePhonesFromText(snippet), (item) => item.value);

      results.push({ url: key, host: hostOf(key), title, snippet, emails, phones });
    }

    return { kind: "serp", blocked: false, blockReason: null, pageUrl: location.href, results };
  }

  // ---------------------------------------------------------------------- generic page

  function scrapePage() {
    const pageHost = hostOf(location.href);
    const anchors = Array.from(document.querySelectorAll("a[href]")).slice(0, 3000);

    const emails = [];
    const phones = [];
    const socials = [];
    const internalLinks = [];

    for (const anchor of anchors) {
      const raw = anchor.getAttribute("href") || "";
      if (/^mailto:/i.test(raw)) {
        const email = cleanEmail(raw);
        if (email) emails.push({ value: email, confidence: "high", how: "mailto" });
        continue;
      }
      if (/^tel:/i.test(raw)) {
        const phone = cleanPhone(raw);
        if (phone) {
          // The label lives in the markup around the link ("Direct: <a>…</a>"), not in the
          // href, so the anchor's own text and its parent's are both worth a look.
          const around = textOf(anchor) + " " + (anchor.parentElement ? textOf(anchor.parentElement) : "");
          const labelMatch = around.match(PHONE_LABEL_RE);
          phones.push({
            value: phone,
            label: labelMatch ? labelMatch[0].toLowerCase() : "",
            confidence: "high",
            how: "tel",
          });
        }
        continue;
      }

      let absolute;
      try {
        absolute = new URL(raw, location.href).href;
      } catch (e) {
        continue;
      }
      if (!/^https?:/i.test(absolute)) continue;

      const social = classifySocial(absolute);
      if (social) {
        socials.push(social);
        continue;
      }

      // Contact-ish pages on the same site, for the worker to queue as follow-ups.
      if (hostOf(absolute) === pageHost) {
        const label = (textOf(anchor) + " " + absolute).toLowerCase();
        if (/contact|about|team|leadership|our-story|impressum|reach|connect|management|founder/.test(label)) {
          internalLinks.push(absolute.split("#")[0]);
        }
      }
    }

    // Visible text is the fallback for sites that print an address as plain text. It is
    // capped because a long page's innerText can be megabytes, and it is marked lower
    // confidence than a mailto:/tel: link.
    const bodyText = (document.body ? document.body.innerText : "").slice(0, 200000);
    for (const match of uniq((bodyText.match(EMAIL_RE) || []).map(cleanEmail).filter(Boolean))) {
      emails.push({ value: match, confidence: "medium", how: "page_text" });
    }
    // Footers and contact sections are where a number actually is; scanning them before
    // the whole page keeps the strongest hits first in the list.
    const contactZones = Array.from(
      document.querySelectorAll("footer, address, [class*='contact' i], [id*='contact' i], [class*='footer' i]")
    ).slice(0, 20);
    for (const zone of contactZones) {
      for (const phone of minePhonesFromText(textOf(zone).slice(0, 6000))) {
        phones.push({ value: phone.value, label: phone.label, confidence: "medium", how: "contact_block" });
      }
    }
    for (const phone of minePhonesFromText(bodyText.slice(0, 40000))) {
      phones.push({ value: phone.value, label: phone.label, confidence: "low", how: "page_text" });
    }

    const ld = readJsonLd();
    for (const value of ld.emails) {
      const email = cleanEmail(value);
      if (email) emails.push({ value: email, confidence: "high", how: "jsonld" });
    }
    for (const value of ld.phones) {
      const phone = cleanPhone(value);
      if (phone) phones.push({ value: phone, confidence: "high", how: "jsonld" });
    }
    for (const value of ld.urls) {
      const social = classifySocial(value);
      if (social) socials.push(social);
    }

    const people = uniq([...ld.people, ...minePeopleFromDom()], (person) => person.name.toLowerCase()).slice(0, 12);

    return {
      kind: "page",
      blocked: false,
      blockReason: null,
      pageUrl: location.href,
      host: pageHost,
      title: (document.title || "").slice(0, 200),
      loginWall: detectLoginWall(),
      emails: uniq(emails, (item) => item.value).slice(0, 25),
      phones: uniq(phones, (item) => item.value).slice(0, 15),
      socials: uniq(socials, (item) => item.url).slice(0, 20),
      people,
      internalLinks: uniq(internalLinks).slice(0, 10),
      orgName: (ld.orgNames[0] || "").slice(0, 120),
    };
  }

  // ----------------------------------------------------------------------------- entry

  const blockReason = detectBlock();
  if (blockReason) {
    return { kind: job.kind || "page", blocked: true, blockReason, pageUrl: location.href };
  }
  return job.kind === "serp" ? scrapeSerp() : scrapePage();
})();
