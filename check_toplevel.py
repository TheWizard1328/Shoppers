import re

with open('base44/functions/squareCleanupCatalog/entry.ts', 'r') as f:
    lines = f.readlines()

toplevel_names = []

for idx, line in enumerate(lines):
    # Match starting with const/let/var/function/class at the beginning of the line (or only optional spaces)
    # const name = ...
    m = re.match(r'^(const|let|var|class|function|async\s+function)\s+([a-zA-Z0-9_$]+)', line.strip())
    if m:
        kind = m.group(1)
        name = m.group(2)
        toplevel_names.append((kind, name, idx + 1))

print("Found top-level declarations:")
seen = {}
duplicates = []
for kind, name, line_num in toplevel_names:
    print(f"  Line {line_num:3d}: {kind} {name}")
    if name in seen:
        duplicates.append((name, kind, seen[name], line_num))
    else:
        seen[name] = (kind, line_num)

if duplicates:
    print("\nWARNING: Duplicate top-level declarations found!")
    for name, kind, (prev_kind, prev_line), line_num in duplicates:
        print(f"  - '{name}' (line {line_num}, {kind}) also declared as '{prev_kind}' on line {prev_line}")
else:
    print("\nNo duplicate top-level declarations found!")

