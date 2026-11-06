import re

# A) workflow: bump BAKED_APK_DIGIT in the same commit as the WEB reset
p = '.github/workflows/build-apk.yml'
s = open(p).read()
old = '          sed -i "s/export const WEB_VERSION = [0-9]\\+/export const WEB_VERSION = 0/" src/version.js\n'
assert old in s, 'workflow anchor missing'
new = old + (
    '          # OWNER SPEC (Nov 6 2026): the bundle published from now on carries\n'
    '          # this APK digit, so the live sidebar reads v2.[APK].[WEB] and holds\n'
    '          # the OLD digit until the next web publish.\n'
    '          CURRENT_APK=$(grep -oP \'BAKED_APK_DIGIT = \\K[0-9]+\' src/version.js || echo 0)\n'
    '          NEXT_APK=$((CURRENT_APK + 1))\n'
    '          sed -i "s/export const BAKED_APK_DIGIT = [0-9]\\+/export const BAKED_APK_DIGIT = ${NEXT_APK}/" src/version.js\n'
    '          echo "Baked APK digit: ${CURRENT_APK} -> ${NEXT_APK}"\n'
)
s = s.replace(old, new, 1)
open(p, 'w').write(s)

# B) publishedBuildInfo: carry apkDigit + webVersion through the cache
p = 'src/components/utils/publishedBuildInfo.jsx'
s = open(p).read()
s = s.replace(
    "writeCache({ buildNumber, webVersion: Number(data?.webVersion) || 0, buildId: data?.buildId || null });",
    "writeCache({ buildNumber, webVersion: Number(data?.webVersion) || 0, apkDigit: Number(data?.apkDigit) || 0, buildId: data?.buildId || null });",
    1)
if 'apkDigit' not in s:
    # fall back: append apkDigit wherever webVersion is cached
    s = re.sub(r"writeCache\(\{([^}]*?)webVersion: Number\(data\?\.webVersion\) \|\| 0,", r"writeCache({\1webVersion: Number(data?.webVersion) || 0, apkDigit: Number(data?.apkDigit) || 0,", s)
open(p, 'w').write(s)

# C) published push count hook already exists in this file; expose apk+web sync readers
if 'getPublishedApkDigitSync' not in s:
    s = open(p).read()
    anchor = 'export const getPublishedPushSync ='
    if anchor in s:
        add = """export const getPublishedApkDigitSync = () => {
  const cached = readCache();
  const d = Number(cached?.apkDigit);
  const w = Number(cached?.webVersion);
  if (!Number.isFinite(d) || d <= 0) return null;
  return { apkDigit: d, webVersion: Number.isFinite(w) ? w : 0 };
};

"""
        s = s.replace(anchor, add + anchor, 1)
        open(p, 'w').write(s)
        print('sync apk reader added')
print('patched workflow + publishedBuildInfo')
