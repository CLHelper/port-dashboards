"""Tests for build.py: scores, ranking, validation, masking and the built site. Standard library only:

    python -I -m unittest discover -s tests
"""
import copy
import json
import os
import re
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import build  # noqa: E402

LADDER = [
    {"key": "a", "label": "A", "pct": 0, "means": "a"},
    {"key": "b", "label": "B", "pct": 40, "means": "b"},
    {"key": "c", "label": "C", "pct": 100, "means": "c"},
]
KINDS = {"compat-layer": {"label": "Layer", "about": "x"}}


def project(slug, stage, within, status="active", **extra):
    p = {"repo": f"owner/{slug}", "slug": slug, "name": slug.title(), "kind": "compat-layer", "stage": stage,
         "within": within, "status": status, "summary": "s", "evidence": "e"}
    p.update(extra)
    return p


def data(*projects):
    return {"checked": "2026-11-24", "ladder": LADDER, "kinds": KINDS, "projects": list(projects)}


class ScoreTests(unittest.TestCase):
    def test_within_interpolates_to_the_next_stage(self):
        self.assertEqual(build.score(project("x", "b", 0.5), LADDER), 70.0)

    def test_the_last_stage_does_not_go_past_it(self):
        self.assertEqual(build.score(project("x", "c", 0.5), LADDER), 100)

    def test_ties_share_a_rank_and_the_next_rank_skips(self):
        ranked = build.standings(data(project("p", "b", 0.5), project("q", "b", 0.5), project("r", "a", 0.1)))
        self.assertEqual([(p["slug"], p["rank"], p["tied"]) for p in ranked],
                         [("p", 1, True), ("q", 1, True), ("r", 3, False)])

    def test_blocked_and_no_work_projects_are_not_ranked(self):
        ranked = build.standings(data(project("p", "b", 0), project("q", "c", 0, status="no-work"),
                                      project("r", "c", 0, status="blocked")))
        self.assertEqual([p["slug"] for p in ranked], ["p"])


class ValidationTests(unittest.TestCase):
    def test_a_valid_file_passes(self):
        build.validate(data(project("p", "b", 0)))

    def test_unknown_stage_kind_status_and_bad_within_are_refused(self):
        for bad in ({"stage": "zz"}, {"kind": "zz"}, {"status": "zz"}, {"within": 1}, {"within": -0.1}):
            with self.subTest(bad=bad), self.assertRaises(build.BuildError):
                build.validate(data(dict(project("p", "b", 0), **bad)))

    def test_repeated_or_reserved_slugs_are_refused(self):
        with self.assertRaises(build.BuildError):
            build.validate(data(project("p", "b", 0), project("p", "a", 0)))
        with self.assertRaises(build.BuildError):
            build.validate(data(project("assets", "b", 0)))

    def test_a_ladder_that_does_not_rise_is_refused(self):
        d = data(project("p", "b", 0))
        d["ladder"] = copy.deepcopy(LADDER)
        d["ladder"][2]["pct"] = 30
        with self.assertRaises(build.BuildError):
            build.validate(d)

    def test_text_naming_the_game_is_refused(self):
        name = "G" + "TA"   # built at run time so this file never holds the name either
        with self.assertRaises(build.BuildError):
            build.validate(data(project("p", "b", 0, summary=f"runs {name} fine")))


class MaskingTests(unittest.TestCase):
    NAME = "G" + "TA6"

    def test_html_masks_the_first_letter_and_still_reads_the_same(self):
        out = build.esc(f"owner/{self.NAME}-Boot")
        self.assertNotRegex(out, build.NAMED)
        self.assertIn("&#71;TA6", out)

    def test_script_json_masks_and_round_trips(self):
        value = {"repo": f"owner/{self.NAME}-Boot", "html": "</script>"}
        text = build.json_for_script(value)
        self.assertNotRegex(text, build.NAMED)
        self.assertNotIn("</script>", text)
        self.assertEqual(json.loads(text), value)


