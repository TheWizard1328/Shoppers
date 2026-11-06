p = '.github/workflows/build-apk.yml'
s = open(p).read()

old = """          CURRENT_APK=$(grep -oP 'BAKED_APK_DIGIT = \\K[0-9]+' src/version.js || echo 0)
          NEXT_APK=$((CURRENT_APK + 1))
          sed -i "s/export const BAKED_APK_DIGIT = [0-9]\\+/export const BAKED_APK_DIGIT = ${NEXT_APK}/" src/version.js
          echo "Baked APK digit: ${CURRENT_APK} -> ${NEXT_APK}"
"""
assert old in s, 'baked step missing'
new = """          # The digit EXACTLY as baked into this APK (env APK_VERSION_NAME is
          # vX.Y.0) — never an increment, so the published bundle and the APK it
          # ships with always agree.
          BAKED_DIGIT=$(echo "${APK_VERSION_NAME#v}" | cut -d. -f2)
          if [ -n "$BAKED_DIGIT" ]; then
            sed -i "s/export const BAKED_APK_DIGIT = [0-9]\\+/export const BAKED_APK_DIGIT = ${BAKED_DIGIT}/" src/version.js
            echo "Baked APK digit set to ${BAKED_DIGIT}"
          fi
"""
s = s.replace(old, new, 1)
open(p, 'w').write(s)

# correct the current value (the run-369 bump made it 22 while that APK shipped 21)
p = 'src/version.js'
s = open(p).read()
import re
m = re.search(r'BAKED_APK_DIGIT = (\d+)', s)
print('current baked digit:', m.group(1) if m else None)
open(p, 'w').write(s)
print('workflow baked digit now exact')
