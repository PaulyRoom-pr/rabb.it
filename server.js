const express = require('express');

const app = express();
const PORT = process.env.PORT || 3000;

// GitHub repository to serve.
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

app.set('trust proxy', 1);

async function getRepositoryFiles() {
  const cacheIsFresh =
    cachedFiles && Date.now() - treeFetchedAt < TREE_CACHE_MS;

  if (cacheIsFresh) {
    return cachedFiles;
  }

  const response = await fetch(API_TREE_URL, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'Rabbit-Express-Server'
    }
  });

  if (!response.ok) {
    throw new Error(
      `GitHub file listing failed: ${response.status} ${response.statusText}`
    );
  }

  const data = await response.json();

  if (!Array.isArray(data.tree)) {
    throw new Error('GitHub returned an invalid repository file tree.');
  }

  // Keep files only; folders are represented by their child file paths.
  cachedFiles = data.tree
    .filter((item) => item.type === 'blob')
    .map((item) => item.path);

  treeFetchedAt = Date.now();

  if (data.truncated) {
    console.warn(
      'Warning: GitHub truncated the recursive tree response. ' +
      'Not every repository file may be listed.'
    );
  }

  return cachedFiles;
}

function findIndexFile(files) {
  // Prefer /index.html in the repository root.
  if (files.includes('index.html')) {
    return 'index.html';
  }

  // Otherwise use the first index.html found in a subfolder.
  return files
    .filter((file) => file.toLowerCase().endsWith('/index.html'))
    .sort((a, b) => a.localeCompare(b))[0] || null;
}

function safeDecodePath(value) {
  try {
    return decodeURIComponent(value).replace(/^\/+/, '');
  } catch {
    return null;
  }
}

async function sendRepositoryFile(res, repositoryPath, options = {}) {
  const files = await getRepositoryFiles();

  // Only serve paths that actually exist in the GitHub repository.
  if (!files.includes(repositoryPath)) {
    return false;
  }

  const encodedPath = repositoryPath
    .split('/')
    .map(encodeURIComponent)
    .join('/');

  const response = await fetch(`${RAW_BASE_URL}${encodedPath}`, {
    headers: {
      'User-Agent': 'Rabbit-Express-Server'
    }
  });

  if (!response.ok) {
    throw new Error(
      `Could not download ${repositoryPath}: ${response.status}`
    );
  }

  const contentType =
    response.headers.get('content-type') || 'application/octet-stream';

  let body = Buffer.from(await response.arrayBuffer());

  // When the chosen homepage is in a subfolder, make relative CSS/JS/image
  // paths resolve from that folder while the page is shown at "/".
  if (options.injectBase && /\.html?$/i.test(repositoryPath)) {
    let html = body.toString('utf8');

    if (!/<base\s/i.test(html)) {
      const directory = repositoryPath.includes('/')
        ? repositoryPath.slice(0, repositoryPath.lastIndexOf('/') + 1)
        : '';

      const baseTag = `<base href="/${directory}">`;

      if (/<head[^>]*>/i.test(html)) {
        html = html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
      } else {
        html = `${baseTag}${html}`;
      }
    }

    body = Buffer.from(html, 'utf8');
  }

  res.setHeader('Content-Type', contentType);
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.send(body);
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

// List every file discovered in the repository.
app.get('/__repo/files', async (req, res) => {
  try {
    const files = await getRepositoryFiles();

    res.json({
      repository: `${GITHUB_OWNER}/${GITHUB_REPO}`,
      branch: GITHUB_BRANCH,
      index: findIndexFile(files),
      count: files.length,
      files
    });
  } catch (error) {
    console.error(error);
    res.status(502).json({
      error: 'Could not read the GitHub repository file list.'
    });
  }
});

// Serve the repository's index.html at the home page.
app.get('/', async (req, res) => {
  try {
    const files = await getRepositoryFiles();
    const indexFile = findIndexFile(files);

    if (!indexFile) {
      return res.status(404).send(
        'No index.html was found in the GitHub repository.'
      );
    }

    await sendRepositoryFile(res, indexFile, { injectBase: true });
  } catch (error) {
    console.error(error);
    res.status(502).send('Unable to load the website from GitHub.');
  }
});

// Friendly routes: find these files even if they are inside subfolders.
const friendlyPages = {
  '/login': 'login.html',
  '/signup': 'signup.html',
  '/home': 'home.html'
};

for (const [route, fileName] of Object.entries(friendlyPages)) {
  app.get(route, async (req, res) => {
    try {
      const files = await getRepositoryFiles();
      const match = files.find(
        (file) => file.toLowerCase() === fileName ||
          file.toLowerCase().endsWith(`/${fileName}`)
      );

      if (!match) {
        return res.status(404).send(`${fileName} was not found in GitHub.`);
      }

      await sendRepositoryFile(res, match, { injectBase: true });
    } catch (error) {
      console.error(error);
      res.status(502).send(`Unable to load ${fileName} from GitHub.`);
    }
  });
}

// Serve any other repository file, including files in nested directories.
app.use(async (req, res) => {
  try {
    const requestedPath = safeDecodePath(req.path);

    if (!requestedPath || requestedPath.includes('\\') ||
        requestedPath.split('/').some((part) => part === '.' || part === '..')) {
      return res.status(400).send('Invalid file path.');
    }

    const found = await sendRepositoryFile(res, requestedPath);

    if (!found) {
      return res.status(404).send('File not found in the GitHub repository.');
    }
  } catch (error) {
    console.error(error);
    res.status(502).send('Unable to load this file from GitHub.');
  }
});

// Listen on all interfaces so hosting providers such as Render can reach it.
app.listen(PORT, '0.0.0.0', () => {
  console.log(
    `Rabbit is running on port ${PORT} and serving ` +
    `${GITHUB_OWNER}/${GITHUB_REPO}@${GITHUB_BRANCH}`
  );
});
