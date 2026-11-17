const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const GITHUB_OWNER = 'PaulyRoom-pr';
const GITHUB_REPO = 'rabb.it';
const GITHUB_BRANCH = 'main';

const API_TREE_URL =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;

const RAW_BASE_URL =
  `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/`;

const TREE_CACHE_MS = 5 * 60 * 1000;
let cachedFiles = null;
let treeFetchedAt = 0;

// These five files must be shown as source text in the dashboard
// and returned as plain text when opened directly through /__repo/file.
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

async function getRepositoryFiles() {
  if (cachedFiles && Date.now() - treeFetchedAt < TREE_CACHE_MS) {
    return cachedFiles;
  }

  const response = await fetch(API_TREE_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Rabbit-Express-Server'
    }
  });

  if (!response.ok) {
    throw new Error(`GitHub tree request failed: ${response.status}`);
  }

  const data = await response.json();

  if (!Array.isArray(data.tree)) {
    throw new Error('GitHub returned an invalid repository tree.');
  }

  cachedFiles = data.tree
    .filter((item) => item.type === 'blob')
    .map((item) => item.path);

  treeFetchedAt = Date.now();

  if (data.truncated) {
    console.warn('GitHub truncated the recursive tree response.');
  }

  return cachedFiles;
}

function normalizeRepoPath(input) {
  if (typeof input !== 'string' || !input || input.includes('\\')) {
    return null;
  }

  let decoded;
  try {
    decoded = decodeURIComponent(input);
  } catch {
    return null;
  }

  const parts = decoded.split('/');

  if (
    decoded.startsWith('/') ||
    parts.some((part) => !part || part === '.' || part === '..') ||
    decoded.includes('\0')
  ) {
    return null;
  }

  return decoded;
}

async function getRepositoryFile(pathInRepo) {
  const files = await getRepositoryFiles();

  // Require an exact path match from GitHub's repository tree.
  if (!files.includes(pathInRepo)) {
    return null;
  }

  const encodedPath = pathInRepo
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  const response = await fetch(`${RAW_BASE_URL}${encodedPath}`, {
    headers: { 'User-Agent': 'Rabbit-Express-Server' }
  });

  if (!response.ok) {
    throw new Error(`GitHub could not return ${pathInRepo}: ${response.status}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const extension = path.extname(pathInRepo).toLowerCase();

  return {
    buffer,
    contentType: MIME_TYPES[extension] || 'application/octet-stream',
    extension
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

function fileUrl(pathInRepo) {
  return `/__repo/file?path=${encodeURIComponent(pathInRepo)}`;
}

async function sendDashboard(res) {
  const files = await getRepositoryFiles();

  const rows = await Promise.all(files.map(async (filePath) => {
    const baseName = path.posix.basename(filePath).toLowerCase();
    const isTextOnly = TEXT_ONLY_FILES.has(baseName);
    const isHtml = /\.(html?|xhtml)$/i.test(filePath);
    const url = fileUrl(filePath);
    const safeName = escapeHtml(filePath);

    if (isTextOnly) {
      try {
        const file = await getRepositoryFile(filePath);
        const source = file.buffer.toString('utf8');

        return `
          <section class="file-card">
            <h2>${safeName}</h2>
            <p class="kind">Source text (preview disabled)</p>
            <pre><code>${escapeHtml(source)}</code></pre>
            <a href="${url}" target="_blank" rel="noopener">Open text file</a>
          </section>`;
      } catch (error) {
        console.error(error);
        return `
          <section class="file-card">
            <h2>${safeName}</h2>
            <p class="error">Could not load this file from GitHub.</p>
          </section>`;
      }
    }

    if (isHtml) {
      return `
        <section class="file-card">
          <h2>${safeName}</h2>
          <p class="kind">Rendered HTML preview</p>
          <iframe title="${safeName}" src="${url}" loading="lazy"></iframe>
          <a href="${url}" target="_blank" rel="noopener">Open page</a>
        </section>`;
    }

    return `
      <section class="file-card">
        <h2>${safeName}</h2>
        <p class="kind">Repository file</p>
        <a href="${url}" target="_blank" rel="noopener">Open or view file</a>
      </section>`;
  }));

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rabbit Repository</title>
  <style>
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 24px;
      color: #202124;
      background: #f3f4f6;
      font-family: Arial, sans-serif;
    }
    main { max-width: 1400px; margin: auto; }
    h1 { margin-top: 0; }
    .summary { color: #555; }
    .file-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
      gap: 18px;
    }
    .file-card {
      min-width: 0;
      padding: 16px;
      background: white;
      border: 1px solid #ddd;
      border-radius: 12px;
    }
    .file-card h2 {
      margin: 0 0 10px;
      font-size: 16px;
      overflow-wrap: anywhere;
    }
    .kind { color: #666; font-size: 13px; }
    iframe {
      display: block;
      width: 100%;
      height: 420px;
      border: 1px solid #ccc;
      border-radius: 8px;
      background: white;
    }
    pre {
      max-height: 420px;
      overflow: auto;
      padding: 12px;
      border-radius: 8px;
      background: #171923;
      color: #f4f4f5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      font-size: 12px;
    }
    a { display: inline-block; margin-top: 10px; color: #145dcc; }
    .error { color: #a22; }
  </style>
</head>
<body>
  <main>
    <h1>Rabbit Repository Files</h1>
    <p class="summary">
      ${files.length} files found in ${GITHUB_OWNER}/${GITHUB_REPO}
      (${GITHUB_BRANCH}). HTML files are previewed, except the five
      text-only files which are displayed as source text.
    </p>
    <div class="file-grid">${rows.join('\n')}</div>
  </main>
</body>
</html>`;

  res.status(200);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.send(html);
}

// Health check.
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    service: 'rabbit',
    repository: `${GITHUB_OWNER}/${GITHUB_REPO}`,
    branch: GITHUB_BRANCH
  });
});

