  // ── State ──────────────────────────────────────────────
  let allMedia = [];
  let activeTab = 'all';
  let pendingDel = null;

  // ── Helpers ────────────────────────────────────────────
  const $ = id => document.getElementById(id);

  function fmt(bytes) {
    if (!bytes) return '';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + ' KB';
    return (bytes / 1048576).toFixed(1) + ' MB';
  }

  // ── Toast ──────────────────────────────────────────────
  let toastT;
  function toast(msg, type = 'success') {
    clearTimeout(toastT);
    const el = $('toast');
    el.textContent = msg;
    el.className = `toast show ${type}`;
    toastT = setTimeout(() => el.classList.remove('show'), 3200);
  }

  // ── Thumbnails ─────────────────────────────────────────
  // Small JPEG previews are generated in the browser and stored in the repo's
  // `thumbs/` folder, so the gallery never downloads full-size media files.
  const THUMB_DIR = 'thumbs';
  const THUMB_MAX_DIM = 480;
  const THUMB_QUALITY = 0.82;

  // Upload ceiling. Must match the limit documented in the README and the
  // practical cap of the GitHub Contents API.
  const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
  const MAX_UPLOAD_LABEL = '50 MB';

  // Thumbnail file name for a media file.
  //   IMG_1.jpeg -> IMG_1__jpeg.jpg      clip.mp4 -> clip__mp4.jpg
  // The source extension stays in the name so the mapping stays unique even
  // when two files share a base name (a.png vs a.jpg vs a.mp4).
  // Keep in sync with thumbNameFor() in routes/github.js.
  function thumbNameFor(name) {
    const dot = name.lastIndexOf('.');
    const ext = dot > 0 ? name.slice(dot + 1).toLowerCase() : 'bin';
    const base = dot > 0 ? name.slice(0, dot) : name;
    return `${base}__${ext}.jpg`;
  }

  // Works out whether a file is an image or a video, falling back to the
  // extension when the browser does not report a useful MIME type.
  function mediaKind(file) {
    const type = (file.type || '').toLowerCase();
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    const name = (file.name || '').toLowerCase();
    if (/\.(jpe?g|png|gif|webp|bmp|avif|heic)$/.test(name)) return 'image';
    if (/\.(mp4|webm|mov|m4v|avi|mkv)$/.test(name)) return 'video';
    return null;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      if (!canvas.toBlob) return reject(new Error('Canvas export unsupported'));
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Could not export thumbnail'));
      }, type, quality);
    });
  }

  // Decodes an image file, honouring EXIF orientation where supported.
  async function decodeImage(file) {
    if (window.createImageBitmap) {
      try {
        return await createImageBitmap(file, { imageOrientation: 'from-image' });
      } catch (err) { /* fall through to the <img> decoder */ }
    }
    const url = URL.createObjectURL(file);
    try {
      return await new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = () => reject(new Error('Unsupported image format'));
        img.src = url;
      });
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Scales a source (image or video frame) down into a canvas.
  function drawToCanvas(source, sw, sh) {
    const scale = Math.min(1, THUMB_MAX_DIM / Math.max(sw, sh));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(sw * scale));
    canvas.height = Math.max(1, Math.round(sh * scale));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, canvas.width, canvas.height);
    return canvas;
  }

  async function makeImageThumb(file) {
    const source = await decodeImage(file);
    const sw = source.width || source.naturalWidth;
    const sh = source.height || source.naturalHeight;
    if (!sw || !sh) throw new Error('Could not read image dimensions');
    const canvas = drawToCanvas(source, sw, sh);
    if (source.close) source.close();
    return await canvasToBlob(canvas, 'image/jpeg', THUMB_QUALITY);
  }

  // Grabs a frame from a video to use as its poster image. Several seek
  // positions are tried because some encodes have no keyframe at 0.5s.
  async function makeVideoPoster(file) {
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');

    try {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Video load timed out')), 20000);
        video.onloadeddata = () => { clearTimeout(timer); resolve(); };
        video.onerror = () => { clearTimeout(timer); reject(new Error('Unsupported video format')); };
        video.src = url;
      });

      const duration = isFinite(video.duration) ? video.duration : 0;

      for (const pos of [0.5, 1, 2, 0.1]) {
        const target = duration ? Math.min(pos, Math.max(0, duration - 0.05)) : pos;
        try {
          video.currentTime = target;
          await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('Seek timed out')), 8000);
            video.onseeked = () => { clearTimeout(timer); resolve(); };
            video.onerror = () => { clearTimeout(timer); reject(new Error('Seek failed')); };
          });
        } catch (err) {
          continue; // try the next position
        }

        const w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) continue;
        const canvas = drawToCanvas(video, w, h);
        return await canvasToBlob(canvas, 'image/jpeg', 0.78);
      }

      throw new Error('Could not extract a poster frame');
    } finally {
      URL.revokeObjectURL(url);
    }
  }

  // Returns a thumbnail blob for a media file, or null when it has none.
  // Returns null when the thumbnail would not be smaller than the source —
  // small images are already their own thumbnail.
  async function makeThumb(file) {
    const kind = mediaKind(file);
    let blob = null;
    if (kind === 'image') blob = await makeImageThumb(file);
    else if (kind === 'video') blob = await makeVideoPoster(file);
    else return null; // PDFs have no thumbnail

    if (blob && file.size && blob.size >= file.size) return null;
    return blob;
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(blob);
    });
  }

  // ── GitHub Contents API helpers ─────────────────────────
  function ghHeaders(token, extra) {
    return {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'RepoLens',
      ...(extra || {}),
    };
  }

  function ghUrl(cfg, filePath) {
    return `https://api.github.com/repos/${cfg.owner}/${cfg.repo}/contents/${filePath}`;
  }

  // Blob SHA of an existing file, or null when it does not exist yet.
  async function ghGetSha(cfg, filePath) {
    const res = await fetch(`${ghUrl(cfg, filePath)}?ref=${cfg.branch}`, {
      headers: ghHeaders(cfg.token),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.sha || null;
  }

  // Creates a file, or replaces it when it already exists.
  async function ghPut(cfg, filePath, base64Content, message) {
    const sha = await ghGetSha(cfg, filePath);
    const res = await fetch(ghUrl(cfg, filePath), {
      method: 'PUT',
      headers: ghHeaders(cfg.token, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({
        message,
        content: base64Content,
        branch: cfg.branch,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.message || 'GitHub upload failed');
    }
    return await res.json();
  }

  // ── Upload ─────────────────────────────────────────────
  $('fileInput').addEventListener('change', e => doUpload(e.target.files));
  $('mobInput').addEventListener('change', e => doUpload(e.target.files));

  const uploadZone = $('uploadZone');
  uploadZone.addEventListener('dragover', e => { e.preventDefault(); $('uploadCard').classList.add('drag-over'); });
  uploadZone.addEventListener('dragleave', () => $('uploadCard').classList.remove('drag-over'));
  uploadZone.addEventListener('drop', e => { e.preventDefault(); $('uploadCard').classList.remove('drag-over'); doUpload(e.dataTransfer.files); });

  // ── Session ────────────────────────────────────────────
  // The password is verified by the server (APP_PASSWORD). The browser only
  // holds an HttpOnly session cookie, which JavaScript cannot read.
  function showLogin(message) {
    $('loginOverlay').classList.remove('hidden');
    if (message) {
      $('loginError').textContent = message;
      $('loginError').classList.add('show');
    }
    setTimeout(() => $('loginPass').focus(), 50);
  }

  function hideLogin() {
    $('loginOverlay').classList.add('hidden');
    $('loginError').classList.remove('show');
    $('loginPass').value = '';
  }

  // Any API call may come back 401 when the session expired or was cleared.
  // Returns true when it did, after putting the login screen back up.
  function handleAuthError(res) {
    if (res.status !== 401) return false;
    ghConfig = null;
    showLogin('Your session expired. Please sign in again.');
    return true;
  }

  // ── GitHub config (fetched once per session) ───────────
  // The token is only handed out by /api/config to an authenticated session.
  let ghConfig = null;
  async function getConfig() {
    if (ghConfig) return ghConfig;
    const res = await fetch('/api/config');
    if (handleAuthError(res)) throw new Error('Please sign in again');
    if (!res.ok) throw new Error('Could not load upload configuration');
    ghConfig = await res.json();
    return ghConfig;
  }

  // ── Upload pill helpers ────────────────────────────────
  function pillShow(filename, status, pct, done = false) {
    const pill = $('uploadPill');
    $('upFilename').textContent = filename;
    $('upStatus').textContent = status;
    $('upPct').textContent = pct + '%';
    $('upFill').style.width = pct + '%';
    pill.classList.toggle('done', done);
    pill.classList.add('visible');
  }

  function pillHide() {
    const pill = $('uploadPill');
    pill.classList.remove('visible');
    setTimeout(() => { pill.classList.remove('done'); $('upFill').style.width = '0%'; }, 400);
  }

  async function doUpload(files) {
    if (!files?.length) return;

    // Reject oversized files up front. GitHub's Contents API will not accept
    // them, and we would otherwise waste a long base64 round trip first.
    const selected = Array.from(files);
    const queue = selected.filter(f => f.size <= MAX_UPLOAD_BYTES);
    selected
      .filter(f => f.size > MAX_UPLOAD_BYTES)
      .forEach(f => toast(`✗ ${f.name} is ${fmt(f.size)} — the limit is ${MAX_UPLOAD_LABEL}`, 'error'));

    if (!queue.length) {
      $('fileInput').value = '';
      $('mobInput').value = '';
      return;
    }

    const total = queue.length;
    $('uploadProgress').style.display = 'block';
    $('fileInput').disabled = true;
    let successCount = 0;
    const thumbWarnings = [];

    let cfg;
    try {
      cfg = await getConfig();
    } catch (err) {
      $('uploadProgress').style.display = 'none';
      $('fileInput').disabled = false;
      toast('✗ ' + err.message, 'error');
      return;
    }

    for (let i = 0; i < total; i++) {
      const file = queue[i];
      const fileNum = `${i + 1} / ${total}`;
      const pct = Math.round((i / total) * 100);

      // Update old sidebar bar
      $('progFill').style.width = pct + '%';
      $('progPct').textContent = pct + '%';
      $('progName').textContent = file.name;

      // Update floating pill
      pillShow(file.name, `File ${fileNum} · ${fmt(file.size)}`, pct);

      try {
        // Read file as base64 directly in browser
        const base64 = await blobToBase64(file);

        // Update pill to show uploading state
        pillShow(file.name, `Uploading ${fileNum}…`, pct);

        // Clean filename
        const ext = file.name.includes('.') ? file.name.split('.').pop().toLowerCase() : 'bin';
        const baseName = file.name
          .replace(/\.[^/.]+$/, '')
          .replace(/[^a-zA-Z0-9\-_. ]/g, '')
          .replace(/\s+/g, '_')
          .replace(/_+/g, '_')
          .trim() || 'file';
        const safeName = `${baseName}.${ext}`;
        const filePath = `media/${safeName}`;

        // Upload directly to GitHub
        await ghPut(cfg, filePath, base64, `Upload ${safeName}`);

        // Generate a small thumbnail and store it next to the media.
        // Best effort - a missing thumbnail falls back to the full-size file.
        try {
          const thumbBlob = await makeThumb(file);
          if (thumbBlob) {
            const thumbB64 = await blobToBase64(thumbBlob);
            await ghPut(cfg, `${THUMB_DIR}/${thumbNameFor(safeName)}`, thumbB64, `Thumbnail ${safeName}`);
          }
        } catch (err) {
          thumbWarnings.push(`${safeName}: ${err.message}`);
          console.warn('[thumb]', safeName, err);
        }

        successCount++;
        // Show per-file completion in pill
        const doneCount = successCount;
        const newPct = Math.round(((i + 1) / total) * 100);
        $('progFill').style.width = newPct + '%';
        $('progPct').textContent = newPct + '%';
        pillShow(file.name, `Done ${doneCount} / ${total}`, newPct);

      } catch (err) {
        toast('✗ ' + file.name + ': ' + err.message, 'error');
        pillShow(file.name, `✗ Failed — ${err.message}`, Math.round((i / total) * 100));
      }
    }

    // Final done state
    $('progFill').style.width = '100%';
    $('progPct').textContent = '100%';
    $('progName').textContent = 'Done!';
    pillShow(`${successCount} file${successCount !== 1 ? 's' : ''} uploaded`, 'Complete ✓', 100, true);

    setTimeout(() => {
      $('uploadProgress').style.display = 'none';
      $('progFill').style.width = '0%';
      $('fileInput').disabled = false;
      $('fileInput').value = '';
      $('mobInput').value = '';
      pillHide();
    }, 2200);

    if (successCount > 0) toast(`✓ ${successCount} file${successCount > 1 ? 's' : ''} uploaded`);
    if (thumbWarnings.length) {
      console.warn('[thumb] skipped:', thumbWarnings);
      toast(`⚠ ${thumbWarnings.length} thumbnail${thumbWarnings.length > 1 ? 's' : ''} skipped`, 'error');
    }
    loadAll();
  }

  // ── Load all media ─────────────────────────────────────
  async function loadAll() {
    renderSkeletons();
    visibleCount = PAGE_SIZE;
    try {
      const res = await fetch('/api/media');
      if (handleAuthError(res)) {
        $('contentArea').innerHTML = '';
        return;
      }
      if (!res.ok) throw new Error('Failed to load');
      allMedia = await res.json();
      updateCounts();
      renderTab(activeTab);
    } catch (err) {
      $('contentArea').innerHTML = '';
      $('pageSub').textContent = 'Could not load media';
      toast('✗ ' + err.message, 'error');
    }
  }

  function updateCounts() {
    const total   = allMedia.length;
    const photos  = allMedia.filter(m => m.type === 'image').length;
    const videos  = allMedia.filter(m => m.type === 'video').length;
    const pdfs    = allMedia.filter(m => m.type === 'pdf').length;

    $('statPhotos').textContent = photos;
    $('statVideos').textContent = videos;
    $('statPdfs').textContent   = pdfs;

    $('pageSub').textContent = `${total} file${total !== 1 ? 's' : ''} stored in your vault`;

    // Desktop tabs
    $('dt-cnt-all').textContent   = total;
    $('dt-cnt-image').textContent = photos;
    $('dt-cnt-video').textContent = videos;
    $('dt-cnt-pdf').textContent   = pdfs;

    // Mobile tabs
    $('mob-cnt-all').textContent   = total;
    $('mob-cnt-image').textContent = photos;
    $('mob-cnt-video').textContent = videos;
    $('mob-cnt-pdf').textContent   = pdfs;

    updateThumbButton();
  }

  // ── Thumbnail backfill ─────────────────────────────────
  // Files uploaded before thumbnails existed (or uploaded through the server
  // route) have no preview yet. This generates and uploads the missing ones.
  function missingThumbItems() {
    return allMedia.filter(m =>
      (m.type === 'image' || m.type === 'video') && !m.thumb_url
    );
  }

  function updateThumbButton() {
    const btn = $('thumbBtn');
    if (!btn) return;
    const missing = missingThumbItems().length;
    btn.style.display = missing ? '' : 'none';
    btn.title = missing
      ? `Create thumbnails for ${missing} file${missing > 1 ? 's' : ''}`
      : '';
  }

  async function backfillThumbs() {
    const btn = $('thumbBtn');
    const targets = missingThumbItems();
    if (!targets.length) {
      toast('All thumbnails are up to date');
      return;
    }

    const originalHtml = btn.innerHTML;
    let done = 0;
    let skipped = 0;
    let failed = 0;

    try {
      const cfg = await getConfig();

      for (const item of targets) {
        btn.innerHTML = `Optimizing ${done + skipped + failed + 1}/${targets.length}`;
        try {
          const res = await fetch(item.download_url);
          if (!res.ok) throw new Error('Download failed');
          const blob = await res.blob();
          const file = new File([blob], item.name, {
            type: blob.type || 'application/octet-stream',
          });

          const thumbBlob = await makeThumb(file);
          if (!thumbBlob) {
            // The source is already small enough to be its own thumbnail —
            // drop any leftover thumbnail file for it.
            skipped++;
            await deleteThumbFile(item.thumb_path);
            continue;
          }

          const thumbB64 = await blobToBase64(thumbBlob);
          const path = item.thumb_path || `${THUMB_DIR}/${thumbNameFor(item.name)}`;
          await ghPut(cfg, path, thumbB64, `Thumbnail ${item.name}`);
          done++;
        } catch (err) {
          failed++;
          console.warn('[thumb]', item.name, err);
        }
      }

      await loadAll();
      const parts = [];
      if (done) parts.push(`${done} created`);
      if (skipped) parts.push(`${skipped} already small`);
      if (failed) parts.push(`${failed} failed`);
      toast('✓ ' + (parts.join(', ') || 'nothing to do'), failed ? 'error' : 'success');
    } catch (err) {
      toast('✗ ' + err.message, 'error');
    } finally {
      btn.innerHTML = originalHtml;
    }
  }

  // Removes a thumbnail file without touching its media file.
  async function deleteThumbFile(thumbPath) {
    if (!thumbPath) return;
    try {
      await fetch('/api/thumb', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: thumbPath }),
      });
    } catch (err) {
      console.warn('[thumb] cleanup failed:', err);
    }
  }

  // ── Tabs ───────────────────────────────────────────────
  function setTab(tab) {
    activeTab = tab;
    visibleCount = PAGE_SIZE;
    document.querySelectorAll('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    renderTab(tab);
  }

  document.querySelectorAll('.tab').forEach(b => b.addEventListener('click', () => setTab(b.dataset.tab)));

  // ── Skeleton ───────────────────────────────────────────
  function renderSkeletons() {
    $('contentArea').innerHTML = `<div class="gallery-grid">${
      Array.from({ length: 12 }).map(() => `
        <div class="skel">
          <div class="skel-thumb"></div>
          <div class="skel-foot">
            <div class="skel-line"></div>
            <div class="skel-line s"></div>
          </div>
        </div>`).join('')
    }</div>`;
  }

  // ── Grid view (photos + videos) ────────────────────────
  // Shared card markup — used by every tab so thumbnails, metadata and
  // overlays stay identical across views.
  function mediaCardHtml(item, idx) {
    const isVideo = item.type === 'video';

    // Prefer the small generated thumbnail; fall back to the full-size file.
    const preview = isVideo
      ? `<div class="vid-thumb-wrap">
           ${item.thumb_url
             ? `<img src="${item.thumb_url}" alt="${item.name}" loading="lazy" />`
             : `<video src="${item.download_url}#t=0.5" preload="metadata" muted playsinline
                 onerror="this.parentElement.innerHTML='<div class=vid-ph><div class=vid-ph-icon><svg width=18 height=18 viewBox=&quot;0 0 24 24&quot; fill=none stroke=&quot;var(--gold)&quot; stroke-width=2><polygon points=&quot;5 3 19 12 5 21 5 3&quot;/></svg></div><span>Video</span></div>'">
                 </video>`}
           <div class="vid-play-badge">
             <div class="vid-play-circle">
               <svg width="14" height="14" viewBox="0 0 24 24" fill="white" stroke="none">
                 <polygon points="6 3 20 12 6 21 6 3"/>
               </svg>
             </div>
           </div>
         </div>`
      : `<img src="${item.thumb_url || item.download_url}" alt="${item.name}" loading="lazy" />`;

    return `
        <div class="media-card" data-idx="${idx}" data-sha="${item.sha}">
          <div class="media-thumb">
            <div class="select-check" data-sha="${item.sha}">
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </div>
            ${preview}
            <div class="card-overlay">
              <div class="ov-acts">
                <button class="ov-btn view-btn" data-idx="${idx}" title="View" aria-label="View">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>
                  </svg>
                  <span>View</span>
                </button>
                <button class="ov-btn dl-btn" data-url="${item.download_url}" data-name="${item.name}" title="Download" aria-label="Download">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  <span>Save</span>
                </button>
                <button class="ov-btn del del-btn" data-idx="${idx}" title="Delete" aria-label="Delete">
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                  </svg>
                  <span>Delete</span>
                </button>
              </div>
            </div>
          </div>
          <div class="card-footer">
            <div class="card-name">${item.name}</div>
            <div class="card-meta">
              <span class="card-type">${item.type}</span>
              <span class="card-size">${fmt(item.size)}</span>
            </div>
          </div>
        </div>`;
  }

  // Binds the interactive parts of the cards. Elements already bound are
  // skipped so appended cards never get a second listener.
  function bindMediaCards(root, items) {
    root.querySelectorAll('.view-btn:not([data-bound])').forEach(b => {
      b.setAttribute('data-bound', '1');
      b.addEventListener('click', e => { e.stopPropagation(); if (!selectMode) openModal(+b.dataset.idx, items); });
    });
    root.querySelectorAll('.dl-btn:not([data-bound])').forEach(b => {
      b.setAttribute('data-bound', '1');
      b.addEventListener('click', e => { e.stopPropagation(); if (!selectMode) downloadFile(b.dataset.url, b.dataset.name); });
    });
    root.querySelectorAll('.del-btn:not([data-bound])').forEach(b => {
      b.setAttribute('data-bound', '1');
      b.addEventListener('click', e => { e.stopPropagation(); if (!selectMode) openConfirm(+b.dataset.idx, items); });
    });
    root.querySelectorAll('.select-check:not([data-bound])').forEach(chk => {
      chk.setAttribute('data-bound', '1');
      chk.addEventListener('click', e => { e.stopPropagation(); toggleItemSelect(chk.dataset.sha); });
    });
    root.querySelectorAll('.media-card:not([data-bound])').forEach(c => {
      c.setAttribute('data-bound', '1');
      c.addEventListener('click', () => {
        if (selectMode) toggleItemSelect(c.dataset.sha);
        else openModal(+c.dataset.idx, items);
      });
    });
  }

  // ── Incremental rendering ─────────────────────────────
  // Only the first PAGE_SIZE cards are rendered; the rest load on demand so a
  // large vault does not flood the DOM with hundreds of cards at once.
  const PAGE_SIZE = 60;
  let visibleCount = PAGE_SIZE;
  let currentGridItems = [];

  function renderLoadMore(grid, items) {
    if (!grid || items.length <= visibleCount) return;
    const btn = document.createElement('button');
    btn.className = 'load-more';
    btn.id = 'loadMoreBtn';
    btn.textContent = `Show more (${items.length - visibleCount} remaining)`;
    btn.addEventListener('click', loadMore);
    grid.insertAdjacentElement('afterend', btn);
  }

  function loadMore() {
    const grid = $('contentArea').querySelector('.gallery-grid');
    if (!grid) return;

    const items = currentGridItems;
    const startIdx = visibleCount;
    const next = items.slice(startIdx, startIdx + PAGE_SIZE);
    if (!next.length) return;

    grid.insertAdjacentHTML('beforeend', next.map((item, i) => mediaCardHtml(item, startIdx + i)).join(''));
    visibleCount += next.length;

    bindMediaCards(grid, items);

    const btn = $('loadMoreBtn');
    if (btn) {
      if (items.length <= visibleCount) btn.remove();
      else btn.textContent = `Show more (${items.length - visibleCount} remaining)`;
    }

    // Bring the newly added cards into view without yanking the page around.
    const firstNew = grid.children[startIdx];
    if (firstNew) firstNew.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function renderGrid(items) {
    const content = $('contentArea');

    if (!items.length) {
      currentGridItems = [];
      content.innerHTML = emptyState(activeTab);
      return;
    }

    currentGridItems = items;
    const shown = items.slice(0, visibleCount);

    content.innerHTML = `<div class="gallery-grid">${shown.map(mediaCardHtml).join('')}</div>`;

    bindMediaCards(content, items);
    renderLoadMore(content.querySelector('.gallery-grid'), items);
  }

  // ── PDF list view ──────────────────────────────────────
  function renderPDFList(items) {
    const content = $('contentArea');

    if (!items.length) {
      content.innerHTML = emptyState('pdf');
      return;
    }

    content.innerHTML = `<div class="pdf-list">${
      items.map((item, idx) => `
        <div class="pdf-row" data-idx="${idx}" data-sha="${item.sha}" title="Open preview">
          <div class="pdf-select-check" data-sha="${item.sha}">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <div class="pdf-row-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--pdf)" stroke-width="1.8">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="9" y1="13" x2="15" y2="13"/>
              <line x1="9" y1="17" x2="15" y2="17"/>
            </svg>
          </div>
          <div class="pdf-row-info">
            <div class="pdf-row-name">${item.name}</div>
            <div class="pdf-row-meta">${fmt(item.size)} · Tap to preview</div>
          </div>
          <div class="pdf-row-actions">
            <button class="pdf-act dl" data-url="${item.download_url}" data-name="${item.name}" title="Download" aria-label="Download">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                <polyline points="7 10 12 15 17 10"/>
                <line x1="12" y1="15" x2="12" y2="3"/>
              </svg>
              <span>Download</span>
            </button>
            <button class="pdf-act del pdf-del-btn" data-idx="${idx}" title="Delete" aria-label="Delete">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"/>
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
              </svg>
              <span>Delete</span>
            </button>
          </div>
        </div>`).join('')
    }</div>`;

    content.querySelectorAll('.pdf-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.pdf-act')) return;
        if (selectMode) { toggleItemSelect(row.dataset.sha); return; }
        openPDFModal(items[+row.dataset.idx]);
      });
    });
    content.querySelectorAll('.pdf-select-check').forEach(chk =>
      chk.addEventListener('click', e => { e.stopPropagation(); toggleItemSelect(chk.dataset.sha); })
    );
    content.querySelectorAll('.pdf-del-btn').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); if (!selectMode) openConfirm(+b.dataset.idx, items); })
    );
    content.querySelectorAll('.pdf-act.dl').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); if (!selectMode) downloadFile(b.dataset.url, b.dataset.name); })
    );
  }

  // ── "All" tab: show photos grid + pdf list ─────────────
  function renderTab(tab) {
    if (tab !== 'all') {
      const items = allMedia.filter(m => m.type === tab);
      if (tab === 'pdf') {
        currentGridItems = [];
        renderPDFList(items);
      } else {
        renderGrid(items);
      }
      return;
    }

    // All tab: show media grid then PDF section
    const mediaItems = allMedia.filter(m => m.type !== 'pdf');
    const pdfItems   = allMedia.filter(m => m.type === 'pdf');
    const content = $('contentArea');

    if (!allMedia.length) {
      currentGridItems = [];
      content.innerHTML = emptyState('all');
      return;
    }

    currentGridItems = mediaItems;
    const shown = mediaItems.slice(0, visibleCount);

    // Render media section
    let html = '';

    if (shown.length) {
      html += `<div class="gallery-grid" style="margin-bottom: ${pdfItems.length ? '36px' : '0'}">${shown.map(mediaCardHtml).join('')}</div>`;
    }

    // PDF section
    if (pdfItems.length) {
      html += `
        <div class="section-head">
          <span class="section-title">Documents</span>
          <span class="section-count">${pdfItems.length} PDF${pdfItems.length > 1 ? 's' : ''}</span>
        </div>
        <div class="pdf-list">${
          pdfItems.map((item, idx) => `
            <div class="pdf-row" data-idx="${idx}" data-sha="${item.sha}" title="Open preview">
              <div class="pdf-select-check" data-sha="${item.sha}">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="3">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </div>
              <div class="pdf-row-icon">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--pdf)" stroke-width="1.8">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                  <polyline points="14 2 14 8 20 8"/>
                  <line x1="9" y1="13" x2="15" y2="13"/>
                  <line x1="9" y1="17" x2="15" y2="17"/>
                </svg>
              </div>
              <div class="pdf-row-info">
                <div class="pdf-row-name">${item.name}</div>
                <div class="pdf-row-meta">${fmt(item.size)} · Tap to preview</div>
              </div>
              <div class="pdf-row-actions">
                <button class="pdf-act dl all-pdf-dl" data-url="${item.download_url}" data-name="${item.name}" title="Download" aria-label="Download">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                  </svg>
                  <span>Download</span>
                </button>
                <button class="pdf-act del pdf-del-btn" data-src="pdf" data-idx="${idx}">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="3 6 5 6 21 6"/>
                    <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
                  </svg>
                  <span>Delete</span>
                </button>
              </div>
            </div>`).join('')
        }</div>`;
    }

    content.innerHTML = html;

    // Bind events
    bindMediaCards(content, mediaItems);

    content.querySelectorAll('.pdf-del-btn').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); if (!selectMode) openConfirm(+b.dataset.idx, pdfItems); })
    );

    content.querySelectorAll('.all-pdf-dl').forEach(b =>
      b.addEventListener('click', e => { e.stopPropagation(); if (!selectMode) downloadFile(b.dataset.url, b.dataset.name); })
    );

    content.querySelectorAll('.pdf-list .pdf-row').forEach(row => {
      row.addEventListener('click', e => {
        if (e.target.closest('.pdf-act')) return;
        if (selectMode) { toggleItemSelect(row.dataset.sha); return; }
        openPDFModal(pdfItems[+row.dataset.idx]);
      });
    });

    content.querySelectorAll('.pdf-select-check').forEach(chk =>
      chk.addEventListener('click', e => { e.stopPropagation(); toggleItemSelect(chk.dataset.sha); })
    );

    renderLoadMore(content.querySelector('.gallery-grid'), mediaItems);
  }

  // ── Empty states ───────────────────────────────────────
  function emptyState(tab) {
    const msgs = {
      all:   ['Nothing here yet', 'Upload photos, videos, or PDFs to get started.'],
      image: ['No photos yet', 'Upload some images to see them here.'],
      video: ['No videos yet', 'Upload video files to see them here.'],
      pdf:   ['No documents yet', 'Upload PDF files to see them here.'],
    };
    const [title, desc] = msgs[tab] || msgs.all;
    return `<div class="empty">
      <div class="empty-ico">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="var(--text3)" stroke-width="1.5">
          <rect x="3" y="3" width="18" height="18" rx="3"/>
          <circle cx="8.5" cy="8.5" r="1.5"/>
          <polyline points="21 15 16 10 5 21"/>
        </svg>
      </div>
      <div class="empty-title">${title}</div>
      <p class="empty-desc">${desc}</p>
    </div>`;
  }

  // ── Select Mode ────────────────────────────────────────
  let selectMode = false;
  let selectedShas = new Set();

  function toggleSelectMode() {
    selectMode = !selectMode;
    selectedShas.clear();

    document.body.classList.toggle('select-mode', selectMode);
    $('bulkBar').classList.toggle('visible', selectMode);
    $('uploadFab').style.display = selectMode ? 'none' : '';

    // Highlight select buttons
    ['selectModeBtn', 'mobSelectBtn'].forEach(id => {
      const btn = $(id);
      if (btn) btn.classList.toggle('select-active', selectMode);
    });

    updateBulkBar();

    if (!selectMode) {
      // Clear all checked states visually
      document.querySelectorAll('.select-check.checked, .pdf-select-check.checked').forEach(el => el.classList.remove('checked'));
      document.querySelectorAll('.media-card.selected, .pdf-row.selected').forEach(el => el.classList.remove('selected'));
    }
  }

  function toggleItemSelect(sha) {
    if (!sha) return;
    if (selectedShas.has(sha)) {
      selectedShas.delete(sha);
    } else {
      selectedShas.add(sha);
    }
    // Update visual state for all matching elements (card + check)
    document.querySelectorAll(`[data-sha="${sha}"]`).forEach(el => {
      if (el.classList.contains('select-check') || el.classList.contains('pdf-select-check')) {
        el.classList.toggle('checked', selectedShas.has(sha));
      } else {
        el.classList.toggle('selected', selectedShas.has(sha));
      }
    });
    updateBulkBar();
  }

  function updateBulkBar() {
    const n = selectedShas.size;
    $('bulkCount').textContent = n === 0 ? 'None selected' : `${n} selected`;
    $('bulkDeleteBtn').disabled = n === 0;
    // Update select-all button label
    const visibleShas = [...document.querySelectorAll('[data-sha].media-card, [data-sha].pdf-row')].map(el => el.dataset.sha);
    const allSelected = visibleShas.length > 0 && visibleShas.every(s => selectedShas.has(s));
    $('bulkSelectAll').textContent = allSelected ? 'Deselect all' : 'Select all';
  }

  $('bulkSelectAll').addEventListener('click', () => {
    const allEls = [...document.querySelectorAll('[data-sha].media-card, [data-sha].pdf-row')];
    const allSelected = allEls.every(el => selectedShas.has(el.dataset.sha));
    allEls.forEach(el => {
      const sha = el.dataset.sha;
      if (allSelected) {
        selectedShas.delete(sha);
      } else {
        selectedShas.add(sha);
      }
      el.classList.toggle('selected', selectedShas.has(sha));
      document.querySelectorAll(`.select-check[data-sha="${sha}"], .pdf-select-check[data-sha="${sha}"]`)
        .forEach(chk => chk.classList.toggle('checked', selectedShas.has(sha)));
    });
    updateBulkBar();
  });

  async function bulkDelete() {
    if (selectedShas.size === 0) return;
    const count = selectedShas.size;
    const items = allMedia.filter(m => selectedShas.has(m.sha));

    // Confirm
    const confirmed = await new Promise(resolve => {
      $('cFname').textContent = `${count} item${count > 1 ? 's' : ''}`;
      $('confirmOverlay').classList.add('open');
      const onConfirm = () => {
        cleanup(); resolve(true);
      };
      const onCancel = () => {
        cleanup(); resolve(false);
      };
      function cleanup() {
        $('cConfirm').removeEventListener('click', onConfirm);
        $('cCancel').removeEventListener('click', onCancel);
        $('confirmOverlay').classList.remove('open');
      }
      $('cConfirm').addEventListener('click', onConfirm, { once: true });
      $('cCancel').addEventListener('click', onCancel, { once: true });
    });

    if (!confirmed) return;

    toggleSelectMode(); // exit select mode

    toast(`🗑 Deleting ${count} items…`);
    let deleted = 0, failed = 0;

    for (const item of items) {
      try {
        const res = await fetch('/api/media', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: item.path, sha: item.sha }),
        });
        if (!res.ok) throw new Error();
        deleted++;
      } catch {
        failed++;
      }
    }

    if (deleted > 0) toast(`✓ Deleted ${deleted} item${deleted > 1 ? 's' : ''}`);
    if (failed > 0) toast(`✗ ${failed} failed to delete`, 'error');
    loadAll();
  }

  // ── Download ───────────────────────────────────────────
  async function downloadFile(url, filename) {
    try {
      toast('⬇ Downloading…');
      const res = await fetch(url);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
      toast('✓ Downloaded: ' + filename);
    } catch (err) {
      toast('✗ ' + err.message, 'error');
    }
  }

  // ── Modal ──────────────────────────────────────────────
  let modalItems = [];
  let modalIdx = null;
  let currentSlide = null;
  let isAnimating = false;

  function openModal(idx, items) {
    modalItems = items.filter(m => m.type === 'image' || m.type === 'video');
    const item = items[idx];
    if (!item) return;
    const filteredIdx = modalItems.findIndex(m => m.sha === item.sha);
    modalIdx = filteredIdx >= 0 ? filteredIdx : 0;
    $('modalMedia').innerHTML = '';
    currentSlide = null;
    isAnimating = false;
    renderModal(0);
    $('modal').classList.add('open');
    document.body.style.overflow = 'hidden';
  }

  function buildSlide(item) {
    const el = document.createElement('div');
    el.className = 'modal-slide';
    el.innerHTML = item.type === 'video'
      ? `<video controls autoplay playsinline><source src="${item.download_url}" /></video>`
      : `<img src="${item.download_url}" alt="${item.name}" draggable="false" />`;
    return el;
  }

  function renderModal(dir) {
    const item = modalItems[modalIdx];
    if (!item) return;

    $('modalFname').textContent = item.name;
    $('modalCounter').textContent = `${modalIdx + 1} / ${modalItems.length}`;
    $('modal').dataset.src = JSON.stringify(item);
    $('modalPrev').classList.toggle('hidden', modalIdx === 0);
    $('modalNext').classList.toggle('hidden', modalIdx === modalItems.length - 1);

    const W = window.innerWidth;
    const newSlide = buildSlide(item);
    const media = $('modalMedia');

    if (!currentSlide || dir === 0) {
      // First open — just zoom in
      media.innerHTML = '';
      newSlide.style.transform = 'scale(0.92)';
      newSlide.style.opacity = '0';
      media.appendChild(newSlide);
      currentSlide = newSlide;
      requestAnimationFrame(() => {
        newSlide.style.transition = 'transform 0.32s cubic-bezier(0.34,1.4,0.64,1), opacity 0.25s ease';
        newSlide.style.transform = 'scale(1)';
        newSlide.style.opacity = '1';
      });
      return;
    }

    // Slide in from side
    isAnimating = true;
    const outgoing = currentSlide;
    newSlide.style.transform = `translateX(${dir > 0 ? W : -W}px)`;
    newSlide.style.opacity = '1';
    media.appendChild(newSlide);
    currentSlide = newSlide;

    requestAnimationFrame(() => {
      const easing = 'cubic-bezier(0.25, 0.46, 0.45, 0.94)';
      outgoing.style.transition = `transform 0.36s ${easing}, opacity 0.28s ease`;
      newSlide.style.transition  = `transform 0.36s ${easing}`;
      outgoing.style.transform = `translateX(${dir > 0 ? -W * 0.3 : W * 0.3}px)`;
      outgoing.style.opacity = '0';
      newSlide.style.transform = 'translateX(0)';
      setTimeout(() => { outgoing.remove(); isAnimating = false; }, 380);
    });
  }

  function modalNavigate(dir) {
    if (isAnimating) return;
    const next = modalIdx + dir;
    if (next < 0 || next >= modalItems.length) return;
    modalIdx = next;
    renderModal(dir);
  }

  function closeModal(animateDir) {
    const modal = $('modal');
    if (!modal.classList.contains('open')) return;

    if (animateDir === 'down' && currentSlide) {
      // Swipe-down dismiss — fly off screen
      currentSlide.style.transition = 'transform 0.32s cubic-bezier(0.55,0,1,0.45), opacity 0.28s ease';
      currentSlide.style.transform = 'translateY(100vh) scale(0.85)';
      currentSlide.style.opacity = '0';
      modal.style.transition = 'opacity 0.32s ease';
      modal.style.opacity = '0';
      setTimeout(() => {
        modal.classList.remove('open');
        modal.style.opacity = '';
        modal.style.transition = '';
        $('modalMedia').innerHTML = '';
        document.body.style.overflow = '';
        currentSlide = null; modalItems = []; modalIdx = null;
      }, 340);
    } else {
      modal.classList.remove('open');
      $('modalMedia').innerHTML = '';
      document.body.style.overflow = '';
      currentSlide = null; modalItems = []; modalIdx = null;
    }
  }

  $('modalClose').addEventListener('click', () => closeModal());
  $('modalPrev').addEventListener('click', e => { e.stopPropagation(); modalNavigate(-1); });
  $('modalNext').addEventListener('click', e => { e.stopPropagation(); modalNavigate(+1); });
  $('modal').addEventListener('click', e => {
    // Only close if clicking the dark backdrop itself, not any child
    if (e.target === $('modal')) closeModal();
  });

  $('modalDownload').addEventListener('click', () => {
    const item = JSON.parse($('modal').dataset.src || 'null');
    if (item) downloadFile(item.download_url, item.name);
  });

  $('modalDel').addEventListener('click', () => {
    const item = JSON.parse($('modal').dataset.src || 'null');
    if (!item) return;
    closeModal();
    const idx = allMedia.findIndex(m => m.sha === item.sha);
    if (idx !== -1) openConfirm(idx, allMedia);
  });

  // ── Touch: live-tracking swipe (horizontal = navigate, vertical = dismiss) ──
  let touch = { startX: 0, startY: 0, dx: 0, dy: 0, active: false, axis: null };

  $('modal').addEventListener('touchstart', e => {
    if (e.touches.length !== 1) return;
    touch.startX = e.touches[0].clientX;
    touch.startY = e.touches[0].clientY;
    touch.dx = 0; touch.dy = 0;
    touch.active = true; touch.axis = null;
  }, { passive: true });

  $('modal').addEventListener('touchmove', e => {
    if (!touch.active || !currentSlide) return;
    touch.dx = e.touches[0].clientX - touch.startX;
    touch.dy = e.touches[0].clientY - touch.startY;

    // Lock axis after first 8px of movement
    if (!touch.axis) {
      if (Math.abs(touch.dx) > 8 || Math.abs(touch.dy) > 8) {
        touch.axis = Math.abs(touch.dx) > Math.abs(touch.dy) ? 'x' : 'y';
      } else return;
    }

    if (touch.axis === 'x') {
      // Horizontal: drag the slide live
      const resistance = 0.45;
      const atEdge = (touch.dx > 0 && modalIdx === 0) || (touch.dx < 0 && modalIdx === modalItems.length - 1);
      const move = atEdge ? touch.dx * resistance : touch.dx;
      currentSlide.style.transition = 'none';
      currentSlide.style.transform = `translateX(${move}px)`;
    } else {
      // Vertical: drag down to dismiss
      if (touch.dy < 0) return; // don't allow upward drag
      const progress = Math.min(touch.dy / 400, 1);
      const scale = 1 - progress * 0.15;
      currentSlide.style.transition = 'none';
      currentSlide.style.transform = `translateY(${touch.dy}px) scale(${scale})`;
      $('modal').style.background = `rgba(4,4,12,${0.97 - progress * 0.6})`;
    }
  }, { passive: true });

  $('modal').addEventListener('touchend', () => {
    if (!touch.active || !currentSlide) { touch.active = false; return; }
    touch.active = false;
    $('modal').style.background = '';

    if (touch.axis === 'x') {
      const W = window.innerWidth;
      const threshold = W * 0.28;
      if (Math.abs(touch.dx) > threshold && !isAnimating) {
        const dir = touch.dx < 0 ? 1 : -1;
        const next = modalIdx + dir;
        if (next >= 0 && next < modalItems.length) {
          // Snap to next item
          const easing = 'cubic-bezier(0.25,0.46,0.45,0.94)';
          currentSlide.style.transition = `transform 0.26s ${easing}`;
          currentSlide.style.transform = `translateX(${touch.dx < 0 ? -W : W}px)`;
          modalIdx = next;
          isAnimating = true;
          const newSlide = buildSlide(modalItems[modalIdx]);
          newSlide.style.transform = `translateX(${touch.dx < 0 ? W : -W}px)`;
          $('modalMedia').appendChild(newSlide);
          requestAnimationFrame(() => {
            newSlide.style.transition = `transform 0.26s ${easing}`;
            newSlide.style.transform = 'translateX(0)';
          });
          setTimeout(() => {
            currentSlide.remove();
            currentSlide = newSlide;
            isAnimating = false;
            // Update header
            const item = modalItems[modalIdx];
            $('modalFname').textContent = item.name;
            $('modalCounter').textContent = `${modalIdx + 1} / ${modalItems.length}`;
            $('modal').dataset.src = JSON.stringify(item);
            $('modalPrev').classList.toggle('hidden', modalIdx === 0);
            $('modalNext').classList.toggle('hidden', modalIdx === modalItems.length - 1);
          }, 280);
          return;
        }
      }
      // Snap back
      currentSlide.style.transition = 'transform 0.3s cubic-bezier(0.34,1.4,0.64,1)';
      currentSlide.style.transform = 'translateX(0)';

    } else if (touch.axis === 'y') {
      if (touch.dy > 120) {
        closeModal('down');
      } else {
        // Snap back
        currentSlide.style.transition = 'transform 0.35s cubic-bezier(0.34,1.4,0.64,1)';
        currentSlide.style.transform = 'translateY(0) scale(1)';
      }
    }
  }, { passive: true });

  // ── Confirm delete ──────────────────────────────────────
  let pendingItem = null;

  function openConfirm(idx, list) {
    pendingItem = list[idx];
    $('cFname').textContent = pendingItem.name;
    $('confirmOverlay').classList.add('open');
  }

  function closeConfirm() { $('confirmOverlay').classList.remove('open'); pendingItem = null; }

  $('cCancel').addEventListener('click', closeConfirm);
  $('confirmOverlay').addEventListener('click', e => { if (e.target === $('confirmOverlay')) closeConfirm(); });

  $('cConfirm').addEventListener('click', async () => {
    if (!pendingItem) return; // bulk delete handles its own confirm flow
    const item = pendingItem;
    closeConfirm();
    try {
      const res = await fetch('/api/media', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: item.path, sha: item.sha }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Delete failed');
      toast('✓ File deleted');
      loadAll();
    } catch (err) {
      toast('✗ ' + err.message, 'error');
    }
  });

  document.addEventListener('keydown', e => {
    if ($('modal').classList.contains('open')) {
      if (e.key === 'ArrowLeft')  { e.preventDefault(); modalNavigate(-1); return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); modalNavigate(+1); return; }
    }
    if (e.key === 'Escape') { closeModal(); closePDFModal(); closeConfirm(); }
  });

  // ── PDF Modal ──────────────────────────────────────────
  // The preview is proxied through our own origin. GitHub's raw URLs answer
  // with `application/octet-stream` + `X-Frame-Options: deny`, which makes the
  // browser download the file instead of rendering it in the frame.
  function pdfPreviewUrl(item) {
    return `/api/pdf?path=${encodeURIComponent(item.path)}`;
  }

  function openPDFModal(item) {
    if (!item) return;
    $('pdfModalFname').textContent = item.name;
    $('pdfModal').dataset.src = JSON.stringify(item);
    $('pdfLoading').classList.remove('hidden');
    $('pdfModal').classList.add('open');
    document.body.style.overflow = 'hidden';
    $('pdfFrame').src = pdfPreviewUrl(item);
  }

  function closePDFModal() {
    $('pdfModal').classList.remove('open');
    $('pdfFrame').src = 'about:blank';
    $('pdfLoading').classList.add('hidden');
    document.body.style.overflow = '';
  }

  // Hide the spinner once the preview has loaded. The reset to about:blank on
  // close never matches, so reopening always starts with a fresh spinner.
  $('pdfFrame').addEventListener('load', () => {
    if (
      $('pdfModal').classList.contains('open') &&
      $('pdfFrame').getAttribute('src') !== 'about:blank'
    ) {
      $('pdfLoading').classList.add('hidden');
    }
  });

  $('pdfModalClose').addEventListener('click', closePDFModal);
  $('pdfModal').addEventListener('click', e => { if (e.target === $('pdfModal')) closePDFModal(); });

  $('pdfModalDownload').addEventListener('click', () => {
    const item = JSON.parse($('pdfModal').dataset.src || 'null');
    if (item) downloadFile(item.download_url, item.name);
  });

  $('pdfModalDel').addEventListener('click', () => {
    const item = JSON.parse($('pdfModal').dataset.src || 'null');
    if (!item) return;
    closePDFModal();
    const idx = allMedia.findIndex(m => m.sha === item.sha);
    if (idx !== -1) openConfirm(idx, allMedia);
  });

  // ── Auth ───────────────────────────────────────────────
  // The password lives in the server environment (APP_PASSWORD) and is never
  // shipped to the browser. Success sets an HttpOnly session cookie.
  let signingIn = false;

  async function submitLogin() {
    if (signingIn) return;
    const input = $('loginPass');
    const password = input.value;
    if (!password) { input.focus(); return; }

    signingIn = true;
    const btn = $('loginBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Unlocking…'; }

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not sign in');

      hideLogin();
      ghConfig = null;
      await loadAll();
    } catch (err) {
      $('loginError').textContent = err.message;
      $('loginError').classList.add('show');
      input.value = '';
      input.focus();
    } finally {
      signingIn = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Unlock'; }
    }
  }

  async function doLogout() {
    try { await fetch('/api/logout', { method: 'POST' }); } catch { /* ignore */ }
    ghConfig = null;
    allMedia = [];
    $('contentArea').innerHTML = '';
    showLogin('Signed out.');
  }

  $('loginPass').addEventListener('keydown', e => {
    if (e.key === 'Enter') submitLogin();
  });
  $('logoutBtn')?.addEventListener('click', doLogout);

  // Expose for inline onclick handlers
  window.submitLogin = submitLogin;
  window.doLogout = doLogout;

  // ── Init ───────────────────────────────────────────────
  (async () => {
    try {
      const res = await fetch('/api/session');
      const data = await res.json();
      if (data.authenticated) {
        hideLogin();
        await loadAll();
      } else {
        showLogin(
          data.configured === false
            ? 'Server password is not configured. Set APP_PASSWORD and restart.'
            : ''
        );
      }
    } catch {
      showLogin('Could not reach the server.');
    }
  })();
