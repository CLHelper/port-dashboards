"""Refreshes the GitHub facts stored in projects.json (owner avatar, created and pushed times, licence).

    python -I refresh.py            # every project
    python -I refresh.py xcl tuxbox # only these slugs

Uses the public GitHub API without a token (one request per project), so nothing identifies who ran it. The
hand-written fields (stage, summary, evidence...) are never touched: those come from reading each project's sources.
Standard library only.
"""
import json
import os
import sys
import urllib.error
import urllib.request

import build

ROOT = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(ROOT, "projects.json")
API = "https://api.github.com/repos/"
AVATAR_SIZE = "&s=80"
TIMEOUT_S = 20


def fetch(repo):
    req = urllib.request.Request(API + repo, headers={"Accept": "application/vnd.github+json",
                                                      "User-Agent": "port-dashboards-refresh"})
    with urllib.request.urlopen(req, timeout=TIMEOUT_S) as res:
        return json.load(res)


def refresh(project, meta):
    avatar = (meta.get("owner") or {}).get("avatar_url")
    if avatar:
        project["avatar"] = avatar + AVATAR_SIZE
    project["pushed_at"] = meta.get("pushed_at")
    project["branch"] = meta.get("default_branch") or project.get("branch") or "main"
    project["created_at"] = meta.get("created_at")
    project["license"] = (meta.get("license") or {}).get("spdx_id")


def main(argv):
    with open(DATA, encoding="utf-8") as f:
        data = json.load(f)
    wanted = set(argv)
    failed = 0
    for p in data["projects"]:
        if wanted and p["slug"] not in wanted:
            continue
        try:
            refresh(p, fetch(p["repo"]))
            print(f"{p['slug']}: pushed {p['pushed_at']}")
        except (urllib.error.URLError, TimeoutError, ValueError) as e:
            failed += 1
            print(f"{p['slug']}: not refreshed ({e})", file=sys.stderr)
    build.dump_data(data, DATA)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
