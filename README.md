# theedstow

Recipes for the [theedstow](https://prefix.dev/channels/theedstow) conda
channel. Each folder under `recipes/` is one package.

```toml
channels = ["conda-forge", "https://prefix.dev/theedstow"]

[dependencies]
surrealdb = "*"
```

A daily workflow checks every recipe for a new upstream release and bumps it.
Only bumped recipes, or on a push the recipes it changed, get built and tested
natively on every platform, then published to the channel with the
`PREFIX_API_KEY` repository secret. A bump is committed once its recipe built on
every platform; a recipe that failed anywhere is retried on the next run.

A recipe's version comes from `extra.latest_version_url` when it sets one,
otherwise from the release GitHub marks as latest for `about.repository`.

| Task | What it does |
| --- | --- |
| `pixi run build [recipes/<name>]` | Build and test recipes for the current platform |
| `pixi run bump` | Move every recipe to its latest upstream version |
| `pixi run check` | Type-check, lint and format-check the scripts |
