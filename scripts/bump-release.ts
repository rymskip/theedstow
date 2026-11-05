// Stages every upstream release of each recipe under recipes/ that is newer
// than the recipe's version, up to its latest: the one at
// extra.latest_version_url (matched against extra.latest_version_pattern when
// set), or else the release GitHub marks as latest for about.repository, or
// else its highest stable tag. The releases in between come from
// extra.versions, or else about.repository's GitHub releases, or else its tags,
// with extra.tag_prefix stripped from tags. Only ever moves forward.
import { encodeHex } from "@std/encoding/hex";
import {
  compare,
  format,
  greaterThan,
  lessOrEqual,
  type SemVer,
  tryParse,
} from "@std/semver";
import { z } from "zod";
import {
  type Build,
  builds,
  clearStaged,
  git,
  maxMatrixJobs,
  platforms,
  recipeNames,
  recipePath,
  type Rendered,
  type RenderedRecipe,
  renderPlatforms,
  setOutput,
  stageRecipe,
} from "./workspace.ts";

const LatestRelease = z.object({ tag_name: z.string() });

const ReleaseListing = z.array(
  z.object({
    tag_name: z.string(),
    draft: z.boolean(),
    prerelease: z.boolean(),
  }),
);

const releasesPerPage = 100;
const maxReleasePages = 20;

interface Version {
  text: string;
  semver: SemVer;
  // Tagged in a repository that publishes GitHub releases, without one.
  tagOnly: boolean;
}

interface Pending {
  name: string;
  currentVersion: string;
  current: Rendered[];
  text: string;
  versions: Version[];
}

interface Bump {
  recipe: string;
  name: string;
  versions: string[];
}

function githubRepository(url: string): string | undefined {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/);
  return match ? `${match[1]}/${match[2]}` : undefined;
}

function githubHeaders(): Headers {
  const headers = new Headers({ Accept: "application/vnd.github+json" });
  const token = Deno.env.get("GITHUB_TOKEN");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  return headers;
}

class HttpError extends Error {
  constructor(readonly status: number, url: string, body: string) {
    super(`${url} answered ${status}: ${body}`);
  }
}

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new HttpError(response.status, url, await response.text());
  }
  return response;
}

// Upstream versions such as potrace's 1.16 have no patch component.
function tryComparableVersion(version: string): SemVer | undefined {
  return tryParse(/^\d+\.\d+$/.test(version) ? `${version}.0` : version);
}

function comparableVersion(version: string): SemVer {
  const semver = tryComparableVersion(version);
  if (semver === undefined) {
    throw new Error(`${version} is not a version`);
  }
  return semver;
}

function stableVersions(texts: string[], tagOnly: boolean): Version[] {
  return texts.flatMap((text) => {
    const semver = tryComparableVersion(text);
    return semver !== undefined && (semver.prerelease ?? []).length === 0
      ? [{ text, semver, tagOnly }]
      : [];
  });
}

// The version a tag names, or undefined for a tag outside the release scheme.
function tagVersion(
  tag: string,
  prefix: string | undefined,
): string | undefined {
  if (prefix === undefined) {
    return tag.replace(/^v/, "");
  }
  return tag.startsWith(prefix) ? tag.slice(prefix.length) : undefined;
}

function tagVersions(tags: string[], prefix: string | undefined): string[] {
  return tags.flatMap((tag) => {
    const version = tagVersion(tag, prefix);
    return version === undefined ? [] : [version];
  });
}

async function remoteTags(repository: string): Promise<string[]> {
  const refs = await git(
    "ls-remote",
    "--tags",
    "--refs",
    `https://github.com/${repository}.git`,
  );
  return refs.split("\n").flatMap((line) => {
    const tag = line.split("refs/tags/")[1];
    return tag === undefined ? [] : [tag];
  });
}

// The tags of the repository's published, non-prerelease GitHub releases, or
// undefined when it publishes no releases at all.
async function releaseTags(repository: string): Promise<string[] | undefined> {
  const tags = [];
  let total = 0;
  for (let page = 1; page <= maxReleasePages; page++) {
    const url =
      `https://api.github.com/repos/${repository}/releases?per_page=${releasesPerPage}&page=${page}`;
    const releases = ReleaseListing.parse(
      await (await fetchOk(url, { headers: githubHeaders() })).json(),
    );
    total += releases.length;
    tags.push(
      ...releases.filter((release) => !release.draft && !release.prerelease)
        .map((release) => release.tag_name),
    );
    if (releases.length < releasesPerPage) {
      return total === 0 ? undefined : tags;
    }
  }
  throw new Error(
    `${repository} has more than ${
      maxReleasePages * releasesPerPage
    } releases, set extra.versions to list them`,
  );
}

