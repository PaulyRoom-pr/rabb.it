const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy (important on Render)
app.set('trust proxy', 1);

// Serve static files from the public directory
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1d',
  etag: true
}));

// Explicit clean routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/signup', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'signup.html'));
});

app.get('/home', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'home.html'));
});

// Health check for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'rabbit' });
});

// Fallback – send unknown routes to landing page
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Listen on 0.0.0.0 so Render can reach the service
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🐇 Rabbit is running on port ${PORT}`);
});
