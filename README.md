# Road to Playable: port dashboards

Live at **https://clhelper.github.io/port-dashboards/**

An independent tracker of the open projects that try to run one Xbox Series game natively on a PC. The
standings page places every project on one milestone ladder, and each project gets its own dashboard; the
switcher in the top bar moves between them.

- `/`: the standings, the ladder with every project on it, and how the stages are defined
- `/<project>/`: the full live dashboard for each project, the same for all of them: the live pull request
  pipeline and feed, the road to playable, blockers, graphics layer, how sure we are, "Can my PC run it?",
  activity, merge queue, triage, releases, work board (its open issues), forks that are moving and Q&A, with a
  GitHub token box for when the free hourly allowance runs out. Where Leonida reads its own documents (README status
  table, coordination issue, D3D12 tracker, design notes, security review table), the other projects get the same
  section built from their ladder entry and their own repository.

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
- `src/`: the standings page template, shared CSS and scripts.
- `src/full/`: the dashboard engine every project page is built from (`page.html` and its scripts, served once from
  `docs/assets/full/`). `features` in a project's entry switches on Leonida's own data sources; elements marked
  `data-only="leonida"` or `data-only="generic"` are kept only on that kind of page.
- `projects/<slug>/`: extra files for one project's page (for example its share image `og-image.png`).

To add a project, add an entry to `projects.json` (the build checks every field) and run the build.

## House rules

- The game's title, studio, publisher and places never appear in this repository or the built pages. Text from
  GitHub is masked in the browser (`src/scrub.js`); the build masks repository names that contain them and fails if
  any built file still does.
- The pages call only `api.github.com` from the visitor's browser, without a token unless the visitor adds one
  (it stays in their browser).

Corrections to a project's stage or summary are welcome as issues.
