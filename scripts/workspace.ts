import { join } from "@std/path";
import { parse as parseToml } from "@std/toml";
import { z } from "zod";

export const recipesDir = "recipes";

// GitHub rejects a job matrix with more than 256 entries.
export const maxMatrixJobs = 256;

// Recipe names reach job names, artifact names and shell arguments.
const recipeName = /^[a-z0-9][a-z0-9._-]*$/;

// The GitHub-hosted runner that builds and tests each platform natively.
const runners = new Map([
  ["linux-64", "ubuntu-24.04"],
  ["linux-aarch64", "ubuntu-24.04-arm"],
  ["osx-64", "macos-15-intel"],
  ["osx-arm64", "macos-15"],
  ["win-64", "windows-2025"],
]);

const Workspace = z.object({
  workspace: z.object({ platforms: z.tuple([z.string()], z.string()) }),
});

const RenderedRecipe = z.object({
  package: z.object({ name: z.string(), version: z.string() }),
  source: z.array(z.object({ url: z.string(), sha256: z.string() })),
  about: z.object({ repository: z.string() }),
  extra: z.object({ latest_version_url: z.string().optional() }).optional(),
});

// A platform the recipe skips renders to no outputs.
const RenderOutput = z.union([
  z.tuple([]),
  z.tuple([z.object({ recipe: RenderedRecipe })]),
]);

export type RenderedRecipe = z.infer<typeof RenderedRecipe>;

export interface Rendered {
  platform: string;
  recipe: RenderedRecipe;
}

export const Build = z.object({
  recipe: z.string(),
  platform: z.string(),
  runner: z.string(),
});

export type Build = z.infer<typeof Build>;

export async function platforms(): Promise<[string, ...string[]]> {
  const { workspace } = Workspace.parse(
    parseToml(await Deno.readTextFile("pixi.toml")),
  );
  return workspace.platforms;
}

export async function recipeNames(): Promise<string[]> {
  const names = [];
  for await (const entry of Deno.readDir(recipesDir)) {
    if (!entry.isDirectory) {
      continue;
    }
    if (!recipeName.test(entry.name)) {
      throw new Error(
        `${recipesDir}/${entry.name} is not a valid recipe name, expected ${recipeName.source}`,
      );
    }
    names.push(entry.name);
  }
  return names.sort();
}

export function recipePath(recipe: string): string {
  return join(recipesDir, recipe, "recipe.yaml");
}

async function render(
  path: string,
  platform: string,
): Promise<RenderedRecipe | undefined> {
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
  const outputs = RenderOutput.parse(
    JSON.parse(new TextDecoder().decode(stdout)),
  );
  return outputs.length === 0 ? undefined : outputs[0].recipe;
}

// Renders the recipe for each platform it builds on, skipping the rest.
export async function renderPlatforms(
  path: string,
  targetPlatforms: string[],
): Promise<Rendered[]> {
  const rendered = [];
  for (const platform of targetPlatforms) {
    const recipe = await render(path, platform);
    if (recipe !== undefined) {
      rendered.push({ platform, recipe });
    }
  }
  return rendered;
}

export function builds(recipe: string, rendered: Rendered[]): Build[] {
  return rendered.map(({ platform }) => {
    const runner = runners.get(platform);
    if (runner === undefined) {
      throw new Error(
        `no runner builds ${platform}, add one to scripts/workspace.ts`,
      );
    }
    return { recipe, platform, runner };
  });
}

export async function git(...args: string[]): Promise<string> {
  const { success, stdout, stderr } = await new Deno.Command("git", {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!success) {
    throw new Error(
      `git ${args.join(" ")} failed: ${new TextDecoder().decode(stderr)}`,
    );
  }
  return new TextDecoder().decode(stdout);
}

export async function setOutput(name: string, value: unknown): Promise<void> {
  const outputPath = Deno.env.get("GITHUB_OUTPUT");
  if (outputPath) {
    await Deno.writeTextFile(outputPath, `${name}=${JSON.stringify(value)}\n`, {
      append: true,
    });
  }
}
