p = 'src/components/utils/publishedBuildInfo.jsx'
s = open(p).read()

# accept a legitimate web digit of 0 whenever an APK digit exists (fresh-reset publish)
old = """    if (!Number.isFinite(apkDigit) && !Number.isFinite(web)) return null;
    if ((!Number.isFinite(apkDigit) || apkDigit <= 0) && !(Number.isFinite(web) && web > 0)) return null;
    return { apkDigit: Number.isFinite(apkDigit) && apkDigit > 0 ? apkDigit : 0, webVersion: Number.isFinite(web) ? web : 0 };"""
new = """    const hasApk = Number.isFinite(apkDigit) && apkDigit > 0;
    const hasWeb = Number.isFinite(web) && web > 0;
    // A freshly reset publish legitimately has web 000, so an APK digit alone
    // is a valid answer; only "nothing at all" is null.
    if (!hasApk && !hasWeb) return null;
    return { apkDigit: hasApk ? apkDigit : 0, webVersion: Number.isFinite(web) ? web : 0 };"""
assert old in s
s = s.replace(old, new, 1)

old2 = """    if (!Number.isFinite(apkDigit) || apkDigit <= 0) {
      // Older live publish (no baked APK digit yet): still surface its WEB digit
      // so the owner can see the live number before the next publish.
      if (Number.isFinite(webVersion) && webVersion > 0) {
        return { apkDigit: 0, webVersion };
      }
      return readDigits();
    }"""
assert old2 in s
open(p, 'w').write(s)
print('web-0 tolerance in place')
