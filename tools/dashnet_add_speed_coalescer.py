#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import re
import sys

TS = Path("/opt/homebridge-forks/homebridge-acinfinity/src/accessories/ACInfinityFanPort.ts")
MARK = "DashNet patch: coalesce duplicate speed writes (prevents racing)"

def die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(code)

def main() -> None:
    if not TS.exists():
        die(f"not found: {TS}")

    s = TS.read_text(encoding="utf-8")

    if MARK in s:
        print("OK: coalescer already present (no changes).")
        return

    m = re.search(
        r"(async\s+setSpeed\s*\(\s*value:\s*CharacteristicValue\s*\)\s*:\s*Promise<void>\s*\{[\s\S]*?)"
        r"(const\s+speed\s*=\s*Math\.round\(\s*Number\(value\)\s*/\s*10\s*\)\s*;[^\n]*\n)",
        s,
        flags=re.M,
    )
    if not m:
        die("Could not locate setSpeed() and speed rounding line.")

    prefix = s[:m.start(2)]
    speed_line = m.group(2)
    rest = s[m.end(2):]

    block = (
        speed_line
        + f"      // {MARK}\n"
        + "      // If the requested speed matches what we just set very recently, skip the API call.\n"
        + "      const now = Date.now();\n"
        + "      const COALESCE_MS = 1500;\n"
        + "      if (this.lastSetSpeed === speed && (now - this.lastSetTime) < COALESCE_MS) {\n"
        + "        this.platform.log.info(`[FanPort] Coalescing duplicate SETSPEED to ${speed} for port ${this.portNumber} (within ${COALESCE_MS}ms)`);\n"
        + "        // Keep UI aligned with snapped speed\n"
        + "        this.fanService.updateCharacteristic(this.platform.Characteristic.RotationSpeed, speed * 10);\n"
        + "        return;\n"
        + "      }\n"
    )

    s2 = prefix + block + rest
    TS.write_text(s2, encoding="utf-8")
    print("APPLIED: speed coalescer inserted into setSpeed().")

if __name__ == "__main__":
    main()
