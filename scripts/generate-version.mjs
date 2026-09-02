/**
 * Generates public/version.json with the current git SHA short hash.
 * Called by the "prebuild" npm script before `vite build`.
 * Also writes the build ID to a temp env file that vite.config.js reads
 * for the `define` injection.
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

let buildId;
try {
  buildId = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  buildId = `build-${Date.now()}`;
}

// Write version.json to public/ so it's served as a static file
writeFileSync('public/version.json', JSON.stringify({
  buildId,
  generatedAt: new Date().toISOString(),
}, null, 2));

// Write to a temp file that vite.config.js reads for define
writeFileSync('.build-id', buildId);

console.log(`[generate-version] buildId=${buildId}`);
