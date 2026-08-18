// Shared helpers loaded on every page.

// Collects everything available client-side about the browser/device, with no
// permission prompts, for attendance anti-fraud/audit purposes. Server-side
// (IP, geo, ISP) is added separately in functions/api/attendance.js.
async function collectDeviceInfo() {
  const info = {
    userAgent: navigator.userAgent,
    platform: navigator.platform || null,
    vendor: navigator.vendor || null,
    language: navigator.language,
    languages: navigator.languages ? Array.from(navigator.languages) : null,
    cookieEnabled: navigator.cookieEnabled,
    hardwareConcurrency: navigator.hardwareConcurrency || null,
    deviceMemory: navigator.deviceMemory || null,
    maxTouchPoints: navigator.maxTouchPoints || 0,
    screen: {
      width: screen.width, height: screen.height,
      availWidth: screen.availWidth, availHeight: screen.availHeight,
      colorDepth: screen.colorDepth, pixelRatio: window.devicePixelRatio || 1,
      orientation: screen.orientation ? screen.orientation.type : null,
    },
    viewport: { width: window.innerWidth, height: window.innerHeight },
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffsetMin: new Date().getTimezoneOffset(),
  };

  if (navigator.connection) {
    const c = navigator.connection;
    info.connection = { effectiveType: c.effectiveType, downlink: c.downlink, rtt: c.rtt, saveData: c.saveData };
  }

  if (navigator.userAgentData) {
    info.uaData = {
      brands: navigator.userAgentData.brands,
      mobile: navigator.userAgentData.mobile,
      platform: navigator.userAgentData.platform,
    };
    try {
      info.uaData.highEntropy = await navigator.userAgentData.getHighEntropyValues(
        ["architecture", "bitness", "model", "platformVersion", "uaFullVersion", "fullVersionList"]
      );
    } catch { /* browser declined or doesn't support high-entropy hints */ }
  }

  try {
    if (navigator.getBattery) {
      const b = await navigator.getBattery();
      info.battery = { level: b.level, charging: b.charging };
    }
  } catch { /* unsupported */ }

  return info;
}

// ---------------- Biometric login (WebAuthn) ----------------

function bufToB64url(buf) {
  const bytes = new Uint8Array(buf);
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlToBuf(str) {
  str = str.replace(/-/g, "+").replace(/_/g, "/");
  while (str.length % 4) str += "=";
  const bin = atob(str);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function webauthnSupported() {
  return !!(window.PublicKeyCredential && navigator.credentials);
}

function deviceLabelGuess() {
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? "Edge" : /Chrome\//.test(ua) ? "Chrome" : /Firefox\//.test(ua) ? "Firefox" : /Safari\//.test(ua) ? "Safari" : "Browser";
  const os = /Windows/.test(ua) ? "Windows" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS/.test(ua) ? "macOS" : /Linux/.test(ua) ? "Linux" : "device";
  return `${browser} on ${os}`;
}

// Registers this device's biometric authenticator for the currently logged-in
// user. Must be called from a page where the user is already signed in via
// the normal user_id login. Throws with a human-readable message on failure.
async function registerBiometric() {
  if (!webauthnSupported()) throw new Error(t ? t("security.unsupported") : "This browser doesn't support biometric sign-in.");
  const opts = await api("/api/webauthn", { method: "POST", body: { action: "register-options" } });

  const publicKey = {
    challenge: b64urlToBuf(opts.challenge),
    rp: opts.rp,
    user: { id: b64urlToBuf(opts.user.id), name: opts.user.name, displayName: opts.user.displayName },
    pubKeyCredParams: opts.pubKeyCredParams,
    authenticatorSelection: opts.authenticatorSelection,
    timeout: opts.timeout,
    attestation: opts.attestation,
    excludeCredentials: (opts.excludeCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
  };

  const cred = await navigator.credentials.create({ publicKey });
  const payload = {
    action: "register-verify",
    challenge: opts.challenge,
    deviceLabel: deviceLabelGuess(),
    credential: {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        attestationObject: bufToB64url(cred.response.attestationObject),
      },
    },
  };
  return api("/api/webauthn", { method: "POST", body: payload });
}

// Attempts a biometric login for the given user_id. Returns the same shape as
// the normal /api/auth login call ({ user }) on success.
async function loginWithBiometric(userId) {
  const opts = await api("/api/webauthn", { method: "POST", body: { action: "login-options", user_id: userId } });

  const publicKey = {
    challenge: b64urlToBuf(opts.challenge),
    rpId: opts.rpId,
    timeout: opts.timeout,
    userVerification: opts.userVerification,
    allowCredentials: (opts.allowCredentials || []).map((c) => ({ ...c, id: b64urlToBuf(c.id) })),
  };

  const cred = await navigator.credentials.get({ publicKey });
  const payload = {
    action: "login-verify",
    user_id: userId,
    challenge: opts.challenge,
    credential: {
      id: cred.id,
      rawId: bufToB64url(cred.rawId),
      type: cred.type,
      response: {
        clientDataJSON: bufToB64url(cred.response.clientDataJSON),
        authenticatorData: bufToB64url(cred.response.authenticatorData),
        signature: bufToB64url(cred.response.signature),
        userHandle: cred.response.userHandle ? bufToB64url(cred.response.userHandle) : null,
      },
    },
  };
  return api("/api/webauthn", { method: "POST", body: payload });
}

// Wires up a "Sign-in security" card (see student.html/support.html/
// attendance-control.html) with: list of registered devices, add button,
// remove buttons. Call once after guard() resolves. No-op if the card isn't
// present on the page.
async function initBiometricSettings() {
  const card = document.getElementById("webauthnCard");
  if (!card) return;
  const listEl = document.getElementById("webauthnList");
  const msgEl = document.getElementById("webauthnMsg");
  const addBtn = document.getElementById("webauthnAddBtn");

  if (!webauthnSupported()) {
    card.classList.add("hidden");
    return;
  }

  async function refresh() {
    const { credentials } = await api("/api/webauthn");
    if (!credentials.length) {
      listEl.innerHTML = `<p class="hint">${t("security.none")}</p>`;
      return;
    }
    listEl.innerHTML = credentials.map((c) => `
      <div class="webauthn-item">
        <span>${c.device_label || "Device"} <small>${fmtDateTime(c.created_at)}</small></span>
        <button class="btn-link" data-del="${c.id}" data-i18n="security.remove">${t("security.remove")}</button>
      </div>`).join("");
    listEl.querySelectorAll("[data-del]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await api("/api/webauthn", { method: "POST", body: { action: "delete", id: btn.dataset.del } }).catch(() => {});
        refresh();
      });
    });
  }

  addBtn.addEventListener("click", async () => {
    addBtn.disabled = true;
    try {
      await registerBiometric();
      showMsg(msgEl, t("security.added"), "success");
      refresh();
    } catch (e) {
      showMsg(msgEl, e.message || t("security.failed"));
    } finally {
      addBtn.disabled = false;
    }
  });

  refresh();
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || "Request failed");
    err.data = data;
    throw err;
  }
  return data;
}

