const express = require("express");
const path = require("path");
const fs = require("fs");

const app = express();
const PORT = process.env.PORT || 10000;

// Set SITE_DIR in Render if your built frontend is in a different folder.
const candidates = [
  process.env.SITE_DIR,
  "dist",
  "build",
  "public",
  "client/dist",
  "client/build",
  "client/public",
  "."
].filter(Boolean);

const siteDir = candidates
  .map((folder) => path.resolve(__dirname, folder))
  .find((folder) => fs.existsSync(path.join(folder, "index.html")));

if (!siteDir) {
  console.error(
    "Could not find index.html. Build the frontend first or set SITE_DIR."
  );
  process.exit(1);
}

app.disable("x-powered-by");

// Serve files such as JavaScript, CSS, images, fonts, and HTML.
app.use(express.static(siteDir, {
  dotfiles: "ignore",
  index: "index.html"
}));

// Client-side routes fall back to the app entry point.
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(siteDir, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Website listening on port ${PORT}`);
  console.log(`Serving frontend from ${siteDir}`);
});
