"""Builds the static site in docs/ from projects.json and src/.

    python -I build.py            # writes docs/
    python -I build.py --check    # builds into a temporary folder and only reports problems

Standard library only. The site has one standings page (docs/index.html), one generated dashboard per project
(docs/<slug>/index.html) and, for a project with a hand-made dashboard (`custom` in projects.json), a copy of that
folder (docs/<slug>/). Every page carries the same project switcher.

House rule: the game's title, its studio, publisher and places never appear in this repository or in the built
pages. Text from GitHub is masked in the browser (src/scrub.js); text written here must not contain them, and repo
names that do are written with an HTML character reference / JSON escape for their first letter, so the built files
never hold the name either. The last step of every build scans docs/ and fails on a hit.
"""
import argparse
import html
import json
import os
import re
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "src")
DATA = os.path.join(ROOT, "projects.json")
SITE_URL = "https://clhelper.github.io/port-dashboards/"

# The same pattern as src/scrub.js. \x escapes keep the names out of this file.
NAMED = re.compile(r"g\x74a|gr\x61nd[\s_%20.-]*the\x66t|ro\x63kstar|t\x61ke[\s_-]?two|vi\x63e[\s_-]?city", re.I)

STAGE_FIELDS = ("key", "label", "pct", "means")
PROJECT_FIELDS = ("repo", "slug", "name", "kind", "stage", "within", "status", "summary", "evidence")
STATUSES = ("active", "halted", "blocked", "no-work")
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,40}$")
REPO_RE = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
SHARED_ASSETS = ("site.css", "ladder.css", "scrub.js", "ladder.js", "switcher.js", "project.js", "standings.js")


class BuildError(Exception):
    pass


# ---------- data ----------

def load(path=DATA):
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    validate(data)
    return data


def validate(data):
    ladder = data.get("ladder")
    if not isinstance(ladder, list) or len(ladder) < 2:
        raise BuildError("projects.json: 'ladder' needs at least two stages")
    keys = []
    last = -1
    for stage in ladder:
        missing = [k for k in STAGE_FIELDS if k not in stage]
        if missing:
            raise BuildError(f"ladder stage {stage!r} lacks {missing}")
        if not isinstance(stage["pct"], (int, float)) or not last < stage["pct"] <= 100:
            raise BuildError(f"ladder stage {stage['key']}: pct must rise and stay within 0-100")
        last = stage["pct"]
        keys.append(stage["key"])
    kinds = data.get("kinds", {})
    slugs = set()
    for p in data.get("projects", []):
        missing = [k for k in PROJECT_FIELDS if k not in p]
        if missing:
            raise BuildError(f"project {p.get('repo')!r} lacks {missing}")
        if not REPO_RE.match(p["repo"]):
            raise BuildError(f"project repo {p['repo']!r} is not owner/name")
        if not SLUG_RE.match(p["slug"]) or p["slug"] in slugs or p["slug"] == "assets":
            raise BuildError(f"project slug {p['slug']!r} is invalid or repeated")
        slugs.add(p["slug"])
        if p["stage"] not in keys:
            raise BuildError(f"project {p['slug']}: unknown stage {p['stage']!r}")
        if p["kind"] not in kinds:
            raise BuildError(f"project {p['slug']}: unknown kind {p['kind']!r}")
        if p["status"] not in STATUSES:
            raise BuildError(f"project {p['slug']}: unknown status {p['status']!r}")
        if not isinstance(p["within"], (int, float)) or not 0 <= p["within"] < 1:
            raise BuildError(f"project {p['slug']}: within must be in [0, 1)")
        custom = p.get("custom")
        if custom and not os.path.isfile(os.path.join(ROOT, custom, "index.html")):
            raise BuildError(f"project {p['slug']}: custom dashboard {custom}/index.html not found")
        for field in ("name", "summary", "evidence", "caveat"):
            if isinstance(p.get(field), str) and NAMED.search(p[field]):
                raise BuildError(f"project {p['slug']}: {field} names the game; write 'the game'")


def score(project, ladder):
    """Percent along the ladder: the stage's own percent plus `within` of the way to the next stage."""
    keys = [s["key"] for s in ladder]
    i = keys.index(project["stage"])
    here = ladder[i]["pct"]
    nxt = ladder[i + 1]["pct"] if i + 1 < len(ladder) else here
    return round(here + project["within"] * (nxt - here), 1)


def standings(data):
    """Racing projects (active or halted) by score, highest first; ties share a rank."""
    ladder = data["ladder"]
    racing = [dict(p, score=score(p, ladder)) for p in data["projects"] if p["status"] in ("active", "halted")]
    racing.sort(key=lambda p: (-p["score"], p["name"].lower()))
    rank = 0
    for i, p in enumerate(racing):
        if i == 0 or p["score"] != racing[i - 1]["score"]:
            rank = i + 1
        p["rank"] = rank
    for p in racing:
        p["tied"] = sum(1 for q in racing if q["rank"] == p["rank"]) > 1
    return racing


