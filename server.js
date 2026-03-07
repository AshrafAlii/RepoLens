require("dotenv").config();
const express = require("express");
const multer = require("multer");
const path = require("path");

const githubRoutes = require("./routes/github");

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory storage — we never write to disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB max
  fileFilter: (req, file, cb) => {
    const allowed = /image\/(jpeg|jpg|png|gif|webp)|video\/(mp4|webm|quicktime|mov)/;
    if (allowed.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Only images and videos are allowed."));
    }
  },
});

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Routes
app.use("/api", upload.single("file"), githubRoutes);

// Global error handler
app.use((err, req, res, next) => {
  console.error("[Error]", err.message);
  res.status(err.status || 500).json({ error: err.message || "Server error" });
});

app.listen(PORT, () => {
  console.log(`\n🚀 GitHub Media Vault running at http://localhost:${PORT}\n`);
  const missing = ["GITHUB_TOKEN", "GITHUB_USERNAME", "GITHUB_REPO"].filter(
    (k) => !process.env[k]
  );
  if (missing.length) {
    console.warn(`⚠️  Missing env variables: ${missing.join(", ")}`);
    console.warn("   Copy .env.example → .env and fill in your values.\n");
  }
});
