p = 'base44/functions/getPublishedBuildInfo/entry.ts'
s = open(p).read()

old = """          webVersion: Number(data?.webVersion) || 0,
          pushCount: Number(data?.pushCount) || 0,"""
new = """          webVersion: Number(data?.webVersion) || 0,
          // APK digit baked into the PUBLISHED bundle (src/version.js
          // BAKED_APK_DIGIT). Owner report Nov 6 2026: the live row under the
          // preview version never rendered because this function dropped the
          // field, so every client received no digit and showed nothing.
          apkDigit: Number(data?.apkDigit) || 0,
          pushCount: Number(data?.pushCount) || 0,"""
assert old in s
s = s.replace(old, new, 1)
s = s.replace("// Returns { buildNumber, webVersion, buildId, generatedAt, fetchedAt } or",
              "// Returns { buildNumber, webVersion, apkDigit, pushCount, buildId, generatedAt, fetchedAt } or", 1)
open(p, 'w').write(s)
print('backend now returns apkDigit')
