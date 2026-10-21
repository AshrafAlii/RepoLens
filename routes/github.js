const express = require("express");
const router = express.Router();

const GH_API = "https://api.github.com";

const MEDIA_DIR = "media";
const THUMB_DIR = "thumbs";

// Thumbnail file name for a media file.
//   IMG_1.jpeg  -> IMG_1__jpeg.jpg
//   clip.mp4    -> clip__mp4.jpg
// The original extension is kept in the name so the mapping stays unique even
// when two source files share a base name (a.png vs a.jpg vs a.mp4).
// Keep in sync with thumbNameFor() in public/index.html.
function thumbNameFor(fileName) {
  const dot = fileName.lastIndexOf(".");
  const ext = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : "bin";
  const base = dot > 0 ? fileName.slice(0, dot) : fileName;
  return `${base}__${ext}.jpg`;
}

// Reverse of thumbNameFor(): returns { base, ext } or null when the name does
// not follow the thumbnail convention. Used as a fallback lookup.
function parseThumbName(thumbFile) {
  const stem = thumbFile.replace(/\.jpg$/i, "");
  const sep = stem.lastIndexOf("__");
  if (sep < 0) return null;
  return { base: stem.slice(0, sep), ext: stem.slice(sep + 2) };
}

function getFileType(name) {
  if (/\.(mp4|webm|mov)$/i.test(name)) return "video";
  if (/\.pdf$/i.test(name)) return "pdf";
  return "image";
}

// Remove the thumbnail that belongs to a media file. No-op when there is none.
async function deleteThumb(fileName, branch) {
  const thumbPath = `${THUMB_DIR}/${thumbNameFor(fileName)}`;
  const url = `${repoBase()}/contents/${thumbPath}`;

  const getRes = await fetch(`${url}?ref=${branch}`, { headers: githubHeaders() });
  if (!getRes.ok) return; // no thumbnail for this file
  const info = await getRes.json();

  const delRes = await fetch(url, {
    method: "DELETE",
    headers: githubHeaders(),
    body: JSON.stringify({
      message: `Delete thumbnail ${fileName}`,
      sha: info.sha,
      branch,
    }),
  });
  if (!delRes.ok) {
    const errBody = await delRes.json().catch(() => ({}));
    throw new Error(errBody.message || "Failed to delete thumbnail");
  }
}

function githubHeaders() {
  return {
    Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "RepoLens",
  };
}

function repoBase() {
  const { GITHUB_USERNAME: owner, GITHUB_REPO: repo } = process.env;
  return `${GH_API}/repos/${owner}/${repo}`;
}

// ─── GET /api/config ─────────────────────────────────────────────────────────
// Hands the repo coordinates and token to the browser so large files can be
// uploaded straight to GitHub, past Vercel's ~4.5 MB serverless body limit.
// This route sits behind auth.requireAuth — the token is never sent to an
// unauthenticated visitor.
router.get("/config", (req, res) => {
  res.json({
    token: process.env.GITHUB_TOKEN,
    owner: process.env.GITHUB_USERNAME,
    repo: process.env.GITHUB_REPO,
    branch: process.env.GITHUB_BRANCH || "main",
  });
});

