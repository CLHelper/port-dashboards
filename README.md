# Road to Playable: port dashboards

Live at **https://clhelper.github.io/port-dashboards/**

An independent tracker of the open projects that try to run one Xbox Series game natively on a PC. The
standings page places every project on one milestone ladder, and each project gets its own dashboard; the
switcher in the top bar moves between them.

- `/`: the standings, the ladder with every project on it, and how the stages are defined
- `/<project>/`: a generated dashboard for each project: its stage, what its own sources report, and live
  activity from GitHub (commits over 14 days, latest commits, open pull requests, contributors, and how far a fork
  is ahead of or behind the project it builds on)
- `/leonida/`: a hand-made dashboard with that project's coordination board, merge queue, triage and more, plus the
  shared ladder under its ring

Not affiliated with any of the projects or with the game's makers. Nothing here is run or verified by this page.

## How it is built

Static pages, no build service: `build.py` writes `docs/`, which GitHub Pages serves from `main`.

```sh
python -I build.py                        # writes docs/
python -I -m unittest discover -s tests   # tests, standard library only
python -I refresh.py                      # refreshes avatars and push times in projects.json (public API, no token)
```

- `projects.json`: the ladder, the kinds of approach and one entry per project. The stage, summary, evidence and
  caveat of each project are read by hand from its README, status notes and commits; a vague or second-hand claim
  counts as the stage below.
- `src/`: page templates, shared CSS and the scripts that fetch live data in the visitor's browser.
- `leonida/`: the hand-made dashboard, copied as it is (an entry with `"custom": "<folder>"` uses its own folder
  instead of the generated page).

To add a project, add an entry to `projects.json` (the build checks every field) and run the build.

## House rules

- The game's title, studio, publisher and places never appear in this repository or the built pages. Text from
  GitHub is masked in the browser (`src/scrub.js`); the build masks repository names that contain them and fails if
  any built file still does.
- The pages call only `api.github.com` from the visitor's browser, without a token unless the visitor adds one
  (it stays in their browser).

Corrections to a project's stage or summary are welcome as issues.
