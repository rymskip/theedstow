# theedstow

Recipes for the `rymskip/theedstow` conda channel on prefix.dev. Each folder
under `recipes/` is one package.

```toml
channels = ["conda-forge", "https://prefix.dev/rymskip/theedstow"]

[dependencies]
surrealdb = "*"
```

To install globally, list conda-forge too. `--channel` replaces pixi's default
channel, and the Linux packages depend on its `libgcc` and `libstdcxx`.

```sh
pixi global install --channel conda-forge --channel https://prefix.dev/rymskip/theedstow surrealdb
```

Pin a version as one spec, such as `"surrealdb==3.3.4"`. A separate `3.3.4`
argument is read as another package.

A daily workflow checks every recipe for a new upstream release and bumps it.
Only bumped recipes, or on a push the recipes it changed, get built and tested
natively on each platform the recipe does not skip with `build.skip`, then
published with a Sigstore attestation through prefix.dev trusted publishing. A
bump is committed once its recipe built on all of its platforms; a recipe that
failed anywhere is retried on the next run.

A recipe's version comes from `extra.latest_version_url` when it sets one,
otherwise from the release GitHub marks as latest for `about.repository`, or
its highest stable tag when the repository publishes no releases.

| Task | What it does |
| --- | --- |
| `pixi run build [recipes/<name>]` | Build and test recipes for the current platform |
| `pixi run bump` | Move every recipe to its latest upstream version |
| `pixi run check` | Type-check, lint and format-check the scripts |
