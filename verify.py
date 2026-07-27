import re

with open('base44/functions/squareReconcile/entry.ts', 'r') as f:
    content = f.read()

# Let's find all global function/const/let/var declarations using a simple regex:
# E.g., const name = ... or function name(...) or class name ... or import { ... } from ...

# Let's clean block and line comments to avoid false positives
def remove_comments(text):
    # remove block comments
    text = re.sub(r'/\*[\s\S]*?\*/', '', text)
    # remove line comments (be careful with URLs, but simple replacement is fine if we check lines)
    lines = []
    for line in text.splitlines():
        # simple check for comment
        if '//' in line:
            # check if // is inside a string (simple check, not perfect but usually fine)
            parts = line.split('//')
            # If the first part has odd quotes, // might be in string
            if parts[0].count("'") % 2 == 0 and parts[0].count('"') % 2 == 0 and parts[0].count('`') % 2 == 0:
                line = parts[0]
        lines.append(line)
    return '\n'.join(lines)

clean_code = remove_comments(content)

# Let's extract declarations at the top-level
# 1. imports: import { a, b as c } from '...'
# we can find import names
imported_names = set()
for match in re.finditer(r'import\s+\{([^}]+)\}\s+from', clean_code):
    for part in match.group(1).split(','):
        part = part.strip()
        if ' as ' in part:
            imported_names.add(part.split(' as ')[1].strip())
        elif part:
            imported_names.add(part)
for match in re.finditer(r'import\s+(\w+)\s+from', clean_code):
    imported_names.add(match.group(1).strip())

# 2. top-level classes
classes = set(re.findall(r'class\s+(\w+)', clean_code))

# 3. top-level functions
functions = set(re.findall(r'function\s+(\w+)\s*\(', clean_code))
async_functions = set(re.findall(r'async\s+function\s+(\w+)\s*\(', clean_code))
functions.update(async_functions)

# 4. top-level const/let/var
# Note: we want to only get top-level ones.
# In a simple JS/TS file, top-level const/let/var are usually at the beginning of a line or only preceded by spaces, export, etc.
const_let_vars = []
for line in clean_code.splitlines():
    line = line.strip()
    if line.startswith('export '):
        line = line[7:]
    m = re.match(r'^(const|let|var)\s+(\w+)\s*=', line)
    if m:
        const_let_vars.append(m.group(2))

# Let's check for duplicates among all declared names
all_declared = list(imported_names) + list(classes) + list(functions) + const_let_vars
seen = set()
duplicates = set()
for name in all_declared:
    if name in seen:
        duplicates.add(name)
    seen.add(name)

print("Duplicates:")
print(duplicates)
print("All declared names:")
print(sorted(list(seen)))

