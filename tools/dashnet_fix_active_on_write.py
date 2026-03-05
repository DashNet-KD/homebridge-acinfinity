#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import re
import sys

TS = Path("/opt/homebridge-forks/homebridge-acinfinity/src/accessories/ACInfinityFanPort.ts")
MARK = "DashNet patch: ignore Active=ON writes (prevents 10% blips)"

def die(msg: str, code: int = 1) -> None:
    print(f"ERROR: {msg}", file=sys.stderr)
    raise SystemExit(code)

def main() -> None:
    if not TS.exists():
        die(f"not found: {TS}")

    s = TS.read_text(encoding="utf-8")

    if MARK in s:
        print("OK: patch already present (no changes).")
        return

    # Replace the first setActive() implementation body with a safe handler:
    # - Ignore Active=ON completely (prevents wakeSpeed=1 / 10% blips)
    # - Treat Active=OFF as "set speed 0" (safe)
    m = re.search(r"async\s+setActive\s*\(\s*value:\s*CharacteristicValue\s*\)\s*:\s*Promise<void>\s*\{", s)
    if not m:
        die("Could not find setActive()")

    # Find the end of setActive() by matching the next function signature "async getState("
    m2 = re.search(r"\n\s*async\s+getState\s*\(", s)
    if not m2:
        die("Could not find getState() anchor after setActive()")

    prefix = s[:m.start()]
    setactive_start = s[m.start():m2.start()]
    suffix = s[m2.start():]

    # Extract indentation level for the method
    indent_match = re.search(r"(\n\s*)async\s+setActive", "\n" + setactive_start)
    indent = indent_match.group(1) if indent_match else "\n  "
    ind = indent + "  "

    new_block = f"""async setActive(value: CharacteristicValue): Promise<void> {{
{ind}const active = value === this.platform.Characteristic.Active.ACTIVE;
{ind}// {MARK}
{ind}// HomeKit may emit Active=ON during RotationSpeed transitions. Writing Active=ON can cause a wake to 10%.
{ind}// DashNet behavior: treat Active as read-only and ignore Active=ON. Use RotationSpeed to control speed.
{ind}if (active) {{
{ind}  this.platform.log.info(`[FanPort] Ignoring Active=ON write for port ${{this.portNumber}}; RotationSpeed is the source of truth.`);
{ind}  return;
{ind}}}

{ind}// Active=OFF -> force speed 0
{ind}const speed = 0;
{ind}try {{
{ind}  const device = this.accessory.context.device;
{ind}  await this.platform.client.setDeviceModeSettings(
{ind}    this.deviceId,
{ind}    this.portNumber,
{ind}    [[PortControlKey.ON_SPEED, speed]],
{ind}    device?.devType,
{ind}    device
{ind}  );
{ind}  this.lastSetSpeed = speed;
{ind}  this.lastSetTime = Date.now();
{ind}  this.platform.log.info(`[FanPort] SUCCESS: set speed 0 via Active=OFF for port ${{this.portNumber}}`);
{ind}}} catch (error) {{
{ind}  this.platform.log.error(`[FanPort] ERROR setting speed 0 via Active=OFF for port ${{this.portNumber}}:`, error);
{ind}  throw new this.platform.api.hap.HapStatusError(-70402);
{ind}}}
}}
"""

    # Replace old setActive() block entirely
    s2 = prefix + new_block + suffix
    TS.write_text(s2, encoding="utf-8")
    print("APPLIED: Active=ON ignored; Active=OFF forces speed 0.")

if __name__ == "__main__":
    main()
