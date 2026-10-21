# RepoLens

A private media vault backed by a GitHub repository. Upload photos, videos and
PDFs, browse them in a mobile-friendly gallery, and delete them again — while
the files themselves live in a repo you control. There is no database and no
server-side file storage.

---

## Features

- 📤 Upload images, videos and PDFs from any device
- ☁️ Files are committed to a `media/` folder in your GitHub repo
- 🔐 **Server-side password gate** — sessions are signed HttpOnly cookies; the
  password never reaches the browser
- 🖼️ Responsive grid gallery with full-screen image preview and inline video
- 📄 PDF list view with an embedded preview modal
- 🗑️ Single and bulk (multi-select) delete
- 💧 Drag-and-drop uploads and a floating progress pill that works on mobile
- ⚡ **Auto-generated thumbnails** — a small JPEG preview is generated in the
  browser on upload and stored in a `thumbs/` folder, so the gallery loads ~99%
  less data
- 🎞️ **Video poster frames** — a frame is captured from the video instead of
  relying on the unreliable `#t=` trick
- ♾️ **Incremental loading** — only the first 60 cards render; the rest load on
  demand so large vaults stay fast
- 🔁 **Optimize** backfills thumbnails for media uploaded before they existed

---

## Project structure

```
RepoLens/
├── public/
│   ├── index.html       # Markup only
│   ├── styles.css       # All styles
│   ├── app.js           # Frontend logic (vanilla JS, no build step)
│   └── logo.svg
├── lib/
│   └── auth.js          # Password check, signed session cookies, throttling
├── routes/
│   └── github.js        # GitHub REST API logic
├── test/
│   └── auth.test.js     # Auth and request-validation tests (node:test)
├── server.js            # Express entry point (exports the app)
├── .env.example         # Environment variable template
├── vercel.json
└── package.json
```

### Repository layout (the storage repo)

```
your-repo/
├── media/               # Originals
│   ├── IMG_1.jpeg
│   ├── clip.mp4
│   └── invoice.pdf
└── thumbs/              # Generated thumbnails (created automatically)
    ├── IMG_1__jpeg.jpg
    └── clip__mp4.jpg
```

Thumbnail names keep the source extension (`IMG_1.jpeg` → `IMG_1__jpeg.jpg`) so
files sharing a base name never collide. A thumbnail is only used when it is
smaller than the original — small images are their own thumbnail. Rename logic
lives in two places and must stay in sync: `thumbNameFor()` in
`routes/github.js` and `public/app.js`.

---

## Setup

### 1. Install

```bash
npm install
```

### 2. Create a GitHub token

Use a **fine-grained token** limited to the storage repo and to
**Contents: Read and write** — that is all RepoLens needs, and it limits the
blast radius if the token ever leaks. (A classic token with `repo` scope also
works, but grants far more access.)

### 3. Create the storage repo

Any repo, public or private. It does not need to be the code repo.

### 4. Configure environment variables

```bash
cp .env.example .env
```

```env
# Auth (required)
APP_PASSWORD=change-me
# Optional: rotate to invalidate all sessions
# SESSION_SECRET=

# GitHub storage
GITHUB_TOKEN=github_pat_xxxxxxxxxxxxxxxxxxxx
GITHUB_USERNAME=your-github-username
GITHUB_REPO=your-repo-name
GITHUB_BRANCH=main

PORT=3000
```

The server refuses all API requests if `APP_PASSWORD` is unset; it never falls
back to "no password".

### 5. Run

```bash
npm start        # production
npm run dev      # auto-reload (Node 18+)
```

Open <http://localhost:3000>, or `http://<your-ip>:3000` from a phone on the
same network.

### 6. Checks

```bash
npm run lint     # syntax check on server and browser JS
npm test         # auth + validation tests (no network access needed)
```

---

## Security model

- `APP_PASSWORD` is read from the environment and compared on the server using a
  constant-time check. Login attempts are throttled to 10 failures per IP per
  15 minutes (in-memory, so per instance).
- A successful login sets `rl_session`, an HMAC-signed cookie valid for 7 days,
  with `HttpOnly` and `SameSite=Lax` (and `Secure` over HTTPS). The signing key
  is `SESSION_SECRET`, or a value derived from `APP_PASSWORD` when unset.
- Every `/api` route except `/api/login`, `/api/logout` and `/api/session`
  requires a valid session. Static assets are public, but contain no secrets.
- Authenticated responses are sent with `Cache-Control: no-store`.
- Delete routes only accept paths under `media/` or `thumbs/` and a well-formed
  sha, so a request cannot touch other files in the repo.

### Why does the browser receive the GitHub token?

`GET /api/config` returns the repo coordinates **and the token** to an
authenticated session. This is deliberate: uploads go straight from the browser
to `api.github.com`, which sidesteps the ~4.5 MB request-body limit on Vercel
serverless functions. The trade-off is that anyone who knows the password can
retrieve the token from their own browser's devtools. Use a fine-grained,
single-repo, contents-only token, and rotate it if you ever share the password.

---

## API

All routes below require a valid session cookie except the auth routes.

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/api/login` | — | `{ password }` → sets session cookie |
| `POST` | `/api/logout` | — | Clears the session cookie |
| `GET` | `/api/session` | — | `{ authenticated, configured }` |
| `GET` | `/api/config` | ✅ | Repo coordinates + token for direct uploads |
| `GET` | `/api/media` | ✅ | List `media/` (includes `thumb_url` when a smaller thumb exists) |
| `GET` | `/api/pdf` | ✅ | `?path=media/…pdf` — streams the PDF inline for in-app preview (`&download=1` for attachment) |
| `DELETE` | `/api/media` | ✅ | `{ path, sha }` — deletes the file and its thumbnail |
| `DELETE` | `/api/thumb` | ✅ | `{ path }` — deletes one thumbnail, keeps the media file |

Uploads do not have a server endpoint: the browser PUTs base64 content to
GitHub's Contents API directly.

### Thumbnails

Thumbnails are generated client-side with Canvas (images) or by capturing a
video frame, then uploaded to `thumbs/`. The gallery falls back to the
full-size file when no thumbnail exists, so older media keeps working. Use the
**Optimize** button to backfill missing thumbnails; it only appears when there
is something to do.

---

## Limits

- **50 MB per file** — enforced in the browser before upload and documented as
  the practical ceiling of the GitHub Contents API. Larger videos need Git LFS
  or a different backend.
- Supported formats: JPEG, PNG, GIF, WebP, MP4, WebM, MOV, PDF.
- Filenames are sanitised to `[a-zA-Z0-9-_.]` and spaces become underscores.
  Re-uploading an existing name updates that file.
- The storage repo grows with every upload; GitHub repos should stay under
  ~1 GB, so prune old media.

---

## Deployment

The app is plain Node.js/Express and exports the Express app from `server.js`
(it only calls `listen()` when run directly), so it works on Vercel and on any
long-running host.

**Vercel** — import the repo, set the environment variables in the project
settings, and deploy. `vercel.json` routes everything to `server.js`. Because
uploads go browser → GitHub, files are not capped by Vercel's body limit.

**Railway / Render / Fly.io / VPS** — set the same environment variables and
run `npm start`. Any Node 18+ runtime provides the global `fetch` the app uses.

On serverless hosts the login throttle resets with each cold start; that is an
accepted trade-off for a single-user vault. Set `SESSION_SECRET` so sessions
survive redeploys.

---

## Credits

Crafted by Ashraf.