# ---------- escaping ----------

def mask_first_letter_html(text):
    return NAMED.sub(lambda m: f"&#{ord(m.group(0)[0])};" + m.group(0)[1:], text)


def esc(value):
    """HTML text or attribute; a name inside (only ever a repo name) gets its first letter as a reference."""
    return mask_first_letter_html(html.escape("" if value is None else str(value), quote=True))


def json_for_script(value):
    """JSON safe inside <script type="application/json">, with names' first letters as \\u escapes."""
    text = json.dumps(value, ensure_ascii=True, separators=(",", ":"))
    text = text.replace("</", "<\\/")
    return NAMED.sub(lambda m: "\\u%04x" % ord(m.group(0)[0]) + m.group(0)[1:], text)


def repo_url(repo):
    return "https://github.com/" + repo


def dump_data(data, path=DATA):
    """Writes projects.json readably, with the first letter of any name (only ever in a repo name) as a JSON escape."""
    text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
    text = NAMED.sub(lambda m: "\\u%04x" % ord(m.group(0)[0]) + m.group(0)[1:], text)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


# ---------- page pieces ----------

def read_src(name):
    with open(os.path.join(SRC, name), encoding="utf-8") as f:
        return f.read()


def fill(template, values):
    def sub(m):
        key = m.group(1)
        if key not in values:
            raise BuildError(f"template placeholder {{{{{key}}}}} has no value")
        return values[key]
    return re.sub(r"\{\{(\w+)\}\}", sub, template)


def stage_of(data, key):
    return next(s for s in data["ladder"] if s["key"] == key)


def stage_number(data, key):
    return [s["key"] for s in data["ladder"]].index(key) + 1


def switcher_html(data, current, prefix):
    """The project switcher: a select grouped by ladder stage, furthest first. `prefix` leads back to the site root."""
    groups = []
    ladder = data["ladder"]
    by_stage = {}
    for p in data["projects"]:
        by_stage.setdefault(p["stage"], []).append(p)
    options = [f'<option value="{prefix}"{" selected" if current is None else ""}>Standings: every project</option>']
    for stage in reversed(ladder):
        members = sorted(by_stage.get(stage["key"], []), key=lambda p: (-p["within"], p["name"].lower()))
        if not members:
            continue
        opts = "".join(
            f'<option value="{prefix}{esc(p["slug"])}/"{" selected" if current == p["slug"] else ""}>{esc(p["name"])}</option>'
            for p in members)
        groups.append(f'<optgroup label="{esc(stage["label"])}">{opts}</optgroup>')
    return (f'<label class="switch"><span>Project</span><select id="switcher" aria-label="Pick a project">'
            f'{"".join(options)}{"".join(groups)}</select></label>')


def topbar(data, current, prefix):
    return (f'<header class="topbar"><div class="wrap">'
            f'<a class="brand" href="{prefix}">Road to Playable</a>'
            f'{switcher_html(data, current, prefix)}'
            f'<span class="checked">Standings checked {esc(data["checked"])}</span>'
            f'</div></header>')


def head(title, description, url, prefix):
    return (f'<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
            f'<title>{esc(title)}</title>'
            f'<meta name="description" content="{esc(description)}">'
            f'<meta property="og:type" content="website"><meta property="og:title" content="{esc(title)}">'
            f'<meta property="og:description" content="{esc(description)}"><meta property="og:url" content="{esc(url)}">'
            f'<meta name="theme-color" content="#0a0718">'
            f'<link rel="icon" href="{prefix}assets/favicon-64.png" sizes="64x64" type="image/png">'
            f'<link rel="stylesheet" href="{prefix}assets/site.css">'
            f'<link rel="stylesheet" href="{prefix}assets/ladder.css">')


def page(title, description, url, prefix, body, scripts, data_json):
    return fill(read_src("shell.html"), {
        "head": head(title, description, url, prefix),
        "body": body,
        "data": data_json,
        "scripts": "".join(f'<script src="{prefix}assets/{s}"></script>' for s in scripts),
    })


def badge(project):
    labels = {"active": "Active", "halted": "Halted", "blocked": "Blocked", "no-work": "Nothing published"}
    return f'<span class="badge {esc(project["status"])}">{labels[project["status"]]}</span>'


def facts(project):
    rows = [("Evidence", project.get("evidence")), ("Caveat", project.get("caveat")),
            ("Tested on", project.get("tested_on")), ("Graphics", project.get("backend")),
            ("Shaders", project.get("shader_path")), ("Language", project.get("language"))]
    items = "".join(f"<div><dt>{k}</dt><dd>{esc(v)}</dd></div>" for k, v in rows if v)
    return f'<dl class="facts">{items}</dl>'