async function latestVersion(recipe: RenderedRecipe): Promise<string> {
  const versionUrl = recipe.extra?.latest_version_url;
  if (versionUrl !== undefined) {
    const text = await (await fetchOk(versionUrl)).text();
    const pattern = recipe.extra?.latest_version_pattern;
    if (pattern === undefined) {
      return text.trim().replace(/^v/, "");
    }
    const version = text.match(new RegExp(pattern))?.[1];
    if (version === undefined) {
      throw new Error(`${versionUrl} has no match for ${pattern}`);
    }
    return version;
  }
  const repository = githubRepository(recipe.about.repository);
  if (repository === undefined) {
    throw new Error(
      `about.repository ${recipe.about.repository} is not on GitHub, set extra.latest_version_url`,
    );
  }
  const tagPrefix = recipe.extra?.tag_prefix;
  const url = `https://api.github.com/repos/${repository}/releases/latest`;
  const response = await fetch(url, { headers: githubHeaders() });
  if (response.status === 404) {
    await response.body?.cancel();
    return await latestTag(repository, tagPrefix);
  }
  if (!response.ok) {
    throw new HttpError(response.status, url, await response.text());
  }
  const tag = LatestRelease.parse(await response.json()).tag_name;
  const version = tagVersion(tag, tagPrefix);
  if (version === undefined) {
    throw new Error(
      `latest release tag ${tag} does not start with ${tagPrefix}`,
    );
  }
  return version;
}

// For repositories that tag releases without publishing GitHub releases.
async function latestTag(
  repository: string,
  tagPrefix: string | undefined,
): Promise<string> {
  const versions = stableVersions(
    tagVersions(await remoteTags(repository), tagPrefix),
    false,
  );
  const [latest] = versions.sort((left, right) =>
    compare(right.semver, left.semver)
  );
  if (latest === undefined) {
    throw new Error(`${repository} has no GitHub release and no semver tag`);
  }
  return latest.text;
}

async function releasedVersions(recipe: RenderedRecipe): Promise<Version[]> {
  const listing = recipe.extra?.versions;
  if (listing !== undefined) {
    const page = await (await fetchOk(listing.url)).text();
    const texts = [...page.matchAll(new RegExp(listing.pattern, "g"))].map(
      (match) => {
        const version = match[1];
        if (version === undefined) {
          throw new Error(
            `extra.versions.pattern ${listing.pattern} has no capture group`,
          );
        }
        return version;
      },
    );
    return stableVersions(texts, false);
  }
  const repository = githubRepository(recipe.about.repository);
  if (repository === undefined) {
    throw new Error(
      `about.repository ${recipe.about.repository} is not on GitHub, set extra.versions to list its releases`,
    );
  }
  const tagPrefix = recipe.extra?.tag_prefix;
  const tags = await remoteTags(repository);
  const released = await releaseTags(repository);
  if (released === undefined) {
    return stableVersions(tagVersions(tags, tagPrefix), false);
  }
  // Some projects that publish GitHub releases still tag a release without
  // one, such as blosc 1.21.3.
  const releasedTags = new Set(released);
  return [
    ...stableVersions(tagVersions(released, tagPrefix), false),
    ...stableVersions(
      tagVersions(tags.filter((tag) => !releasedTags.has(tag)), tagPrefix),
      true,
    ),
  ];
}

// The releases newer than current up to latest, oldest first. Latest counts
// even when the listing lags behind it.
function pendingVersions(
  currentVersion: string,
  latest: string,
  released: Version[],
): Version[] {
  const current = comparableVersion(currentVersion);
  const newest = comparableVersion(latest);
  const pending = new Map<string, Version>();
  const newestVersion = { text: latest, semver: newest, tagOnly: false };
  for (const version of [...released, newestVersion]) {
    if (
      greaterThan(version.semver, current) &&
      lessOrEqual(version.semver, newest)
    ) {
      pending.set(format(version.semver), version);
    }
  }
  return [...pending.values()].sort((left, right) =>
    compare(left.semver, right.semver)
  );
}

async function sha256Of(url: string): Promise<string> {
  const body = await (await fetchOk(url)).arrayBuffer();
  return encodeHex(await crypto.subtle.digest("SHA-256", body));
}

function replaceSingleLine(
  path: string,
  text: string,
  pattern: RegExp,
  line: string,
  what: string,
): string {
  const matches = text.match(new RegExp(pattern.source, "gm"))?.length ?? 0;
  if (matches !== 1) {
    throw new Error(
      `expected one ${what} line in the context of ${path}, found ${matches}`,
    );
  }
  return text.replace(new RegExp(pattern.source, "m"), line);
}

