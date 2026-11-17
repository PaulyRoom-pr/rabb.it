const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

// GitHub repository configuration.
const GITHUB_OWNER = 'PaulyRoom-pr';
const GITHUB_REPO = 'rabb.it';
const GITHUB_BRANCH = 'main';

const API_TREE_URL =
  `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/git/trees/${GITHUB_BRANCH}?recursive=1`;

const RAW_BASE_URL =
  `https://raw.githubusercontent.com/${GITHUB_OWNER}/${GITHUB_REPO}/${GITHUB_BRANCH}/`;

// Only these HTML files may be served.
const ALLOWED_FILES = new Set([
  'movieapi.html',
  'membershipapi.html',
  'reportabuseapi.html',
  'friendapi.html',
  'y1hs6s2m8.html'
]);

const TREE_CACHE_MS = 5 * 60 * 1000;
let cachedAllowedFiles = null;
let treeFetchedAt = 0;

async function getAllowedRepositoryFiles() {
  if (
    cachedAllowedFiles &&
    Date.now() - treeFetchedAt < TREE_CACHE_MS
  ) {
    return cachedAllowedFiles;
  }

  const response = await fetch(API_TREE_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Rabbit-Express-Server'
    }
  });

  if (!response.ok) {
    throw new Error(
      `GitHub repository lookup failed: ${response.status}`
    );
  }

  const data = await response.json();

  if (!Array.isArray(data.tree)) {
    throw new Error('GitHub returned an invalid repository tree.');
  }

  cachedAllowedFiles = data.tree
    .filter((item) => item.type === 'blob')
    .map((item) => item.path)
    .filter((file) => ALLOWED_FILES.has(
      file.split('/').pop().toLowerCase()
    ));

  treeFetchedAt = Date.now();

  if (data.truncated) {
    console.warn('GitHub truncated the repository tree response.');
  }

  return cachedAllowedFiles;
}

function decodeRequestedPath(value) {
  try {
    return decodeURIComponent(value).replace(/^\/+/, '');
  } catch {
    return null;
  }
}

async function serveAllowedFile(res, repositoryPath) {
  const allowedFiles = await getAllowedRepositoryFiles();

  // Match only a file in the explicit allowlist.
  const actualPath = allowedFiles.find(
    (file) => file.toLowerCase() === repositoryPath.toLowerCase()
  );

  if (!actualPath) {
    return false;
  }

  const encodedPath = actualPath
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  const response = await fetch(`${RAW_BASE_URL}${encodedPath}`, {
    headers: {
      'User-Agent': 'Rabbit-Express-Server'
    }
  });

  if (!response.ok) {
    throw new Error(`Could not load ${actualPath}: ${response.status}`);
  }

  // Return the HTML file itself. Do not load, parse, or expose
  // any other repository files.
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300');

  const html = await response.text();
  res.send(html);

  return true;
}

// Health check.
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'rabbit',
    repository: `${GITHUB_OWNER}/${GITHUB_REPO}`,
    branch: GITHUB_BRANCH
  });
});

// List only the five permitted HTML files, not the full repository.
app.get('/__repo/files', async (req, res) => {
  try {
    const files = await getAllowedRepositoryFiles();

    res.json({
      repository: `${GITHUB_OWNER}/${GITHUB_REPO}`,
      branch: GITHUB_BRANCH,
      count: files.length,
      files
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error: 'Could not retrieve the permitted HTML files from GitHub.'
    });
  }
});

// Root loads the first permitted file found, if available.
app.get('/', async (req, res) => {
  try {
    const files = await getAllowedRepositoryFiles();

    if (files.length === 0) {
      return res.status(404).send('None of the allowed HTML files were found.');
    }

    await serveAllowedFile(res, files[0]);
  } catch (error) {
    console.error(error);
    res.status(502).send('Unable to load the allowed HTML file from GitHub.');
  }
});

// Each permitted filename can be requested directly, even if it is
// stored in a subfolder in the GitHub repository.
app.get('/:fileName', async (req, res, next) => {
  const requestedName = req.params.fileName.toLowerCase();

  if (!ALLOWED_FILES.has(requestedName)) {
    return res.status(404).send('This file is not allowed.');
  }

  try {
    const files = await getAllowedRepositoryFiles();

    const match = files.find(
      (file) => file.split('/').pop().toLowerCase() === requestedName
    );

    if (!match) {
      return res.status(404).send('Allowed HTML file not found in GitHub.');
    }

    await serveAllowedFile(res, match);
  } catch (error) {
    console.error(error);
    res.status(502).send('Unable to load this HTML file from GitHub.');
  }
});

// Block all other paths and file types.
app.use((req, res) => {
  res.status(404).send('Not found. Only the five permitted HTML files are available.');
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Rabbit is running on port ${PORT}; only the five permitted HTML files are enabled.`
  );
});
