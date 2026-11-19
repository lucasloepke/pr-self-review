# Evaluation

Measures the skill against a fixture repo whose branches carry known, planted
defects (see `../PLAN.md`, *Evaluation*).

```bash
bash eval/fixture/build.sh /tmp/psr-fixture          # build the fixture repo
```

Until the headless runner exists, a run is driven from a Claude session: for
each branch, check it out in the fixture, write the key's `brief` to a file,
and run `/self-review --dry-run --dont-stop --brief <file> --description
eval/fixture/descriptions/<name>.md` (plus `--issue` where the key has one).
Each workflow step leaves a `result.json`; score them:

```bash
node eval/score.js feature/order-filters --review <review result.json> --brief <brief result.json>
node eval/score.js feature/order-count --review <review result.json> --skeptic <planted-false result.json>
```

Pass several `--review` / `--brief` files to get mean, min and max across
runs. Record each scored run in `results/`. Add every real miss to
`misses.md` and as a new branch in `fixture/build.sh` plus `expected.json`.
