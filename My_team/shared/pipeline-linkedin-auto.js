const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth");
chromium.use(stealth());
const config = require("./pipeline-config");
const fs = require("fs");
const path = require("path");

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const RATE_LIMITS = {
  maxConnectionsPerDay: 20,
  maxDMsPerDay: 30,
  maxTotalActionsPerDay: 50,
  minDelayMs: 45000,  // 45 seconds
  maxDelayMs: 120000, // 2 minutes
  sessionMaxMinutes: 30,
};

const LOG_DIR = path.join(__dirname, "../logs");
const LOG_FILE = path.join(LOG_DIR, "linkedin-automation.log");
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

function log(msg) {
  const line = `[${ts()}] [linkedin-auto] ${msg}\n`;
  process.stdout.write(line);
  fs.appendFileSync(LOG_FILE, line);
}

// ---------------------------------------------------------------------------
// Rate limit tracking (in-memory, per-run)
// ---------------------------------------------------------------------------
let dailyCounts = { connections: 0, dms: 0, total: 0 };

function canPerformAction(type) {
  if (dailyCounts.total >= RATE_LIMITS.maxTotalActionsPerDay) return false;
  if (type === "connection" && dailyCounts.connections >= RATE_LIMITS.maxConnectionsPerDay) return false;
  if (type === "dm" && dailyCounts.dms >= RATE_LIMITS.maxDMsPerDay) return false;
  return true;
}

function recordAction(type) {
  dailyCounts.total++;
  if (type === "connection") dailyCounts.connections++;
  if (type === "dm") dailyCounts.dms++;
}

function getRateLimitStatus() {
  return { ...dailyCounts };
}

function resetDailyCounts() {
  dailyCounts = { connections: 0, dms: 0, total: 0 };
}

