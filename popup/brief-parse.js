// Campaign brief -> discovery plan.
//
// Pure functions, no DOM and no chrome APIs on purpose: the same file runs in the side
// panel (for the editable preview) and under Node (for tests). It attaches to globalThis
// rather than using modules, because the panel loads plain <script> tags and the service
// worker uses importScripts — neither of which understands `export`.
//
// What this is NOT: an LLM. It reads the structured shape real agency briefs already have
// ("Niche / Genre:", "Tier:", "Location:") plus a vocabulary of Indian cities and creator
// niches. Everything it extracts is shown to the user as editable text before a single
// request is made — the parser is a first draft, never a black box.

(function (root) {
  "use strict";

  // ------------------------------------------------------------------- vocabularies

  // Canonical name on the right. A brief that says "Bangalore" and one that says
  // "Bengaluru" have to produce the same seed, or the run searches twice for one city.
  const CITY_ALIASES = {
    "delhi ncr": "delhi",
    "new delhi": "delhi",
    ncr: "delhi",
    delhi: "delhi",
    gurugram: "gurugram",
    gurgaon: "gurugram",
    noida: "noida",
    faridabad: "faridabad",
    ghaziabad: "ghaziabad",
    "navi mumbai": "mumbai",
    mumbai: "mumbai",
    bombay: "mumbai",
    thane: "thane",
    bengaluru: "bengaluru",
    bangalore: "bengaluru",
    hyderabad: "hyderabad",
    chennai: "chennai",
    kolkata: "kolkata",
    calcutta: "kolkata",
    pune: "pune",
    ahmedabad: "ahmedabad",
    jaipur: "jaipur",
    chandigarh: "chandigarh",
    lucknow: "lucknow",
    indore: "indore",
    surat: "surat",
    kochi: "kochi",
    cochin: "kochi",
    nagpur: "nagpur",
    bhopal: "bhopal",
    patna: "patna",
    kanpur: "kanpur",
    varanasi: "varanasi",
    coimbatore: "coimbatore",
    visakhapatnam: "visakhapatnam",
    vizag: "visakhapatnam",
    guwahati: "guwahati",
    bhubaneswar: "bhubaneswar",
    dehradun: "dehradun",
    ludhiana: "ludhiana",
    amritsar: "amritsar",
    nashik: "nashik",
    vadodara: "vadodara",
    rajkot: "rajkot",
    mysuru: "mysuru",
    mysore: "mysuru",
    thiruvananthapuram: "thiruvananthapuram",
    trivandrum: "thiruvananthapuram",
    goa: "goa",
    jodhpur: "jodhpur",
    udaipur: "udaipur",
    agra: "agra",
    ranchi: "ranchi",
    raipur: "raipur",
    madurai: "madurai",
    vijayawada: "vijayawada",
  };

  // `word` is what gets paired with a city ("mumbai fashion") — Instagram search matches
  // name/username/bio tokens, and short queries return far more than long sentences.
  // `term` is the standalone seed, where there is room to say what kind of account.
  const NICHES = [
    { id: "wedding", word: "wedding", term: "wedding content creator", re: /wedding|bridal|shaadi|sangeet|dulhan/i },
    { id: "couple", word: "couple", term: "couple creator", re: /couples?\b|relationship|husband|wife/i },
    { id: "family", word: "family", term: "family creator", re: /famil(y|ies)|parenting|\bmom\b|momlife|\bdad\b|kids|children|baby/i },
    { id: "fashion", word: "fashion", term: "fashion influencer", re: /fashion|styling|outfit|\bootd\b|apparel|wardrobe/i },
    { id: "beauty", word: "beauty", term: "beauty creator", re: /beauty|makeup|make-up|skincare|grooming|cosmetic/i },
    { id: "lifestyle", word: "lifestyle", term: "lifestyle creator", re: /life\s?style/i },
    { id: "gifting", word: "gifting", term: "gifting creator", re: /gift(ing|s)?\b|keepsake|souvenir|hamper|memento/i },
    { id: "decor", word: "home decor", term: "home decor creator", re: /home\s?decor|interior|decor/i },
    { id: "food", word: "food", term: "food blogger", re: /\bfood\b|foodie|recipe|cafe|restaurant|cooking|baking/i },
    { id: "travel", word: "travel", term: "travel creator", re: /travel|wanderlust|tourism|backpack/i },
    { id: "tech", word: "tech", term: "tech creator", re: /\btech\b|technology|gadget|smartphone/i },
    { id: "fitness", word: "fitness", term: "fitness creator", re: /fitness|\bgym\b|workout|\byoga\b|bodybuild/i },
    { id: "comedy", word: "comedy", term: "comedy creator", re: /comed(y|ian)|humou?r|\bfunny\b|\bmeme/i },
    { id: "art", word: "art", term: "artist", re: /\bart\b|artist|handmade|craft|illustrat|sculpt/i },
    { id: "photography", word: "photographer", term: "photographer", re: /photograph|photoshoot/i },
    { id: "pets", word: "pet", term: "pet creator", re: /\bpets?\b|\bdogs?\b|\bcats?\b|petparent/i },
    { id: "dance", word: "dance", term: "dance creator", re: /danc(e|er|ing)|choreograph/i },
    { id: "music", word: "music", term: "music creator", re: /music|singer|musician|\bsong\b/i },
    { id: "gaming", word: "gaming", term: "gaming creator", re: /gaming|gamer|esports/i },
    { id: "auto", word: "car", term: "automobile creator", re: /automobile|\bcars?\b|motorcycl|\bbike/i },
  ];

  // Tier -> follower band. Only used when the brief names a tier but no explicit numbers;
  // an explicit "100K to 500K" always wins over the label next to it.
  const TIER_BANDS = {
    nano: [1000, 10000],
    micro: [10000, 100000],
    "mid-tier": [100000, 500000],
    mid: [100000, 500000],
    macro: [100000, 500000],
    mega: [500000, 5000000],
    celebrity: [1000000, 20000000],
  };

  const LANGUAGES = [
    "hindi", "english", "hinglish", "marathi", "tamil", "telugu", "kannada", "malayalam",
    "bengali", "gujarati", "punjabi", "odia", "assamese", "urdu",
  ];

  // Handles that are never a creator lead: platform paths and the usual placeholder.
  const NON_HANDLES = new Set([
    "p", "reel", "reels", "explore", "stories", "tv", "direct", "accounts", "example",
  ]);

  // ------------------------------------------------------------------------ sections
  //
  // Real briefs are "Label:" followed by the answer. Reading niches out of the Niche
  // section instead of the whole document is what keeps the word "Unboxing" in the
  // deliverables list from turning this into a tech-creator campaign.

  function splitSections(text) {
    const sections = [];
    let current = null;
    for (const line of String(text || "").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z][A-Za-z0-9 /&'()-]{1,60}?)\s*:\s*(.*)$/);
      if (match) {
        current = { key: match[1].trim().toLowerCase(), lines: [] };
        if (match[2].trim()) current.lines.push(match[2].trim());
        sections.push(current);
      } else if (current) {
        current.lines.push(line);
      }
    }
    return sections;
  }

  // First section whose label contains any of these words, as one string.
  function sectionText(sections, words) {
    for (const section of sections) {
      for (const word of words) {
        if (section.key.includes(word)) return section.lines.join("\n");
      }
    }
    return "";
  }

  // Scoped read with a documented fallback: use the section when the brief has one, the
  // whole brief when it does not. Which one happened is reported, so a surprising result
  // is explainable rather than mysterious.
  function scoped(sections, words, whole) {
    const text = sectionText(sections, words);
    return text ? { text, scoped: true } : { text: whole, scoped: false };
  }

  // -------------------------------------------------------------------- field readers

  function aliasPattern(alias) {
    return new RegExp("\\s" + alias.replace(/\s+/g, "\\s") + "(?=\\s)");
  }

  function findCities(text) {
    // Punctuation to spaces so "Delhi NCR, Mumbai" and "Delhi NCR and Mumbai" read alike.
    const normalised = " " + String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";

    // Longest alias first, consuming as it goes, so "delhi ncr" is taken before the bare
    // "delhi" inside it can match separately.
    let remaining = normalised;
    const matched = [];
    for (const alias of Object.keys(CITY_ALIASES).sort((a, b) => b.length - a.length)) {
      const pattern = aliasPattern(alias);
      if (!pattern.test(remaining)) continue;
      remaining = remaining.replace(new RegExp(pattern.source, "g"), " ");
      const canonical = CITY_ALIASES[alias];
      if (!matched.includes(canonical)) matched.push(canonical);
    }

    // Ordered by where each city actually appears in the brief — measured against the
    // untouched text, because the consuming pass above shortens the string as it runs and
    // its offsets drift. A brief lists its priority markets first and the seed budget is
    // spent front-to-back, so "Delhi NCR, Mumbai, ..." must not come back reshuffled into
    // whatever order the alias table happens to be sorted in.
    const firstSeenAt = (canonical) => {
      let earliest = Infinity;
      for (const alias of Object.keys(CITY_ALIASES)) {
        if (CITY_ALIASES[alias] !== canonical) continue;
        const found = aliasPattern(alias).exec(normalised);
        if (found && found.index < earliest) earliest = found.index;
      }
      return earliest;
    };
    const positions = new Map(matched.map((city) => [city, firstSeenAt(city)]));
    return matched.sort((a, b) => positions.get(a) - positions.get(b));
  }

  function findNiches(text) {
    const value = String(text || "");
    return NICHES.filter((niche) => niche.re.test(value)).map((niche) => ({
      id: niche.id,
      word: niche.word,
      term: niche.term,
    }));
  }

  function toCount(number, suffix) {
    const base = Number(String(number).replace(/,/g, ""));
    if (!Number.isFinite(base)) return null;
    const unit = String(suffix || "").toLowerCase();
    if (unit === "k") return Math.round(base * 1000);
    if (unit === "m") return Math.round(base * 1000000);
    return Math.round(base);
  }

  // Explicit numbers beat the tier label. A range only counts on a line that is talking
  // about followers or that carries a K/M suffix — otherwise "Week 1 to 4" becomes a band.
  function findFollowerBand(text) {
    const rangeRe = /(\d[\d.,]*)\s*([km])?\s*(?:to|through|until|–|—|-)\s*(\d[\d.,]*)\s*([km])?/i;
    for (const line of String(text || "").split(/\r?\n/)) {
      const match = line.match(rangeRe);
      if (!match) continue;
      const hasUnit = !!(match[2] || match[4]);
      const talksFollowers = /follower|subscriber|audience|tier|influencer/i.test(line);
      if (!hasUnit && !talksFollowers) continue;
      // "100K to 500K" — a unit written on only one side applies to both.
      const unit = match[2] || match[4] || "";
      const low = toCount(match[1], match[2] || unit);
      const high = toCount(match[3], match[4] || unit);
      if (low == null || high == null || high <= low) continue;
      return { min: low, max: high, source: "explicit" };
    }
    return null;
  }

  function findTier(text) {
    const value = String(text || "").toLowerCase();
    for (const name of Object.keys(TIER_BANDS)) {
      if (new RegExp("\\b" + name.replace("-", "[- ]?") + "\\b").test(value)) return name;
    }
    return "";
  }

  function findCreatorCount(text) {
    const match = String(text || "").match(/(\d+)\s+(?:[a-z][a-z-]*\s+){0,3}creators?\b/i);
    if (match) {
      const count = Number(match[1]);
      if (count >= 1 && count <= 100) return count;
    }
    return null;
  }

  function findGenderSplit(text) {
    const value = String(text || "");
    const female = value.match(/(\d+)\s+female/i);
    const male = value.match(/(\d+)\s+male/i);
    return {
      female: female ? Number(female[1]) : null,
      male: male ? Number(male[1]) : null,
    };
  }

  function findHandles(text) {
    const handles = [];
    const value = String(text || "");
    const push = (raw) => {
      const handle = String(raw || "").toLowerCase().replace(/^@/, "").replace(/\/+$/, "");
      if (!handle || NON_HANDLES.has(handle)) return;
      if (!/^[a-z0-9._]{1,30}$/.test(handle)) return;
      if (!handles.includes(handle)) handles.push(handle);
    };
    // instagram.com/<handle> first, so a URL is not also read as a bare word.
    for (const match of value.matchAll(/instagram\.com\/([a-zA-Z0-9._]+)/g)) push(match[1]);
    // @mentions, but never the local part of an email address (which has no leading space).
    for (const match of value.matchAll(/(^|[\s(,[])@([a-zA-Z0-9._]{2,30})/g)) push(match[2]);
    return handles;
  }

  function findHashtags(text) {
    const tags = [];
    for (const match of String(text || "").matchAll(/#([a-zA-Z0-9_]{2,50})/g)) {
      const tag = match[1].toLowerCase();
      if (!tags.includes(tag)) tags.push(tag);
    }
    return tags;
  }

  function findPlatform(text) {
    const value = String(text || "").toLowerCase();
    const instagram = /instagram|\breels?\b/.test(value);
    const youtube = /youtube|\bshorts?\b/.test(value);
    if (instagram && youtube) return "both";
    if (youtube) return "youtube";
    if (instagram) return "instagram";
    return "";
  }

  function findLanguages(text) {
    const value = String(text || "").toLowerCase();
    return LANGUAGES.filter((language) => new RegExp("\\b" + language + "\\b").test(value));
  }

  function findBrand(sections, text) {
    const named = sectionText(sections, ["brand name", "brand", "client"]).split(/\r?\n/)[0];
    if (named && named.trim()) return named.trim().slice(0, 60);
    const site = String(text || "").match(/https?:\/\/(?:www\.)?([a-z0-9-]+)\./i);
    return site ? site[1] : "";
  }

  function findWebsite(text) {
    const match = String(text || "").match(
      /https?:\/\/[^\s,)]+|(?:^|\s)(?:www\.)?[a-z0-9-]+\.(?:in|com|co|shop|store|net|org)(?:\/[^\s,)]*)?/i
    );
    if (!match) return "";
    return (match[0] || "").trim().replace(/[.,]$/, "");
  }

  // ----------------------------------------------------------------------- seeds

  // Round-robin over niches with a rotating city, so the first N seeds cover many niches
  // AND many cities. Nesting city-in-niche (or the reverse) would spend the whole seed
  // budget inside one of the two dimensions before ever touching the other.
  function buildSeeds(plan, maxSeeds) {
    const cap = Math.max(1, Number(maxSeeds) || 24);
    const seeds = [];
    const push = (seed) => {
      const value = String(seed || "").trim().replace(/\s+/g, " ");
      if (value && seeds.length < cap && !seeds.includes(value)) seeds.push(value);
    };

    for (const niche of plan.niches) push(niche.term);

    const cities = plan.cities;
    const niches = plan.niches;
    if (cities.length && niches.length) {
      for (let round = 0; round < cities.length && seeds.length < cap; round++) {
        for (let index = 0; index < niches.length && seeds.length < cap; index++) {
          push(cities[(round + index) % cities.length] + " " + niches[index].word);
        }
      }
    } else {
      for (const city of cities) push(city + " creator");
    }

    // Brief hashtags last: they are usually the brand's own campaign tag, which is a thin
    // source next to a search term — but they cost one task each, so they stay.
    for (const tag of plan.hashtags) push("#" + tag);

    return seeds;
  }

  // ----------------------------------------------------------------------- the parse

  function parseBrief(text, options) {
    const raw = String(text || "");
    const maxSeeds = Math.max(1, Number(options && options.maxSeeds) || 24);
    const sections = splitSections(raw);
    const warnings = [];

    const nicheScope = scoped(sections, ["niche", "genre", "category", "vertical"], raw);
    const cityScope = scoped(sections, ["location", "geograph", "market", "city", "cities"], raw);
    const tierScope = scoped(sections, ["tier", "follower", "size"], raw);
    const countScope = scoped(sections, ["number of creator", "creators", "no of creator", "split"], raw);

    const niches = findNiches(nicheScope.text);
    const cities = findCities(cityScope.text);
    const tier = findTier(tierScope.text) || findTier(raw);
    const explicitBand = findFollowerBand(tierScope.text) || findFollowerBand(raw);
    const tierBand = tier && TIER_BANDS[tier] ? TIER_BANDS[tier] : null;

    let minFollowers = 1000;
    let maxFollowers = 1000000;
    let bandSource = "default";
    if (explicitBand) {
      minFollowers = explicitBand.min;
      maxFollowers = explicitBand.max;
      bandSource = "brief ke numbers";
    } else if (tierBand) {
      minFollowers = tierBand[0];
      maxFollowers = tierBand[1];
      bandSource = tier + " tier default";
    }

    const creatorCount = findCreatorCount(countScope.text) || findCreatorCount(raw);
    const genderSplit = findGenderSplit(countScope.text || raw);
    const platform = findPlatform(raw);
    const brandHandles = findHandles(raw);

    if (!niches.length) {
      warnings.push("Brief me koi niche pehchana nahi gaya — seeds khud likhne padenge.");
    }
    if (!cities.length) {
      warnings.push("Koi city nahi mili — seeds sirf niche ke basis par bane hain.");
    }
    if (!explicitBand && !tierBand) {
      warnings.push("Follower band brief me nahi mila — default 1K–1M laga diya hai.");
    }
    if (!creatorCount) {
      warnings.push("Creator count brief me nahi mila — khud daalna padega.");
    }
    if (platform === "youtube") {
      warnings.push("Brief YouTube ka lag raha hai. Yeh mode sirf Instagram creators dhoondta hai.");
    }
    if (genderSplit.female || genderSplit.male) {
      warnings.push(
        "Brief me gender split maanga hai (" +
          (genderSplit.female || 0) +
          "F / " +
          (genderSplit.male || 0) +
          "M). Gender profile se bharosemand tarike se pata nahi chalta, isliye woh apne aap nahi chunta — shortlist file se khud pick karo."
      );
    }

    const plan = {
      brand: findBrand(sections, raw),
      website: findWebsite(raw),
      brandHandles,
      platform,
      niches,
      cities,
      hashtags: findHashtags(raw),
      tier,
      minFollowers,
      maxFollowers,
      bandSource,
      creatorCount,
      genderSplit,
      languages: findLanguages(raw),
      scopedFrom: {
        niches: nicheScope.scoped ? "niche section" : "poora brief",
        cities: cityScope.scoped ? "location section" : "poora brief",
        tier: tierScope.scoped ? "tier section" : "poora brief",
      },
      warnings,
    };
    plan.seeds = buildSeeds(plan, maxSeeds);
    // The brand's own accounts are leads for nobody — excluded from the walk so one of
    // them can never come back as a "creator" and eat one of the N slots.
    plan.excludes = brandHandles.slice();
    return plan;
  }

  root.BriefParse = {
    parseBrief,
    buildSeeds,
    splitSections,
    findCities,
    findNiches,
    findFollowerBand,
    findCreatorCount,
    findHandles,
    NICHES,
    CITY_ALIASES,
    TIER_BANDS,
  };
})(typeof globalThis !== "undefined" ? globalThis : this);
