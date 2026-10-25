import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files from _site, assets, and root
app.use(express.static(path.join(__dirname, '_site')));
app.use('/assets', express.static(path.join(__dirname, 'assets')));
app.use(express.static(__dirname));

// Clean URL handling
app.get('/readme', (req, res) => {
  res.sendFile(path.join(__dirname, '_site', 'readme.html'));
});

// Default fallback to index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '_site', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`RELIC dev server listening on http://0.0.0.0:${PORT}`);
});
