// Build the clean production deployment directory for the website.
//
//   node website/scripts/package-deploy.mjs [--out <dir>]
//
// Default output: website/dist-production/ (gitignored — it is a build
// artifact, never committed). Dependency-free: Node built-ins only, so it
// runs identically on Windows, macOS and Linux.
//
// What ships: exactly the files the live website needs — every page, tool,
// stylesheet, script, font, image and the font licence texts. What never
// ships: the test suites (tests/), the design reference mockup
// (reference/), these packaging scripts (scripts/), development documents
// (*.md) and any previous build output.
//
// After copying, the script verifies the package:
//   1. every packaged file is byte-identical to its source file;
//   2. no excluded artifact is present in the package;
//   3. every relative href/src (HTML) and url() (CSS) reference resolves
//      to a file inside the package (directories resolve to index.html);
//   4. every packaged JavaScript file parses;
//   5. no packaged page carries an inline event-handler attribute, a
//      javascript: URL, or an inline <script> block, so the site stays
//      compatible with a strict script-src 'self' CSP.
// Any failure exits non-zero and names the offending file/reference.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const outFlag = args.indexOf('--out');
const outDir = outFlag >= 0 ? path.resolve(args[outFlag + 1]) : path.join(root, 'dist-production');

// Top-level directories that are development-only.
const EXCLUDED_DIRS = new Set(['tests', 'reference', 'scripts', 'dist-production']);
// Development documents, wherever they sit.
const EXCLUDED_EXTS = new Set(['.md']);
// Individual development-only files.
const EXCLUDED_FILES = new Set(['.gitignore']);

const toPosix = p => p.split(path.sep).join('/');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');

function walk(dir, base = dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(full, base) : [path.relative(base, full)];
  });
}

// ---- collect the production file set --------------------------------------
const relFiles = walk(root).filter(rel => {
  const posix = toPosix(rel);
  const firstSegment = posix.split('/')[0];
  if (EXCLUDED_DIRS.has(firstSegment)) return false;
  if (EXCLUDED_FILES.has(posix)) return false;
  if (EXCLUDED_EXTS.has(path.extname(posix).toLowerCase())) return false;
  // Never ingest a previous build, wherever --out pointed.
  const abs = path.join(root, rel);
  if (abs === outDir || abs.startsWith(outDir + path.sep)) return false;
  return true;
}).sort();

// ---- copy ------------------------------------------------------------------
fs.rmSync(outDir, { recursive: true, force: true });
for (const rel of relFiles) {
  const dest = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(path.join(root, rel), dest);
}

// ---- verify ----------------------------------------------------------------
const failures = [];
let totalBytes = 0;

// 1 + 2: byte-identity with the source, and no excluded artifacts packaged.
for (const rel of relFiles) {
  const src = fs.readFileSync(path.join(root, rel));
  const dst = fs.readFileSync(path.join(outDir, rel));
  totalBytes += dst.length;
  if (sha256(src) !== sha256(dst)) failures.push(`not byte-identical to source: ${toPosix(rel)}`);
}
for (const rel of walk(outDir)) {
  const posix = toPosix(rel);
  if (EXCLUDED_DIRS.has(posix.split('/')[0]) || EXCLUDED_FILES.has(posix) || EXCLUDED_EXTS.has(path.extname(posix).toLowerCase())) {
    failures.push(`excluded artifact present in package: ${posix}`);
  }
}

// 3 + 4: reference integrity and JavaScript syntax.
let references = 0;
const REF_PATTERNS = {
  '.html': /(?:href|src)\s*=\s*["']([^"']*)["']/g,
  '.css': /url\(\s*["']?([^"'\s)]+)["']?\s*\)/g
};
for (const rel of relFiles) {
  const posix = toPosix(rel);
  const ext = path.extname(posix).toLowerCase();
  const packaged = path.join(outDir, rel);
  if (ext === '.js') {
    try { new vm.Script(fs.readFileSync(packaged, 'utf8'), { filename: posix }); }
    catch (err) { failures.push(`JavaScript does not parse: ${posix} (${err.message})`); }
    continue;
  }
  const pattern = REF_PATTERNS[ext];
  if (!pattern) continue;
  const content = fs.readFileSync(packaged, 'utf8');
  for (const match of content.matchAll(pattern)) {
    const ref = match[1].split(/[?#]/)[0];
    if (!ref || /^(?:[a-z]+:|\/\/)/i.test(ref)) continue;
    references++;
    let target = path.resolve(path.dirname(packaged), decodeURIComponent(ref));
    if (!target.startsWith(outDir)) { failures.push(`reference escapes the package: ${ref} in ${posix}`); continue; }
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) target = path.join(target, 'index.html');
    if (!fs.existsSync(target)) failures.push(`unresolved reference: ${ref} in ${posix}`);
  }
}

// 5: CSP readiness of every packaged page.
for (const rel of relFiles) {
  const posix = toPosix(rel);
  if (path.extname(posix).toLowerCase() !== '.html') continue;
  const content = fs.readFileSync(path.join(outDir, rel), 'utf8');
  if (/<[^>]*\son[a-z]+\s*=/i.test(content)) failures.push(`inline event handler in packaged page: ${posix}`);
  if (/href\s*=\s*["']\s*javascript:/i.test(content)) failures.push(`javascript: URL in packaged page: ${posix}`);
  if (/<script(?![^>]*\bsrc=)/i.test(content)) failures.push(`inline <script> block in packaged page: ${posix}`);
}

// ---- report ------------------------------------------------------------------
if (failures.length) {
  console.error(`PACKAGING FAILED (${failures.length} problem${failures.length === 1 ? '' : 's'}):`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(`Packaged ${relFiles.length} files (${totalBytes.toLocaleString('en-US')} bytes) into ${toPosix(path.relative(process.cwd(), outDir)) || outDir}`);
console.log(`Verified: byte-identical copies, no excluded artifacts, ${references} internal references resolve, all JavaScript parses, no inline handlers or inline scripts (CSP-ready).`);
