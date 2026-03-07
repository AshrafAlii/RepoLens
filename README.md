# 📷 GitHub Media Vault

A minimal full-stack web app to upload photos and videos directly to a GitHub repository, then preview them in a mobile-friendly gallery.

---

## Features

- 📤 Upload images and videos from any device
- ☁️ Files are stored in a `media/` folder in your GitHub repo
- 🖼️ Mobile-optimised grid gallery
- 🔍 Tap to preview images full-screen or play videos inline
- 🗑️ Delete files directly from the gallery
- 💧 Drag-and-drop upload support

---

## Project Structure

```
github-media-vault/
├── public/
│   └── index.html       # Frontend (HTML + CSS + vanilla JS)
├── routes/
│   └── github.js        # GitHub REST API logic
├── server.js            # Express server entry point
├── package.json
├── .env.example         # Environment variable template
├── .gitignore
└── README.md
```

---

## Setup

### 1. Clone / download the project

```bash
git clone https://github.com/your-username/github-media-vault.git
cd github-media-vault
```

### 2. Install dependencies

```bash
npm install
```

### 3. Create a GitHub Personal Access Token

1. Go to **GitHub → Settings → Developer settings → Personal access tokens → Tokens (classic)**
2. Click **Generate new token (classic)**
3. Give it a name (e.g. `media-vault`)
4. Under **Scopes**, tick **`repo`** (full control of private repositories)
5. Click **Generate token** and copy it — you won't see it again!

### 4. Create the target repository

Create a new (or use an existing) GitHub repository where your media will be stored. It can be public or private.

### 5. Configure environment variables

```bash
cp .env.example .env
```

Edit `.env` and fill in your values:

```env
GITHUB_TOKEN=ghp_xxxxxxxxxxxxxxxxxxxx
GITHUB_USERNAME=your-github-username
GITHUB_REPO=your-repo-name
GITHUB_BRANCH=main
PORT=3000
```

### 6. Start the server

```bash
npm start
```

Or with auto-reload during development (Node 18+):

```bash
npm run dev
```

Open **http://localhost:3000** in your browser (or on your phone if on the same network: `http://<your-ip>:3000`).

---

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/media` | List all files in the `media/` folder |
| `POST` | `/api/upload` | Upload a file (multipart/form-data, field: `file`) |
| `DELETE` | `/api/media` | Delete a file (`{ path, sha }` in body) |

---

## Notes

- Files are stored under `media/` in the repository root
- File names are prefixed with a timestamp to avoid collisions
- Max upload size: **100 MB** per file
- Supported formats: JPEG, PNG, GIF, WebP, MP4, WebM, MOV
- The GitHub API has a **soft limit of 50 MB** per file for the Contents API. For large videos, consider Git LFS instead.

---

## Deployment

This is a plain Node.js/Express app and can be deployed to:

- **Railway** — `railway up`
- **Render** — connect your repo, set env vars in the dashboard
- **Fly.io** — `fly launch`
- **Any VPS** — install Node, set env vars, run `npm start` with PM2

Set the same environment variables in your hosting platform's dashboard.
