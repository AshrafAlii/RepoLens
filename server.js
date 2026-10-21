require("dotenv").config();
const express = require("express");
const path = require("path");

const auth = require("./lib/auth");
const githubRoutes = require("./routes/github");

const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.set("trust proxy", 1);

// Our own API only ever carries small JSON bodies; media itself is uploaded
// straight from the browser to GitHub, so there is no multipart parsing here.
app.use(express.json({ limit: "256kb" }));

// Never let a proxy or browser cache authenticated API responses.
app.use("/api", (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

// Public auth endpoints.
app.post("/api/login", auth.login);
app.post("/api/logout", auth.logout);
app.get("/api/session", auth.session);

// Everything else under /api requires a valid session.
app.use("/api", auth.requireAuth, githubRoutes);

app.use(express.static(path.join(__dirname, "public")));

// Global error handler
app.use((err, req, res, next) => {
  if (err.type === "entity.too.large") {
    return res.status(413).json({ error: "Request body is too large." });
  }
  console.error("[Error]", err.message);
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`\n🚀 RepoLens running at http://localhost:${PORT}\n`);
    const missing = ["GITHUB_TOKEN", "GITHUB_USERNAME", "GITHUB_REPO"].filter(
      (k) => !process.env[k]
    );
    if (missing.length) {
      console.warn(`⚠️  Missing env variables: ${missing.join(", ")}`);
    }
    if (!auth.isConfigured()) {
      console.warn("⚠️  APP_PASSWORD is not set — all API requests will be rejected.");
      console.warn("   Copy .env.example → .env and fill in your values.\n");
    }
  });
}

module.exports = app;
