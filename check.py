import re

with open('base44/functions/squareCleanupCatalog/entry.ts', 'r') as f:
    code = f.read()

defs = []
for m in re.finditer(r'\b(const|let|var)\s+([a-zA-Z0-9_$]+)\s*=', code):
    defs.append((m.group(1), m.group(2), m.start()))

for m in re.finditer(r'\b(function)\s+([a-zA-Z0-9_$]+)\s*\(', code):
    defs.append((m.group(1), m.group(2), m.start()))

for m in re.finditer(r'\bclass\s+([a-zA-Z0-9_$]+)', code):
    defs.append(('class', m.group(1), m.start()))

seen = {}
duplicates = []
for kind, name, pos in defs:
    if name in seen:
        duplicates.append((name, kind, seen[name], pos))
    else:
        seen[name] = (kind, pos)

if duplicates:
    print("Found duplicates:")
    for name, kind, (prev_kind, prev_pos), pos in duplicates:
        print(f"  - '{name}' ({kind} at pos {pos}) already defined as '{prev_kind}' at pos {prev_pos}")
else:
    print("No duplicates found with simple regex!")