// ─── GET /api/media ───────────────────────────────────────────────────────────
// Returns list of files inside the /media folder, each with a thumb_url when a
// matching thumbnail exists in the /thumbs folder.
router.get("/media", async (req, res, next) => {
  try {
    const branch = process.env.GITHUB_BRANCH || "main";
    const url = `${repoBase()}/contents/${MEDIA_DIR}?ref=${branch}`;

    // Fetch media and thumbnails in parallel — one round trip each.
    const [mediaRes, thumbRes] = await Promise.all([
      fetch(url, { headers: githubHeaders() }),
      fetch(`${repoBase()}/contents/${THUMB_DIR}?ref=${branch}`, {
        headers: githubHeaders(),
      }),
    ]);

    if (mediaRes.status === 404) {
      // Folder doesn't exist yet — return empty list
      return res.json([]);
    }

    if (!mediaRes.ok) {
      const body = await mediaRes.json().catch(() => ({}));
      throw Object.assign(new Error(body.message || "GitHub API error"), {
        status: mediaRes.status,
      });
    }

    const files = await mediaRes.json();

    // Build the thumbnail lookup. 404 just means no thumbs folder yet.
    const thumbByName = new Map();
    const thumbByBase = new Map();
    if (thumbRes.ok) {
      const thumbFiles = await thumbRes.json();
      for (const t of thumbFiles) {
        if (t.type !== "file") continue;
        const entry = { url: t.download_url, size: t.size };
        thumbByName.set(t.name, entry);
        const parsed = parseThumbName(t.name);
        if (parsed) thumbByBase.set(parsed.base, entry);
      }
    }

    // Return image, video, and PDF files with useful metadata
    const mediaExtensions = /\.(jpe?g|png|gif|webp|mp4|webm|mov|pdf)$/i;

    function findThumb(name, originalSize) {
      const candidates = [
        thumbByName.get(thumbNameFor(name)),
        (() => {
          const dot = name.lastIndexOf(".");
          const base = dot > 0 ? name.slice(0, dot) : name;
          return thumbByBase.get(base);
        })(),
      ];
      for (const entry of candidates) {
        if (!entry) continue;
        // A thumbnail is only worth using when it is actually smaller than
        // the original — small images are their own thumbnail.
        if (entry.size < originalSize) return entry.url;
      }
      return null;
    }

    const media = files
      .filter((f) => f.type === "file" && mediaExtensions.test(f.name))
      .map((f) => {
        const thumb_url = findThumb(f.name, f.size);
        return {
          name: f.name,
          path: f.path,
          size: f.size,
          sha: f.sha,
          download_url: f.download_url,
          type: getFileType(f.name),
          thumb_path: `${THUMB_DIR}/${thumbNameFor(f.name)}`,
          thumb_url: thumb_url || null,
        };
      });

    res.json(media);
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/date ───────────────────────────────────────────────────────────
// Returns when a file was added to the repo: the date of the last commit that
// touched its path.
const DATE_EXTENSIONS = /\.(jpe?g|png|gif|webp|mp4|webm|mov|pdf)$/i;
const dateInfoCache = new Map();

async function lastCommitDate(filePath) {
  const branch = process.env.GITHUB_BRANCH || "main";
  const url = `${repoBase()}/commits?path=${encodeURIComponent(filePath)}&sha=${encodeURIComponent(branch)}&per_page=1`;
  const res = await fetch(url, {
    headers: githubHeaders(),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) return null;

  const commits = await res.json();
  return (
    commits?.[0]?.commit?.committer?.date ||
    commits?.[0]?.commit?.author?.date ||
    null
  );
}

router.get("/date", async (req, res, next) => {
  try {
    const filePath = String(req.query.path || "");
    if (
      !filePath.startsWith(`${MEDIA_DIR}/`) ||
      filePath.includes("..") ||
      filePath.includes("\\") ||
      !DATE_EXTENSIONS.test(filePath)
    ) {
      return res.status(400).json({ error: "Invalid media path." });
    }

    // Key on the blob sha so a replaced file is re-read instead of cached.
    const key = `${filePath}:${String(req.query.sha || "")}`;
    if (!dateInfoCache.has(key)) {
      if (dateInfoCache.size > 2000) dateInfoCache.clear();
      const upload = await lastCommitDate(filePath);
      dateInfoCache.set(key, { upload });
    }

    res.json(dateInfoCache.get(key));
  } catch (err) {
    next(err);
  }
});

// ─── GET /api/pdf ────────────────────────────────────────────────────────────
// Streams a PDF from the repo with an inline disposition so the browser renders
// it in its built-in viewer instead of downloading it.
//
// raw.githubusercontent.com cannot be used for this: it serves PDFs as
// application/octet-stream with `X-Frame-Options: deny`, so an iframe either
// gets blocked or triggers a download. Serving the bytes from our own origin
// (behind auth) fixes both.
router.get("/pdf", async (req, res, next) => {
  const wantsHtml = Boolean(req.accepts(["html", "json"]) === "html");
  const fail = (status, message) => {
    if (!wantsHtml) return res.status(status).json({ error: message });
    res.status(status).type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Preview unavailable</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
    background:#0a0a0b;color:#a2a2a9;font:14px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    padding:24px;text-align:center}
  p{max-width:320px}
</style></head>
<body><p>${message}<br>Use the Download button above to save the file.</p></body></html>`);
  };

  try {
    const filePath = String(req.query.path || "");
    if (
      !filePath.startsWith(`${MEDIA_DIR}/`) ||
      filePath.includes("..") ||
      filePath.includes("\\") ||
      !/\.pdf$/i.test(filePath)
    ) {
      return fail(400, "A valid PDF path is required.");
    }

    const branch = process.env.GITHUB_BRANCH || "main";
    const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
    const ghRes = await fetch(
      `${repoBase()}/contents/${encodedPath}?ref=${encodeURIComponent(branch)}`,
      {
        headers: {
          ...githubHeaders(),
          // Raw media type returns the file bytes rather than base64 JSON.
          Accept: "application/vnd.github.raw",
        },
      }
    );

    if (!ghRes.ok) {
      const status = ghRes.status === 404 ? 404 : 502;
      return fail(status, "This PDF could not be loaded from the repository.");
    }

    const buffer = Buffer.from(await ghRes.arrayBuffer());
    const fileName = filePath.split("/").pop().replace(/["\\\r\n]/g, "");
    const download = req.query.download === "1";

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Length", buffer.length);
    res.setHeader(
      "Content-Disposition",
      `${download ? "attachment" : "inline"}; filename="${fileName}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
    );
    // Private: the response depends on the session cookie and repo access.
    res.setHeader("Cache-Control", "private, max-age=60");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.send(buffer);
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/thumb ───────────────────────────────────────────────────────
// Removes a single thumbnail without touching the media file it belongs to.
router.delete("/thumb", async (req, res, next) => {
  try {
    const { path: thumbPath } = req.body;
    if (!thumbPath || !thumbPath.startsWith(`${THUMB_DIR}/`) || thumbPath.includes("..")) {
      return res.status(400).json({ error: "A valid thumbnail path is required." });
    }

    const branch = process.env.GITHUB_BRANCH || "main";
    const url = `${repoBase()}/contents/${thumbPath}`;

    const getRes = await fetch(`${url}?ref=${branch}`, { headers: githubHeaders() });
    if (!getRes.ok) {
      // Nothing to remove.
      return res.json({ success: true, deleted: false });
    }
    const info = await getRes.json();

    const delRes = await fetch(url, {
      method: "DELETE",
      headers: githubHeaders(),
      body: JSON.stringify({
        message: `Delete thumbnail ${thumbPath}`,
        sha: info.sha,
        branch,
      }),
    });

    if (!delRes.ok) {
      const errBody = await delRes.json().catch(() => ({}));
      throw Object.assign(
        new Error(errBody.message || "Failed to delete thumbnail"),
        { status: delRes.status }
      );
    }

    res.json({ success: true, deleted: true });
  } catch (err) {
    next(err);
  }
});

// ─── DELETE /api/media/:sha ───────────────────────────────────────────────────
// Deletes a file from the repository by path + sha, plus its thumbnail.
router.delete("/media", async (req, res, next) => {
  try {
    const { path: filePath, sha } = req.body;
    if (!filePath || !sha) {
      return res.status(400).json({ error: "path and sha are required." });
    }
    // Only ever touch files inside the media folder — never the rest of the repo.
    if (!filePath.startsWith(`${MEDIA_DIR}/`) || filePath.includes("..")) {
      return res.status(400).json({ error: "Only files in media/ can be deleted." });
    }
    if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
      return res.status(400).json({ error: "Invalid sha." });
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

    // Clean up the matching thumbnail (best effort — a missing thumb is fine).
    const fileName = filePath.split("/").pop();
    if (fileName) {
      try {
        await deleteThumb(fileName, branch);
      } catch (err) {
        console.warn("[thumb] cleanup failed:", err.message);
      }
    }

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;