class SiteTests(unittest.TestCase):
    """Builds the real projects.json into a temporary folder."""

    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.out = os.path.join(cls.tmp.name, "docs")
        cls.data, cls.ranked = build.build(cls.out)

    @classmethod
    def tearDownClass(cls):
        cls.tmp.cleanup()

    def read(self, *parts):
        with open(os.path.join(self.out, *parts), encoding="utf-8") as f:
            return f.read()

    def config(self, page):
        m = re.search(r'<script type="application/json" id="project-config">(.*?)</script>', page, re.S)
        self.assertIsNotNone(m, "page has no project config")
        return json.loads(m.group(1))

    def test_every_project_gets_the_full_dashboard_with_its_own_config(self):
        for p in self.data["projects"]:
            with self.subTest(slug=p["slug"]):
                page = self.read(p["slug"], "index.html")
                cfg = self.config(page)
                self.assertEqual((cfg["slug"], cfg["repo"], cfg["stage"]), (p["slug"], p["repo"], p["stage"]))
                for part in ('id="live"', 'id="pipe"', 'id="journey"', 'id="blockers"', 'id="pulse"', 'id="queue"',
                             'id="triage"', 'id="hardware"', 'id="work"', 'id="faq"', 'id="tokenInput"', 'id="switcher"'):
                    self.assertIn(part, page)
                self.assertIn('src="../assets/full/live.js"', page)

    def test_leonida_keeps_its_own_sources_and_the_others_get_the_generic_parts(self):
        for p in self.data["projects"]:
            with self.subTest(slug=p["slug"]):
                page = self.read(p["slug"], "index.html")
                own = "readme" in p.get("features", [])
                self.assertNotIn('data-only="generic"' if own else 'data-only="leonida"', page)
                self.assertEqual('src="../assets/full/project.js"' in page, not own)
                self.assertEqual('src="../assets/full/coord.js"' in page, "coord" in p.get("features", []))
                self.assertEqual('class="gone"' in page, "gone" in p.get("features", []))

    def test_every_page_has_a_share_image_that_exists(self):
        pages = [("index.html",)] + [(p["slug"], "index.html") for p in self.data["projects"]]
        for parts in pages:
            with self.subTest(page="/".join(parts)):
                page = self.read(*parts)
                m = re.search(r'<meta property="og:image" content="([^"?]+)\?v=[0-9a-f]{10}"', page)
                self.assertIsNotNone(m, "no versioned og:image")
                self.assertIn('<meta name="twitter:card" content="summary_large_image">', page)
                local = m.group(1).replace(build.SITE_URL, "")
                self.assertTrue(os.path.isfile(os.path.join(self.out, *local.split("/"))), local)

    def test_the_engine_scripts_are_served_once(self):
        for name in ("live.js", "pipeline.js", "project.js", "race.js", "hardware.json"):
            self.assertTrue(os.path.isfile(os.path.join(self.out, "assets", "full", name)), name)
        self.assertFalse(os.path.exists(os.path.join(self.out, "assets", "full", "page.html")))

    def test_the_standings_list_every_ranked_project_in_order(self):
        page = self.read("index.html")
        found = re.findall(r'<li class="row" data-repo="([^"]+)"', page)
        self.assertEqual([build.mask_first_letter_html(p["repo"]) for p in self.ranked], found)

    def test_no_placeholder_is_left_unfilled(self):
        for folder, _, files in os.walk(self.out):
            for name in files:
                if name.endswith(".html"):
                    with self.subTest(file=name), open(os.path.join(folder, name), encoding="utf-8") as f:
                        text = f.read()
                        self.assertNotRegex(text, r"\{\{\w+\}\}")
                        self.assertNotRegex(text, r"@@[A-Z_]+@@")

    def test_data_json_matches_the_standings(self):
        d = json.loads(self.read("data.json"))
        self.assertEqual([s["slug"] for s in d["standings"]], [p["slug"] for p in self.ranked])
        self.assertEqual(len(d["projects"]), len(self.data["projects"]))

    def test_the_scan_catches_a_name_that_slipped_through(self):
        with open(os.path.join(self.out, "leak.txt"), "w", encoding="utf-8") as f:
            f.write("G" + "TA\n")
        try:
            with self.assertRaises(build.BuildError):
                build.scan(self.out)
        finally:
            os.remove(os.path.join(self.out, "leak.txt"))


if __name__ == "__main__":
    unittest.main()
