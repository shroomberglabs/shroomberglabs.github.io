(() => {
  "use strict";

  const $ = (selector, root = document) => root.querySelector(selector);
  const clean = (value) => String(value ?? "").trim();
  const pages = [...document.querySelectorAll(".site-page")];
  const mapPage = $("#map-page");
  const navLinks = [...document.querySelectorAll(".header-link[data-open-panel]")];
  const swipeDirections = ["left", "right"];
  const faqCloseTimers = new WeakMap();
  const config = window.SHROOMBERG_WORKER_CONFIG;
  const SESSION_KEY = "shroomberg.session.v1";
  let workerOrigin = "";
  let authSession = null;
  let refreshInFlight = null;
  let passwordRecovery = false;
  let authReady = false;
  try {
    if (config?.apiUrl?.trim()) {
      const workerUrl = new URL(config.apiUrl.trim());
      const isLocalWorker = ["localhost", "127.0.0.1", "[::1]"].includes(workerUrl.hostname);
      if ((workerUrl.protocol === "https:" || (workerUrl.protocol === "http:" && isLocalWorker)) &&
          workerUrl.pathname === "/" && !workerUrl.search && !workerUrl.hash && !workerUrl.username && !workerUrl.password) {
        workerOrigin = workerUrl.origin;
      }
    }
  } catch {
    // Public directory browsing remains available until the Worker URL is configured.
  }

  function storedSession() {
    try {
      const value = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null");
      if (value && typeof value.access_token === "string" && typeof value.refresh_token === "string") return value;
    } catch { /* Ignore unavailable or malformed tab storage. */ }
    return null;
  }

  function saveSession(session) {
    if (!session?.access_token || !session?.refresh_token) {
      authSession = null;
      try { sessionStorage.removeItem(SESSION_KEY); } catch { /* Storage may be disabled. */ }
      return;
    }
    authSession = {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_at: Number(session.expires_at) || Math.floor(Date.now() / 1000) + (Number(session.expires_in) || 3600)
    };
    try { sessionStorage.setItem(SESSION_KEY, JSON.stringify(authSession)); } catch { /* Keep the session in memory for this page. */ }
  }

  function apiError(status, code) {
    const error = new Error(code || "request_failed");
    error.status = status;
    error.code = code || "request_failed";
    return error;
  }

  async function refreshAuthSession() {
    if (!authSession?.refresh_token) throw apiError(401, "authentication_required");
    if (refreshInFlight) return refreshInFlight;
    refreshInFlight = (async () => {
      try {
        const response = await fetch(`${workerOrigin}/api/auth/refresh`, {
          method: "POST", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ refreshToken: authSession.refresh_token })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || !payload.session?.access_token) throw apiError(response.status, payload.error);
        saveSession(payload.session);
        return authSession;
      } catch (error) {
        saveSession(null);
        currentUser = null;
        updateAuthUI();
        throw error;
      } finally {
        refreshInFlight = null;
      }
    })();
    return refreshInFlight;
  }

  async function apiRequest(path, { method = "GET", body, authenticated = true, retryAuth = true } = {}) {
    if (!workerOrigin) throw apiError(503, "worker_not_configured");
    if (authenticated && authSession && authSession.expires_at <= Math.floor(Date.now() / 1000) + 45 && path !== "/api/auth/refresh") {
      await refreshAuthSession();
    }
    const headers = new Headers({ Accept: "application/json" });
    if (body !== undefined) headers.set("Content-Type", "application/json");
    if (authenticated && authSession?.access_token) headers.set("Authorization", `Bearer ${authSession.access_token}`);
    let response;
    try {
      response = await fetch(`${workerOrigin}${path}`, {
        method, mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      });
    } catch {
      throw apiError(0, "network_error");
    }
    const payload = await response.json().catch(() => ({}));
    if (response.status === 401 && authenticated && retryAuth && authSession?.refresh_token && path !== "/api/auth/refresh") {
      await refreshAuthSession();
      return apiRequest(path, { method, body, authenticated, retryAuth: false });
    }
    if (!response.ok) throw apiError(response.status, payload.error);
    return payload;
  }

  let currentUser = null;
  let currentDisclaimer = null;
  let selectedProvider = null;
  let reviewProviderId = null;
  let currentOwnReview = null;
  let reviewLoadNumber = 0;
  let authMode = "signin";
  let authBusy = false;
  let providerBusy = false;
  let supportBusy = false;
  let reviewBusy = false;
  let activePage = pages.find((page) => !page.hidden) || mapPage;
  let panelSwipeIndex = 0;
  let panelTransitionId = 0;

  function setStatus(element, message, isError = false) {
    if (!element) return;
    element.textContent = message;
    element.classList.toggle("error", Boolean(isError));
  }

  function setVisible(element, visible) {
    if (!element) return;
    element.getAnimations().forEach((animation) => animation.cancel());
    if (visible) {
      const wasHidden = element.hidden;
      element.hidden = false;
      if (wasHidden && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        element.animate(
          [{ opacity: 0, transform: "translateY(8px)" }, { opacity: 1, transform: "translateY(0)" }],
          { duration: 220, easing: "cubic-bezier(.2,.7,.2,1)" }
        );
      }
      return;
    }
    if (element.hidden) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      element.hidden = true;
      return;
    }
    const animation = element.animate(
      [{ opacity: 1, transform: "translateY(0)" }, { opacity: 0, transform: "translateY(6px)" }],
      { duration: 170, easing: "ease-in" }
    );
    animation.onfinish = () => { element.hidden = true; };
  }

  function panelOffset(direction, panel) {
    const distance = panel?.getBoundingClientRect().width || window.innerWidth;
    return { x: direction === "left" ? -distance : distance, y: 0 };
  }

  function panelFrames(from, to) {
    const transform = ({ x, y }) => `translate3d(${x}px, ${y}px, 0)`;
    return [
      { transform: transform(from) },
      { transform: transform(to) }
    ];
  }

  function stopPageAnimations() {
    for (const page of pages) {
      page.getAnimations().forEach((animation) => animation.cancel());
      page.style.zIndex = "";
    }
  }

  function hidePage(page) {
    page.hidden = true;
    page.inert = true;
  }

  function updatePageNavigation(page) {
    const activeRouteId = page?.id === "provider-panel" ? "account-panel" : page?.id;
    for (const link of navLinks) {
      const authModeMatches = !link.dataset.authMode ||
        (activeRouteId === "account-panel" && link.dataset.authMode === authMode);
      if (link.dataset.openPanel === activeRouteId && authModeMatches) link.setAttribute("aria-current", "page");
      else link.removeAttribute("aria-current");
    }
  }

  function transitionPage(target) {
    if (!target) return;
    if (target === activePage && !target.hidden && !target.inert) {
      updatePageNavigation(target);
      return;
    }
    const previous = activePage;
    const transitionId = ++panelTransitionId;
    stopPageAnimations();
    for (const page of pages) {
      if (page !== previous && page !== target) hidePage(page);
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) {
      if (previous && previous !== target) hidePage(previous);
      target.hidden = false;
      target.inert = false;
      activePage = target;
      updatePageNavigation(target);
      return;
    }

    const direction = swipeDirections[panelSwipeIndex++ % swipeDirections.length];
    const outgoingOffset = panelOffset(direction, previous || target);
    const incomingOffset = { x: -outgoingOffset.x, y: -outgoingOffset.y };
    target.hidden = false;
    target.inert = false;
    activePage = target;
    updatePageNavigation(target);
    target.style.zIndex = previous && previous !== target ? "1" : "2";

    if (previous && previous !== target && !previous.hidden) {
      previous.inert = true;
      previous.style.zIndex = "2";
      const exit = previous.animate(
        panelFrames({ x: 0, y: 0 }, outgoingOffset),
        { duration: 380, easing: "cubic-bezier(.22,.61,.36,1)" }
      );
      exit.onfinish = () => {
        if (transitionId === panelTransitionId && activePage === target) {
          hidePage(previous);
          previous.style.zIndex = "";
          target.style.zIndex = "";
        }
      };
    }

    const entrance = target.animate(
      panelFrames(incomingOffset, { x: 0, y: 0 }),
      { duration: 380, easing: "cubic-bezier(.22,.61,.36,1)" }
    );
    entrance.onfinish = () => {
      if (transitionId === panelTransitionId && activePage === target) target.style.zIndex = "";
    };
  }

  function closePanel() {
    if (!mapPage) return;
    transitionPage(mapPage);
    mapPage.scrollIntoView({ behavior: "smooth", block: "start" });
    mapPage.focus({ preventScroll: true });
  }

  function openPanel(id) {
    const target = document.getElementById(id);
    const page = target?.closest(".site-page");
    if (!target || !page) return;
    transitionPage(page);
    page.scrollIntoView({ behavior: "smooth", block: "start" });
    page.focus({ preventScroll: true });
    if (id === "account-panel" && !currentUser) window.setTimeout(() => $("#account-email-input")?.focus(), 0);
    if (id === "provider-panel" && currentUser) loadProviderApplications();
    if (id === "support-panel" && currentUser) loadSupportHistory();
  }

  document.addEventListener("click", (event) => {
    const faqQuestion = event.target.closest(".faq-question");
    if (faqQuestion) {
      event.preventDefault();
      const answer = document.getElementById(faqQuestion.getAttribute("aria-controls"));
      const item = faqQuestion.closest(".faq-item");
      if (!answer || !item) return;
      const priorTimer = faqCloseTimers.get(answer);
      if (priorTimer) window.clearTimeout(priorTimer);
      const open = faqQuestion.getAttribute("aria-expanded") !== "true";
      faqQuestion.setAttribute("aria-expanded", String(open));
      const sign = faqQuestion.querySelector("span");
      if (sign) sign.textContent = "+";
      if (open) {
        item.classList.remove("is-closing");
        answer.hidden = false;
      } else {
        item.classList.add("is-closing");
        const timer = window.setTimeout(() => {
          if (faqQuestion.getAttribute("aria-expanded") === "false") answer.hidden = true;
          item.classList.remove("is-closing");
          faqCloseTimers.delete(answer);
        }, window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 180);
        faqCloseTimers.set(answer, timer);
      }
      return;
    }
    const closeButton = event.target.closest("[data-close-panel]");
    if (closeButton) {
      const page = closeButton.closest(".site-page");
      if (page && page !== mapPage) closePanel();
      return;
    }
    const opener = event.target.closest("[data-open-panel]");
    if (opener) {
      event.preventDefault();
      if (opener.dataset.authMode) setAccountMode(opener.dataset.authMode);
      openPanel(opener.dataset.openPanel);
    }
  });

  function setAccountMode(mode) {
    authMode = mode === "signup" ? "signup" : "signin";
    const heading = $("#account-heading");
    const submit = $("#account-submit");
    const toggle = $("#account-mode-toggle");
    const password = $("#account-password-input");
    if (heading) heading.textContent = authMode === "signup" ? "Join the community" : "Sign in to Shroomberg";
    passwordRecovery = false;
    setVisible($("#account-form"), true);
    setVisible($("#password-update-form"), false);
    if (submit) submit.textContent = authMode === "signup" ? "Create account" : "Sign in";
    if (toggle) toggle.textContent = authMode === "signup" ? "I already have an account" : "Create an account";
    if (password) password.autocomplete = authMode === "signup" ? "new-password" : "current-password";
    setStatus($("#account-status"), "");
  }

  function updateAuthUI() {
    const signedIn = Boolean(currentUser) && !passwordRecovery;
    setVisible($("#account-signed-out"), !signedIn);
    setVisible($("#account-signed-in"), signedIn);
    $("#account-email").textContent = currentUser?.email || "your account";
    setVisible($("#provider-login-required"), !signedIn);
    setVisible($("#provider-form"), signedIn);
    setVisible($("#support-login-required"), !signedIn);
    setVisible($("#support-form"), signedIn);
    $("#provider-submit").disabled = !signedIn || !currentDisclaimer;
    $("#provider-application-history").textContent = signedIn ? "Loading your applications…" : "Sign in to view your submissions.";
    $("#support-history").textContent = signedIn ? "Loading your requests…" : "Sign in to view your requests.";
    if (signedIn) {
      loadProviderApplications();
      loadSupportHistory();
    }
    if (selectedProvider) loadReviews(selectedProvider);
  }

  function redirectUrl() {
    return window.location.origin + window.location.pathname;
  }

  async function submitAccount(event) {
    event.preventDefault();
    if (!workerOrigin || !authReady || authBusy) return;
    const form = event.currentTarget;
    if (!form.reportValidity()) return;
    authBusy = true;
    $("#account-submit").disabled = true;
    setStatus($("#account-status"), authMode === "signup" ? "Creating your account…" : "Signing in…");
    const email = clean($("#account-email-input").value).toLowerCase();
    const password = $("#account-password-input").value;
    try {
      if (authMode === "signup") {
        const result = await apiRequest("/api/auth/signup", {
          method: "POST", authenticated: false,
          body: { email, password, redirectTo: redirectUrl() }
        });
        if (result.session) {
          saveSession(result.session);
          currentUser = result.user;
          updateAuthUI();
          setStatus($("#account-status"), "Account created. You are signed in.");
        } else {
          setAccountMode("signin");
          setStatus($("#account-status"), "Account request received. Check your email to confirm it, then sign in here.");
        }
      } else {
        const result = await apiRequest("/api/auth/login", {
          method: "POST", authenticated: false, body: { email, password }
        });
        saveSession(result.session);
        currentUser = result.user;
        updateAuthUI();
        setStatus($("#account-status"), "You are signed in.");
      }
    } catch (error) {
      const tooMany = error?.status === 429 || error?.code === "rate_limited";
      setStatus($("#account-status"), tooMany
        ? "There have been too many attempts. Wait a little and try again."
        : authMode === "signup"
          ? "We couldn't create the account. Check the email and password, then try again."
          : "We couldn't sign you in. Check your email and password, then try again.", true);
    } finally {
      authBusy = false;
      $("#account-submit").disabled = false;
    }
  }

  async function resetPassword() {
    if (!workerOrigin || !authReady) return;
    const email = clean($("#account-email-input").value).toLowerCase();
    if (!email) {
      $("#account-email-input").focus();
      $("#account-email-input").reportValidity();
      setStatus($("#account-status"), "Enter your account email first.", true);
      return;
    }
    try {
      await apiRequest("/api/auth/password-reset", {
        method: "POST", authenticated: false, body: { email, redirectTo: redirectUrl() }
      });
      setStatus($("#account-status"), "If an account uses that address, a password reset email is on its way.");
    } catch {
      setStatus($("#account-status"), "We couldn't send a reset email. Check your connection and try again.", true);
    }
  }

  async function updatePassword(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!workerOrigin || !authReady || authBusy || !form.reportValidity()) return;
    authBusy = true;
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    setStatus($("#password-update-status"), "Updating your password…");
    try {
      await apiRequest("/api/auth/update-password", {
        method: "POST", body: { password: $("#new-password-input").value }
      });
      passwordRecovery = false;
      form.reset();
      saveSession(null);
      currentUser = null;
      setVisible(form, false);
      setVisible($("#account-form"), true);
      setAccountMode("signin");
      updateAuthUI();
      setStatus($("#account-status"), "Password updated. Sign in with your new password.");
    } catch {
      setStatus($("#password-update-status"), "We couldn't update the password. Use a current reset link and try again.", true);
    } finally {
      authBusy = false;
      button.disabled = false;
    }
  }

  async function signOut() {
    if (!workerOrigin) return;
    try {
      if (authSession?.access_token) await apiRequest("/api/auth/logout", { method: "POST", body: {} });
    } catch {
      // Clear local credentials even when the remote session cannot be reached.
    }
    saveSession(null);
    currentUser = null;
    updateAuthUI();
    openPanel("account-panel");
    setStatus($("#account-status"), "You are signed out.");
  }

  async function loadDisclaimer() {
    if (!workerOrigin) return;
    try {
      const result = await apiRequest("/api/disclaimer", { authenticated: false });
      if (!result.disclaimer) throw new Error("unavailable");
      currentDisclaimer = result.disclaimer;
      $("#disclaimer-title").textContent = result.disclaimer.title;
      $("#disclaimer-body").textContent = result.disclaimer.body;
      $("#disclaimer-version").textContent = `Version ${result.disclaimer.version}. The signed application records this exact wording and a server timestamp.`;
      $("#provider-submit").disabled = !currentUser;
    } catch {
      currentDisclaimer = null;
      $("#disclaimer-title").textContent = "Disclaimer unavailable";
      $("#disclaimer-body").textContent = "The current provider disclaimer could not be loaded. Applications are temporarily unavailable; try again later.";
      $("#disclaimer-version").textContent = "";
      $("#provider-submit").disabled = true;
    }
  }

  function openProviderApplication(provider = null) {
    const target = $("#provider-target-id");
    const claimContext = $("#provider-claim-context");
    if (provider) {
      target.value = clean(provider.id);
      $("#provider-name").value = clean(provider.name);
      $("#provider-type").value = clean(provider.category);
      $("#provider-country").value = clean(provider.countryCode).toUpperCase();
      $("#provider-region").value = clean(provider.region);
      $("#provider-city").value = clean(provider.city);
      $("#provider-street").value = clean(provider.streetAddress);
      $("#provider-postal").value = clean(provider.postalCode);
      $("#provider-website").value = clean(provider.website);
      claimContext.textContent = `You are applying to claim “${clean(provider.name)}.” The existing directory record will not change until the application is reviewed and the source workbook is updated.`;
    } else {
      target.value = "";
      claimContext.textContent = "To claim an existing directory entry, open its profile and choose “Claim this listing.”";
    }
    if (currentUser && !clean($("#provider-contact-email").value)) {
      $("#provider-contact-email").value = currentUser.email || "";
    }
    openPanel("account-panel");
    if (currentUser) $("#account-signed-in [data-open-panel='provider-panel']")?.focus({ preventScroll: true });
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "Date not available" : date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  async function loadProviderApplications() {
    const output = $("#provider-application-history");
    if (!workerOrigin || !currentUser) return;
    const userId = currentUser.id;
    output.textContent = "Loading your applications…";
    let data;
    try {
      ({ applications: data } = await apiRequest("/api/applications"));
    } catch {
      if (!currentUser || currentUser.id !== userId) return;
      output.textContent = "Your application history is temporarily unavailable.";
      return;
    }
    if (!currentUser || currentUser.id !== userId) return;
    if (!data?.length) {
      output.textContent = "No applications submitted yet.";
      return;
    }
    const list = document.createElement("div");
    for (const application of data) {
      const row = document.createElement("p");
      row.textContent = `${application.provider_name} · ${application.status.replaceAll("_", " ")} · ${formatDate(application.created_at)}`;
      list.append(row);
    }
    output.replaceChildren(list);
  }

  async function submitProviderApplication(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!workerOrigin || !currentUser || providerBusy || !form.reportValidity()) return;
    if (!currentDisclaimer) {
      setStatus($("#provider-status"), "The current disclaimer is unavailable. Try again later.", true);
      return;
    }
    providerBusy = true;
    const button = $("#provider-submit");
    button.disabled = true;
    button.textContent = "Sending application…";
    setStatus($("#provider-status"), "Submitting your signed application…");
    const value = (id) => clean($(id).value) || null;
    try {
      const result = await apiRequest("/api/applications", {
        method: "POST",
        body: {
          targetProviderId: value("#provider-target-id"),
          providerName: value("#provider-name"),
          providerType: value("#provider-type"),
          website: value("#provider-website"),
          contactEmail: value("#provider-contact-email"),
          phone: value("#provider-phone"),
          countryCode: value("#provider-country").toUpperCase(),
          operatingRegion: value("#provider-region"),
          city: value("#provider-city"),
          streetAddress: value("#provider-street"),
          postalCode: value("#provider-postal"),
          serviceArea: value("#provider-service-area"),
          servicesDescription: value("#provider-description"),
          licenseInformation: value("#provider-license"),
          authorizationConfirmed: $("#provider-authorized").checked,
          signatureName: value("#provider-signature"),
          signatureConsent: $("#provider-signature-consent").checked,
          disclaimerVersion: currentDisclaimer.version
        }
      });
      form.reset();
      $("#provider-target-id").value = "";
      $("#provider-claim-context").textContent = "To claim an existing directory entry, open its profile and choose “Claim this listing.”";
      $("#provider-contact-email").value = currentUser.email || "";
      setStatus($("#provider-status"), `Application received${result.id ? ` (reference ${String(result.id).slice(0, 8)})` : ""}. It is private and pending review.`);
      await loadProviderApplications();
    } catch (error) {
      if (error?.code === "disclaimer_version_unavailable") {
        currentDisclaimer = null;
        await loadDisclaimer();
        setStatus($("#provider-status"), "The disclaimer changed while you were completing the form. Review the updated text and submit again.", true);
      } else if (error?.status === 429 || error?.code === "rate_limited") {
        setStatus($("#provider-status"), "For security, only a few applications can be submitted per hour. Try again later.", true);
      } else {
        setStatus($("#provider-status"), "We couldn't send the application. Check the required fields and try again.", true);
      }
    } finally {
      providerBusy = false;
      button.disabled = !currentUser || !currentDisclaimer;
      button.textContent = "Submit signed application";
    }
  }

  async function loadSupportHistory() {
    const output = $("#support-history");
    if (!workerOrigin || !currentUser) return;
    const userId = currentUser.id;
    output.textContent = "Loading your requests…";
    let data;
    try {
      ({ requests: data } = await apiRequest("/api/support"));
    } catch {
      if (!currentUser || currentUser.id !== userId) return;
      output.textContent = "Your support history is temporarily unavailable.";
      return;
    }
    if (!currentUser || currentUser.id !== userId) return;
    if (!data?.length) {
      output.textContent = "No support requests submitted yet.";
      return;
    }
    const list = document.createElement("div");
    for (const request of data) {
      const row = document.createElement("p");
      row.textContent = `${request.subject} · ${request.status.replaceAll("_", " ")} · ${formatDate(request.created_at)}`;
      list.append(row);
    }
    output.replaceChildren(list);
  }

  async function submitSupportRequest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!workerOrigin || !currentUser || supportBusy || !form.reportValidity()) return;
    supportBusy = true;
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    setStatus($("#support-status"), "Sending your request…");
    try {
      await apiRequest("/api/support", {
        method: "POST",
        body: {
          requestType: $("#support-type").value,
          subject: clean($("#support-subject").value),
          message: clean($("#support-message").value)
        }
      });
      form.reset();
      setStatus($("#support-status"), "Your support request has been received. You can review its status here.");
      await loadSupportHistory();
    } catch (error) {
      const rateLimited = error?.status === 429 || error?.code === "rate_limited";
      setStatus($("#support-status"), rateLimited
        ? "For security, only a few support requests can be sent per hour. Try again later."
        : "We couldn't send the request. Check the required fields and try again.", true);
    } finally {
      supportBusy = false;
      button.disabled = false;
    }
  }

  function reviewCard(review, owned = false) {
    const card = document.createElement("article");
    card.className = "detail-location";
    const title = document.createElement("strong");
    title.textContent = clean(review.title) || (owned ? "Your review" : "Community review");
    const meta = document.createElement("p");
    const stars = "★".repeat(Number(review.rating)) + "☆".repeat(5 - Number(review.rating));
    meta.textContent = `${stars} · ${review.rating}/5 · ${owned ? `Your review: ${review.status.replaceAll("_", " ")}` : formatDate(review.created_at)}`;
    const body = document.createElement("p");
    body.textContent = review.body;
    card.append(title, meta, body);
    return card;
  }

  async function loadReviews(provider) {
    if (reviewProviderId !== provider.id) currentOwnReview = null;
    reviewProviderId = provider.id;
    selectedProvider = provider;
    const sequence = ++reviewLoadNumber;
    const section = $("#community-reviews");
    if (!section) return;
    const message = $("#review-message", section);
    const list = $("#review-list", section);
    const loginPrompt = $("#review-login-required", section);
    const form = $("#review-form", section);
    list.replaceChildren();
    setStatus(message, workerOrigin ? "Loading reviews…" : "Review services are not connected yet.", !workerOrigin);
    if (!workerOrigin) return;

    let result;
    try {
      result = await apiRequest(`/api/reviews?providerId=${encodeURIComponent(provider.id)}`);
    } catch {
      if (sequence === reviewLoadNumber) setStatus(message, "Reviews are temporarily unavailable. Try again later.", true);
      return;
    }
    if (sequence !== reviewLoadNumber || selectedProvider?.id !== provider.id) return;
    const own = result.ownReview;
    currentOwnReview = own;
    const publicReviews = result.reviews || [];
    const isOwnPublished = own?.status === "published";
    const combined = [...publicReviews.filter((review) => review.id !== own?.id).map((review) => ({ review, owned: false }))];
    if (own) combined.unshift({ review: own, owned: true });
    for (const entry of combined) list.append(reviewCard(entry.review, entry.owned));
    setStatus(message, publicReviews.length
      ? `${publicReviews.length} public ${publicReviews.length === 1 ? "review" : "reviews"}. Reviews are moderated and shown only for approved provider records.`
      : "No public reviews are approved for this provider yet. Submitted reviews are moderated before publication.");

    setVisible(loginPrompt, !currentUser);
    setVisible(form, Boolean(currentUser) && !isOwnPublished);
    const titleInput = $("#review-title", form);
    const bodyInput = $("#review-body", form);
    const ratingInput = $("#review-rating", form);
    const submit = form.querySelector("button[type='submit']");
    if (own?.status === "rejected") {
      titleInput.value = own.title || "";
      bodyInput.value = own.body || "";
      ratingInput.value = String(own.rating);
      submit.textContent = "Update and resubmit review";
    } else {
      titleInput.value = "";
      bodyInput.value = "";
      ratingInput.value = "5";
      submit.textContent = "Submit review";
    }
    setStatus($("#review-status", form), own?.status === "pending"
      ? "Your review is pending moderation. You can submit one review per provider."
      : own?.status === "rejected"
        ? "Your review needs changes before it can be considered again."
        : isOwnPublished
          ? "Your review is published."
          : "");
  }

  async function submitReview(event) {
    event.preventDefault();
    const form = event.currentTarget;
    if (!workerOrigin || !currentUser || !selectedProvider || reviewBusy || !form.reportValidity()) return;
    const provider = selectedProvider;
    const ownReview = currentOwnReview;
    reviewBusy = true;
    const button = form.querySelector("button[type='submit']");
    button.disabled = true;
    setStatus($("#review-status", form), "Submitting your review…");
    const payload = {
      rating: Number($("#review-rating", form).value),
      title: clean($("#review-title", form).value),
      body: clean($("#review-body", form).value)
    };
    try {
      if (ownReview?.status === "rejected") {
        await apiRequest(`/api/reviews/${encodeURIComponent(ownReview.id)}`, { method: "PATCH", body: payload });
      } else {
        await apiRequest("/api/reviews", {
          method: "POST", body: { providerId: provider.id, ...payload }
        });
      }
      setStatus($("#review-status", form), "Review received. It will appear publicly after moderation and provider-record approval.");
      if (selectedProvider?.id === provider.id) await loadReviews(provider);
    } catch (error) {
      setStatus($("#review-status", form), error?.status === 409
        ? "You already have a review for this provider. Check its status above."
        : error?.status === 429
          ? "For security, only a few reviews can be submitted per hour. Try again later."
          : "We couldn't send the review. Check the required fields and try again.", true);
    } finally {
      reviewBusy = false;
      button.disabled = false;
    }
  }

  function clearReviews() {
    selectedProvider = null;
    reviewProviderId = null;
    currentOwnReview = null;
    reviewLoadNumber += 1;
  }

  function bindForms() {
    $("#account-form").addEventListener("submit", submitAccount);
    $("#account-mode-toggle").addEventListener("click", () => setAccountMode(authMode === "signup" ? "signin" : "signup"));
    $("#password-reset").addEventListener("click", resetPassword);
    $("#password-update-form").addEventListener("submit", updatePassword);
    $("#sign-out").addEventListener("click", signOut);
    $("#provider-form").addEventListener("submit", submitProviderApplication);
    $("#support-form").addEventListener("submit", submitSupportRequest);
    document.addEventListener("submit", (event) => {
      if (event.target?.id === "review-form") submitReview(event);
    });
  }

  async function start() {
    bindForms();
    if (!workerOrigin) {
      $("#auth-configuration-note").textContent = "Account, review, and submission services are not connected yet. Directory browsing remains available.";
      $("#account-submit").disabled = true;
      $("#account-mode-toggle").disabled = true;
      $("#password-reset").disabled = true;
      return;
    }
    $("#auth-configuration-note").textContent = "Connecting account and provider services…";
    $("#account-submit").disabled = true;
    authSession = storedSession();
    await restoreAuthState();
    await loadDisclaimer();
    authReady = true;
    $("#account-submit").disabled = false;
    $("#auth-configuration-note").textContent = "Accounts use email and password. Provider forms, reviews, and support requests require sign-in.";
    updateAuthUI();
  }

  async function restoreAuthState() {
    const callback = new URLSearchParams(window.location.hash.replace(/^#/, ""));
    const accessToken = callback.get("access_token");
    const refreshToken = callback.get("refresh_token");
    const callbackType = callback.get("type");
    const hasAuthCallback = callback.has("access_token") || callback.has("error") || callback.has("error_description");
    const hasCallbackError = callback.has("error") || callback.has("error_description") ||
      (callback.has("access_token") && !callback.has("refresh_token"));
    authSession = storedSession();
    if (accessToken && refreshToken) {
      const expiresIn = Number(callback.get("expires_in")) || 3600;
      saveSession({ access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn });
      passwordRecovery = callbackType === "recovery";
    }
    if (hasAuthCallback) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    if (authSession) {
      try {
        const result = await apiRequest("/api/auth/session");
        currentUser = result.user || null;
      } catch {
        saveSession(null);
        currentUser = null;
      }
    }
    if (passwordRecovery) {
      setVisible($("#account-form"), !currentUser);
      setVisible($("#password-update-form"), Boolean(currentUser));
      setStatus($("#password-update-status"), currentUser
        ? "Choose a new password for your account."
        : "This password reset link is invalid or has expired. Request a new one.", !currentUser);
      if (currentUser) openPanel("account-panel");
      else {
        setStatus($("#account-status"), "This password reset link is invalid or has expired. Request a new one.", true);
        openPanel("account-panel");
      }
    } else if (callbackType === "signup" && currentUser) {
      setStatus($("#account-status"), "Email confirmed. You are signed in.");
      openPanel("account-panel");
    } else if (hasCallbackError) {
      setStatus($("#account-status"), "That email link could not be verified. Request a new link and try again.", true);
      openPanel("account-panel");
    }
  }

  window.ShroombergCommunity = { loadReviews, clearReviews, openProviderApplication };
  start();
})();
