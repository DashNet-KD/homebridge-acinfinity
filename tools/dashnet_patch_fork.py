#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import argparse
import json
import re
import subprocess
import sys

REPO_DIR = Path("/opt/homebridge-forks/homebridge-acinfinity")

PLATFORM_TS = REPO_DIR / "src" / "platform.ts"
PACKAGE_JSON = REPO_DIR / "package.json"

SIGNATURE_LINE = "DashNet fork active (snap-to-10 + safe wake speed)"
SIGNATURE_STMT = f"this.log.info('{SIGNATURE_LINE}');"

def run(cmd: list[str], cwd: Path | None = None) -> None:
    p = subprocess.run(cmd, cwd=str(cwd) if cwd else None, text=True)
    if p.returncode != 0:
        raise SystemExit(p.returncode)

def patch_platform_ts() -> bool:
    if not PLATFORM_TS.exists():
        raise SystemExit(f"ERROR: missing {PLATFORM_TS}")

    s = PLATFORM_TS.read_text(encoding="utf-8")

    if SIGNATURE_LINE in s or SIGNATURE_STMT in s:
        return False

    m = re.search(r"^\s*this\.log\s*=\s*log\s*;\s*$", s, flags=re.MULTILINE)
    if not m:
        raise SystemExit("ERROR: Could not find a line like: this.log = log; in src/platform.ts")

    insert = m.group(0) + "\n        " + SIGNATURE_STMT
    s2 = s[:m.start()] + insert + s[m.end():]

    PLATFORM_TS.write_text(s2, encoding="utf-8")
    return True

def patch_package_json(owner: str, repo: str) -> bool:
    if not PACKAGE_JSON.exists():
        raise SystemExit(f"ERROR: missing {PACKAGE_JSON}")

    data = json.loads(PACKAGE_JSON.read_text(encoding="utf-8"))
    changed = False

    desired_repo_url = f"https://github.com/{owner}/{repo}.git"
    desired_homepage = f"https://github.com/{owner}/{repo}#readme"
    desired_changelog = f"https://github.com/{owner}/{repo}/blob/beta4-dashnet/CHANGELOG.md"
    desired_bugs = f"https://github.com/{owner}/{repo}/issues"

    repo_obj = data.get("repository")
    if not isinstance(repo_obj, dict) or repo_obj.get("url") != desired_repo_url:
        data["repository"] = {"type": "git", "url": desired_repo_url}
        changed = True

    if data.get("homepage") != desired_homepage:
        data["homepage"] = desired_homepage
        changed = True

    bugs_obj = data.get("bugs")
    if not isinstance(bugs_obj, dict) or bugs_obj.get("url") != desired_bugs:
        data["bugs"] = {"url": desired_bugs}
        changed = True

    if data.get("changelog") != desired_changelog:
        data["changelog"] = desired_changelog
        changed = True

    if changed:
        PACKAGE_JSON.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")

    return changed

def git_commit(message: str) -> None:
    run(["git", "add", "-A"], cwd=REPO_DIR)
    p = subprocess.run(["git", "diff", "--cached", "--quiet"], cwd=str(REPO_DIR))
    if p.returncode == 0:
        print("OK: nothing to commit.")
        return
    run(["git", "commit", "-m", message], cwd=REPO_DIR)

def main() -> None:
    ap = argparse.ArgumentParser(description="DashNet patch helper for homebridge-acinfinity fork")
    ap.add_argument("--owner", default="keyadash", help="GitHub owner/org for cosmetic URLs")
    ap.add_argument("--repo", default="homebridge-acinfinity", help="GitHub repo name for cosmetic URLs")
    ap.add_argument("--no-package-json", action="store_true", help="Skip package.json cosmetic fixes")
    ap.add_argument("--build", action="store_true", help="Run npm run build after patching")
    ap.add_argument("--commit", action="store_true", help="git commit changes after patching")
    ap.add_argument("--commit-message", default="DashNet: add fork signature log line", help="Commit message")
    args = ap.parse_args()

    if not REPO_DIR.exists():
        raise SystemExit(f"ERROR: repo dir not found: {REPO_DIR}")

    changed_platform = patch_platform_ts()
    changed_pkg = False
    if not args.no_package_json:
        changed_pkg = patch_package_json(args.owner, args.repo)

    print("APPLIED: platform.ts signature log line" if changed_platform else "OK: platform.ts already has signature log line")
    if args.no_package_json:
        print("SKIP: package.json")
    else:
        print("APPLIED: package.json cosmetic URLs" if changed_pkg else "OK: package.json cosmetic URLs already set")

    if args.build:
        print("BUILD: npm run build")
        run(["npm", "run", "build"], cwd=REPO_DIR)

    if args.commit:
        print("GIT: committing")
        git_commit(args.commit_message)

    print("DONE.")

if __name__ == "__main__":
    main()