// Redirects to login if not authenticated, or if role doesn't match the page.
// Pass null for allowedRoles to accept any logged-in user.
async function guard(allowedRoles) {
  try {
    const { user } = await api("/api/auth");
    if (allowedRoles && user.role !== "super_admin" && !allowedRoles.includes(user.role)) {
      window.location.href = "/";
      return null;
    }
    document.querySelectorAll("[data-user-name]").forEach((el) => (el.textContent = user.full_name || user.user_id));
    return user;
  } catch {
    window.location.href = "/";
    return null;
  }
}

async function logout() {
  await api("/api/auth", { method: "POST", body: { action: "logout" } });
  window.location.href = "/";
}

// Sets message text/color and announces it to screen readers via aria-live.
function showMsg(el, text, type = "error") {
  el.textContent = text;
  el.className = `msg ${type}`;
  el.setAttribute("role", type === "error" ? "alert" : "status");
  el.setAttribute("aria-live", "polite");
  el.classList.remove("hidden");
  el.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

// Wraps date/time strings so the browser's bidi algorithm can't reorder the
// date and time halves when this sits inside an RTL table cell (Arabic UI).
// The value itself is still plain, left-to-right text — only its direction
// is pinned so "2026-08-13 10:56" can't render as "10:56 2026-08-13".
function fmtDateTime(s) {
  if (!s) return "—";
  const text = s.replace("T", " ").slice(0, 16);
  return `<span dir="ltr" style="unicode-bidi:isolate">${text}</span>`;
}

// Renders a friendly empty state instead of a bare "no rows" table row.
function emptyState(message) {
  return `<div class="empty-state">
    <svg class="icon icon-lg" viewBox="0 0 24 24"><path d="M9 12h6M9 16h6M9 8h1"/><rect x="4" y="3" width="16" height="18" rx="2"/></svg>
    <p>${message}</p>
  </div>`;
}

// simple tab switcher used by role dashboards: buttons with data-tab, panels with data-panel
function initTabs() {
  document.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", btn.classList.contains("active") ? "true" : "false");
    btn.addEventListener("click", () => {
      document.querySelectorAll("[data-tab]").forEach((b) => { b.classList.remove("active"); b.setAttribute("aria-selected", "false"); });
      document.querySelectorAll("[data-panel]").forEach((p) => p.classList.add("hidden"));
      btn.classList.add("active");
      btn.setAttribute("aria-selected", "true");
      const panel = document.querySelector(`[data-panel="${btn.dataset.tab}"]`);
      panel.classList.remove("hidden");
      panel.focus?.();
    });
  });
}