// List every repository file path.
app.get('/__repo/files', async (req, res) => {
  try {
    const files = await getRepositoryFiles();
    res.json({ count: files.length, files });
  } catch (error) {
    console.error(error);
    res.status(502).json({ error: 'Could not list repository files.' });
  }
});

// Repository file endpoint. All files are accessible here.
// The five named HTML files are sent as text/plain; other HTML files
// are sent as text/html and therefore render as webpages in browsers.
app.get('/__repo/file', async (req, res) => {
  try {
    const repoPath = normalizeRepoPath(req.query.path);

    if (!repoPath) {
      return res.status(400).send('Invalid repository file path.');
    }

    const file = await getRepositoryFile(repoPath);

    if (!file) {
      return res.status(404).send('File not found in the GitHub repository.');
    }

    const baseName = path.posix.basename(repoPath).toLowerCase();
    const textOnly = TEXT_ONLY_FILES.has(baseName);

    res.status(200);
    res.setHeader(
      'Content-Type',
      textOnly ? 'text/plain; charset=utf-8' : file.contentType
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(file.buffer);
  } catch (error) {
    console.error(error);
    res.status(502).send('Unable to load this file from GitHub.');
  }
});

// Main page and the requested dashboard filename both show the file browser.
app.get('/', async (req, res) => {
  try {
    await sendDashboard(res);
  } catch (error) {
    console.error(error);
    res.status(502).send('Unable to load the GitHub repository dashboard.');
  }
});

app.get('/y1hs6s2m8.html', async (req, res) => {
  try {
    await sendDashboard(res);
  } catch (error) {
    console.error(error);
    res.status(502).send('Unable to load the GitHub repository dashboard.');
  }
});

// Friendly direct URLs for the four other text-only files.
// They return their HTML source as plain text, not a rendered preview.
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
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.send(file.buffer);
    } catch (error) {
      console.error(error);
      res.status(502).send(`Unable to load ${fileName}.`);
    }
  });
}

// All remaining direct repository paths are resolved from the GitHub tree.
// Only exact paths present in the repository are served.
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

    const baseName = path.posix.basename(repoPath).toLowerCase();
    const textOnly = TEXT_ONLY_FILES.has(baseName);

    res.setHeader(
      'Content-Type',
      textOnly ? 'text/plain; charset=utf-8' : file.contentType
    );
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.send(file.buffer);
  } catch (error) {
    console.error(error);
    res.status(502).send('Unable to load this repository file.');
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Rabbit is running on port ${PORT}, connected to ` +
    `${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}`
  );
});
