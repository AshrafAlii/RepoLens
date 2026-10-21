const crypto = require("crypto");

const SESSION_COOKIE = "rl_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Failed logins allowed per IP inside the window before we stop answering.
const MAX_ATTEMPTS = 10;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;

function appPassword() {
  return process.env.APP_PASSWORD || "";
}

// True when the app has been given a password to check against. Without one
// every request is rejected — an unset password must never mean "open".
function isConfigured() {
  return appPassword().length > 0;
}

function sessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  // Stable fallback: sessions survive restarts and serverless cold starts.
  // Set SESSION_SECRET explicitly to invalidate old sessions by rotating it.
  return crypto
    .createHmac("sha256", "repolens-session-v1")
    .update(appPassword() || "unset")
    .digest("hex");
}

function sign(value) {
  return crypto.createHmac("sha256", sessionSecret()).update(value).digest("hex");
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function createSessionToken() {
  const expires = String(Date.now() + SESSION_TTL_MS);
  return `${expires}.${sign(expires)}`;
}

function verifySessionToken(token) {
  if (!token || typeof token !== "string") return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;

  const expires = token.slice(0, dot);
  if (!/^\d+$/.test(expires) || Number(expires) < Date.now()) return false;

  return safeEqual(token.slice(dot + 1), sign(expires));
}

function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

function isSecure(req) {
  return req.secure || req.headers["x-forwarded-proto"] === "https";
}

function sessionCookie(req, token) {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecure(req)) attrs.push("Secure");
  return attrs.join("; ");
}

function clearCookie(req) {
  const attrs = [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (isSecure(req)) attrs.push("Secure");
  return attrs.join("; ");
}

function isAuthenticated(req) {
  if (!isConfigured()) return false;
  const token = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  return verifySessionToken(token);
}

function requireAuth(req, res, next) {
  if (!isConfigured()) {
    return res.status(503).json({
      error: "Server is not configured. Set APP_PASSWORD and restart.",
    });
  }
  if (isAuthenticated(req)) return next();
  return res.status(401).json({ error: "Not authenticated." });
}

// ── Login throttling ─────────────────────────────────────────────────────────
// In-memory only: shared by all requests on one instance. On serverless hosts
// each warm instance keeps its own counter, which is still enough to blunt
// online guessing.
const attempts = new Map();

function attemptKey(req) {
  return req.ip || req.headers["x-forwarded-for"] || "unknown";
}

function isThrottled(req) {
  const entry = attempts.get(attemptKey(req));
  if (!entry) return false;
  if (Date.now() > entry.resetAt) {
    attempts.delete(attemptKey(req));
    return false;
  }
  return entry.count >= MAX_ATTEMPTS;
}

function recordFailure(req) {
  const key = attemptKey(req);
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now > entry.resetAt) {
    attempts.set(key, { count: 1, resetAt: now + ATTEMPT_WINDOW_MS });
  } else {
    entry.count += 1;
  }
}

function clearFailures(req) {
  attempts.delete(attemptKey(req));
}

// ── Handlers ─────────────────────────────────────────────────────────────────
function login(req, res) {
  if (!isConfigured()) {
    return res.status(503).json({
      error: "Server is not configured. Set APP_PASSWORD and restart.",
    });
  }
  if (isThrottled(req)) {
    return res
      .status(429)
      .json({ error: "Too many attempts. Try again in a few minutes." });
  }

  const password = typeof req.body?.password === "string" ? req.body.password : "";
  if (!safeEqual(password, appPassword())) {
    recordFailure(req);
    return res.status(401).json({ error: "Incorrect password." });
  }

  clearFailures(req);
  res.setHeader("Set-Cookie", sessionCookie(req, createSessionToken()));
  res.setHeader("Cache-Control", "no-store");
  res.json({ authenticated: true });
}

function logout(req, res) {
  res.setHeader("Set-Cookie", clearCookie(req));
  res.json({ authenticated: false });
}

function session(req, res) {
  res.setHeader("Cache-Control", "no-store");
  res.json({ authenticated: isAuthenticated(req), configured: isConfigured() });
}

module.exports = {
  SESSION_COOKIE,
  isConfigured,
  isAuthenticated,
  requireAuth,
  login,
  logout,
  session,
};
