import re

# ── 1. AcceptAll: the 90s watchdog timer was never cleared, so every single
#        Accept All logged a false "optimizer timed out after 90s" 90 seconds
#        later, even when the optimizer had finished in 3.4s. False errors in
#        the owner's hourly digest.
p1 = 'src/components/common/stopCardCompletionActions.js'
s = open(p1).read()
old1 = """      const coordResult = await Promise.race([
        performRouteOptimization({"""
new1 = """      // The 90 s watchdog must be CANCELLED when the optimizer wins: it used to
      // stay armed, so every Accept All logged a false "timed out after 90s"
      // error 90 s later even with the optimizer finishing in ~3 s.
      let _accTimeoutHandle = null;
      const coordResult = await Promise.race([
        performRouteOptimization({"""
assert old1 in s, 'acceptall race anchor'
s = s.replace(old1, new1, 1)

old2 = """        new Promise(resolve => setTimeout(() => {
          console.error(`⏱️ [AcceptAll] optimizer timed out after 90s — stages: ${_accMarks.join(' | ')}`);
          resolve(null);
        }, 90000)),
      ]);"""
new2 = """        new Promise(resolve => {
          _accTimeoutHandle = setTimeout(() => {
            console.error(`⏱️ [AcceptAll] optimizer timed out after 90s — stages: ${_accMarks.join(' | ')}`);
            resolve(null);
          }, 90000);
        }),
      ]).finally(() => {
        if (_accTimeoutHandle) { clearTimeout(_accTimeoutHandle); _accTimeoutHandle = null; }
      });"""
assert old2 in s, 'acceptall timer anchor'
s = s.replace(old2, new2, 1)
open(p1, 'w').write(s)

# ── 2. Patient delivery_history: trim stale arrays on the backfill pass.
#        Keith Dombroski (68e156d4b5b79aa33ef88dc7) carried ~100 entries, so his
#        Patient record crossed the 10 KB realtime limit and every write to him
#        broadcast an oversize-slimmed stub to all nine devices plus forced full
#        Patient.get fetches. appendToHistory caps new writes at 20; nothing ever
#        trimmed the ones that already existed.
p2 = 'src/components/utils/patientHistoryBackfillRunner.js'
s = open(p2).read()
old3 = """    const { history, lastDeliveryDate } = buildCleanHistory(entries);
    const existingHistory = Array.isArray(p.delivery_history) ? p.delivery_history : null;
    const existingLast = p.last_delivery_date ?? null;
    const historyChanged = !existingHistory ||
      existingHistory.length !== history.length ||
      JSON.stringify(existingHistory) !== JSON.stringify(history);"""
new3 = """    const built = buildCleanHistory(entries);
    const lastDeliveryDate = built.lastDeliveryDate;
    // Cap matches appendToHistory's MAX_HISTORY_ENTRIES (20). A long-running
    // recurring patient otherwise crosses the 10 KB realtime broadcast limit and
    // every save to them ships an oversize-stub broadcast to every device.
    const HISTORY_CAP = 20;
    const history = Array.isArray(built.history) ? built.history.slice(0, HISTORY_CAP) : [];
    const existingHistory = Array.isArray(p.delivery_history) ? p.delivery_history : null;
    const existingLast = p.last_delivery_date ?? null;
    const historyChanged = !existingHistory ||
      existingHistory.length !== history.length ||
      existingHistory.length > HISTORY_CAP ||
      JSON.stringify(existingHistory) !== JSON.stringify(history);"""
assert old3 in s, 'backfill anchor'
s = s.replace(old3, new3, 1)
open(p2, 'w').write(s)
print('acceptall watchdog + history trim patched')
