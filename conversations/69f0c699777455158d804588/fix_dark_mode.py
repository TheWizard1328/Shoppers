#!/usr/bin/env python3
"""
Adds dark: Tailwind variants to hardcoded light-mode Tailwind classes.
Only processes Tailwind classes in className, NOT CSS variables in style attrs.
"""
import re
import sys
import os

REPLACEMENTS = [
    # Hover states first (longer patterns)
    ('hover:bg-white', 'dark:hover:bg-slate-800'),
    ('hover:bg-slate-50', 'dark:hover:bg-slate-800'),
    ('hover:bg-slate-100', 'dark:hover:bg-slate-700'),
    ('hover:bg-gray-50', 'dark:hover:bg-slate-800'),
    ('hover:bg-gray-100', 'dark:hover:bg-slate-700'),
    ('hover:bg-red-50', 'dark:hover:bg-red-950'),
    ('hover:bg-blue-50', 'dark:hover:bg-blue-950'),
    ('hover:text-slate-600', 'dark:hover:text-slate-300'),
    ('hover:text-slate-700', 'dark:hover:text-slate-300'),
    ('hover:text-slate-800', 'dark:hover:text-slate-200'),
    # Backgrounds
    ('bg-white', 'dark:bg-slate-900'),
    ('bg-slate-50', 'dark:bg-slate-800'),
    ('bg-slate-100', 'dark:bg-slate-800'),
    ('bg-gray-50', 'dark:bg-slate-800'),
    ('bg-gray-100', 'dark:bg-slate-800'),
    ('bg-blue-50', 'dark:bg-blue-950'),
    ('bg-green-50', 'dark:bg-green-950'),
    ('bg-red-50', 'dark:bg-red-950'),
    ('bg-yellow-50', 'dark:bg-yellow-950'),
    ('bg-amber-50', 'dark:bg-amber-950'),
    # Text - ordered darkest to lightest
    ('text-slate-900', 'dark:text-slate-100'),
    ('text-slate-800', 'dark:text-slate-200'),
    ('text-slate-700', 'dark:text-slate-300'),
    ('text-slate-600', 'dark:text-slate-400'),
    ('text-slate-500', 'dark:text-slate-400'),
    ('text-slate-400', 'dark:text-slate-500'),
    ('text-gray-900', 'dark:text-slate-100'),
    ('text-gray-800', 'dark:text-slate-200'),
    ('text-gray-700', 'dark:text-slate-300'),
    ('text-gray-600', 'dark:text-slate-400'),
    ('text-gray-500', 'dark:text-slate-400'),
    ('text-gray-400', 'dark:text-slate-500'),
    # Borders
    ('border-slate-200', 'dark:border-slate-700'),
    ('border-slate-300', 'dark:border-slate-600'),
    ('border-gray-200', 'dark:border-slate-700'),
    ('border-gray-300', 'dark:border-slate-600'),
]

def find_var_ranges(line):
    """Find character ranges of var(...) calls in the line."""
    ranges = []
    for m in re.finditer(r'var\(', line):
        start = m.start()
        depth = 1
        i = m.end()
        while i < len(line) and depth > 0:
            if line[i] == '(':
                depth += 1
            elif line[i] == ')':
                depth -= 1
            i += 1
        ranges.append((start, i))
    return ranges

def is_in_var(pos, var_ranges):
    for start, end in var_ranges:
        if start <= pos < end:
            return True
    return False

def process_line(line):
    var_ranges = find_var_ranges(line)
    
    for light_cls, dark_cls in REPLACEMENTS:
        if dark_cls in line:
            continue
        
        pattern = r'\b' + re.escape(light_cls) + r'\b'
        
        for match in reversed(list(re.finditer(pattern, line))):
            start, end = match.start(), match.end()
            
            if is_in_var(start, var_ranges):
                continue
            
            # Skip bg-white/XX (opacity modifier)
            if light_cls == 'bg-white' and end < len(line) and line[end] == '/':
                continue
            
            line = line[:end] + ' ' + dark_cls + line[end:]
    
    return line

def process_file(filepath):
    with open(filepath, 'r', encoding='utf-8') as f:
        lines = f.readlines()
    
    changes = 0
    new_lines = []
    
    for line in lines:
        original = line
        new_line = process_line(line)
        if new_line != original:
            changes += 1
        new_lines.append(new_line)
    
    if changes > 0:
        with open(filepath, 'w', encoding='utf-8') as f:
            f.writelines(new_lines)
    
    return changes

def main():
    files = sys.argv[1:]
    if not files:
        print("Usage: python3 fix_dark_mode.py <file1> [file2] ...")
        sys.exit(1)
    
    total = 0
    for f in files:
        if not os.path.exists(f):
            print(f"  SKIP: {f}")
            continue
        n = process_file(f)
        if n > 0:
            print(f"  FIXED {n:3d} lines: {f}")
            total += n
    print(f"\nTotal: {total} lines changed")

if __name__ == '__main__':
    main()
