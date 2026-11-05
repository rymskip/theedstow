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

A daily workflow stages every upstream release newer than each recipe's
version, up to the latest, so a jump of several releases also builds the ones
in between. Only staged releases, or on a push the recipes it changed, get
built and tested natively on each platform the recipe does not skip with
`build.skip`, then published with a Sigstore attestation through prefix.dev
trusted publishing. A recipe's releases are committed oldest first, one commit
each, once they built on all of their platforms. The first release that failed
anywhere stops its recipe there, and the next run retries from it, so a fix to
the recipe applies to that release and every one after it.

A recipe's latest version comes from `extra.latest_version_url` when it sets
one, otherwise from the release GitHub marks as latest for `about.repository`,
or its highest stable tag when the repository publishes no releases. A page at
`extra.latest_version_url` that is more than the bare version takes an
`extra.latest_version_pattern`, whose first capture group is the version. Tags
lose a leading `v`, or `extra.tag_prefix` when the recipe sets one.

The releases in between come from the repository's GitHub releases, or its tags
when it publishes none. A recipe whose repository is not on GitHub lists them
with `extra.versions`: a `url` and a `pattern` whose first capture group
matches each version on that page.

| Task | What it does |
| --- | --- |
| `pixi run build [recipes/<name>]` | Build and test recipes for the current platform |
| `pixi run bump` | Move every recipe to its latest upstream version |
| `pixi run check` | Type-check, lint and format-check the scripts |
