const express = require("express");
const router = express.Router();

const GH_API = "https://api.github.com";

function githubHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "github-media-vault",
  };
}

function repoBase() {
  const { GITHUB_USERNAME: owner, GITHUB_REPO: repo } = process.env;
  return `${GH_API}/repos/${owner}/${repo}`;
}

// ─── GET /api/media ───────────────────────────────────────────────────────────
// Returns list of files inside the /media folder
router.get("/media", async (req, res, next) => {
  try {
    const branch = process.env.GITHUB_BRANCH || "main";
    const url = `${repoBase()}/contents/media?ref=${branch}`;

    const response = await fetch(url, { headers: githubHeaders() });

    if (response.status === 404) {
      // Folder doesn't exist yet — return empty list
      return res.json([]);
    }

    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      throw Object.assign(new Error(body.message || "GitHub API error"), {
        status: response.status,
      });
    }

    const files = await response.json();

    // Return image, video, and PDF files with useful metadata
    const mediaExtensions = /\.(jpe?g|png|gif|webp|mp4|webm|mov|pdf)$/i;

    function getFileType(name) {
      if (/\.(mp4|webm|mov)$/i.test(name)) return "video";
      if (/\.pdf$/i.test(name)) return "pdf";
      return "image";
    }

    const media = files
      .filter((f) => f.type === "file" && mediaExtensions.test(f.name))
      .map((f) => ({
        name: f.name,
        path: f.path,
        size: f.size,
        sha: f.sha,
        download_url: f.download_url,
        type: getFileType(f.name),
      }));

    res.json(media);
  } catch (err) {
    next(err);
  }
});

// ─── POST /api/upload ─────────────────────────────────────────────────────────
// Uploads a single file to the GitHub repo under /media
router.post("/upload", async (req, res, next) => {
  try {
    // Detailed diagnostics to catch silent Vercel body issues
    if (!req.file) {
      const contentType = req.headers["content-type"] || "none";
      const contentLength = req.headers["content-length"] || "unknown";
      return res.status(400).json({
        error: `No file received. Content-Type: ${contentType}, Content-Length: ${contentLength} bytes. File may exceed the 4.5MB Vercel serverless limit.`,
      });
    }

    if (req.file.size === 0) {
      return res.status(400).json({ error: "Received an empty file." });
    }

    const branch = process.env.GITHUB_BRANCH || "main";

    // Sanitise filename: replace spaces, keep extension
    const safeName = `${Date.now()}_${req.file.originalname.replace(/\s+/g, "_")}`;
    const filePath = `media/${safeName}`;
    const url = `${repoBase()}/contents/${filePath}`;

    // Check if the file already exists (to get its SHA for update)
    let sha;
    const checkRes = await fetch(`${url}?ref=${branch}`, {
      headers: githubHeaders(),
    });
    if (checkRes.ok) {
      const existing = await checkRes.json();
      sha = existing.sha;
    }

    const base64Content = req.file.buffer.toString("base64");

    const body = {
      message: `Upload ${safeName}`,
      content: base64Content,
      branch,
      ...(sha ? { sha } : {}),
    };

    const uploadRes = await fetch(url, {
      method: "PUT",
      headers: githubHeaders(),
      body: JSON.stringify(body),
    });

    if (!uploadRes.ok) {
      const errBody = await uploadRes.json().catch(() => ({}));
      throw Object.assign(
        new Error(errBody.message || "Failed to upload to GitHub"),
        { status: uploadRes.status }
      );
    }

    const result = await uploadRes.json();
    function getFileType(name) {
      if (/\.(mp4|webm|mov)$/i.test(name)) return "video";
      if (/\.pdf$/i.test(name)) return "pdf";
      return "image";
    }

    res.json({
      success: true,
      name: safeName,
      path: filePath,
      download_url: result.content.download_url,
      type: getFileType(safeName),
    });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/media/:sha ───────────────────────────────────────────────────
// Deletes a file from the repository by path + sha
router.delete("/media", async (req, res, next) => {
  try {
    const { path: filePath, sha } = req.body;
    if (!filePath || !sha) {
      return res.status(400).json({ error: "path and sha are required." });
    }

    const branch = process.env.GITHUB_BRANCH || "main";
    const url = `${repoBase()}/contents/${filePath}`;

    const delRes = await fetch(url, {
      method: "DELETE",
      headers: githubHeaders(),
      body: JSON.stringify({
        message: `Delete ${filePath}`,
        sha,
        branch,
      }),
    });

    if (!delRes.ok) {
      const errBody = await delRes.json().catch(() => ({}));
      throw Object.assign(
        new Error(errBody.message || "Failed to delete from GitHub"),
        { status: delRes.status }
      );
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;