# GitHub Commit Message Format

Every commit pushed to the TheWizard1328/Shoppers repository MUST include a local Edmonton timestamp prefix.

## Format
```
@ MM/DD HH:MM - <your commit message here>
```

## MANDATORY bash pattern — use EXACTLY this in every commit

```bash
ts=$(TZ='America/Edmonton' date '+%m/%d %H:%M') && git commit -m "@ $ts - your message here"
```

**Never use plain `date` without the `TZ=` prefix — the sandbox runs UTC.**
**Never use `date -d 'TZ=...'` — that is wrong Linux syntax.**
**Always capture the timestamp in a variable FIRST, then use it in the commit message.**

## Full push sequence (copy-paste ready)
```bash
git add <files>
ts=$(TZ='America/Edmonton' date '+%m/%d %H:%M') && git commit -m "@ $ts - feat: your message here"
git push origin main && git push github main
```

## Verification
After generating the timestamp, confirm it looks like `07/30 20:57` (not `07/31 02:57`) before committing.
Current UTC offset for Edmonton: MDT = UTC-6, MST = UTC-7.

## Example
`@ 07/30 20:57 - feat: store abbreviation badges in route optimization dialog`

This applies to ALL commits — features, fixes, reverts, everything.
