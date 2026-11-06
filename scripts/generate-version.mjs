/**
 * Generates public/version.json for the running app.
 * Called by the "prebuild" npm script before `vite build`.
 * Also writes the build ID to a temp env file that vite.config.js reads
 * for the `define` injection.
 *
 * OWNER REPORT (Oct 31 2026): "the app version difference is not updating
 * after I publish". buildId used to be the raw git short SHA, so a publish
 * that Base44 rebuilt without a git author identity (or with git unavailable)
 * could produce the SAME id (or a timestamp id) and the sidebar / update
 * balloon never changed. The id is now keyed on the two numbers the owner
 * actually versions with — BUILD_NUMBER (src/changeLog.jsx) and WEB_VERSION
 * (src/version.js) — so every published build with a version bump is
 * guaranteed to report a different id to every device.
 */
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { execSync } from 'child_process';

const readNumber = (file, key, fallback = 0) => {
  try {
    if (!existsSync(file)) return fallback;
    const src = readFileSync(file, 'utf8');
    const m = new RegExp(`${key}\\s*=\\s*(\\d+)`).exec(src);
    return m ? Number(m[1]) : fallback;
  } catch {
    return fallback;
  }
};

const BUILD_NUMBER = readNumber('src/changeLog.jsx', 'BUILD_NUMBER', 0);
const WEB_VERSION = readNumber('src/version.js', 'WEB_VERSION', 0);

let sha = '';
try {
  sha = execSync('git rev-parse --short HEAD').toString().trim();
} catch {
  sha = '';
}

// PUSH_COUNT — the one number that changes on EVERY published push.
// OWNER REPORT (Nov 5 2026): "there's been no update notifications for the last
// two fixes". BUILD_NUMBER only moves on APK releases and WEB_VERSION resets to
// 0 on every successful APK build, so a plain web push (w5, w6) changed neither
// value the update check compared — devices had no way to learn a new bundle
// existed. The git commit count is monotonic by construction (never reset, never
// reused) and is known at build time on the deploy host, so it travels in
// version.json AND into the bundle itself.
let pushCount = 0;
try {
  pushCount = Number(execSync('git rev-list --count HEAD').toString().trim()) || 0;
} catch {
  pushCount = 0;
}

const buildId = `b${BUILD_NUMBER}.w${WEB_VERSION}${sha ? `-${sha}` : ''}`;

writeFileSync('public/version.json', JSON.stringify({
  buildId,
  buildNumber: BUILD_NUMBER,
  webVersion: WEB_VERSION,
  apkDigit: Number((/BAKED_APK_DIGIT = (\d+)/.exec(readFileSync('src/version.js', 'utf8')) || [0, 0])[1]) || 0,
  pushCount,
  sha,
  generatedAt: new Date().toISOString(),
}, null, 2));

writeFileSync('.build-id', buildId);
writeFileSync('.build-push-count', String(pushCount));

console.log(`[generate-version] buildId=${buildId} pushCount=${pushCount}`);
