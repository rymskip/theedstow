// Moves each recipe under recipes/ to its latest upstream version: the one at
// extra.latest_version_url, or else the release GitHub marks as latest for
// about.repository. Only ever moves forward.
import { encodeHex } from "@std/encoding/hex";
import { greaterThan, parse as parseVersion } from "@std/semver";
import { z } from "zod";
import {
  maxRecipesPerRun,
  platforms,
  recipeNames,
  recipePath,
  setOutput,
} from "./workspace.ts";

const RenderedRecipe = z.object({
  package: z.object({ name: z.string(), version: z.string() }),
  source: z.array(z.object({ url: z.string(), sha256: z.string() })),
  about: z.object({ repository: z.string() }),
  extra: z.object({ latest_version_url: z.string().optional() }).optional(),
});

const RenderOutput = z.tuple([z.object({ recipe: RenderedRecipe })]);

const Release = z.object({ tag_name: z.string() });

type RenderedRecipe = z.infer<typeof RenderedRecipe>;

interface Bump {
  recipe: string;
  name: string;
  version: string;
}

async function render(path: string, platform: string): Promise<RenderedRecipe> {
  const { success, stdout } = await new Deno.Command("rattler-build", {
    args: [
      "build",
      "--recipe",
      path,
      "--render-only",
      "--target-platform",
      platform,
    ],
    stdout: "piped",
    stderr: "inherit",
  }).output();
  if (!success) {
    throw new Error(`rendering ${path} for ${platform} failed`);
  }
  const [output] = RenderOutput.parse(
    JSON.parse(new TextDecoder().decode(stdout)),
  );
  return output.recipe;
}

async function renderAll(
  path: string,
  targetPlatforms: string[],
): Promise<RenderedRecipe[]> {
  const recipes = [];
  for (const platform of targetPlatforms) {
    recipes.push(await render(path, platform));
  }
  return recipes;
}

function githubRepository(url: string): string {
  const match = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/);
  if (!match) {
    throw new Error(`about.repository ${url} is not a GitHub repository`);
  }
  return `${match[1]}/${match[2]}`;
}

async function fetchOk(url: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(url, init);
  if (!response.ok) {
    throw new Error(
      `${url} answered ${response.status}: ${await response.text()}`,
    );
  }
  return response;
}

async function latestVersion(recipe: RenderedRecipe): Promise<string> {
  const versionUrl = recipe.extra?.latest_version_url;
  if (versionUrl !== undefined) {
    const text = await (await fetchOk(versionUrl)).text();
    return text.trim().replace(/^v/, "");
  }
  const headers = new Headers({ Accept: "application/vnd.github+json" });
  const token = Deno.env.get("GITHUB_TOKEN");
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const repository = githubRepository(recipe.about.repository);
  const response = await fetchOk(
    `https://api.github.com/repos/${repository}/releases/latest`,
    { headers },
  );
  return Release.parse(await response.json()).tag_name.replace(/^v/, "");
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

async function bumpRecipe(
  recipe: string,
  targetPlatforms: [string, ...string[]],
): Promise<Bump | undefined> {
  const path = recipePath(recipe);
  const [firstPlatform, ...otherPlatforms] = targetPlatforms;
  const first = await render(path, firstPlatform);
  const { name, version: currentVersion } = first.package;
  const nextVersion = await latestVersion(first);

  if (!greaterThan(parseVersion(nextVersion), parseVersion(currentVersion))) {
    console.log(
      `${name} is at ${currentVersion}, latest is ${nextVersion}: up to date`,
    );
    return undefined;
  }

  const current = [first, ...await renderAll(path, otherPlatforms)];
  const urlChecksums = new Map<string, string>();
  const checksums = new Map<string, string>();
  for (const rendered of current) {
    for (const source of rendered.source) {
      const url = source.url.replaceAll(currentVersion, nextVersion);
      const next = urlChecksums.get(url) ?? await sha256Of(url);
      urlChecksums.set(url, next);
      const mapped = checksums.get(source.sha256);
      if (mapped !== undefined && mapped !== next) {
        throw new Error(
          `sha256 ${source.sha256} is shared by sources that diverge in ${nextVersion}`,
        );
      }
      checksums.set(source.sha256, next);
    }
  }

  let text = await Deno.readTextFile(path);
  text = replaceSingleLine(
    path,
    text,
    /^ {2}version: "[^"]+"$/,
    `  version: "${nextVersion}"`,
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

  for (const rendered of await renderAll(path, targetPlatforms)) {
    if (rendered.package.version !== nextVersion) {
      throw new Error(
        `${path} renders version ${rendered.package.version}, expected ${nextVersion}`,
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

  console.log(`bumped ${name} from ${currentVersion} to ${nextVersion}`);
  return { recipe, name, version: nextVersion };
}

async function main(): Promise<void> {
  const targetPlatforms = await platforms();
  const limit = maxRecipesPerRun(targetPlatforms.length);
  const bumped: Bump[] = [];
  const failed: string[] = [];

  for (const recipe of await recipeNames()) {
    if (bumped.length === limit) {
      console.log(
        `${limit} recipes bumped, the most one build matrix holds: ${recipe} onwards waits for the next run`,
      );
      break;
    }
    try {
      const bump = await bumpRecipe(recipe, targetPlatforms);
      if (bump !== undefined) {
        bumped.push(bump);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const escaped = message.replaceAll("%", "%25").replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A");
      console.error(`::error title=bump ${recipe}::${escaped}`);
      failed.push(recipe);
    }
  }

  await setOutput("recipes", bumped.map((bump) => bump.recipe));
  await setOutput("bumped", bumped);
  await setOutput("failed", failed);
}

await main();
