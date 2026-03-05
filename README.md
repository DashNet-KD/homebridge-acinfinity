# homebridge-acinfinity (DashNet fork)

This is a DashNet-maintained fork of the upstream AC Infinity Homebridge plugin.

**Primary goal:** stable HomeKit control in environments where fan speed is managed by automation “ladder logic” (step-based threshold rules), rather than continuous manual slider values.

Upstream project: https://github.com/keithah/homebridge-acinfinity

## What “ladder logic” means here

In this context, **ladder logic** refers to step-based automation rules (“rungs”) that set fan speed when a sensor crosses thresholds, similar to PLC-style control systems.

Example (PM2.5 ladder):

- PM2.5 ≥ 60  → Fan 20%
- PM2.5 ≥ 150 → Fan 40%
- PM2.5 ≥ 500 → Fan 60%
- PM2.5 ≥ 650 → Fan 70%

And step-down behavior as air quality improves:

- PM2.5 ≤ 200 → Fan 50% (if previously ≥70%)
- PM2.5 ≤ 200 → Fan 40%
- PM2.5 ≤ 110 → Fan 30%
- PM2.5 ≤ 42  → Fan 20%
- PM2.5 ≤ 15  → Fan OFF

This fork keeps the plugin behavior aligned with fixed-step automation so HomeKit UI jitter and “Active” writes do not fight the automation ladder.

## DashNet changes

### 1) Snap-to-10 fan speed control (UI alignment)
HomeKit fan speed is snapped to multiples of 10 (20, 30, 40, 60, 70, etc.). This prevents intermediate slider values from fighting step-based automations.

### 2) Safe wake speed behavior
Prevents sudden “wake at 100%” behavior on Active=ON. The plugin uses the last known speed rather than blasting to full power.

### 3) Prevent spurious 10% wakes after OFF
HomeKit can emit an `Active=ON` write immediately after a `RotationSpeed=0` (OFF) write. This fork ignores those spurious ON events briefly after an OFF so the fan does not pop back to 10%.

## Versioning
DashNet versions are tagged as:

- `1.3.0-beta.4-dashnet.X`

See CHANGELOG.md for details.