// ---------------------------------------------------------------------------
// Random delay — human-like timing
// ---------------------------------------------------------------------------
function randomDelay() {
  const ms = RATE_LIMITS.minDelayMs + Math.random() * (RATE_LIMITS.maxDelayMs - RATE_LIMITS.minDelayMs);
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shortDelay() {
  const ms = 2000 + Math.random() * 3000; // 2-5 seconds
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Cookie / auth management
// ---------------------------------------------------------------------------
const COOKIE_FILE = path.join(__dirname, "../logs/linkedin-cookies.json");
let sessionStart = null;
let _liAt = null;
let _jsessionId = null;

function loadCookies() {
  let cookies = [];
  if (fs.existsSync(COOKIE_FILE)) {
    try {
      cookies = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
      log("Using saved cookies from disk");
    } catch (err) {
      log(`Failed to parse cookie file: ${err.message}`);
    }
  }
  if (cookies.length === 0 && config.linkedinCookies) {
    try {
      cookies = JSON.parse(config.linkedinCookies);
      log("Using cookies from env var");
    } catch (err) {
      log(`Failed to parse LINKEDIN_COOKIES env: ${err.message}`);
    }
  }
  _liAt = cookies.find((c) => c.name === "li_at")?.value || null;
  _jsessionId = (cookies.find((c) => c.name === "JSESSIONID")?.value || "").replace(/"/g, "");
  if (_liAt) log(`Loaded li_at (${_liAt.slice(0, 20)}...)`);
  if (_jsessionId) log(`Loaded JSESSIONID (${_jsessionId})`);
  return cookies;
}

// ---------------------------------------------------------------------------
// Playwright browser — uses real Chrome + stealth plugin.
// API calls are made via page.evaluate(fetch) so they go through the
// browser's native HTTP/2+TLS stack, indistinguishable from real XHRs.
// ---------------------------------------------------------------------------
let _browser = null;
let _context = null;
let _page = null;

async function apiRequest(endpoint, method = "GET", body = null) {
  if (!_page) throw new Error("Browser not launched");

  // Check if page is still on LinkedIn (not redirected to login by JS)
  const pageUrl = _page.url();
  if (pageUrl.includes("/login") || pageUrl.includes("/authwall")) {
    throw new Error(`Page redirected to login: ${pageUrl}`);
  }

  const result = await _page.evaluate(async ({ endpoint, method, body }) => {
    try {
      // Read CSRF token directly from browser cookies (always in sync)
      const csrfToken = document.cookie
        .split("; ")
        .find(c => c.startsWith("JSESSIONID="))
        ?.split("=")
        ?.slice(1)
        ?.join("=")
        ?.replace(/"/g, "") || "";

      const opts = {
        method,
        credentials: "include",
        headers: {
          "csrf-token": csrfToken,
          "x-li-lang": "en_US",
          "x-restli-protocol-version": "2.0.0",
          "x-li-page-instance": "urn:li:page:feed_index;",
          "Accept": "application/vnd.linkedin.normalized+json+2.1",
        },
      };
      if (body) {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(body);
      }
      const res = await fetch(`/voyager/api${endpoint}`, opts);
      const text = await res.text();
      return {
        status: res.status,
        body: text,
        url: window.location.href,
        csrfToken: csrfToken ? csrfToken.slice(0, 20) + "..." : "EMPTY",
      };
    } catch (err) {
      return { status: 0, body: err.message, error: true, url: window.location.href };
    }
  }, { endpoint, method, body });

  if (result.error) throw new Error(`Fetch error: ${result.body}`);

  // Log diagnostics for all non-2xx responses
  if (result.status >= 300) {
    log(`API ${method} ${endpoint} → ${result.status} | csrf=${result.csrfToken} | pageUrl=${result.url} | body=${(result.body || "").slice(0, 300)}`);
  }

  if (result.status === 302) {
    throw new Error(`API 302: session redirected (likely expired)`);
  }
  if (result.status === 401) {
    throw new Error(`API 401 on ${method} ${endpoint}: ${(result.body || "").slice(0, 300)}`);
  }
  if (result.status === 403) {
    throw new Error(`API 403 on ${method} ${endpoint}: ${(result.body || "").slice(0, 300)}`);
  }
  if (result.status >= 400) {
    throw new Error(`API ${result.status}: ${(result.body || "").slice(0, 300)}`);
  }
  try {
    return result.body ? JSON.parse(result.body) : {};
  } catch (e) {
    return { _raw: result.body };
  }
}

// ---------------------------------------------------------------------------
// Browser lifecycle — persistent context preserves localStorage, cache, etc.
// ---------------------------------------------------------------------------
const BROWSER_PROFILE_DIR = path.join(__dirname, "../logs/chrome-profile");

async function launchBrowser() {
  // Re-entrant guard: skip if browser is already running
  if (_context && _page) {
    log("Browser already running — reusing existing session");
    return;
  }

  log("Launching Chrome with persistent profile + stealth...");
  loadCookies();

  // Try real Chrome first, fall back to bundled Chromium
  const chromePaths = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
  ];
  let execPath;
  for (const p of chromePaths) {
    if (fs.existsSync(p)) { execPath = p; break; }
  }

  // Clean stale lock files that can prevent browser launch
  for (const lockFile of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    const p = path.join(BROWSER_PROFILE_DIR, lockFile);
    try { fs.unlinkSync(p); } catch (_) {}
  }

  // Persistent context retains localStorage, IndexedDB, cache between runs
  _context = await chromium.launchPersistentContext(BROWSER_PROFILE_DIR, {
    headless: true,
    ...(execPath ? { executablePath: execPath } : {}),
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-setuid-sandbox",
    ],
    userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    locale: "en-AU",
    timezoneId: "Australia/Melbourne",
    viewport: { width: 1440, height: 900 },
  });

  // Add cookies from file
  let cookies = [];
  if (fs.existsSync(COOKIE_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(COOKIE_FILE, "utf-8"));
      cookies = raw.map(c => ({
        name: c.name,
        value: c.value.replace(/^"|"$/g, ""),
        domain: c.domain,
        path: c.path || "/",
        secure: c.secure !== false,
        httpOnly: c.httpOnly || false,
        sameSite: c.sameSite === "no_restriction" ? "None" :
                  c.sameSite === "lax" ? "Lax" :
                  c.sameSite === "strict" ? "Strict" : "None",
        ...(c.expirationDate && !c.session ? { expires: c.expirationDate } : {}),
      }));
    } catch (e) {
      log(`Failed to parse cookies: ${e.message}`);
    }
  }

  if (cookies.length > 0) {
    await _context.addCookies(cookies);
    log(`Loaded ${cookies.length} cookies into persistent context`);
  }

  _page = _context.pages()[0] || await _context.newPage();

  // Navigate to LinkedIn feed — establishes full browser session context
  log("Loading LinkedIn feed page...");
  try {
    await _page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });
    // Wait a bit for JS to initialize
    await _page.waitForTimeout(3000);
    log(`Feed page loaded (URL: ${_page.url()})`);

    // Read the current JSESSIONID from browser cookies — LinkedIn may have
    // updated it during page load, and we need the matching CSRF token
    const browserCookies = await _context.cookies("https://www.linkedin.com");
    const jsessionCookie = browserCookies.find(c => c.name === "JSESSIONID");
    if (jsessionCookie) {
      const newJsession = jsessionCookie.value.replace(/"/g, "");
      if (newJsession !== _jsessionId) {
        log(`JSESSIONID updated: ${_jsessionId} → ${newJsession}`);
      }
      _jsessionId = newJsession;
    }

    // Verify CSRF token is accessible from page.evaluate (document.cookie)
    const csrfCheck = await _page.evaluate(() => {
      const csrf = document.cookie
        .split("; ")
        .find(c => c.startsWith("JSESSIONID="))
        ?.split("=")
        ?.slice(1)
        ?.join("=")
        ?.replace(/"/g, "") || "";
      return { csrf, allCookieNames: document.cookie.split("; ").map(c => c.split("=")[0]) };
    });
    if (csrfCheck.csrf) {
      log(`CSRF token verified in browser: ${csrfCheck.csrf.slice(0, 25)}...`);
    } else {
      log(`WARNING: CSRF token NOT found in document.cookie! Available: ${csrfCheck.allCookieNames.join(", ")}`);
    }
  } catch (err) {
    log(`Feed page load error: ${err.message}`);
  }

  sessionStart = Date.now();
}

async function closeBrowser() {
  try { if (_context) await _context.close(); } catch (_) {}
  _page = null;
  _context = null;
  _browser = null;
  _liAt = null;
  _jsessionId = null;
  sessionStart = null;
  log("Session closed");
}

function isSessionExpired() {
  if (!sessionStart) return true;
  const elapsed = (Date.now() - sessionStart) / 1000 / 60;
  return elapsed >= RATE_LIMITS.sessionMaxMinutes;
}

// ---------------------------------------------------------------------------
// Session validation — check if the browser session is alive
// ---------------------------------------------------------------------------
async function validateSession() {
  if (!_page) await launchBrowser();
  if (!_liAt || !_jsessionId) {
    log("Session INVALID — missing li_at or JSESSIONID cookies");
    return false;
  }

  // Check if we're on a LinkedIn page (not redirected to login)
  const url = _page.url();
  if (url.includes("/login") || url.includes("/authwall")) {
    log(`Session INVALID — redirected to login page: ${url}`);
    return false;
  }

  try {
    const data = await apiRequest("/me");
    const name = data?.miniProfile?.firstName || data?.firstName;
    if (name) {
      log(`Session VALID — logged in as ${name}`);
      return true;
    }
    if (data?.included?.length > 0) {
      const profile = data.included.find((i) => i.firstName);
      if (profile) {
        log(`Session VALID — logged in as ${profile.firstName} ${profile.lastName}`);
        return true;
      }
    }
    log(`Session UNCERTAIN — /me returned data but no name found`);
    return true;
  } catch (err) {
    log(`Session INVALID — ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Warm-up: browse the feed briefly to look human
// ---------------------------------------------------------------------------
async function warmUp() {
  log("Warm-up — browsing feed...");
  if (_page) {
    try {
      // Scroll down slightly like a human would
      await _page.evaluate(() => window.scrollBy(0, 300));
      await _page.waitForTimeout(2000 + Math.random() * 3000);
      await _page.evaluate(() => window.scrollBy(0, 200));
    } catch (_) {}
  }
  await new Promise((r) => setTimeout(r, 2000 + Math.random() * 3000));
}

// ---------------------------------------------------------------------------
// Helper: extract vanity name from LinkedIn URL
// ---------------------------------------------------------------------------
function extractVanityName(url) {
  // https://www.linkedin.com/in/john-doe-12345/ → john-doe-12345
  const match = url.match(/linkedin\.com\/in\/([^/?]+)/);
  return match ? match[1].replace(/\/$/, "") : null;
}

// ---------------------------------------------------------------------------
// Helper: get profile URN (member ID) from vanity name
// ---------------------------------------------------------------------------
async function getProfileUrn(vanityName) {
  // Navigate to the profile page (like a real user) and extract the member ID
  // from the page data. The /identity/dash/profiles API returns 401, but
  // navigating to the profile page and reading the embedded data works.
  log(`Looking up profile: navigating to /in/${vanityName}/`);

  try {
    await _page.goto(`https://www.linkedin.com/in/${vanityName}/`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await _page.waitForTimeout(2000 + Math.random() * 2000);

    const currentUrl = _page.url();
    log(`Profile page loaded (URL: ${currentUrl})`);

    // Check if redirected to login or 404
    if (currentUrl.includes("/login") || currentUrl.includes("/authwall")) {
      log(`Redirected to login while loading profile for ${vanityName}`);
      return null;
    }

    // Extract member URN from the page
    const urnData = await _page.evaluate(() => {
      // Method 1: Look for data-member-id or urn in code tags / embedded data
      const html = document.documentElement.innerHTML;

      // Look for ACoAA member IDs (LinkedIn's member ID format)
      const acoMatch = html.match(/urn:li:f(?:s_miniProfile|sd_profile):(ACoAA[A-Za-z0-9_-]+)/);
      if (acoMatch) return { urn: `urn:li:fsd_profile:${acoMatch[1]}`, method: "html_urn" };

      // Look for member URN in data attributes
      const memberIdEl = document.querySelector("[data-member-id]");
      if (memberIdEl) {
        const mid = memberIdEl.getAttribute("data-member-id");
        return { urn: `urn:li:fsd_profile:${mid}`, method: "data_attr" };
      }

      // Look in embedded JSON-LD or microdata
      const scripts = document.querySelectorAll('script[type="application/ld+json"]');
      for (const s of scripts) {
        try {
          const data = JSON.parse(s.textContent);
          if (data?.url?.includes("/in/")) {
            // LD+JSON found but no direct URN — try other methods
          }
        } catch (_) {}
      }

      // Look for the profile entity in code elements (LinkedIn embeds data in code tags)
      const codeTags = document.querySelectorAll("code");
      for (const code of codeTags) {
        try {
          const text = code.textContent;
          if (text.includes("fsd_profile") || text.includes("fs_miniProfile")) {
            const m = text.match(/(ACoAA[A-Za-z0-9_-]+)/);
            if (m) return { urn: `urn:li:fsd_profile:${m[1]}`, method: "code_tag" };
          }
        } catch (_) {}
      }

      // Last resort: scan for ACoAA pattern anywhere in page
      const globalMatch = html.match(/(ACoAA[A-Za-z0-9_-]{10,})/);
      if (globalMatch) return { urn: `urn:li:fsd_profile:${globalMatch[1]}`, method: "global_scan" };

      return { urn: null, method: "not_found" };
    });

    if (urnData.urn) {
      log(`Found member URN via ${urnData.method}: ${urnData.urn}`);
    } else {
      log(`Could not find member URN for ${vanityName} on profile page`);
    }

    // Navigate back to feed so subsequent API calls work from feed context
    await _page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await _page.waitForTimeout(1000 + Math.random() * 1000);

    return urnData.urn;
  } catch (err) {
    log(`Profile navigation failed for ${vanityName}: ${err.message}`);
    // Try to go back to feed
    try {
      await _page.goto("https://www.linkedin.com/feed/", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
    } catch (_) {}
    return null;
  }
}

// ---------------------------------------------------------------------------
// LinkedIn Actions
// ---------------------------------------------------------------------------

/**
 * Send a connection request to a prospect.
 * @param {string} linkedinUrl — full LinkedIn profile URL
 * @param {string} note — connection note (300 char max)
 * @returns {{ success: boolean, error?: string }}
 */
async function sendConnectionRequest(linkedinUrl, note) {
  if (!canPerformAction("connection")) {
    return { success: false, error: "Daily connection limit reached" };
  }

  const vanityName = extractVanityName(linkedinUrl);
  if (!vanityName) {
    return { success: false, error: `Invalid LinkedIn URL: ${linkedinUrl}` };
  }

  try {
    // Navigate to profile page (like a real user visiting before connecting)
    log(`Visiting profile: /in/${vanityName}/`);
    await _page.goto(`https://www.linkedin.com/in/${vanityName}/`, {
      waitUntil: "load",
      timeout: 30000,
    });
    // Wait for profile to render (JS-heavy page)
    await _page.waitForTimeout(3000 + Math.random() * 2000);

    const pageUrl = _page.url();
    log(`Profile page loaded: ${pageUrl}`);
    if (pageUrl.includes("/login") || pageUrl.includes("/authwall")) {
      return { success: false, error: `Redirected to login: ${pageUrl}` };
    }

    // Try to find and click the Connect button via UI
    const connectResult = await clickConnectButton(vanityName, note);

    // Navigate back to feed
    await _page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded", timeout: 15000,
    }).catch(() => {});
    await _page.waitForTimeout(1000 + Math.random() * 1000);

    if (connectResult.success) {
      recordAction("connection");
      log(`Connection request sent to ${vanityName}`);
    }
    return connectResult;
  } catch (err) {
    // Try to get back to feed on any error
    try {
      await _page.goto("https://www.linkedin.com/feed/", {
        waitUntil: "domcontentloaded", timeout: 15000,
      });
    } catch (_) {}
    return { success: false, error: err.message };
  }
}

/**
 * Click the Connect button on a profile page (UI-based approach).
 * Handles: dismissing modals, main Connect button, "More" dropdown, note dialog.
 */
async function clickConnectButton(vanityName, note) {
  // First: dismiss any existing modals/overlays that might block clicks
  await dismissModals();

  // Strategy: look for Connect button in multiple places
  // LinkedIn has different layouts — Connect can be a primary button or under "More"

  // 1. Try direct Connect button
  let connectBtn = await _page.$('button[aria-label*="connect" i], button[aria-label*="Connect" i]');

  // 2. Also try matching by button text
  if (!connectBtn) {
    const buttons = await _page.$$("button");
    for (const btn of buttons) {
      const text = await btn.textContent().catch(() => "");
      if (text.trim().toLowerCase() === "connect") {
        connectBtn = btn;
        break;
      }
    }
  }

  // 3. If no direct Connect, check the "More" dropdown
  if (!connectBtn) {
    log(`No direct Connect button found, trying More dropdown...`);
    const moreBtn = await _page.$('button[aria-label*="More actions" i], button[aria-label*="More" i]');
    if (moreBtn) {
      await moreBtn.click({ force: true });
      await _page.waitForTimeout(1000 + Math.random() * 500);

      // Look for Connect in the dropdown menu
      const menuItems = await _page.$$('[role="menuitem"], [role="option"], .artdeco-dropdown__content-inner li');
      for (const item of menuItems) {
        const text = await item.textContent().catch(() => "");
        if (text.toLowerCase().includes("connect")) {
          connectBtn = item;
          break;
        }
      }
    }
  }

  if (!connectBtn) {
    // Check if already connected (Message button visible) or pending
    const pageText = await _page.evaluate(() => document.body.innerText.slice(0, 5000));
    if (pageText.includes("Message") && !pageText.includes("Connect")) {
      return { success: false, error: "Already connected" };
    }
    if (pageText.includes("Pending")) {
      return { success: false, error: "Connection request already pending" };
    }
    log(`Could not find Connect button for ${vanityName}. Page text preview: ${pageText.slice(0, 200)}`);
    return { success: false, error: `No Connect button found on profile page for ${vanityName}` };
  }

  // Click Connect — use force:true to bypass any overlay interception
  log(`Clicking Connect button for ${vanityName}`);
  await connectBtn.click({ force: true });
  await _page.waitForTimeout(2000 + Math.random() * 1000);

  // Dismiss any modals that aren't the connection dialog
  // (LinkedIn sometimes shows a "How do you know this person?" prompt)

  // Handle the connection dialog — look for the send/note options
  if (note) {
    // Look for "Add a note" button in the dialog
    const addNoteBtn = await findButtonByText(["Add a note"]);
    if (addNoteBtn) {
      await addNoteBtn.click({ force: true });
      await _page.waitForTimeout(1000);
    }

    // Look for the note textarea
    const textarea = await _page.$('textarea[name="message"], textarea[id*="custom-message"], #custom-message, textarea.connect-button-send-invite__custom-message');
    if (!textarea) {
      // Try broader search
      const allTextareas = await _page.$$("textarea");
      if (allTextareas.length > 0) {
        await allTextareas[0].fill(note.slice(0, 300));
      }
    } else {
      await textarea.fill(note.slice(0, 300));
    }
    await _page.waitForTimeout(500 + Math.random() * 500);
  }

  // Click Send / Send now / Send without a note
  let sendBtn = await findButtonByText(["Send", "Send now", "Send without a note"]);
  if (!sendBtn) {
    sendBtn = await _page.$('button[aria-label*="Send" i]:not([aria-label*="message" i])');
  }

  if (sendBtn) {
    await sendBtn.click({ force: true });
    await _page.waitForTimeout(2000 + Math.random() * 1000);
    log(`Send button clicked for ${vanityName}`);

    // Check for error messages
    const errorMsg = await _page.$('.artdeco-inline-feedback--error, [role="alert"]');
    if (errorMsg) {
      const errText = await errorMsg.textContent().catch(() => "");
      if (errText && errText.toLowerCase().includes("error")) {
        log(`Error after send: ${errText}`);
        return { success: false, error: `Send error: ${errText.trim()}` };
      }
    }

    return { success: true };
  }

  // If no Send button found, check if the initial Connect click already sent
  log(`No Send button found — checking if connection was sent directly`);
  const afterText = await _page.evaluate(() => document.body.innerText.slice(0, 3000));
  if (afterText.includes("Pending") || afterText.includes("pending")) {
    return { success: true };
  }

  return { success: false, error: "Could not complete connection flow (no Send button)" };
}

/**
 * Dismiss any modal overlays, cookie banners, or notification popups.
 */
async function dismissModals() {
  try {
    // Close any visible modal overlays by pressing Escape
    await _page.keyboard.press("Escape");
    await _page.waitForTimeout(500);

    // Try clicking common dismiss buttons
    const dismissSelectors = [
      'button[aria-label="Dismiss"]',
      'button[aria-label="Close"]',
      'button[data-test-modal-close-btn]',
      '.artdeco-modal__dismiss',
      '.msg-overlay-bubble-header__control--new-convo-btn',
    ];
    for (const sel of dismissSelectors) {
      const btn = await _page.$(sel);
      if (btn) {
        await btn.click({ force: true }).catch(() => {});
        await _page.waitForTimeout(300);
      }
    }

    // Remove any remaining modal overlays via JS
    await _page.evaluate(() => {
      const overlays = document.querySelectorAll('.modal__overlay--visible, .artdeco-modal-overlay--visible');
      overlays.forEach(el => el.remove());
    });
  } catch (_) {}
}

/**
 * Find a button by its visible text content (case-insensitive exact match).
 */
async function findButtonByText(texts) {
  const buttons = await _page.$$("button");
  for (const btn of buttons) {
    const text = await btn.textContent().catch(() => "");
    const trimmed = text.trim().toLowerCase();
    for (const target of texts) {
      if (trimmed === target.toLowerCase()) {
        return btn;
      }
    }
  }
  return null;
}

/**
 * Send a direct message to a connected prospect.
 * @param {string} linkedinUrl — full LinkedIn profile URL
 * @param {string} message — the DM text
 * @returns {{ success: boolean, error?: string }}
 */
async function sendDirectMessage(linkedinUrl, message) {
  if (!canPerformAction("dm")) {
    return { success: false, error: "Daily DM limit reached" };
  }

  const vanityName = extractVanityName(linkedinUrl);
  if (!vanityName) {
    return { success: false, error: `Invalid LinkedIn URL: ${linkedinUrl}` };
  }

  try {
    const profileUrn = await getProfileUrn(vanityName);
    if (!profileUrn) {
      return { success: false, error: `Could not resolve profile for ${vanityName}` };
    }

    const memberIdMatch = profileUrn.match(/(ACoAA[A-Za-z0-9_-]+)/);
    if (!memberIdMatch) {
      return { success: false, error: `Could not extract member ID from: ${profileUrn}` };
    }
    const memberId = memberIdMatch[1];

    // Send message via messaging API
    const body = {
      keyVersion: "LEGACY_INBOX",
      conversationCreate: {
        eventCreate: {
          value: {
            "com.linkedin.voyager.messaging.create.MessageCreate": {
              attributedBody: {
                text: message,
                attributes: [],
              },
              attachments: [],
            },
          },
        },
        recipients: [`urn:li:fsd_profile:${memberId}`],
        subtype: "MEMBER_TO_MEMBER",
      },
    };

    await apiRequest("/messaging/conversations", "POST", body);

    recordAction("dm");
    log(`DM sent to ${vanityName}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * Check if a connection request has been accepted.
 * @param {string} linkedinUrl — full LinkedIn profile URL
 * @returns {"connected" | "pending" | "not_connected" | "error"}
 */
async function checkConnectionStatus(linkedinUrl) {
  const vanityName = extractVanityName(linkedinUrl);
  if (!vanityName) return "error";

  try {
    // Navigate to the profile page and check for connection indicators
    await _page.goto(`https://www.linkedin.com/in/${vanityName}/`, {
      waitUntil: "domcontentloaded",
      timeout: 20000,
    });
    await _page.waitForTimeout(2000 + Math.random() * 2000);

    const status = await _page.evaluate(() => {
      const html = document.documentElement.innerHTML;
      // Check for "Message" button (indicates connected)
      const messageBtn = document.querySelector('a[href*="messaging"], button[aria-label*="Message"]');
      if (messageBtn) return "connected";
      // Check for "Pending" indicator
      if (html.includes("Pending") || html.includes("pending")) return "pending";
      // Check for distance indicator in page data
      if (html.includes("DISTANCE_1")) return "connected";
      return "not_connected";
    });

    // Navigate back to feed
    await _page.goto("https://www.linkedin.com/feed/", {
      waitUntil: "domcontentloaded",
      timeout: 15000,
    });
    await _page.waitForTimeout(1000);

    return status;
  } catch (err) {
    log(`Connection status check failed for ${vanityName}: ${err.message}`);
    try {
      await _page.goto("https://www.linkedin.com/feed/", {
        waitUntil: "domcontentloaded",
        timeout: 15000,
      });
    } catch (_) {}
    return "error";
  }
}

