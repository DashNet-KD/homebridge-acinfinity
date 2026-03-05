#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import re
import sys
import subprocess

REPO = Path("/opt/homebridge-forks/homebridge-acinfinity")
TS = REPO / "src" / "accessories" / "ACInfinityFanPort.ts"

MARKER = "DashNet patch: ignore spurious Active=ON right after off (prevents 10% blips)"
GUARD_RE = re.compile(r"DashNet patch: ignore spurious Active=ON right after off", re.M)

def run(cmd: list[str], cwd: Path | None = None) -> None:
    p = subprocess.run(cmd, cwd=str(cwd) if cwd else None)
    if p.returncode != 0:
        raise SystemExit(p.returncode)

def main() -> None:
    if not TS.exists():
        print(f"ERROR: not found: {TS}", file=sys.stderr)
        raise SystemExit(1)

    s = TS.read_text(encoding="utf-8")

    # Idempotent: if already patched, exit cleanly
    if GUARD_RE.search(s):
        print("OK: guard already present (no changes).")
        return

    # Find setActive() header and the line "const active = ..."
    m = re.search(
        r"(async\s+setActive\s*\(\s*value:\s*CharacteristicValue\s*\)\s*:\s*Promise<void>\s*\{\s*\n)"
        r"(\s*const\s+active\s*=\s*value\s*===\s*this\.platform\.Characteristic\.Active\.ACTIVE\s*;\s*\n)",
        s,
        flags=re.M,
    )
    if not m:
        print("ERROR: Could not locate setActive() + const active line to patch.", file=sys.stderr)
        raise SystemExit(2)

    header = m.group(1)
    active_line = m.group(2)

    # Insert guard immediately after "const active = ..."
    # Logic:
    # - If HomeKit calls Active=ON but we very recently set speed=0, ignore it.
    # - Keeps your wakeSpeed behavior for real ON events.
    guard = (
        active_line +
        "    // " + MARKER + "\n"
        "    // HomeKit sometimes emits an Active=ON during RotationSpeed transitions.\n"
        "    // If we *just* turned the fan off (lastSetSpeed=0), ignore the ON to avoid a 10% wake.\n"
        "    const now = Date.now();\n"
        "    const OFF_DEBOUNCE_MS = 2500;\n"
        "    if (active && this.lastSetSpeed === 0 && (now - this.lastSetTime) < OFF_DEBOUNCE_MS) {\n"
        "      this.platform.log.info(`[FanPort] Ignoring spurious Active=ON (debounce ${OFF_DEBOUNCE_MS}ms) for port ${this.portNumber}`);\n"
        "      return;\n"
        "    }\n"
    )

    s2 = s[:m.start(2)] + guard + s[m.end(2):]
    TS.write_text(s2, encoding="utf-8")

    print("APPLIED: spurious-10%-wake guard inserted into setActive().")
    print("Next: run build + restart (commands below).")

if __name__ == "__main__":
    main()
