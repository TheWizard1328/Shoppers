---
title: For you
summary: A personal briefing of open tasks, messages, deadlines and decisions that
  need your attention.
---

# For you

## RxDeliver map API keys MISSING — action needed

* [ ] **Restore the 4 map API keys in the Base44 editor** — RxDeliver app editor → App Settings → Secrets. The backend function runtime lost `GOOGLE_MAPS_API_KEY`, `HERE_API_KEY`, `Here_API_Key_2`, `Here_API_Key_3` between 20:50-21:13 MDT Sep 9 (all other 58 secrets intact: Square, VAPID, FCM fine). Every Google/HERE polyline backend call silently 500s 'key not configured' — polylines stopped generating on ALL new routes (future and today's), devices keep working from cached client keys. If the secrets still appear in the editor, it's a platform env-injection bug — redeploy/re-add them. Verified by diag functions (deleted after use) Sep 9 ~22:30 MDT.

## RxAssist rollout (RxDeliver AI assistant) — action needed

* [ ] **Add `RXASSIST_API_KEY` to RxDeliver's secrets** — App editor → App Settings → Secrets/env → name it exactly `RXASSIST_API_KEY`, value = the RxAssist agent API key (same one provided to The Coder on Sep 4). The rxAssistChat backend function returns `ai_not_configured` until this is set. Everything else is deployed and verified.
* [ ] **Paste Custom Instructions into RxAssist** (agent editor → Settings) — isolation + escalation rules from the Sep 4 session; ask The Coder for the exact text.
* [ ] Optional: decide on WhatsApp triage-ping cadence for SupportTickets (scheduled workflow on The Coder's side, ~credit cost per run) — push notifications to owner/admins already work.

## How Notes help

Notes turn useful details from your conversations and connected data into a lasting workspace your Superagent can keep current.

Use them to track projects, people, decisions and follow-ups without searching through old conversations.

## Connect your data

These are examples. Connect your data to help your Superagent find the messages, tasks, and follow-ups that belong here.

<!-- base44:for-you-empty-state -->
