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
    "User-Agent": "github-media-vault",
  };
}

function repoBase() {
  const { GITHUB_USERNAME: owner, GITHUB_REPO: repo } = process.env;
  return `${GH_API}/repos/${owner}/${repo}`;
}

// ─── GET /api/config ─────────────────────────────────────────────────────────
// Exposes repo config + token to the frontend for direct GitHub uploads
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

    // Clean filename: remove spaces/special chars, keep original name
    const ext = req.file.originalname.split(".").pop().toLowerCase();
    const baseName = req.file.originalname
      .replace(/\.[^/.]+$/, "")           // remove extension
      .replace(/[^a-zA-Z0-9\-_. ]/g, "") // remove special chars
      .replace(/\s+/g, "_")              // spaces to underscores
      .replace(/_+/g, "_")               // collapse multiple underscores
      .trim();
    const safeName = `${baseName}.${ext}`;
    const filePath = `${MEDIA_DIR}/${safeName}`;
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

// ─── DELETE /api/thumb ───────────────────────────────────────────────────────
// Removes a single thumbnail without touching the media file it belongs to.
router.delete("/thumb", async (req, res, next) => {
  try {
    const { path: thumbPath } = req.body;
    if (!thumbPath || !thumbPath.startsWith(`${THUMB_DIR}/`)) {
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