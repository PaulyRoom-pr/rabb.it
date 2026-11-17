const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// Set GITHUB_TOKEN in your hosting environment only if the repository is private
// or you need a higher GitHub API rate limit. Never put the token in frontend code.
const GITHUB_OWNER = 'PaulyRoom-pr';
const GITHUB_REPO = 'rabb.it';
const GITHUB_BRANCH = 'main';
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || '';

const API_TREE_URL =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${encodeURIComponent(GITHUB_BRANCH)}?recursive=1`;

const RAW_BASE_URL =
  `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${encodeURIComponent(GITHUB_BRANCH)}/`;

const TREE_CACHE_MS = 60 * 1000;
let cachedFiles = null;
let treeFetchedAt = 0;

const TEXT_ONLY_FILES = new Set([
  'reportabuseapi.html',
  'movieapi.html',
  'membershipapi.html',
  'friendapi.html',
  'y1hs6s2m8.html'
]);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.pdf': 'application/pdf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf'
};

function githubHeaders() {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'Rabbit-Express-Server'
  };

  if (GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${GITHUB_TOKEN}`;
  }

  return headers;
}

async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('GitHub request timed out after 20 seconds.');
    }

    throw new Error(`Network request to GitHub failed: ${error.message}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function getRepositoryFiles(forceRefresh = false) {
  if (
    !forceRefresh &&
    cachedFiles &&
    Date.now() - treeFetchedAt < TREE_CACHE_MS
  ) {
    return cachedFiles;
  }

  const response = await fetchWithTimeout(API_TREE_URL, {
    headers: githubHeaders()
  });

  if (!response.ok) {
    let detail = '';
    try {
      const body = await response.json();
      detail = body.message || JSON.stringify(body);
    } catch {
      detail = await response.text().catch(() => '');
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        `GitHub denied the request (${response.status}). ${detail} ` +
        'Check the repository visibility, token permissions, and API rate limit.'
      );
    }

    if (response.status === 404) {
      throw new Error(
        `GitHub returned 404. Check that ${GITHUB_OWNER}/${GITHUB_REPO} ` +
        `and branch "${GITHUB_BRANCH}" exist and are accessible. ${detail}`
      );
    }

    throw new Error(`GitHub API error ${response.status}: ${detail}`);
  }

  const data = await response.json();

  if (!Array.isArray(data.tree)) {
    throw new Error('GitHub response did not contain a file tree.');
  }

  cachedFiles = data.tree
    .filter((item) => item.type === 'blob')
    .map((item) => item.path);

  treeFetchedAt = Date.now();

  if (data.truncated) {
    console.warn('GitHub returned a truncated repository file tree.');
  }

  return cachedFiles;
}

function normalizeRepoPath(input, { decode = true } = {}) {
  if (typeof input !== 'string' || !input || input.includes('\\')) {
    return null;
  }

  // Express route paths start with "/"; repository paths do not.
  const candidate = input.replace(/^\/+/, '');

  let normalized;
  try {
    // req.path is URL-encoded; req.query values are already decoded by Express.
    normalized = decode ? decodeURIComponent(candidate) : candidate;
  } catch {
    return null;
  }

  const parts = normalized.split('/');

  if (
    !normalized ||
    normalized.startsWith('/') ||
    parts.some((part) => !part || part === '.' || part === '..') ||
    normalized.includes('\0') ||
    normalized.includes('\\')
  ) {
    return null;
  }

  return normalized;
}

async function getRepositoryFile(repoPath) {
  const files = await getRepositoryFiles();

  if (!files.includes(repoPath)) {
    return null;
  }

  const encodedPath = repoPath
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  const rawUrl = RAW_BASE_URL + encodedPath;

  const response = await fetchWithTimeout(rawUrl, {
    headers: {
      'User-Agent': 'Rabbit-Express-Server',
      ...(GITHUB_TOKEN ? { Authorization: `Bearer ${GITHUB_TOKEN}` } : {})
    }
  });

  if (!response.ok) {
    throw new Error(
      `GitHub could not download "${repoPath}" (HTTP ${response.status}).`
    );
  }

  return {
    buffer: Buffer.from(await response.arrayBuffer()),
    contentType:
      MIME_TYPES[path.extname(repoPath).toLowerCase()] ||
      'application/octet-stream'
  };
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function repoFileUrl(repoPath) {
  return `/__repo/file?path=${encodeURIComponent(repoPath)}`;
}

function errorPage(error) {
  const message = escapeHtml(error.message || String(error));

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GitHub connection error</title>
<style>
body{font-family:Arial,sans-serif;background:#f4f5f7;padding:24px;color:#222}
main{max-width:850px;margin:auto;background:white;padding:24px;border-radius:12px}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#fff0f0;padding:16px;border-radius:8px;color:#8b1d1d}
</style>
</head>
<body><main>
<h1>Unable to load the GitHub repository</h1>
<p>The server received this error:</p>
<pre>${message}</pre>
<p>Repository: ${GITHUB_OWNER}/${GITHUB_REPO}</p>
<p>Branch: ${GITHUB_BRANCH}</p>
<p>Check the server logs for additional details. If the repository is private,
set a read-only GITHUB_TOKEN environment variable in your hosting dashboard.</p>
</main></body></html>`;
}

