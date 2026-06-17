# GitHub Commit Message Format

Every commit pushed to the TheWizard1328/Shoppers repository MUST include a local Edmonton timestamp prefix.

## Format
```
@ MM/DD HH:MM - <your commit message here>
```

## How to generate the timestamp in Python push scripts
```python
import subprocess
ts = subprocess.run(['date', '-d', 'TZ=America/Edmonton'], capture_output=True, text=True)
# OR more reliably:
from datetime import datetime
import pytz
tz = pytz.timezone('America/Edmonton')
ts = datetime.now(tz).strftime('%m/%d %H:%M')
message = f'@ {ts} - feat: your message here'
```

## Simpler bash approach inside python subprocess
```python
import subprocess
ts = subprocess.run("TZ='America/Edmonton' date '+%m/%d %H:%M'", shell=True, capture_output=True, text=True).stdout.strip()
message = f'@ {ts} - feat: your message here'
```

## Example
`@ 06/11 22:49 - feat: hide bottom nav in landscape orientation`

This applies to ALL commits — features, fixes, reverts, everything.
