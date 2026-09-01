// Side panel logic for the brand contact finder.
//
// Wrapped in an IIFE for the same reason popup-profiles.js is: popup.js runs in this same
// page and owns a pile of top-level names, so keeping everything private here means no two
// features can clobber each other's globals. The mode switcher itself still lives in
// popup-profiles.js — this file only draws its own tab dot.
//
// One thing only this mode's panel does: ask for the "<all_urls>" optional permission.
// chrome.permissions.request() needs a user gesture and an extension page, and the service
// worker has neither, so the Start button is where it has to happen.

(function () {
  const brandsEl = document.getElementById("bcBrands");
  const regionEl = document.getElementById("bcRegion");
  const sitePagesEl = document.getElementById("bcSitePages");
  const googleDelayEl = document.getElementById("bcGoogleDelay");
  const pageDelayEl = document.getElementById("bcPageDelay");
  const linkedinEl = document.getElementById("bcLinkedin");
  const leadDbEl = document.getElementById("bcLeadDb");
  const registryEl = document.getElementById("bcRegistry");
  const ownerOnlyEl = document.getElementById("bcOwnerOnly");
  const openProfilesEl = document.getElementById("bcOpenProfiles");
  const delayWarningEl = document.getElementById("bcDelayWarning");
  const accessBanner = document.getElementById("bcAccessBanner");
  const grantBtn = document.getElementById("bcGrantBtn");
  const startBtn = document.getElementById("bcStartBtn");
  const stopBtn = document.getElementById("bcStopBtn");
  const resumeBtn = document.getElementById("bcResumeBtn");
  const pauseBanner = document.getElementById("bcPauseBanner");
  const pauseDetailEl = document.getElementById("bcPauseDetail");
  const statusLineEl = document.getElementById("bcStatusLine");
  const totalsLineEl = document.getElementById("bcTotalsLine");
  const rowsEl = document.getElementById("bcRows");
  const logEl = document.getElementById("bcLog");
  const jsonBtn = document.getElementById("bcJsonBtn");
  const csvBtn = document.getElementById("bcCsvBtn");
  const resetBtn = document.getElementById("bcResetBtn");
  const brandsDot = document.getElementById("brandsModeDot");

  let brandsEdited = false;
  let settingsEdited = false;

  // --------------------------------------------------------------------- input parsing

  function parseBrands(text) {
    const seen = new Set();
    const out = [];
    // Commas are how a list arrives from a sheet, newlines are how it arrives from a doc.
    // Both are accepted; a brand with a comma in its legal name is rare enough that
    // splitting on it is the better default.
    for (const raw of String(text || "").split(/[,\n]+/)) {
      const brand = raw.trim().replace(/\s+/g, " ");
      if (!brand) continue;
      const key = brand.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(brand);
    }
    return out;
  }

  // ------------------------------------------------------------------------- rendering

  const STATUS_LABELS = {
    idle: "Idle",
    stopped: "Stopped",
    done: "Done",
    paused: "Paused — dhyan chahiye",
  };

  function statusText(state) {
    const totals = state.totals || {};
    const brandCount = (state.brands || []).length;
    if (state.status === "running") {
      const task = state.current;
      const where = task ? task.brand : "-";
      return "Chal raha hai — " + where + " (" + (totals.tasksDone || 0) + "/" + (totals.tasksPlanned || 0) + " step)";
    }
    if (state.status === "waiting_delay") {
      const next = (state.queue || [])[0];
      return "Ruke hue — next: " + (next ? next.brand : "-") + " (" + (state.queue || []).length + " step baaki)";
    }
    if (state.status === "done") return "Done — " + brandCount + " brand";
    return STATUS_LABELS[state.status] || state.status;
  }

  // Mirrors BRANDS_ROLE_INBOX_RE in background-brands.js. Duplicated rather than shared
  // for the same reason normalizeHandle() is duplicated in popup-profiles.js — the panel
  // is a separate page from the worker and there is no bundler here. The worker stays the
  // authority: the downloaded file is what it computed, this is only the live preview.
  const ROLE_INBOX_RE = /^(info|hello|hi|contact|support|help|care|customercare|service|sales|enquiry|inquiry|admin|office|team|mail|marketing|hr|careers|press|media|billing|accounts|orders|feedback|connect|business)\b/i;

  // Green only when a *named person* can be reached — the whole point of the mode. A brand
  // with nothing but info@ is amber: it was processed, it just has no owner contact.
  function renderRows(state) {
    const brands = state.brands || [];
    const rows = brands
      .map((brand) => (state.rows || {})[brand.toLowerCase()])
      .filter(Boolean)
      .slice(-40)
      .reverse();

    rowsEl.classList.toggle("hidden", !rows.length);
    rowsEl.innerHTML = "";
    for (const row of rows) {
      const named = (row.people || []).find(
        (person) => (person.phones || []).length || (person.emails || []).length
      );
      const personal = (row.emails || []).filter((item) => !ROLE_INBOX_RE.test(item.value.split("@")[0]));
      const li = document.createElement("li");
      li.className = named ? "ok" : row.status === "done" ? "warn" : "";

      let detail;
      if (named) {
        const contact = (named.phones || [])[0] || (named.emails || [])[0];
        detail = named.name + (named.title ? " (" + named.title + ")" : "") + " · " + contact.value;
      } else if ((row.people || []).length) {
        detail = (row.people || []).length + " naam, direct contact nahi";
      } else if (personal.length) {
        detail = personal.length + " personal email";
      } else if (row.status === "done") {
        detail = "sirf company contact";
      } else {
        detail = "chal raha hai";
      }
      li.textContent = row.brand + " · " + detail;
      rowsEl.appendChild(li);
    }
  }

  // Keeps a hidden section's run visible in the tab strip.
  function renderModeDot(status) {
    const active = status === "running" || status === "waiting_delay" || status === "paused";
    brandsDot.classList.toggle("hidden", !active);
    brandsDot.classList.toggle("paused", status === "paused");
  }

  function render(state) {
    if (!state) return;

    const running = state.status === "running" || state.status === "waiting_delay";
    const paused = state.status === "paused";
    const resumable = paused || (state.status === "stopped" && (state.queue || []).length > 0);

    startBtn.disabled = running;
    stopBtn.classList.toggle("hidden", !running);
    pauseBanner.classList.toggle("hidden", !resumable);
    if (resumable) pauseDetailEl.textContent = state.lastEvent || "";

    // The access banner is about the *next* run as much as this one, so it shows whenever
    // the permission is missing — not only mid-run.
    accessBanner.classList.toggle("hidden", !!state.hostAccess);

    statusLineEl.textContent = statusText(state);
    const totals = state.totals || {};
    totalsLineEl.textContent =
      "Brands: " +
      (totals.brandsDone || 0) +
      "/" +
      ((state.brands || []).length || 0) +
      " · owner contact: " +
      (totals.reachableOwners || 0) +
      " · naam: " +
      (totals.people || 0) +
      " · email: " +
      (totals.emails || 0);

    renderRows(state);

    logEl.innerHTML = "";
    (state.log || [])
      .slice(-20)
      .reverse()
      .forEach((entry) => {
        const li = document.createElement("li");
        li.textContent = entry;
        logEl.appendChild(li);
      });

    const hasRows = Object.keys(state.rows || {}).length > 0;
    jsonBtn.disabled = !hasRows;
    csvBtn.disabled = !hasRows;

    // Only repopulate inputs from stored state if the user hasn't started typing —
    // avoids clobbering in-progress edits on every storage.onChanged tick.
    if (!brandsEdited && (state.brands || []).length) {
      brandsEl.value = state.brands.join("\n");
    }
    if (!settingsEdited) {
      regionEl.value = state.region || "";
      if (state.sitePages) sitePagesEl.value = state.sitePages;
      if (state.googleDelaySec) googleDelayEl.value = state.googleDelaySec;
      if (state.pageDelaySec) pageDelayEl.value = state.pageDelaySec;
      linkedinEl.checked = state.useLinkedin !== false;
      leadDbEl.checked = state.useLeadDb !== false;
      registryEl.checked = state.useRegistry !== false;
      ownerOnlyEl.checked = !!state.ownerOnly;
      openProfilesEl.checked = !!state.openProfiles;
    }

    renderModeDot(state.status);
  }

  // --------------------------------------------------------------------------- actions

  function send(msg) {
    return chrome.runtime.sendMessage(msg);
  }

  // Returns whether the run may read brand websites. Denial is not an error: the Google
  // half still works, and the worker records every page it had to skip.
  async function ensureHostAccess() {
    try {
      if (await chrome.permissions.contains({ origins: ["<all_urls>"] })) return true;
      return await chrome.permissions.request({ origins: ["<all_urls>"] });
    } catch (e) {
      return false;
    }
  }

  brandsEl.addEventListener("input", () => {
    brandsEdited = true;
  });

  for (const el of [regionEl, sitePagesEl, pageDelayEl, linkedinEl, leadDbEl, registryEl, ownerOnlyEl, openProfilesEl]) {
    el.addEventListener("input", () => {
      settingsEdited = true;
    });
  }

  googleDelayEl.addEventListener("input", () => {
    settingsEdited = true;
    delayWarningEl.classList.toggle("hidden", Number(googleDelayEl.value) >= 15);
  });

  grantBtn.addEventListener("click", async () => {
    const granted = await ensureHostAccess();
    grantBtn.textContent = granted ? "Mil gaya" : "Nahi mila — Chrome me 'On all sites' karo";
    render(await send({ type: "BRANDS_SYNC_ACCESS" }));
    setTimeout(() => {
      grantBtn.textContent = "Site access do";
    }, 2500);
  });

  startBtn.addEventListener("click", async () => {
    const brands = parseBrands(brandsEl.value);
    if (!brands.length) {
      alert("Kam se kam ek brand ka naam daalo.");
      return;
    }

    // Asked before the run rather than at the first website, because a request that lands
    // 40 seconds after the click has no user gesture left and would be refused outright.
    const hostAccess = await ensureHostAccess();
    if (!hostAccess) {
      const proceed = confirm(
        "Site access nahi mila.\n\nUske bina brand ki apni website nahi khulegi — sirf Google " +
          "ke snippets, LinkedIn aur Apollo ke results milenge. Email/phone zyada tar website " +
          "pe hi hote hain.\n\nPhir bhi chalayein?"
      );
      if (!proceed) return;
    }

    brandsEdited = false;
    settingsEdited = false;

    render(
      await send({
        type: "BRANDS_START",
        brands,
        region: regionEl.value.trim(),
        sitePages: Number(sitePagesEl.value),
        googleDelaySec: Number(googleDelayEl.value),
        pageDelaySec: Number(pageDelayEl.value),
        useLinkedin: linkedinEl.checked,
        useLeadDb: leadDbEl.checked,
        useRegistry: registryEl.checked,
        ownerOnly: ownerOnlyEl.checked,
        openProfiles: openProfilesEl.checked,
      })
    );
  });

  stopBtn.addEventListener("click", async () => {
    render(await send({ type: "BRANDS_STOP" }));
  });

  resumeBtn.addEventListener("click", async () => {
    render(await send({ type: "BRANDS_RESUME" }));
  });

  jsonBtn.addEventListener("click", async () => {
    render(await send({ type: "BRANDS_DOWNLOAD", format: "json" }));
  });

  csvBtn.addEventListener("click", async () => {
    render(await send({ type: "BRANDS_DOWNLOAD", format: "csv" }));
  });

  resetBtn.addEventListener("click", async () => {
    const proceed = confirm(
      "Brand run ka saara collected data clear ho jayega (download ki hui file safe hai). Reset karein?"
    );
    if (!proceed) return;
    const state = await send({ type: "BRANDS_RESET" });
    brandsEdited = false;
    settingsEdited = false;
    brandsEl.value = "";
    regionEl.value = "";
    sitePagesEl.value = 3;
    googleDelayEl.value = 15;
    pageDelayEl.value = 6;
    linkedinEl.checked = true;
    leadDbEl.checked = true;
    registryEl.checked = true;
    ownerOnlyEl.checked = false;
    openProfilesEl.checked = false;
    delayWarningEl.classList.add("hidden");
    render(state);
  });

  // ---------------------------------------------------------------------------- wiring

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.brandsRunState) {
      render(changes.brandsRunState.newValue);
    }
  });

  (async function init() {
    // The panel is the only place that can see the optional permission's real state, so
    // it syncs the worker on open — a permission revoked from chrome://extensions would
    // otherwise stay "granted" in the stored state until the next run.
    render(await send({ type: "BRANDS_SYNC_ACCESS" }));
  })();
})();