async function pendingReleases(
  recipe: string,
  targetPlatforms: string[],
): Promise<Pending> {
  const path = recipePath(recipe);
  const current = await renderPlatforms(path, targetPlatforms);
  const { name, version: currentVersion } = current[0].recipe.package;
  const latest = await latestVersion(current[0].recipe);
  const versions = pendingVersions(
    currentVersion,
    latest,
    await releasedVersions(current[0].recipe),
  );
  console.log(
    versions.length === 0
      ? `${name} is at ${currentVersion}, latest is ${latest}: up to date`
      : `${name} is at ${currentVersion}, staging ${
        versions.map((version) => version.text).join(", ")
      }`,
  );
  return {
    name,
    currentVersion,
    current,
    text: await Deno.readTextFile(path),
    versions,
  };
}

// Stages the recipe at the version, with the checksums of its sources, and
// returns the builds it plans.
async function stageVersion(
  recipe: string,
  pending: Pending,
  version: string,
  targetPlatforms: string[],
): Promise<Build[]> {
  const urlChecksums = new Map<string, string>();
  const checksums = new Map<string, string>();
  for (const { recipe: rendered } of pending.current) {
    for (const source of rendered.source) {
      const url = source.url.replaceAll(pending.currentVersion, version);
      const next = urlChecksums.get(url) ?? await sha256Of(url);
      urlChecksums.set(url, next);
      const mapped = checksums.get(source.sha256);
      if (mapped !== undefined && mapped !== next) {
        throw new Error(
          `sha256 ${source.sha256} is shared by sources that diverge in ${version}`,
        );
      }
      checksums.set(source.sha256, next);
    }
  }

  const path = await stageRecipe(recipe, version);
  let text = replaceSingleLine(
    path,
    pending.text,
    /^ {2}version: "[^"]+"$/,
    `  version: "${version}"`,
    "version",
  );
  text = replaceSingleLine(
    path,
    text,
    /^ {2}build_number: \d+$/,
    "  build_number: 0",
    "build_number",
  );
  for (const [previous, next] of checksums) {
    text = text.replaceAll(previous, next);
  }
  await Deno.writeTextFile(path, text);

  const staged = await renderPlatforms(path, targetPlatforms);
  for (const { recipe: rendered } of staged) {
    if (rendered.package.version !== version) {
      throw new Error(
        `${path} renders version ${rendered.package.version}, expected ${version}`,
      );
    }
    for (const source of rendered.source) {
      if (urlChecksums.get(source.url) !== source.sha256) {
        throw new Error(
          `${source.url} renders sha256 ${source.sha256}, which is not the downloaded file's`,
        );
      }
    }
  }
  return builds(recipe, staged);
}

function reportFailure(recipe: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  const escaped = message.replaceAll("%", "%25").replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
  console.error(`::error title=bump ${recipe}::${escaped}`);
}

async function main(): Promise<void> {
  const targetPlatforms = await platforms();
  await clearStaged();
  const bumped: Bump[] = [];
  const planned: Build[] = [];
  const failed: string[] = [];
  let full = false;

  for (const recipe of await recipeNames()) {
    if (full) {
      break;
    }
    let pending: Pending;
    try {
      pending = await pendingReleases(recipe, targetPlatforms);
    } catch (error) {
      reportFailure(recipe, error);
      failed.push(recipe);
      continue;
    }
    // Later releases build from the same recipe, so a release that cannot be
    // staged holds back the ones after it.
    const versions = [];
    for (const version of pending.versions) {
      if (planned.length + targetPlatforms.length > maxMatrixJobs) {
        console.log(
          `${planned.length} builds planned, near the ${maxMatrixJobs} one build matrix holds: ${pending.name} ${version.text} onwards waits for the next run`,
        );
        full = true;
        break;
      }
      try {
        planned.push(
          ...await stageVersion(recipe, pending, version.text, targetPlatforms),
        );
        versions.push(version.text);
      } catch (error) {
        if (
          version.tagOnly && error instanceof HttpError && error.status === 404
        ) {
          console.log(
            `${pending.name} ${version.text} is tagged without a release and its sources are missing, skipping it: ${error.message}`,
          );
          continue;
        }
        reportFailure(recipe, error);
        failed.push(recipe);
        break;
      }
    }
    if (versions.length > 0) {
      bumped.push({ recipe, name: pending.name, versions });
    }
  }

  await setOutput("builds", planned);
  await setOutput("bumped", bumped);
  await setOutput("failed", failed);
}

await main();