async function sendDashboard(res) {
  const files = await getRepositoryFiles();

  const cards = await Promise.all(files.map(async (repoPath) => {
    const name = path.posix.basename(repoPath);
    const lowerName = name.toLowerCase();
    const isTextOnly = TEXT_ONLY_FILES.has(lowerName);
    const isHtml = /\.(html?|xhtml)$/i.test(repoPath);
    const url = repoFileUrl(repoPath);
    const safePath = escapeHtml(repoPath);

    if (isTextOnly) {
      try {
        const file = await getRepositoryFile(repoPath);
        return `
<section class="file-card">
<h2>${safePath}</h2>
<p class="kind">Source text (preview disabled)</p>
<pre><code>${escapeHtml(file.buffer.toString('utf8'))}</code></pre>
<a href="${url}" target="_blank" rel="noopener">Open source text</a>
</section>`;
      } catch (error) {
        return `
<section class="file-card">
<h2>${safePath}</h2>
<p class="error">${escapeHtml(error.message)}</p>
</section>`;
      }
    }

    if (isHtml) {
      return `
<section class="file-card">
<h2>${safePath}</h2>
<p class="kind">Rendered HTML preview</p>
<iframe title="${safePath}" src="${url}" loading="lazy"></iframe>
<a href="${url}" target="_blank" rel="noopener">Open page</a>
</section>`;
    }

    return `
<section class="file-card">
<h2>${safePath}</h2>
<p class="kind">Repository file</p>
<a href="${url}" target="_blank" rel="noopener">Open or view file</a>
</section>`;
  }));

  const page = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Rabbit Repository</title>
<style>
*{box-sizing:border-box}
body{margin:0;padding:24px;color:#202124;background:#f3f4f6;font-family:Arial,sans-serif}
main{max-width:1400px;margin:auto}
.summary{color:#555}
.file-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:18px}
.file-card{min-width:0;padding:16px;background:white;border:1px solid #ddd;border-radius:12px}
.file-card h2{margin:0 0 10px;font-size:16px;overflow-wrap:anywhere}
.kind{color:#666;font-size:13px}
iframe{display:block;width:100%;height:420px;border:1px solid #ccc;border-radius:8px;background:white}
pre{max-height:420px;overflow:auto;padding:12px;border-radius:8px;background:#171923;color:#f4f4f5;white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px}
a{display:inline-block;margin-top:10px;color:#145dcc}
.error{color:#a22}
</style>
</head>
<body><main>
<h1>Rabbit Repository Files</h1>
<p class="summary">${files.length} files found in ${GITHUB_OWNER}/${GITHUB_REPO} (${GITHUB_BRANCH}).</p>
<div class="file-grid">${cards.join('\n')}</div>
</main></body></html>`;

  res.status(200).type('html').send(page);
}

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'rabbit',
    repository: `${GITHUB_OWNER}/${GITHUB_REPO}`,
    branch: GITHUB_BRANCH,
    nodeVersion: process.version,
    fetchAvailable: typeof fetch === 'function'
  });
});

app.get('/__repo/refresh', async (req, res) => {
  try {
    const files = await getRepositoryFiles(true);
    res.json({ ok: true, count: files.length, files });
  } catch (error) {
    console.error('Repository refresh failed:', error);
    res.status(502).json({ ok: false, error: error.message });
  }
});

app.get('/__repo/files', async (req, res) => {
  try {
    const files = await getRepositoryFiles();
    res.json({ count: files.length, files });
  } catch (error) {
    console.error('Repository listing failed:', error);
    res.status(502).json({ error: error.message });
  }
});

app.get('/__repo/file', async (req, res) => {
  try {
    const repoPath = normalizeRepoPath(req.query.path, { decode: false });

    if (!repoPath) {
      return res.status(400).send('Invalid repository file path.');
    }

    const file = await getRepositoryFile(repoPath);

    if (!file) {
      return res.status(404).send('File not found in the GitHub repository.');
    }

    const textOnly = TEXT_ONLY_FILES.has(
      path.posix.basename(repoPath).toLowerCase()
    );

    res.status(200);
    res.setHeader(
      'Content-Type',
      textOnly ? 'text/plain; charset=utf-8' : file.contentType
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(file.buffer);
  } catch (error) {
    console.error('File request failed:', error);
    res.status(502).send(error.message);
  }
});

// Visiting the site root automatically loads the repository's index.html.
app.get('/', async (req, res) => {
  try {
    const file = await getRepositoryFile('index.html');

    if (!file) {
      return res.status(404).type('text').send(
        'index.html was not found in the root of the GitHub repository.'
      );
    }

    res.status(200);
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(file.buffer);
  } catch (error) {
    console.error('Could not load index.html:', error);
    res.status(502).type('html').send(errorPage(error));
  }
});

app.get('/y1hs6s2m8.html', async (req, res) => {
  try {
    await sendDashboard(res);
  } catch (error) {
    console.error('Dashboard load failed:', error);
    res.status(502).type('html').send(errorPage(error));
  }
});

const textOnlyRoutes = [
  'MovieApi.html',
  'MembershipApi.html',
  'ReportAbuseApi.html',
  'friendapi.html'
];

for (const fileName of textOnlyRoutes) {
  app.get(`/${fileName}`, async (req, res) => {
    try {
      const files = await getRepositoryFiles();
      const match = files.find(
        (file) => path.posix.basename(file).toLowerCase() === fileName.toLowerCase()
      );

      if (!match) {
        return res.status(404).send('File not found in the GitHub repository.');
      }

      const file = await getRepositoryFile(match);
      res.type('text/plain').send(file.buffer);
    } catch (error) {
      console.error(`Could not load ${fileName}:`, error);
      res.status(502).send(error.message);
    }
  });
}

// Any other exact repository path is served using its appropriate content type.
app.use(async (req, res) => {
  try {
    const repoPath = normalizeRepoPath(req.path);

    if (!repoPath) {
      return res.status(400).send('Invalid file path.');
    }

    const file = await getRepositoryFile(repoPath);

    if (!file) {
      return res.status(404).send('File not found.');
    }

    const textOnly = TEXT_ONLY_FILES.has(
      path.posix.basename(repoPath).toLowerCase()
    );

    res.setHeader(
      'Content-Type',
      textOnly ? 'text/plain; charset=utf-8' : file.contentType
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(file.buffer);
  } catch (error) {
    console.error('Repository file route failed:', error);
    res.status(502).send(error.message);
  }
});

if (typeof fetch !== 'function') {
  throw new Error('This server requires Node.js 18 or newer (built-in fetch is missing).');
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Rabbit listening on port ${PORT}; repository: ` +
    `${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}; Node ${process.version}`
  );
});
