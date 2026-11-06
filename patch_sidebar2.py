p = 'src/components/layout/AppSidebar.jsx'
s = open(p).read()

old = """          <div className="flex items-center gap-1">
            {/* OWNER LAYOUT (Nov 1 2026): the version line is plain text again —
                the entry point is now a separate "Change Logs" row underneath,
                so the version number is not itself a link and the builds-ahead
                counter reads cleanly next to it. */}
            <p className="text-xs text-soft text-left">
              {appVersion}
              {/* Owner-only builds-ahead counter: monotonic BUILD_NUMBER minus
                  the live deployment's build number, so it survives APK bumps
                  and the WEB_VERSION reset to 0 (owner request Oct 30 2026). */}
              {buildsAheadCount > 0 && (
                <span className="ml-1 font-semibold text-amber-600">(+{buildsAheadCount})</span>
              )}
            </p>
            {liveVersionLabel && (
              <p className="text-[11px] text-soft text-left leading-tight">{liveVersionLabel}</p>
            )}"""

new = """          <div className="flex items-start gap-1">
            {/* OWNER LAYOUT (Nov 6 2026): TWO rows, always stacked — the preview
                version on top and the live version in parentheses underneath.
                They used to share one flex row, so on a phone the live number was
                pushed off the panel and the owner only ever saw one number. */}
            <div className="flex flex-col text-left leading-tight">
              <p className="text-xs text-soft">
                {appVersion}
                {/* Owner-only builds-ahead counter. */}
                {buildsAheadCount > 0 && (
                  <span className="ml-1 font-semibold text-amber-600">(+{buildsAheadCount})</span>
                )}
              </p>
              {liveVersionLabel && (
                <p className="text-[11px] text-soft whitespace-nowrap">({liveVersionLabel})</p>
              )}
            </div>"""
assert old in s, 'sidebar version block anchor missing'
s = s.replace(old, new, 1)
open(p, 'w').write(s)
print('sidebar stacked')
