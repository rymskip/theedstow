import { join } from "@std/path";
import { parse as parseToml } from "@std/toml";
import { z } from "zod";

export const recipesDir = "recipes";

// GitHub rejects a job matrix with more than 256 entries.
const maxMatrixJobs = 256;

// Recipe names reach job names, artifact names and shell arguments.
const recipeName = /^[a-z0-9][a-z0-9._-]*$/;

const Workspace = z.object({
  workspace: z.object({ platforms: z.tuple([z.string()], z.string()) }),
});

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

export function maxRecipesPerRun(platformCount: number): number {
  return Math.floor(maxMatrixJobs / platformCount);
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
