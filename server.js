import express from 'express';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Configure MIME types for modules and PDF.js assets
if (express.static.mime && express.static.mime.define) {
  express.static.mime.define({
    'application/javascript': ['js', 'mjs'],
    'application/json': ['json', 'bcmap'],
    'text/css': ['css'],
    'application/pdf': ['pdf']
  });
}

const staticOptions = {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.mjs') || filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
    }
    // Prevent stale caching during development
    res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  }
};

// Explicit handler for PDF.js build scripts
app.get(['/assets/pdfjs/build/:file', '/_site/assets/pdfjs/build/:file'], (req, res, next) => {
  const fileName = req.params.file;
  const candidates = [
    path.join(__dirname, '_site', 'assets', 'pdfjs', 'build', fileName),
    path.join(__dirname, 'assets', 'pdfjs', 'build', fileName)
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      res.setHeader('Content-Type', 'application/javascript; charset=UTF-8');
      res.setHeader('Cache-Control', 'no-cache, must-revalidate');
      return res.sendFile(candidate);
    }
  }
  next();
});

// Serve static files from _site, assets, and root
app.use(express.static(path.join(__dirname, '_site'), staticOptions));
app.use('/assets', express.static(path.join(__dirname, 'assets'), staticOptions));
app.use(express.static(__dirname, staticOptions));

// Clean URL handling
app.get('/readme', (req, res) => {
  res.sendFile(path.join(__dirname, '_site', 'readme.html'));
});

// Default fallback to index.html for navigation routes only (never for missing file assets)
app.get('*', (req, res) => {
  if (path.extname(req.path)) {
    return res.status(404).type('text/plain').send('Asset not found');
  }
  res.sendFile(path.join(__dirname, '_site', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`RELIC dev server listening on http://0.0.0.0:${PORT}`);
});
