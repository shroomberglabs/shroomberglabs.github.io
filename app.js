(() => {
  "use strict";

  const DATA_URL = "./providers.json";
  const OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
  const NOMINATIM_URL = "https://nominatim.openstreetmap.org/search";
  const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
  const REQUEST_INTERVAL_MS = 1100;
  const MAP_RESULT_LIMIT = 20;
  const coarseResultTypes = new Set(["country", "state", "province", "region", "county", "city", "town", "village", "municipality", "hamlet"]);
  const categoryNames = {
    access: "Access & advocacy",
    medical: "Medical",
    online_retail: "Online retail",
    research: "Research",
    retail: "Retail",
    retreat: "Retreats",
    supervised: "Supervised services",
    supplier: "Suppliers"
  };
  const providerTypeCategories = {
    retail: ["retail"],
    healing: ["supervised", "retreat"],
    online: ["online_retail"],
    medical: ["medical", "access"],
    institutions: ["research"],
    suppliers: ["supplier"]
  };
  const categoryProviderType = Object.fromEntries(
    Object.entries(providerTypeCategories).flatMap(([type, categories]) => categories.map((category) => [category, type]))
  );
  const addressNames = {
    medical_clinic: "Clinic",
    mailing_address: "Mailing address",
    registered_office: "Registered office",
    industrial_facility: "Facility / warehouse",
    research_institution: "Research institution",
    supervised_service_site: "Supervised service site",
    retail_storefront: "Retail storefront",
    retreat_venue: "Retreat venue",
    other: "Historical / other address",
    unclassified: "Address type unclassified"
  };
  const aliases = {
    country: ["countryCode"],
    state: ["region"],
    province: ["region"],
    address: ["streetAddress", "postalCode"],
    street: ["streetAddress"],
    postal: ["postalCode"],
    zip: ["postalCode"],
    kind: ["addressKind"],
    type: ["addressKind"],
    status: ["addressStatus", "websiteStatus", "followUpStatus"],
    evidence: ["addressEvidenceLevel", "addressEvidenceUrl", "websiteEvidenceUrl", "verificationSourceUrl"],
    source: ["addressEvidenceUrl", "websiteEvidenceUrl", "sourceUrl", "verificationSourceUrl", "researchNoteSourceUrl"],
    location: ["city", "region", "countryCode", "streetAddress", "postalCode", "locationContext"],
    online: ["isOnlineOnly"],
    verified: ["businessOperatingVerified"],
    followup: ["followUpStatus", "followUpReason"],
    updated: ["updatedAt"],
    contact: ["contactEmail", "contactFormUrl", "phone"],
    offering: ["offeringCategories", "offeringPrimaryCategory", "servicesSummary", "productKeys"],
    service: ["offeringCategories", "offeringPrimaryCategory", "servicesSummary", "description"],
    availability: ["availabilityStars", "availabilitySummary", "bookingAvailability"],
    stars: ["availabilityStars"],
    legality: ["marketLegality", "legalStatus"],
    access: ["publicAccessTier", "accessRestrictions"]
  };
  const hasAliases = new Set(["address", "website", "source", "region", "location", "evidence", "online", "verified", "service", "notes", "closed"]);
  const $ = (selector) => document.querySelector(selector);
  const els = {
    search: $("#search-input"), searchFeedback: $("#search-feedback"),
    category: $("#category-filter"), country: $("#country-filter"), region: $("#region-filter"),
    status: $("#status-filter"), detail: $("#provider-detail"),
    searchToggle: $("#directory-search-toggle"), searchContent: $("#directory-search-content"),
    profileDialog: $("#provider-profile-dialog"), closeProfile: $("#close-profile"),
    mapMessage: $("#map-message"), mapMatches: $("#map-matches"), mapSearchForm: $("#map-search-form"),
    mapSearch: $("#map-search-input"), mapSearchButton: $("#map-search-form button[type='submit']"),
    resetMap: $("#reset-map"), clear: $("#clear-filters")
  };

  const countryNames = (() => {
    try { return new Intl.DisplayNames(["en"], { type: "region" }); }
    catch { return null; }
  })();
  const countryLabel = (code) => {
    if (!code) return "";
    try { return countryNames?.of(code) || code; } catch { return code; }
  };
  const clean = (value) => String(value ?? "").trim();
  const normalizeKey = (value) => String(value ?? "").toLocaleLowerCase().replace(/[^a-z0-9]/g, "");
  const categoryLabel = (value) => categoryNames[value] || value || "Uncategorized";
  const locationText = (provider) => [clean(provider.city), clean(provider.region), countryLabel(clean(provider.countryCode))].filter(Boolean).join(", ");
  const humanize = (value) => String(value ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (letter) => letter.toLocaleUpperCase())
    .replace(/\burl\b/gi, "URL")
    .replace(/\buri\b/gi, "URI")
    .replace(/\bosm\b/gi, "OSM");
  const safeHttpUrl = (raw) => {
    try {
      const url = new URL(String(raw));
      return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
    } catch { return ""; }
  };
  const makeLink = (raw, label, className = "source-link") => {
    const href = safeHttpUrl(raw);
    if (!href) return null;
    const link = document.createElement("a");
    link.className = className;
    link.href = href;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = label;
    return link;
  };
  const mapQuery = (provider) => [
    clean(provider.streetAddress), clean(provider.city), clean(provider.region),
    countryLabel(clean(provider.countryCode)), clean(provider.postalCode)
  ].filter(Boolean).join(", ");
  const openStreetMapSearch = (provider) => "https://www.openstreetmap.org/search?query=" + encodeURIComponent(mapQuery(provider) || locationText(provider));
  const flattenValue = (value) => {
    if (value === null || value === undefined || value === "") return [];
    if (Array.isArray(value)) return value.flatMap(flattenValue);
    if (typeof value === "object") return Object.entries(value).flatMap(([key, item]) => [key, ...flattenValue(item)]);
    return [String(value)];
  };

  let providers = [];
  let filtered = [];
  let selectedId = "";
  let map;
  let marker;
  let searchMarkerLayer;
  let searchMapTimer = 0;
  let searchMapGeneration = 0;
  let searchPanelTimer = 0;
  let profileCloseTimer = 0;
  const searchPins = new Map();
  let lastGeocodeAt = 0;
  let geocodeQueue = Promise.resolve();
  let mapSearchBusy = false;
  let activeMapRecords = [];
  const searchIndex = new WeakMap();

  function setMapMessage(message, isError = false) {
    if (els.mapMessage.textContent !== message) {
      els.mapMessage.classList.remove("is-refreshing");
      void els.mapMessage.offsetWidth;
      els.mapMessage.textContent = message;
      els.mapMessage.classList.add("is-refreshing");
    }
    els.mapMessage.classList.toggle("error", Boolean(isError));
  }

  function setSearchFeedback(message = "") {
    els.searchFeedback.textContent = message;
    els.searchFeedback.hidden = !message;
  }

  function initMap() {
    if (!window.L) {
      setMapMessage("The interactive map did not load. Provider profiles still include direct OpenStreetMap links.", true);
      return;
    }
    try {
      map = window.L.map("map", { scrollWheelZoom: true, zoomControl: true }).setView([22, 0], 2);
      const mapContainer = map.getContainer();
      mapContainer.style.height = window.innerWidth <= 660 ? "min(60vh, 520px)" : "min(72vh, 760px)";
      mapContainer.style.minHeight = window.innerWidth <= 660 ? "300px" : "460px";
      window.L.tileLayer(OSM_TILE_URL, {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap contributors</a>'
      }).addTo(map);
      searchMarkerLayer = window.L.layerGroup().addTo(map);
      map.on("zoomend", () => {
        if (activeMapRecords.length) scheduleSearchMapUpdate(activeMapRecords, activeMapRecords.length, false, false, true);
      });
      window.setTimeout(() => map.invalidateSize(), 100);
    } catch {
      map = null;
      setMapMessage("The interactive map could not start. Provider profiles still include direct OpenStreetMap links.", true);
    }
  }

  function setStats(records) {
    const addressCount = records.filter((provider) => clean(provider.streetAddress)).length;
    const websiteCount = records.filter((provider) => safeHttpUrl(provider.website)).length;
    $("#stat-providers").textContent = records.length.toLocaleString();
    $("#stat-addresses").textContent = addressCount.toLocaleString();
    $("#stat-websites").textContent = websiteCount.toLocaleString();
  }

  function formatSnapshotDate(value) {
    const raw = clean(value);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw || "Not recorded";
    const date = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(date.getTime())) return raw;
    return date.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" });
  }

  function populateFilters() {
    const categories = [...new Set(providers.map((provider) => clean(provider.category)).filter(Boolean))].sort();
    const countries = [...new Set(providers.map((provider) => clean(provider.countryCode)).filter(Boolean))]
      .sort((a, b) => countryLabel(a).localeCompare(countryLabel(b)));
    els.category.replaceChildren(new Option("All categories", ""));
    els.country.replaceChildren(new Option("Everywhere", ""));
    for (const category of categories) els.category.add(new Option(categoryLabel(category), category));
    for (const country of countries) els.country.add(new Option(countryLabel(country), country));
    updateRegionOptions();
  }

  function updateRegionOptions() {
    const prior = els.region.value;
    const country = els.country.value;
    const regions = [...new Set(providers
      .filter((provider) => !country || clean(provider.countryCode) === country)
      .map((provider) => clean(provider.region)).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    els.region.replaceChildren(new Option("All regions", ""));
    for (const region of regions) els.region.add(new Option(region, region));
    if (regions.includes(prior)) els.region.value = prior;
  }

  function recordSearchText(provider) {
    if (!searchIndex.has(provider)) {
      const values = [];
      for (const [key, value] of Object.entries(provider)) {
        values.push(key, humanize(key), ...flattenValue(value));
      }
      if (provider.countryCode) values.push(countryLabel(clean(provider.countryCode)));
      if (provider.category) values.push(categoryLabel(clean(provider.category)));
      if (provider.addressKind) values.push(addressNames[provider.addressKind] || humanize(provider.addressKind));
      searchIndex.set(provider, values.join(" ").toLocaleLowerCase());
    }
    return searchIndex.get(provider);
  }

  function lexQuery(query) {
    const tokens = [];
    let current = "";
    let quoted = false;
    for (const character of clean(query)) {
      if (character === '"') {
        quoted = !quoted;
        continue;
      }
      if (/\s/.test(character) && !quoted) {
        if (current) tokens.push(current);
        current = "";
      } else current += character;
    }
    if (quoted) return { error: "Close the quoted phrase, then try your search again." };
    if (current) tokens.push(current);
    return { tokens };
  }

  function resolveFieldKeys(field) {
    const normalized = normalizeKey(field);
    const aliasKey = Object.keys(aliases).find((key) => normalizeKey(key) === normalized);
    if (aliasKey) return aliases[aliasKey].filter((key) => providers.some((provider) => Object.hasOwn(provider, key)));
    const keys = providers.length ? Object.keys(providers[0]) : [];
    const exact = keys.find((key) => normalizeKey(key) === normalized);
    return exact ? [exact] : [];
  }

  function parseQuery(query) {
    const lexed = lexQuery(query);
    if (lexed.error) return { tokens: [], error: lexed.error };
    const tokens = [];
    for (const original of lexed.tokens) {
      const negative = original.startsWith("-") && original.length > 1;
      const raw = negative ? original.slice(1) : original;
      const colon = raw.indexOf(":");
      if (colon > 0) {
        const field = raw.slice(0, colon);
        const value = raw.slice(colon + 1);
        if (/^https?$/i.test(field)) {
          tokens.push({ kind: "text", value: raw.toLocaleLowerCase(), negative });
          continue;
        }
        if (!/^[a-z][a-z0-9_.-]*$/i.test(field)) {
          tokens.push({ kind: "text", value: raw.toLocaleLowerCase(), negative });
          continue;
        }
        if (!value) return { tokens: [], error: `Add a value after “${field}:” (for example, “country:CA”).` };
        const normalized = normalizeKey(field);
        if (normalized === "has" || normalized === "is") {
          const valueKey = normalizeKey(value);
          if (normalized === "has" && !hasAliases.has(valueKey) && !resolveFieldKeys(value).length) {
            return { tokens: [], error: `“has:${value}” is not a recognized field. Try has:address, has:website, or has:source.` };
          }
          if (normalized === "is" && !["online", "verified", "closed"].includes(valueKey)) {
            return { tokens: [], error: `“is:${value}” is not supported. Try is:online, is:verified, or is:closed.` };
          }
          tokens.push({ kind: normalized, value: valueKey, negative });
          continue;
        }
        if (normalized === "stars" || normalized === "availabilitystars") {
          const comparison = value.match(/^(>=|<=|>|<|=)?([1-5](?:\.\d+)?)$/);
          if (!comparison || Number(comparison[2]) > 5) {
            return { tokens: [], error: `Use a score from 1 to 5, for example stars:>=4.` };
          }
          tokens.push({ kind: "stars", operator: comparison[1] || "=", value: Number(comparison[2]), negative });
          continue;
        }
        const keys = resolveFieldKeys(field);
        if (!keys.length) {
          return { tokens: [], error: `I don't recognize “${field}:” as a filter. Try name, category, country, region, city, address, website, status, kind, evidence, source, or a workbook field name.` };
        }
        tokens.push({ kind: "field", keys, value: value.toLocaleLowerCase(), negative });
        continue;
      }
      tokens.push({ kind: "text", value: raw.toLocaleLowerCase(), negative });
    }
    return { tokens, error: "" };
  }

  function fieldValues(provider, keys) {
    const values = [];
    for (const key of keys) {
      const value = provider[key];
      values.push(...flattenValue(value));
      if (key === "countryCode" && value) values.push(countryLabel(clean(value)));
      if (key === "category" && value) values.push(categoryLabel(clean(value)));
      if (key === "addressKind" && value) values.push(addressNames[value] || humanize(value));
    }
    return values.map((value) => String(value).toLocaleLowerCase());
  }

  function hasField(provider, requested) {
    const value = normalizeKey(requested);
    if (value === "address") return Boolean(clean(provider.streetAddress));
    if (value === "website") return Boolean(safeHttpUrl(provider.website));
    if (value === "source") return Object.entries(provider).some(([key, field]) => /(?:url|uri)$/i.test(key) && safeHttpUrl(field));
    if (value === "region") return Boolean(clean(provider.region) || clean(provider.city));
    if (value === "location") return Boolean(mapQuery(provider));
    if (value === "evidence") return Boolean(clean(provider.addressEvidenceLevel) || clean(provider.addressEvidenceUrl) || clean(provider.websiteEvidenceUrl));
    if (value === "online") return provider.isOnlineOnly === true;
    if (value === "verified") return provider.businessOperatingVerified === true;
    if (value === "service") return Boolean(clean(provider.category));
    if (value === "notes") return Boolean(clean(provider.locationContext) || clean(provider.researchNote) || clean(provider.followUpReason));
    if (value === "closed") return /closed|inactive|ceased|discontinued/i.test([provider.addressStatus, provider.websiteStatus, provider.followUpStatus, provider.followUpReason].map(clean).join(" "));
    const keys = resolveFieldKeys(requested);
    return keys.some((key) => flattenValue(provider[key]).some((item) => clean(item) !== ""));
  }

  function isFlag(provider, flag) {
    if (flag === "online") return provider.isOnlineOnly === true;
    if (flag === "verified") return provider.businessOperatingVerified === true;
    if (flag === "closed") return /closed|inactive|ceased|discontinued/i.test([provider.addressStatus, provider.websiteStatus, provider.followUpStatus, provider.followUpReason].map(clean).join(" "));
    return false;
  }

  function matchesQuery(provider, tokens) {
    const fullText = recordSearchText(provider);
    return tokens.every((token) => {
      let matched = false;
      if (token.kind === "text") matched = fullText.includes(token.value);
      else if (token.kind === "field") matched = fieldValues(provider, token.keys).some((value) => value.includes(token.value));
      else if (token.kind === "stars") {
        const score = provider.availabilityStars === null || provider.availabilityStars === undefined || provider.availabilityStars === ""
          ? NaN : Number(provider.availabilityStars);
        if (Number.isFinite(score) && score >= 1 && score <= 5) {
          matched = token.operator === ">=" ? score >= token.value
            : token.operator === "<=" ? score <= token.value
              : token.operator === ">" ? score > token.value
                : token.operator === "<" ? score < token.value : score === token.value;
        }
      }
      else if (token.kind === "has") matched = hasField(provider, token.value);
      else if (token.kind === "is") matched = isFlag(provider, token.value);
      return token.negative ? !matched : matched;
    });
  }

  function selectedProviderTypes() {
    return [...document.querySelectorAll("[data-provider-type]:checked")].map((input) => input.dataset.providerType);
  }

  function providerMatchesSelectedTypes(provider, selected = selectedProviderTypes()) {
    const type = categoryProviderType[clean(provider.category)];
    return Boolean(type && selected.includes(type));
  }

  function updateProviderTypeCounts() {
    const counts = Object.fromEntries(Object.keys(providerTypeCategories).map((type) => [type, 0]));
    for (const provider of providers) {
      const type = categoryProviderType[clean(provider.category)];
      if (type) counts[type] += 1;
    }
    for (const [type, count] of Object.entries(counts)) {
      const node = document.querySelector(`[data-provider-type-count="${type}"]`);
      if (node) node.textContent = `(${count.toLocaleString()})`;
    }
  }

  function includeCategoryProviderType(category) {
    const type = categoryProviderType[clean(category)];
    const input = type && document.querySelector(`[data-provider-type="${type}"]`);
    if (input) input.checked = true;
  }

  function resetProviderTypeFilters() {
    for (const input of document.querySelectorAll("[data-provider-type]")) {
      input.checked = ["retail", "healing"].includes(input.dataset.providerType);
    }
  }

  function getFiltered(tokens) {
    const selectedTypes = selectedProviderTypes();
    const category = els.category.value;
    const country = els.country.value;
    const region = els.region.value;
    const status = els.status.value;
    const rows = providers.filter((provider) => {
      if (!providerMatchesSelectedTypes(provider, selectedTypes)) return false;
      if (category && clean(provider.category) !== category) return false;
      if (country && clean(provider.countryCode) !== country) return false;
      if (region && clean(provider.region) !== region) return false;
      if (status === "address" && !clean(provider.streetAddress)) return false;
      if (status === "missing-address" && clean(provider.streetAddress)) return false;
      if (status === "missing-website" && safeHttpUrl(provider.website)) return false;
      if (status === "online" && provider.isOnlineOnly !== true) return false;
      if (status === "verified" && provider.businessOperatingVerified !== true) return false;
      if (!matchesQuery(provider, tokens)) return false;
      return true;
    });
    rows.sort((a, b) => clean(a.name).localeCompare(clean(b.name)));
    return rows;
  }

  function tag(text, style = "") {
    const node = document.createElement("span");
    node.className = "tag" + (style ? " " + style : "");
    node.textContent = text;
    return node;
  }

  function renderList() {
    const parsed = parseQuery(els.search.value);
    setSearchFeedback(parsed.error || "");
    filtered = parsed.error ? [] : getFiltered(parsed.tokens);
    const query = clean(els.search.value);
    scheduleSearchMapUpdate(filtered, filtered.length, Boolean(parsed.error));
    if (query && !parsed.error) renderProviderMapMatches(filtered, query);
    else {
      els.mapMatches.replaceChildren();
      els.mapMatches.hidden = true;
    }
  }

  function appendDetailSection(container, heading, text) {
    if (!clean(text)) return;
    const section = document.createElement("section");
    section.className = "detail-section";
    const h = document.createElement("h3");
    h.textContent = heading;
    section.append(h);
    for (const paragraph of clean(text).split(/\n\s*\n/).map(clean).filter(Boolean)) {
      const p = document.createElement("p");
      p.textContent = paragraph;
      section.append(p);
    }
    container.append(section);
  }

  function serviceAddressNote(provider) {
    const kind = clean(provider.addressKind);
    if (kind === "mailing_address") return "Mailing address. This is not evidence of a public service venue.";
    if (kind === "registered_office") return "Registered or legal office. Visitor access is not confirmed.";
    if (kind === "industrial_facility") return "Facility address. It may not be open to visitors or retail customers.";
    if (kind === "other") return "Historical or other address. Read the source note before treating it as active.";
    if (provider.addressEvidenceLevel === "third_party_directory") return "Address is listed by a third-party directory; confirm before visiting.";
    return clean(provider.locationContext);
  }

  function clearProfile() {
    selectedId = "";
    window.clearTimeout(profileCloseTimer);
    if (!els.profileDialog.open) {
      els.profileDialog.classList.remove("is-closing");
      window.ShroombergCommunity?.clearReviews();
      return;
    }
    els.profileDialog.classList.add("is-closing");
    profileCloseTimer = window.setTimeout(() => {
      if (selectedId) return;
      if (els.profileDialog.open) els.profileDialog.close();
      els.profileDialog.classList.remove("is-closing");
      window.ShroombergCommunity?.clearReviews();
    }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 190);
  }

  function selectProvider(provider, options = {}) {
    const { navigate = true } = options;
    if (!provider) return;
    window.clearTimeout(profileCloseTimer);
    els.profileDialog.classList.remove("is-closing");
    selectedId = provider.id;
    renderDetail(provider);
    window.ShroombergCommunity?.loadReviews(provider);
    if (navigate) {
      const route = `#provider/${encodeURIComponent(provider.id)}`;
      if (window.location.hash !== route) window.history.pushState({ providerId: provider.id }, "", route);
    }
    if (!els.profileDialog.open) els.profileDialog.showModal();
  }

  function dismissProfile() {
    if (providerFromHash()) window.history.pushState({}, "", "#map");
    clearProfile();
  }

  function setSearchPanelOpen(open) {
    window.clearTimeout(searchPanelTimer);
    els.searchToggle.setAttribute("aria-expanded", String(open));
    const state = els.searchToggle.querySelector("[data-toggle-state]");
    if (state) state.textContent = open ? "Hide" : "Show";
    if (open) {
      els.searchContent.hidden = false;
      els.searchContent.classList.remove("is-open");
      window.requestAnimationFrame(() => {
        if (els.searchToggle.getAttribute("aria-expanded") === "true") els.searchContent.classList.add("is-open");
      });
      window.setTimeout(() => els.search.focus(), 0);
      if (map) window.setTimeout(() => map.invalidateSize(), 320);
    } else {
      els.searchContent.classList.remove("is-open");
      searchPanelTimer = window.setTimeout(() => {
        if (els.searchToggle.getAttribute("aria-expanded") === "false") els.searchContent.hidden = true;
        if (map) map.invalidateSize();
      }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 300);
    }
  }

  function renderDetail(provider) {
    const card = document.createElement("article");
    card.className = "detail-content";
    const back = document.createElement("button");
    back.type = "button";
    back.className = "button button-outline";
    back.textContent = "← Back to map";
    back.addEventListener("click", dismissProfile);
    card.append(back);

    const topline = document.createElement("div");
    topline.className = "detail-topline";
    const titleBox = document.createElement("div");
    const category = document.createElement("p");
    category.className = "detail-category";
    category.textContent = categoryLabel(provider.category);
    const title = document.createElement("h2");
    title.id = "selected-provider-name";
    title.textContent = clean(provider.name) || "Unnamed provider";
    titleBox.append(category, title);
    const country = tag(countryLabel(clean(provider.countryCode)) || "Location unknown", "soft");
    topline.append(titleBox, country);
    card.append(topline);

    const location = document.createElement("div");
    location.className = "detail-location";
    const addressTitle = document.createElement("strong");
    addressTitle.textContent = clean(provider.streetAddress) ? (provider.addressKind === "unclassified" ? "Recorded address" : (addressNames[provider.addressKind] || "Recorded address")) : "No street address verified";
    const address = document.createElement("p");
    const addressParts = [];
    for (const part of [provider.streetAddress, provider.city, provider.region, provider.postalCode, countryLabel(clean(provider.countryCode))].map(clean).filter(Boolean)) {
      if (!addressParts.some((existing) => existing.toLocaleLowerCase().includes(part.toLocaleLowerCase()))) addressParts.push(part);
    }
    address.textContent = addressParts.join(", ") || "No location is recorded.";
    const note = document.createElement("p");
    note.className = "type-note";
    note.textContent = serviceAddressNote(provider) || "Use the recorded city or operating region as the location context.";
    location.append(addressTitle, address, note);
    card.append(location);

    const actions = document.createElement("div");
    actions.className = "detail-actions";
    const mapButton = document.createElement("button");
    mapButton.type = "button";
    mapButton.className = "button button-primary";
    mapButton.textContent = "Show on map";
    mapButton.addEventListener("click", () => { dismissProfile(); locateProvider(provider); });
    actions.append(mapButton);
    const osmLink = makeLink(openStreetMapSearch(provider), "Open in OpenStreetMap ↗", "button button-outline");
    if (osmLink) actions.append(osmLink);
    const website = makeLink(provider.website, "Visit website ↗", "button button-outline");
    if (website) actions.append(website);
    const claim = document.createElement("button");
    claim.type = "button";
    claim.className = "button button-outline";
    claim.textContent = "Claim this listing";
    claim.addEventListener("click", () => {
      window.ShroombergCommunity?.openProviderApplication(provider);
      dismissProfile();
    });
    actions.append(claim);
    card.append(actions);

    const flags = document.createElement("div");
    flags.className = "detail-flags";
    flags.append(tag(clean(provider.addressStatus) || "Location context available", clean(provider.streetAddress) ? "" : "warning"));
    flags.append(tag(clean(provider.websiteStatus) || (safeHttpUrl(provider.website) ? "Website URL recorded" : "No verified website URL"), safeHttpUrl(provider.website) ? "" : "warning"));
    if (provider.isOnlineOnly) flags.append(tag("Online only", "soft"));
    if (provider.businessOperatingVerified) flags.append(tag("Operating status verified", "soft"));
    if (provider.geoPrecision) flags.append(tag("Source precision: " + clean(provider.geoPrecision), "soft"));
    card.append(flags);

    const description = clean(provider.description);
    const services = clean(provider.servicesSummary);
    if (!services || !services.includes(description)) appendDetailSection(card, "About", description);
    appendDetailSection(card, "Services", services);
    const offerings = Array.isArray(provider.offeringCategories) ? provider.offeringCategories : [];
    if (offerings.length) {
      const offeringSection = document.createElement("section");
      offeringSection.className = "detail-section";
      const heading = document.createElement("h3");
      heading.textContent = "Services and products";
      const items = document.createElement("div");
      items.className = "detail-flags";
      const statuses = provider.offeringCategoryStatus && typeof provider.offeringCategoryStatus === "object" ? provider.offeringCategoryStatus : {};
      for (const value of [...new Set(offerings.filter((item) => typeof item === "string" && clean(item)))]) {
        const status = clean(statuses[value]);
        const qualifier = status === "documented" ? "" : status === "category_inferred" ? " · inferred" : " · directory classification";
        items.append(tag(humanize(value) + qualifier, "soft"));
      }
      const note = document.createElement("p");
      note.textContent = "Offerings are based on the directory record. Confirm current services and availability with the provider.";
      offeringSection.append(heading, items, note);
      card.append(offeringSection);
    }
    appendDetailSection(card, "Business information", provider.businessStructureSummary);
    const rawAvailability = provider.availabilityStars ?? provider.availability_stars;
    const availabilityScore = rawAvailability === null || rawAvailability === undefined || rawAvailability === "" ? null : Number(rawAvailability);
    const ratingSection = document.createElement("section");
    ratingSection.className = "detail-section";
    const ratingHeading = document.createElement("h3");
    ratingHeading.textContent = "Availability rating";
    const ratingText = document.createElement("p");
    if (clean(provider.availabilityRatingStatus).toLowerCase() !== "unrated" && Number.isInteger(availabilityScore) && availabilityScore >= 1 && availabilityScore <= 5) {
      ratingText.textContent = `${"★".repeat(availabilityScore)}${"☆".repeat(5 - availabilityScore)}  ${availabilityScore} out of 5`;
      ratingText.setAttribute("aria-label", `Availability: ${availabilityScore} out of 5 stars`);
    } else {
      ratingText.textContent = "Not yet rated";
    }
    const ratingExplanation = document.createElement("p");
    ratingExplanation.textContent = "This directory score reflects recorded legal status and public access. It is not a customer review or proof of current licensing or availability.";
    ratingSection.append(ratingHeading, ratingText, ratingExplanation);
    if (provider.availabilityRatingProvisional === true || clean(provider.availabilityConfidence).toLowerCase() === "low") {
      const note = document.createElement("p");
      note.textContent = "This assessment is provisional or has low confidence; confirm details with the provider.";
      ratingSection.append(note);
    }
    card.append(ratingSection);
    appendDetailSection(card, "Availability", provider.availabilitySummary);
    appendDetailSection(card, "Location context", provider.locationContext);
    appendDetailSection(card, "Research note", provider.researchNote);
    if (clean(provider.phone) || clean(provider.contactEmail) || safeHttpUrl(provider.contactFormUrl)) {
      const phoneSection = document.createElement("div");
      phoneSection.className = "detail-section";
      const heading = document.createElement("h3");
      heading.textContent = "Contact";
      phoneSection.append(heading);
      const phoneValue = clean(provider.phone);
      if (phoneValue) {
        const row = document.createElement("p");
        if (/^\+?[\d() .-]{3,40}$/.test(phoneValue)) {
          const link = document.createElement("a");
          link.href = `tel:${phoneValue.replace(/[^+\d]/g, "")}`;
          link.textContent = phoneValue;
          row.append(link);
        } else row.textContent = phoneValue;
        phoneSection.append(row);
      }
      const email = clean(provider.contactEmail);
      if (/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) {
        const row = document.createElement("p");
        const link = document.createElement("a");
        link.href = `mailto:${encodeURIComponent(email)}`;
        link.textContent = email;
        row.append(link);
        phoneSection.append(row);
      }
      const formLink = makeLink(provider.contactFormUrl, "Contact form");
      if (formLink) phoneSection.append(formLink);
      card.append(phoneSection);
    }

    const sourceSection = document.createElement("div");
    sourceSection.className = "detail-section";
    const sourceHeading = document.createElement("h3");
    sourceHeading.textContent = "Sources";
    const links = document.createElement("div");
    links.className = "detail-links";
    const seen = new Set();
    for (const [key, value] of Object.entries(provider)) {
      if (!/(?:url|uri)$/i.test(key)) continue;
      const normalized = safeHttpUrl(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      links.append(makeLink(normalized, humanize(key)));
    }
    for (const value of Array.isArray(provider.availabilityRatingSources) ? provider.availabilityRatingSources : []) {
      const normalized = safeHttpUrl(value);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      links.append(makeLink(normalized, "Availability assessment source"));
    }
    if (links.childElementCount) sourceSection.append(sourceHeading, links);
    else {
      const empty = document.createElement("p");
      empty.textContent = "No source links are attached to this record.";
      sourceSection.append(sourceHeading, empty);
    }
    card.append(sourceSection);

    const externalRatings = Array.isArray(provider.externalReviewRatings) ? provider.externalReviewRatings : [];
    const validExternalRatings = externalRatings.filter((entry) => entry && typeof entry === "object" && entry.rating !== null && entry.rating !== undefined &&
      Number.isFinite(Number(entry.rating)) && Number.isFinite(Number(entry.max_rating ?? entry.maxRating)) &&
      Number(entry.max_rating ?? entry.maxRating) > 0 && Number(entry.rating) >= 0 &&
      Number(entry.rating) <= Number(entry.max_rating ?? entry.maxRating) && safeHttpUrl(entry.source_url ?? entry.sourceUrl));
    if (validExternalRatings.length) {
      const externalSection = document.createElement("section");
      externalSection.className = "detail-section";
      const heading = document.createElement("h3");
      heading.textContent = "Ratings from other sites";
      externalSection.append(heading);
      for (const entry of validExternalRatings) {
        const row = document.createElement("p");
        const max = Number(entry.max_rating ?? entry.maxRating);
        const count = Number(entry.review_count ?? entry.reviewCount);
        const label = `${clean(entry.platform) || "External source"}: ${Number(entry.rating)} / ${max}${Number.isInteger(count) && count >= 0 ? ` · ${count} reviews` : ""}`;
        const link = makeLink(entry.source_url ?? entry.sourceUrl, label);
        if (link) row.append(link);
        if (clean(entry.scope)) row.append(document.createTextNode(` — ${clean(entry.scope)}`));
        if (clean(entry.observed_at ?? entry.observedAt)) row.append(document.createTextNode(` (recorded ${clean(entry.observed_at ?? entry.observedAt)})`));
        if (clean(entry.note)) row.append(document.createTextNode(`. ${clean(entry.note)}`));
        externalSection.append(row);
      }
      const note = document.createElement("p");
      note.textContent = "These third-party ratings are separate from Shroomberg community reviews.";
      externalSection.append(note);
      card.append(externalSection);
    }

    const reviewSection = document.createElement("section");
    reviewSection.className = "detail-section";
    reviewSection.id = "community-reviews";
    const reviewHeading = document.createElement("h3");
    reviewHeading.textContent = "Community reviews";
    const reviewMessage = document.createElement("p");
    reviewMessage.id = "review-message";
    reviewMessage.className = "map-message";
    reviewMessage.textContent = "Loading reviews…";
    const reviewList = document.createElement("div");
    reviewList.id = "review-list";
    const loginPrompt = document.createElement("p");
    loginPrompt.id = "review-login-required";
    loginPrompt.className = "map-policy";
    loginPrompt.hidden = true;
    loginPrompt.append(document.createTextNode("Sign in to write a review. "));
    const loginLink = document.createElement("a");
    loginLink.href = "#account-panel";
    loginLink.dataset.openPanel = "account-panel";
    loginLink.textContent = "Open account";
    loginPrompt.append(loginLink);
    const reviewForm = document.createElement("form");
    reviewForm.id = "review-form";
    reviewForm.hidden = true;
    const fields = document.createElement("div");
    fields.className = "filter-row";
    const ratingLabel = document.createElement("label");
    ratingLabel.className = "filter-control";
    const ratingCaption = document.createElement("span");
    ratingCaption.textContent = "Rating";
    const rating = document.createElement("select");
    rating.id = "review-rating";
    rating.name = "rating";
    rating.required = true;
    for (let score = 5; score >= 1; score -= 1) {
      const option = new Option(`${score} ${score === 1 ? "star" : "stars"}`, String(score));
      rating.add(option);
    }
    ratingLabel.append(ratingCaption, rating);
    const titleLabel = document.createElement("label");
    titleLabel.className = "filter-control";
    const titleCaption = document.createElement("span");
    titleCaption.textContent = "Title (optional)";
    const reviewTitle = document.createElement("input");
    reviewTitle.className = "search-box";
    reviewTitle.id = "review-title";
    reviewTitle.name = "title";
    reviewTitle.maxLength = 100;
    titleLabel.append(titleCaption, reviewTitle);
    fields.append(ratingLabel, titleLabel);
    const bodyLabel = document.createElement("label");
    bodyLabel.className = "filter-control";
    const bodyCaption = document.createElement("span");
    bodyCaption.textContent = "Your experience";
    const reviewBody = document.createElement("textarea");
    reviewBody.id = "review-body";
    reviewBody.name = "body";
    reviewBody.rows = 4;
    reviewBody.minLength = 20;
    reviewBody.maxLength = 3000;
    reviewBody.required = true;
    bodyLabel.append(bodyCaption, reviewBody);
    const reviewActions = document.createElement("div");
    reviewActions.className = "map-actions";
    const reviewSubmit = document.createElement("button");
    reviewSubmit.type = "submit";
    reviewSubmit.className = "button button-primary";
    reviewSubmit.textContent = "Submit review";
    reviewActions.append(reviewSubmit);
    const reviewStatus = document.createElement("p");
    reviewStatus.id = "review-status";
    reviewStatus.className = "map-message";
    reviewStatus.setAttribute("role", "status");
    reviewStatus.setAttribute("aria-live", "polite");
    reviewForm.append(fields, bodyLabel, reviewActions, reviewStatus);
    const reviewHelp = document.createElement("p");
    reviewHelp.className = "map-policy";
    reviewHelp.textContent = "Reviews are moderated. Describe your experience with the provider; avoid private information and medical advice.";
    reviewSection.append(reviewHeading, reviewMessage, reviewList, loginPrompt, reviewForm, reviewHelp);
    card.append(reviewSection);
    els.detail.replaceChildren(card);
  }

  function providerFromHash() {
    const match = window.location.hash.match(/^#provider\/(.+)$/);
    if (!match) return null;
    let id;
    try { id = decodeURIComponent(match[1]); } catch { id = match[1]; }
    return providers.find((provider) => provider.id === id) || null;
  }

  function handleProviderRoute() {
    const provider = providerFromHash();
    if (provider && provider.id !== selectedId) {
      selectProvider(provider, { navigate: false });
      return;
    }
    if (provider && !els.profileDialog.open) {
      renderDetail(provider);
      window.ShroombergCommunity?.loadReviews(provider);
      els.profileDialog.showModal();
      return;
    }
    if (!provider && selectedId) clearProfile();
  }

  function cacheKey(query, countryCode) { return `shroomberg-osm:${(countryCode || "").toLocaleLowerCase()}:${query.toLocaleLowerCase()}`; }
  function readCache(query, countryCode) {
    try {
      const record = JSON.parse(localStorage.getItem(cacheKey(query, countryCode)) || "null");
      if (record && Date.now() - record.savedAt < CACHE_TTL_MS && Array.isArray(record.results)) return record.results;
    } catch { /* Continue if browser storage is unavailable. */ }
    return null;
  }
  function writeCache(query, countryCode, results) {
    try { localStorage.setItem(cacheKey(query, countryCode), JSON.stringify({ savedAt: Date.now(), results })); }
    catch { /* The map still works when browser storage is full or disabled. */ }
  }

  function fetchGeocode(query, countryCode = "", isCurrent = () => true) {
    const task = geocodeQueue.catch(() => undefined).then(async () => {
      if (!isCurrent()) return { results: [], cached: false, skipped: true };
      const normalizedQuery = clean(query).slice(0, 200);
      if (!normalizedQuery) return { results: [], cached: false };
      const cached = readCache(normalizedQuery, countryCode);
      if (cached) return { results: cached, cached: true };
      const wait = Math.max(0, REQUEST_INTERVAL_MS - (Date.now() - lastGeocodeAt));
      if (wait) await new Promise((resolve) => window.setTimeout(resolve, wait));
      if (!isCurrent()) return { results: [], cached: false, skipped: true };
      const params = new URLSearchParams({ q: normalizedQuery, format: "jsonv2", limit: "5", addressdetails: "1", "accept-language": "en" });
      if (/^[A-Za-z]{2}$/.test(countryCode || "")) params.set("countrycodes", countryCode.toLowerCase());
      lastGeocodeAt = Date.now();
      let response;
      try {
        response = await fetch(NOMINATIM_URL + "?" + params.toString(), {
          headers: { Accept: "application/json" },
          referrerPolicy: "origin",
          cache: "no-store"
        });
      } catch {
        const error = new Error("network");
        error.code = "network";
        throw error;
      }
      if (!response.ok) {
        const error = new Error("service");
        error.status = response.status;
        throw error;
      }
      let results;
      try { results = await response.json(); }
      catch {
        const error = new Error("response");
        error.code = "response";
        throw error;
      }
      if (!Array.isArray(results)) results = [];
      writeCache(normalizedQuery, countryCode, results);
      return { results, cached: false };
    });
    geocodeQueue = task;
    return task;
  }

  function clearDirectoryMarkers() {
    if (searchMarkerLayer) {
      searchMarkerLayer.eachLayer((layer) => fadeRemoveLayer(layer, () => searchMarkerLayer?.removeLayer(layer)));
    }
    searchPins.clear();
  }

  function fadeRemoveLayer(layer, removeLayer) {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      removeLayer?.();
      return;
    }
    if (typeof layer.setStyle === "function") layer.setStyle({ opacity: 0, fillOpacity: 0 });
    if (typeof layer.setOpacity === "function") layer.setOpacity(0);
    layer.getElement?.()?.classList.add("shroomberg-node-leaving");
    window.setTimeout(() => removeLayer?.(), 240);
  }

  function makeSearchLocationGroups(records) {
    const groups = new Map();
    for (const provider of records) {
      const hasStreet = Boolean(clean(provider.streetAddress));
      const query = hasStreet ? mapQuery(provider) : locationText(provider);
      if (!query) continue;
      const countryCode = clean(provider.countryCode);
      const key = `${countryCode.toLocaleLowerCase()}|${query.toLocaleLowerCase()}`;
      if (!groups.has(key)) groups.set(key, { query, countryCode, coarse: !hasStreet, providers: [] });
      groups.get(key).providers.push(provider);
    }
    return [...groups.values()];
  }

  function searchMarkerPopup(point) {
    const popup = document.createElement("div");
    const heading = document.createElement("strong");
    heading.textContent = `${point.providers.length} matching ${point.providers.length === 1 ? "provider" : "providers"}`;
    const precision = document.createElement("p");
    precision.textContent = point.providers.length > 1 && !point.zoneCenter
      ? "Grouped map points; zoom in or choose a provider below. Locations may be approximate."
      : point.zoneCenter
      ? "Approximate service-zone center; this is not a verified provider venue."
      : point.coarse
        ? "Approximate city or region point from OpenStreetMap; not a verified provider venue."
        : "Saved map location; confirm the address and visitor access before visiting.";
    popup.append(heading, precision);
    for (const provider of point.providers) {
      const link = document.createElement("a");
      link.href = `#provider/${encodeURIComponent(provider.id)}`;
      link.textContent = clean(provider.name) || "Unnamed provider";
      link.addEventListener("click", (event) => { event.preventDefault(); selectProvider(provider); });
      popup.append(link, document.createElement("br"));
    }
    const place = document.createElement("p");
    place.textContent = point.displayName;
    popup.append(place);
    return popup;
  }

  function addSearchMarker(providerGroup, result, coarse) {
    const lat = Number(result.lat);
    const lon = Number(result.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !searchMarkerLayer || !window.L) return false;
    const key = `${lat.toFixed(5)},${lon.toFixed(5)}`;
    let point = searchPins.get(key);
    if (!point) {
      point = {
        marker: window.L.marker([lat, lon], { title: "Shroomberg search result", opacity: 0 }).addTo(searchMarkerLayer),
        providers: [],
        providerIds: new Set(),
        coarse: Boolean(coarse),
        displayName: clean(result.display_name) || "OpenStreetMap result"
      };
      searchPins.set(key, point);
      window.requestAnimationFrame(() => {
        point.marker.setOpacity(1);
        point.marker.getElement()?.classList.add("shroomberg-marker-enter");
      });
    }
    point.coarse = point.coarse || Boolean(coarse);
    for (const provider of providerGroup.providers) {
      if (point.providerIds.has(provider.id)) continue;
      point.providerIds.add(provider.id);
      point.providers.push(provider);
    }
    point.marker.bindPopup(searchMarkerPopup(point));
    return true;
  }

  function fitDirectorySearchMarkers() {
    if (!map || !searchMarkerLayer || searchPins.size === 0) return;
    const points = [...searchPins.values()];
    if (points.length === 1) {
      map.setView(points[0].marker.getLatLng(), points[0].coarse ? 8 : 15);
      return;
    }
    const bounds = window.L.featureGroup(points.map((point) => point.marker)).getBounds();
    if (bounds.isValid()) map.fitBounds(bounds, { padding: [24, 24], maxZoom: 14 });
  }

  async function populateDirectorySearchMap(records, totalMatches, generation) {
    const groups = makeSearchLocationGroups(records);
    if (generation !== searchMapGeneration) return;
    if (!groups.length) {
      setMapMessage("These results have no address, city, or region to map.");
      return;
    }

    let completed = 0;
    let mappedProviderCount = 0;
    let failed = 0;
    let lastError = null;
    const isCurrent = () => generation === searchMapGeneration;
    const updateProgress = () => {
      if (!isCurrent()) return;
      const displayed = records.length;
      const paging = totalMatches > displayed ? ` Showing ${displayed} of ${totalMatches} matches; use Show more or filters to map additional results.` : "";
      setMapMessage(`OpenStreetMap mapped ${mappedProviderCount} of ${displayed} displayed search results across ${searchPins.size} map point${searchPins.size === 1 ? "" : "s"}.${paging}`);
    };

    setMapMessage(`Searching OpenStreetMap for ${groups.length} unique result location${groups.length === 1 ? "" : "s"}… Results will appear as locations resolve.`);
    await Promise.all(groups.map(async (group) => {
      if (!isCurrent()) return;
      try {
        let result = (await fetchGeocode(group.query, group.countryCode, isCurrent)).results[0];
        let coarse = group.coarse;
        const fallbackQuery = [clean(group.providers[0]?.city), clean(group.providers[0]?.region), countryLabel(clean(group.providers[0]?.countryCode))].filter(Boolean).join(", ");
        if (!result && !group.coarse && fallbackQuery && fallbackQuery.toLocaleLowerCase() !== group.query.toLocaleLowerCase()) {
          result = (await fetchGeocode(fallbackQuery, group.countryCode, isCurrent)).results[0];
          coarse = true;
        }
        if (!isCurrent()) return;
        const approximate = coarse || coarseResultTypes.has(clean(result?.addresstype).toLocaleLowerCase());
        if (result && addSearchMarker(group, result, approximate)) {
          mappedProviderCount += group.providers.length;
          if (searchPins.size === 1) fitDirectorySearchMarkers();
        }
      } catch (error) {
        failed += 1;
        lastError = error;
      } finally {
        if (isCurrent()) {
          completed += 1;
          updateProgress();
        }
      }
    }));

    if (!isCurrent()) return;
    fitDirectorySearchMarkers();
    updateProgress();
    if (failed) {
      setMapMessage(`${mappedProviderCount} displayed results mapped; ${failed} location lookup${failed === 1 ? "" : "s"} failed. ${friendlyMapError(lastError)}`, true);
    } else if (!mappedProviderCount) {
      setMapMessage("OpenStreetMap found no usable points for these results. Try a city or region search instead.", true);
    }
  }

  function scheduleSearchMapUpdate(records, totalMatches, invalidQuery = false, clearMatches = true, preserveView = false) {
    if (!preserveView) activeMapRecords = records.slice();
    searchMapGeneration += 1;
    const generation = searchMapGeneration;
    if (searchMapTimer) window.clearTimeout(searchMapTimer);
    if (!map || !searchMarkerLayer) return;
    clearDirectoryMarkers();
    if (marker && !preserveView) {
      const oldMarker = marker;
      marker = null;
      fadeRemoveLayer(oldMarker, () => map?.removeLayer(oldMarker));
    }
    if (clearMatches) {
      els.mapMatches.replaceChildren();
      els.mapMatches.hidden = true;
    }
    if (invalidQuery) {
      setMapMessage("Fix the directory search query to show its results on the map.", true);
      return;
    }
    if (!records.length) {
      map.setView([22, 0], 2);
      setMapMessage("No provider records match the current search or filters.");
      return;
    }

    const zones = new Map();
    let unmapped = 0;
    for (const provider of records) {
      const lat = provider.mapLatitude == null || provider.mapLatitude === "" ? NaN : Number(provider.mapLatitude);
      const lon = provider.mapLongitude == null || provider.mapLongitude === "" ? NaN : Number(provider.mapLongitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) {
        unmapped += 1;
        continue;
      }
      const zone = clean(provider.mapZone) || locationText(provider) || "Recorded location";
      const projected = map.project([lat, lon], map.getZoom());
      const cellSize = map.getZoom() >= 16 ? 8 : 55;
      const key = `${Math.floor(projected.x / cellSize)},${Math.floor(projected.y / cellSize)}`;
      if (!zones.has(key)) zones.set(key, { zone, lat, lon, latSum: 0, lonSum: 0, providers: [], coordinates: [] });
      zones.get(key).latSum += lat;
      zones.get(key).lonSum += lon;
      zones.get(key).coordinates.push([lat, lon]);
      zones.get(key).providers.push(provider);
    }

    for (const point of zones.values()) {
      const count = point.providers.length;
      point.lat = point.latSum / count;
      point.lon = point.lonSum / count;
      const radius = Math.max(9, Math.min(23, 8 + Math.log2(count + 1) * 2.2));
      const node = window.L.circleMarker([point.lat, point.lon], {
        radius, color: "#0a4824", weight: 2, opacity: 0.95,
        fillColor: "#7baa61", fillOpacity: 0.85, className: "shroomberg-node"
      }).addTo(searchMarkerLayer);
      const pin = {
        marker: node,
        providers: point.providers,
        providerIds: new Set(point.providers.map((provider) => provider.id)),
        coarse: point.providers.some((provider) => !/^(?:street|address|address_point|building|matched_address|osm_house_number|osm_reverse_house_number_verified_2026|osm_exact_house_number_verified_2026|national_address_point|plus_code_3m|recovered_short_plus_code|operator_published_business_gps|office_building_operator_gps)$/.test(clean(provider.mapPointPrecision || provider.geoPrecision).toLowerCase())),
        zoneCenter: point.providers.every((provider) => clean(provider.mapPrecision) === "approximate_zone_center"),
        displayName: point.zone
      };
      const distinctCoordinates = new Set(point.coordinates.map(([lat, lon]) => `${lat.toFixed(6)},${lon.toFixed(6)}`));
      if (count === 1) {
        node.on("click", () => selectProvider(point.providers[0]));
      } else if (distinctCoordinates.size > 1 && map.getZoom() < map.getMaxZoom()) {
        node.on("click", () => map.setView([point.lat, point.lon], Math.min(map.getZoom() + 2, map.getMaxZoom())));
      } else {
        node.bindPopup(searchMarkerPopup(pin), { maxHeight: 260 });
      }
      node.bindTooltip(String(count), { permanent: true, direction: "center", className: "shroomberg-node-count" });
      searchPins.set(`${point.lat.toFixed(8)},${point.lon.toFixed(8)}:${searchPins.size}`, pin);
    }

    if (!preserveView && searchPins.size) fitDirectorySearchMarkers();
    else if (!preserveView) map.setView([22, 0], 2);
    // Fitting the map can trigger zoomend synchronously and redraw the points.
    // The nested redraw owns the latest count and must not be overwritten.
    if (generation !== searchMapGeneration) return;
    const mapped = records.length - unmapped;
    const prefix = totalMatches === providers.length && records.length === providers.length
      ? `Showing all ${mapped.toLocaleString()} providers`
      : `Showing ${mapped.toLocaleString()} matching provider${mapped === 1 ? "" : "s"}`;
    let message = `${prefix} across ${zones.size.toLocaleString()} mapped location${zones.size === 1 ? "" : "s"}. Location precision varies by record.`;
    if (unmapped) message += ` ${unmapped.toLocaleString()} matching record${unmapped === 1 ? " has" : "s have"} no saved coordinates.`;
    setMapMessage(message, unmapped > 0);
  }

  function friendlyMapError(error) {
    if (error?.status === 429) return "OpenStreetMap is limiting public searches right now. Wait a moment, then try again.";
    if (error?.status >= 500) return "OpenStreetMap search is temporarily unavailable. Try again shortly.";
    if (error?.code === "network") return "Could not reach OpenStreetMap. Check your connection and try again.";
    return "The map search could not be completed. Try again or open the location directly in OpenStreetMap.";
  }

  function showMapResult(result, options = {}) {
    const { provider = null, coarse = false } = options;
    if (!map || !window.L) {
      setMapMessage("The interactive map is unavailable. Open the location directly in OpenStreetMap instead.", true);
      return;
    }
    const lat = Number(result.lat), lon = Number(result.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      setMapMessage("OpenStreetMap returned a result without usable map coordinates. Choose another result.", true);
      return;
    }
    if (marker) {
      const oldMarker = marker;
      marker = null;
      fadeRemoveLayer(oldMarker, () => map?.removeLayer(oldMarker));
    }
    marker = window.L.marker([lat, lon], { opacity: 0 }).addTo(map);
    const activeMarker = marker;
    window.requestAnimationFrame(() => {
      activeMarker.setOpacity(1);
      activeMarker.getElement()?.classList.add("shroomberg-marker-enter");
    });
    const popup = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = clean(provider?.name) || "Map search result";
    const description = document.createElement("span");
    description.textContent = clean(result.display_name);
    popup.append(title, document.createElement("br"), description);
    marker.bindPopup(popup).openPopup();
    const zoom = coarse ? 8 : Number(result.zoom) || 16;
    map.setView([lat, lon], Math.min(zoom, 17));
    const precision = coarse
      ? "City/region-level point; not a verified provider venue."
      : provider
        ? "Saved map point for this record; this does not verify the address or current operating status."
        : "Place selected from OpenStreetMap search; provider records were not changed.";
    setMapMessage(precision);
  }

  function renderGeocodeMatches(results, options = {}) {
    const { provider = null, coarse = false, cached = false, query = "" } = options;
    els.mapMatches.replaceChildren();
    const intro = document.createElement("p");
    intro.className = "map-message";
    intro.textContent = `${results.length} possible map ${results.length === 1 ? "match" : "matches"}${cached ? " (cached)" : ""}. Choose the right result.`;
    els.mapMatches.append(intro);
    for (const result of results.slice(0, 5)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "map-match";
      button.textContent = clean(result.display_name) || "Unnamed OpenStreetMap result";
      const small = document.createElement("small");
      small.textContent = [clean(result.type), clean(result.addresstype), coarse ? "city/region query" : provider ? "source address query" : "place query"].filter(Boolean).join(" · ");
      button.append(small);
      button.addEventListener("click", () => showMapResult(result, { provider, coarse }));
      els.mapMatches.append(button);
    }
    if (query && !provider) {
      const open = makeLink("https://www.openstreetmap.org/search?query=" + encodeURIComponent(query), "Open this search in OpenStreetMap ↗", "map-match");
      if (open) {
        open.target = "_blank";
        open.rel = "noopener noreferrer";
        els.mapMatches.append(open);
      }
    }
    els.mapMatches.hidden = false;
  }

  async function locateProvider(provider) {
    if (!map) {
      setMapMessage("The interactive map is unavailable. Use the OpenStreetMap search link in this profile.", true);
      return;
    }
    const saved = validCoordinatePair(provider.mapLatitude, provider.mapLongitude);
    if (saved) {
      const precision = clean(provider.mapPointPrecision || provider.geoPrecision).toLowerCase();
      const coarse = !/^(?:street|address|address_point|building|matched_address|osm_house_number|osm_reverse_house_number_verified_2026|osm_exact_house_number_verified_2026|national_address_point|plus_code_3m|recovered_short_plus_code|operator_published_business_gps|office_building_operator_gps)$/.test(precision);
      els.mapMatches.hidden = true;
      els.mapMatches.replaceChildren();
      showMapResult({ lat: saved.lat, lon: saved.lon, display_name: mapQuery(provider) || locationText(provider), zoom: coarse ? 8 : 16 }, { provider, coarse });
      return;
    }
    const query = mapQuery(provider);
    if (!query) {
      setMapMessage("This record has no saved address, city, or operating region to search on the map.", true);
      return;
    }
    els.mapMatches.hidden = true;
    els.mapMatches.replaceChildren();
    setMapMessage("Searching OpenStreetMap for the saved address or region…");
    try {
      let { results, cached } = await fetchGeocode(query, provider.countryCode);
      const fallbackQuery = [clean(provider.city), clean(provider.region), countryLabel(clean(provider.countryCode))].filter(Boolean).join(", ");
      let coarse = !clean(provider.streetAddress);
      if (!results.length && clean(provider.streetAddress) && fallbackQuery && fallbackQuery !== query) {
        const fallback = await fetchGeocode(fallbackQuery, provider.countryCode);
        results = fallback.results;
        cached = cached && fallback.cached;
        coarse = true;
      }
      if (!results.length) {
        setMapMessage("No OpenStreetMap match was found for this record. Try a broader city or region search.", true);
        return;
      }
      if (coarse) setMapMessage("The exact address did not match. Choose a city or region result; it will be marked approximate.");
      else setMapMessage("Choose the OpenStreetMap result that best matches the saved address.");
      renderGeocodeMatches(results, { provider, coarse, cached });
    } catch (error) {
      setMapMessage(friendlyMapError(error), true);
    }
  }

  function renderProviderMapMatches(matches, query) {
    els.mapMatches.replaceChildren();
    const intro = document.createElement("p");
    intro.className = "map-message";
    intro.textContent = matches.length
      ? `${matches.length.toLocaleString()} provider ${matches.length === 1 ? "record matches" : "records match"}. Select a profile.`
      : "No provider profiles match. Try a broader search or search this term as a place.";
    els.mapMatches.append(intro);
    for (const provider of matches.slice(0, MAP_RESULT_LIMIT)) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "map-match";
      button.textContent = clean(provider.name) || "Unnamed provider";
      const small = document.createElement("small");
      small.textContent = [categoryLabel(provider.category), locationText(provider) || "Location not recorded"].filter(Boolean).join(" · ");
      button.append(small);
      button.addEventListener("click", () => {
        selectProvider(provider, { navigate: true });
      });
      els.mapMatches.append(button);
    }
    const parsed = parseQuery(query);
    const isStructured = parsed.tokens.some((token) => token.kind !== "text");
    if (query && !isStructured) {
      const place = document.createElement("button");
      place.type = "button";
      place.className = "map-match";
      place.textContent = `Search “${query}” as a place in OpenStreetMap`;
      const small = document.createElement("small");
      small.textContent = "One lookup; results are not added to the provider data.";
      place.append(small);
      place.addEventListener("click", () => searchPlaceOnMap(query));
      els.mapMatches.append(place);
    }
    if (matches.length > MAP_RESULT_LIMIT) {
      const more = document.createElement("p");
      more.className = "map-message";
      more.textContent = `Showing the first ${MAP_RESULT_LIMIT} matches. Add search terms to narrow the results.`;
      els.mapMatches.append(more);
    }
    els.mapMatches.hidden = false;
  }

  async function searchPlaceOnMap(query) {
    if (!map) {
      setMapMessage("The interactive map is unavailable. Try the OpenStreetMap search link in a provider profile.", true);
      return;
    }
    els.mapMatches.hidden = true;
    els.mapMatches.replaceChildren();
    setMapMessage("Searching OpenStreetMap for that place…");
    try {
      const { results, cached } = await fetchGeocode(query);
      if (!results.length) {
        setMapMessage("No place was found. Try a city with its region or country, or search provider records.", true);
        return;
      }
      renderGeocodeMatches(results, { cached, query });
      setMapMessage("Choose the matching place to show it on the map.");
    } catch (error) {
      setMapMessage(friendlyMapError(error), true);
    }
  }

  async function searchMap(query) {
    const value = clean(query);
    if (!value) {
      setMapMessage("Enter a provider, address, city, or region to search the map.", true);
      els.mapSearch.focus();
      return;
    }
    const parsed = parseQuery(value);
    if (parsed.error) {
      setMapMessage(`Search format needs a tweak: ${parsed.error}`, true);
      return;
    }
    if (providers.length) {
      const matches = filtered.filter((provider) => matchesQuery(provider, parsed.tokens));
      if (matches.length) {
        renderProviderMapMatches(matches, value);
        scheduleSearchMapUpdate(matches, matches.length, false, false);
        return;
      }
      if (parsed.tokens.some((token) => token.kind !== "text")) {
        els.mapMatches.hidden = true;
        els.mapMatches.replaceChildren();
        setMapMessage("No provider records match those map filters. Try a broader query or clear a filter.", true);
        return;
      }
    }
    await searchPlaceOnMap(value);
  }

  function clearFilters() {
    resetProviderTypeFilters();
    els.search.value = "";
    els.category.value = "";
    els.country.value = "";
    updateRegionOptions();
    els.region.value = "";
    els.status.value = "";
    renderList();
  }

  function resetMap() {
    els.mapSearch.value = "";
    if (marker && map) {
      const oldMarker = marker;
      fadeRemoveLayer(oldMarker, () => map?.removeLayer(oldMarker));
    }
    marker = null;
    renderList();
  }

  function showDataError() {
    filtered = [];
    els.mapMatches.replaceChildren();
    const message = document.createElement("p");
    message.className = "map-message error";
    message.textContent = "Provider records could not be loaded. Check your connection, then retry.";
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "button button-outline";
    retry.textContent = "Retry loading data";
    retry.addEventListener("click", loadDirectory);
    els.mapMatches.append(message, retry);
    els.mapMatches.hidden = false;
    setMapMessage("Provider data is unavailable, so the provider nodes cannot be displayed. Try again to reload the directory.", true);
  }

  function validCoordinatePair(latitude, longitude) {
    if (latitude === null || latitude === undefined || latitude === "" ||
        longitude === null || longitude === undefined || longitude === "") return null;
    const lat = Number(latitude), lon = Number(longitude);
    return Number.isFinite(lat) && Number.isFinite(lon) && lat >= -90 && lat <= 90 && lon >= -180 && lon <= 180
      ? { lat, lon } : null;
  }

  function normalizeProvider(record) {
    const normalized = { ...record };
    for (const [key, value] of Object.entries(record)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase());
      if (!(camelKey in normalized)) normalized[camelKey] = value;
    }
    const main = validCoordinatePair(normalized.mapLatitude ?? normalized.latitude, normalized.mapLongitude ?? normalized.longitude);
    const address = validCoordinatePair(normalized.addressLatitude, normalized.addressLongitude);
    const country = clean(normalized.countryCode).toUpperCase();
    const addressCountry = clean(normalized.addressCountryCode).toUpperCase();
    const precision = clean(normalized.addressGeocodePrecision).toLowerCase();
    const detailedAddress = /^(?:osm_reverse_house_number_verified_2026|osm_exact_house_number_verified_2026|osm_house_number|address_point|matched_address|building|national_address_point|operator_published_business_gps|office_building_operator_gps|plus_code_3m|recovered_short_plus_code)$/.test(precision);
    const addressCountryMatches = Boolean(country && addressCountry && country === addressCountry);
    const chosen = address && addressCountryMatches && (detailedAddress || !main) ? address : main;
    if (chosen) {
      normalized.mapLatitude = chosen.lat;
      normalized.mapLongitude = chosen.lon;
      normalized.mapPointPrecision = chosen === address ? precision : clean(normalized.geoPrecision || normalized.mapPrecision);
    } else {
      normalized.mapLatitude = null;
      normalized.mapLongitude = null;
      normalized.mapPointPrecision = "";
    }
    return normalized;
  }

  async function loadDirectory() {
    setSearchFeedback("");
    let stage = "requesting providers.json";
    try {
      const response = await fetch(DATA_URL, { cache: "no-cache" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      stage = "reading providers.json";
      const payload = await response.json();
      const records = Array.isArray(payload) ? payload : payload.records;
      if (!Array.isArray(records) || records.length === 0) throw new Error("No provider records found");
      stage = "preparing provider records";
      providers = records.filter((record) => record && typeof record === "object" && !Array.isArray(record)).map(normalizeProvider);
      if (!providers.length) throw new Error("No usable provider records found");
      setStats(providers);
      const asOf = $("#data-as-of");
      if (asOf) asOf.textContent = formatSnapshotDate(payload.asOf);
      stage = "preparing filters";
      populateFilters();
      updateProviderTypeCounts();
      stage = "rendering the map";
      renderList();
      stage = "opening the selected profile";
      handleProviderRoute();
      stage = "searching the map";
      if (els.mapSearch.value) await searchMap(els.mapSearch.value);
    } catch (error) {
      console.error(`Shroomberg error while ${stage}:`, error);
      if (providers.length) {
        setMapMessage(`Provider records loaded, but a problem occurred while ${stage}. Please retry.`, true);
      } else {
        showDataError();
        setMapMessage(`Provider records could not load while ${stage}. Please retry.`, true);
      }
    }
  }

  function bindControls() {
    els.search.addEventListener("input", renderList);
    for (const control of [els.category, els.country, els.region, els.status]) {
      control.addEventListener("change", () => {
        if (control === els.category) includeCategoryProviderType(els.category.value);
        if (control === els.country) updateRegionOptions();
        renderList();
      });
    }
    els.searchToggle.addEventListener("click", () => setSearchPanelOpen(els.searchToggle.getAttribute("aria-expanded") !== "true"));
    for (const input of document.querySelectorAll("[data-provider-type]")) {
      input.addEventListener("change", renderList);
    }
    els.clear.addEventListener("click", clearFilters);
    els.mapSearchForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      if (mapSearchBusy) return;
      mapSearchBusy = true;
      els.mapSearchButton.disabled = true;
      try { await searchMap(els.mapSearch.value); }
      finally { mapSearchBusy = false; els.mapSearchButton.disabled = false; }
    });
    els.resetMap.addEventListener("click", resetMap);
    els.closeProfile.addEventListener("click", dismissProfile);
    els.profileDialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      dismissProfile();
    });
    els.profileDialog.addEventListener("click", (event) => {
      if (event.target === els.profileDialog) dismissProfile();
    });
    window.addEventListener("hashchange", handleProviderRoute);
    window.addEventListener("popstate", handleProviderRoute);
    document.addEventListener("keydown", (event) => {
      if (event.key === "/" && !["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName)) {
        event.preventDefault();
        els.search.focus();
      }
      if (event.key === "Escape" && document.activeElement === els.search) {
        els.search.value = "";
        renderList();
      }
      if (event.key === "Escape" && document.activeElement === els.mapSearch) {
        els.mapSearch.value = "";
        resetMap();
      }
    });
  }

  function start() {
    const splash = $(".brand-splash");
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) splash?.remove();
    else window.setTimeout(() => splash?.remove(), 1950);
    const searchHelp = $("#search-help");
    if (searchHelp) {
      const scoreExample = document.createElement("code");
      scoreExample.textContent = "stars:>=4";
      searchHelp.append(document.createTextNode(" Filter availability ratings with "), scoreExample, document.createTextNode("."));
    }
    const mapPolicy = els.mapMessage?.nextElementSibling;
    if (mapPolicy?.classList.contains("map-policy")) {
      const policyLink = mapPolicy.querySelector("a");
      if (policyLink) mapPolicy.replaceChildren(
        document.createTextNode("Markers use saved address, city, or region coordinates. Precision varies, and a map point does not verify a provider's location. Map tiles and place searches use OpenStreetMap. "),
        policyLink,
        document.createTextNode(".")
      );
    }
    initMap();
    bindControls();
    const params = new URLSearchParams(window.location.search);
    if (params.has("q")) {
      els.search.value = params.get("q") || "";
    }
    if (params.has("map")) {
      els.mapSearch.value = params.get("map") || "";
    }
    loadDirectory();
  }

  start();
})();