/**
 * Check LinkedIn messaging inbox for unread replies.
 * @returns {Array<{ senderName: string, senderUrl: string, message: string, timestamp: string }>}
 */
async function checkInboxReplies() {
  try {
    const data = await apiRequest(
      "/messaging/conversations?keyVersion=LEGACY_INBOX&q=unread"
    );
    const replies = [];
    const conversations = data?.elements || [];
    for (const conv of conversations.slice(0, 10)) {
      try {
        const lastMessage = conv.events?.[0];
        const senderName = conv.participants?.[0]?.participantType?.member?.miniProfile?.firstName || "Unknown";
        const lastName = conv.participants?.[0]?.participantType?.member?.miniProfile?.lastName || "";
        const messageText = lastMessage?.eventContent?.["com.linkedin.voyager.messaging.event.MessageEvent"]?.body || "";
        replies.push({
          senderName: `${senderName} ${lastName}`.trim(),
          senderUrl: "",
          message: messageText.slice(0, 500),
          timestamp: lastMessage?.createdAt ? new Date(lastMessage.createdAt).toISOString() : "",
        });
      } catch (_) {}
    }
    log(`Found ${replies.length} unread LinkedIn message(s)`);
    return replies;
  } catch (err) {
    log(`Inbox check failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function generateTrackingId() {
  // Generate a random base64 tracking ID like LinkedIn's client does
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  return Buffer.from(bytes).toString("base64");
}

// ---------------------------------------------------------------------------
// Business hours check (AEST)
// ---------------------------------------------------------------------------
function isBusinessHours() {
  const now = new Date();
  const aest = new Date(now.toLocaleString("en-US", { timeZone: "Australia/Melbourne" }));
  const hour = aest.getHours();
  const day = aest.getDay(); // 0=Sun, 6=Sat

  // Weekdays only, 8am-6pm AEST
  if (day === 0 || day === 6) return false;
  if (hour < 8 || hour >= 18) return false;
  return true;
}

module.exports = {
  launchBrowser,
  closeBrowser,
  isSessionExpired,
  validateSession,
  warmUp,
  sendConnectionRequest,
  sendDirectMessage,
  checkConnectionStatus,
  checkInboxReplies,
  canPerformAction,
  getRateLimitStatus,
  resetDailyCounts,
  randomDelay,
  isBusinessHours,
  RATE_LIMITS,
};
