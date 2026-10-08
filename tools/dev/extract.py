"""Extract a fenced code block from the plan by the file name mentioned just before it.

Usage: extract.py <plan> <path> [occurrence]  -> writes <path>
"""
import re, sys
from pathlib import Path

plan, path = Path(sys.argv[1]).read_text(), sys.argv[2]
nth = int(sys.argv[3]) if len(sys.argv) > 3 else 1
pat = re.compile(r"`" + re.escape(path) + r"`[^\n]*\n(?:[^\n`][^\n]*\n|\n){0,2}```[a-z]*\n(.*?)```", re.S)
found = pat.findall(plan)
if len(found) < nth:
    sys.exit(f"no block for {path}")
Path(path).parent.mkdir(parents=True, exist_ok=True)
Path(path).write_text(found[nth - 1])
print(f"wrote {path} ({len(found[nth-1].splitlines())} lines)")
