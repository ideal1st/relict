import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const srcBuildDir = path.join(rootDir, 'node_modules', 'pdfjs-dist', 'build');
if (!fs.existsSync(srcBuildDir)) {
  console.error('Source pdfjs-dist/build not found:', srcBuildDir);
  process.exit(1);
}

const targetDirs = [
  path.join(rootDir, 'assets', 'pdfjs', 'build'),
  path.join(rootDir, '_site', 'assets', 'pdfjs', 'build'),
  path.join(rootDir, 'public', 'assets', 'pdfjs', 'build')
];

for (const target of targetDirs) {
  fs.mkdirSync(target, { recursive: true });
}

// Read sources
const pdfMjs = fs.readFileSync(path.join(srcBuildDir, 'pdf.mjs'), 'utf8');
const pdfWorkerMjs = fs.readFileSync(path.join(srcBuildDir, 'pdf.worker.mjs'), 'utf8');
const pdfSandboxMjs = fs.readFileSync(path.join(srcBuildDir, 'pdf.sandbox.mjs'), 'utf8');

// Create script-compatible .js versions that define globalThis and work in standard <script> and WebWorker contexts
const pdfJs = `(() => {\n${pdfMjs
  .replace(/import\.meta\.url/g, '(globalThis.document?.currentScript?.src || globalThis.location?.href || "")')
  .replace(
    /export\s*\{[^}]*\};?\s*(\/\/# sourceMappingURL=.*)?$/s,
    `if (typeof module !== 'undefined' && module.exports) {\n  module.exports = globalThis.pdfjsLib;\n}\n$1`
  )}\n})();`;

const pdfWorkerJs = `(() => {\n${pdfWorkerMjs
  .replace(/import\.meta\.url/g, '(globalThis.location?.href || "")')
  .replace(
    /export\s*\{[^}]*\};?\s*(\/\/# sourceMappingURL=.*)?$/s,
    `if (typeof module !== 'undefined' && module.exports) {\n  module.exports = globalThis.pdfjsWorker;\n}\n$1`
  )}\n})();`;

const pdfSandboxJs = `(() => {\n${pdfSandboxMjs
  .replace(/import\.meta\.url/g, '(globalThis.location?.href || "")')
  .replace(
    /export\s*\{[^}]*\};?\s*(\/\/# sourceMappingURL=.*)?$/s,
    `if (typeof module !== 'undefined' && module.exports) {\n  module.exports = globalThis.pdfjsSandbox;\n}\n$1`
  )}\n})();`;

const filesToWrite = [
  { name: 'pdf.mjs', content: pdfMjs },
  { name: 'pdf.js', content: pdfJs },
  { name: 'pdf.worker.mjs', content: pdfWorkerMjs },
  { name: 'pdf.worker.js', content: pdfWorkerJs },
  { name: 'pdf.sandbox.mjs', content: pdfSandboxMjs },
  { name: 'pdf.sandbox.js', content: pdfSandboxJs }
];

// Copy map files if they exist
for (const mapName of ['pdf.mjs.map', 'pdf.worker.mjs.map', 'pdf.sandbox.mjs.map']) {
  const p = path.join(srcBuildDir, mapName);
  if (fs.existsSync(p)) {
    filesToWrite.push({ name: mapName, content: fs.readFileSync(p) });
  }
}

for (const target of targetDirs) {
  for (const item of filesToWrite) {
    const dest = path.join(target, item.name);
    fs.writeFileSync(dest, item.content);
    console.log(`Wrote ${dest}`);
  }
}

console.log('PDF.js build artifacts successfully generated and synced.');
