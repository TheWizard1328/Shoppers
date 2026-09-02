---
title: Previous conversation · Apr 28, 2026
summary: 'Why his phone and not yours — ranked suspects:'
source_conversation_id: 69f0c699777455158d804588
source_selections:
- message_id: d36e534d-e47b-4be4-8ca7-cfc115c82992
  content_sha256: e6f876adc6df266a20c53fc594bb8fe435de42041ec26bd64d0ca4184308d9cb
---

Why his phone and not yours — ranked suspects:

Samsung's background usage limits (most likely). One UI on the S26 Ultra (Android 16 era) is dramatically more aggressive than your Z Fold 6's One UI. "Put unused apps to sleep" is on by default, and deep-sleeping apps get their network and CPU frozen — foreground service included. Critically, this policy is per-device and usage-adaptive: a brand-new phone with no usage history treats unfamiliar apps harsher. Same APK, different sentence.

Battery optimization. The app never requests exemption (no REQUEST_IGNORE_BATTERY_OPTIMIZATIONS in the manifest), so it defaults to "Optimized" → Doze throttles and eventually freezes the service. If you ever manually set your phone to "Unrestricted," that alone explains the difference.

Notification permission. If Sharuk blocked notifications (or swiped the channel), Android 13+ silently kills the foreground service seconds after backgrounding — there'd be no "RxDeliver — Active Delivery" persistent notification. Quick tell: ask him if he sees that notification while on duty with the app backgrounded.

Location permission mode. "While using the app" instead of "Allow all the time" — the app has an in-app nudge banner for this, but he may have dismissed it. Some One UI builds cut background location anyway when it's not "all the time."

5-min checklist for Sharuk's phone (no code changes): App info → Battery → Unrestricted; Settings → Battery → Background usage limits → move RxDeliver to Never sleeping apps; App info → Permissions → Location → Allow all the time; confirm notifications enabled. If it still dies after that, it's Samsung Auto Blocker/Adaptive Battery doing something exotic.