def standings_row(data, p, prefix):
    stage = stage_of(data, p["stage"])
    rank = f'{p["rank"]}{"=" if p["tied"] else ""}'
    dash = f'{prefix}{esc(p["slug"])}/'
    avatar = esc(p.get("avatar") or "")
    img = f'<img class="av" src="{avatar}" alt="" loading="lazy" width="40" height="40">' if avatar else '<span class="av"></span>'
    base = ""
    if p.get("base"):
        b = next((q for q in data["projects"] if q["repo"] == p["base"]), None)
        base = f' <span class="base">builds on {esc(b["name"] if b else p["base"])}</span>'
    return (f'<li class="row" data-repo="{esc(p["repo"])}">'
            f'<div class="rank">{rank}</div>{img}'
            f'<div class="who"><h3><a href="{dash}">{esc(p["name"])}</a>{base}</h3>'
            f'<p class="kind">{esc(data["kinds"][p["kind"]]["label"])} · {badge(p)} · '
            f'<span class="pushed" data-pushed="{esc(p.get("pushed_at") or "")}"></span></p>'
            f'<p class="summary">{esc(p["summary"])}</p>{facts(p)}</div>'
            f'<div class="where"><div class="stage-n">Stage {stage_number(data, p["stage"])} of {len(data["ladder"])}</div>'
            f'<div class="stage-l">{esc(stage["label"])}</div><div class="score">{p["score"]:g}%</div>'
            f'<div class="links"><a class="btn primary" href="{dash}">Dashboard</a>'
            f'<a class="btn" href="{esc(repo_url(p["repo"]))}" target="_blank" rel="noopener">GitHub ↗</a></div></div>'
            f'</li>')


def markers(data, ranked, prefix):
    return [{"name": p["name"], "score": p["score"], "avatar": p.get("avatar"), "href": f'{prefix}{p["slug"]}/',
             "slug": p["slug"]} for p in ranked]


def build_standings(data):
    ranked = standings(data)
    if not ranked:
        raise BuildError("no active or halted project to rank")
    leader = ranked[0]
    ladder = data["ladder"]
    furthest = stage_of(data, leader["stage"])
    top3 = round(sum(p["score"] for p in ranked[:3]) / min(3, len(ranked)))
    menus_pct = stage_of(data, "menus")["pct"] if any(s["key"] == "menus" for s in ladder) else 0
    at_menus = sum(1 for p in ranked if p["score"] >= menus_pct)
    playable = any(p["stage"] == ladder[-1]["key"] for p in ranked)
    others = [p for p in data["projects"] if p["status"] in ("blocked", "no-work")]
    rows = "".join(standings_row(data, p, "") for p in ranked)
    watched = "".join(
        f'<li><a href="{esc(p["slug"])}/">{esc(p["name"])}</a> {badge(p)} <span>{esc(p["summary"])}</span></li>'
        for p in others)
    stages = "".join(
        f'<li><b>{s["pct"]:g}% · {esc(s["label"])}</b><span>{esc(s["means"])}</span></li>' for s in ladder)
    kinds = "".join(f'<li><b>{esc(k["label"])}</b><span>{esc(k["about"])}</span></li>' for k in data["kinds"].values())
    body = fill(read_src("standings.html"), {
        "topbar": topbar(data, None, ""),
        "answer": "Yes." if playable else "Not yet.",
        "answer_class": "yes" if playable else "no",
        "count": str(len(data["projects"])),
        "leader_score": f'{leader["score"]:g}',
        "leader_name": esc(leader["name"]),
        "leader_href": f'{esc(leader["slug"])}/',
        "leader_stage": esc(furthest["label"]),
        "furthest": esc(furthest["label"]),
        "top3": str(top3),
        "at_menus": f"{at_menus}/{len(ranked)}",
        "racing": str(len(ranked)),
        "rows": rows,
        "watched": watched or "<li>None.</li>",
        "stages": stages,
        "kinds": kinds,
        "checked": esc(data["checked"]),
    })
    payload = {"ladder": ladder, "markers": markers(data, ranked, ""), "highlight": leader["slug"]}
    return page("Road to Playable: every project, one ladder",
                f"{len(ranked)} projects racing to run an Xbox Series game natively on PC, ranked on one milestone ladder.",
                SITE_URL, "", body, ["scrub.js", "ladder.js", "switcher.js", "standings.js"], json_for_script(payload))


def build_project(data, p, ranked):
    prefix = "../"
    ladder = data["ladder"]
    stage = stage_of(data, p["stage"])
    s = score(p, ladder)
    kind = data["kinds"][p["kind"]]
    entry = next((q for q in ranked if q["slug"] == p["slug"]), None)
    position = (f'#{entry["rank"]}{"=" if entry["tied"] else ""} of {len(ranked)}' if entry else "not ranked")
    base = next((q for q in data["projects"] if q["repo"] == p.get("base")), None) if p.get("base") else None
    body = fill(read_src("project.html"), {
        "topbar": topbar(data, p["slug"], prefix),
        "name": esc(p["name"]),
        "repo": esc(p["repo"]),
        "repo_url": esc(repo_url(p["repo"])),
        "kind": esc(kind["label"]),
        "kind_about": esc(kind["about"]),
        "badge": badge(p),
        "summary": esc(p["summary"]),
        "facts": facts(p),
        "score": f"{s:g}",
        "dash": f"{540.35 * (1 - s / 100):.2f}",
        "stage_n": str(stage_number(data, p["stage"])),
        "stage_total": str(len(ladder)),
        "stage": esc(stage["label"]),
        "stage_means": esc(stage["means"]),
        "position": position,
        "base_block": (f'<p class="base-line">Builds on <a href="{prefix}{esc(base["slug"])}/">{esc(base["name"])}</a>; '
                       f'the <a href="#upstream">upstream</a> section compares the two.</p>' if base else ""),
        "upstream_section": read_src("upstream.html") if base else "",
        "checked": esc(data["checked"]),
    })
    payload = {
        "ladder": ladder,
        "project": {k: p.get(k) for k in ("repo", "slug", "name", "kind", "base", "stage", "status")},
        "base": {"repo": base["repo"], "name": base["name"]} if base else None,
        "markers": markers(data, ranked, prefix),
        "highlight": p["slug"],
        "self": {"name": p["name"], "score": s, "avatar": p.get("avatar"), "href": "./", "slug": p["slug"]},
    }
    return page(f'{p["name"]}: Road to Playable',
                f'{p["name"]}: stage {stage_number(data, p["stage"])} of {len(ladder)}, {stage["label"]}. {p["summary"]}',
                f'{SITE_URL}{p["slug"]}/', prefix, body,
                ["scrub.js", "ladder.js", "switcher.js", "project.js"], json_for_script(payload))


# ---------- output ----------

def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


def build(out):
    data = load()
    ranked = standings(data)
    # Empty the folder rather than delete it: on Windows a folder that is some process's working directory (a local
    # preview server) cannot be removed.
    os.makedirs(out, exist_ok=True)
    for entry in os.scandir(out):
        if entry.is_dir(follow_symlinks=False):
            shutil.rmtree(entry.path)
        else:
            os.remove(entry.path)
    write(os.path.join(out, ".nojekyll"), "")
    write(os.path.join(out, "index.html"), build_standings(data))
    os.makedirs(os.path.join(out, "assets"))
    for name in SHARED_ASSETS + ("favicon-64.png", "favicon-32.png", "favicon-180.png"):
        shutil.copyfile(os.path.join(SRC, name), os.path.join(out, "assets", name))
    public = {"checked": data["checked"], "ladder": data["ladder"], "kinds": data["kinds"],
              "standings": [{k: p.get(k) for k in ("slug", "name", "repo", "stage", "score", "rank", "avatar", "status")}
                            for p in ranked],
              "projects": [{k: p.get(k) for k in ("slug", "name", "stage", "within")} for p in data["projects"]]}
    write(os.path.join(out, "data.json"), json_for_script(public))
    for p in data["projects"]:
        target = os.path.join(out, p["slug"])
        if p.get("custom"):
            shutil.copytree(os.path.join(ROOT, p["custom"]), target)
        else:
            write(os.path.join(target, "index.html"), build_project(data, p, ranked))
    scan(out)
    return data, ranked


def scan(out):
    """Fails the build when a built text file holds a name: a masking step was missed."""
    hits = []
    for folder, _, files in os.walk(out):
        for name in files:
            if name.endswith((".png", ".jpg", ".woff2")):
                continue
            path = os.path.join(folder, name)
            with open(path, encoding="utf-8") as f:
                for n, line in enumerate(f, 1):
                    if NAMED.search(line):
                        hits.append(f"{os.path.relpath(path, out)}:{n}")
    if hits:
        raise BuildError("built files name the game: " + ", ".join(hits[:10]))


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--check", action="store_true", help="build into a temporary folder and report only")
    parser.add_argument("--out", default=os.path.join(ROOT, "docs"))
    args = parser.parse_args(argv)
    try:
        if args.check:
            with tempfile.TemporaryDirectory() as tmp:
                data, ranked = build(os.path.join(tmp, "docs"))
        else:
            data, ranked = build(args.out)
    except (BuildError, OSError, json.JSONDecodeError) as e:
        print(f"build failed: {e}", file=sys.stderr)
        return 1
    print(f"built {len(data['projects'])} dashboards; leader {ranked[0]['name']} at {ranked[0]['score']:g}%")
    return 0


if __name__ == "__main__":
    sys.exit(main())
