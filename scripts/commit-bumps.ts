// Commits the bumped recipes whose packages built on every planned platform. A
// recipe that failed anywhere stays at its old version, so the next run retries
// it.
import { join } from "@std/path";
import { z } from "zod";
import { Build, git, recipePath } from "./workspace.ts";

const Bumped = z.array(
  z.object({ recipe: z.string(), name: z.string(), version: z.string() }),
);

const Builds = z.array(Build);

async function built(recipe: string, platform: string): Promise<boolean> {
  try {
    for await (
      const entry of Deno.readDir(
        join("output", `package-${recipe}-${platform}`),
      )
    ) {
      if (entry.name.endsWith(".conda")) {
        return true;
      }
    }
    return false;
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) {
      return false;
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const bumped = Bumped.parse(JSON.parse(Deno.env.get("BUMPED") || "[]"));
  const planned = Builds.parse(JSON.parse(Deno.env.get("BUILDS") || "[]"));
  const branch = Deno.env.get("GITHUB_REF_NAME");
  if (branch === undefined) {
    throw new Error("GITHUB_REF_NAME is not set");
  }

  const complete = [];
  for (const bump of bumped) {
    const missing = [];
    for (
      const { platform } of planned.filter(({ recipe }) =>
        recipe === bump.recipe
      )
    ) {
      if (!await built(bump.recipe, platform)) {
        missing.push(platform);
      }
    }
    if (missing.length > 0) {
      console.log(
        `not committing ${bump.name} ${bump.version}: no package for ${
          missing.join(", ")
        }`,
      );
      continue;
    }
    complete.push(bump);
  }

  if (complete.length === 0) {
    console.log(
      "no bumped recipe built on all its platforms, nothing to commit",
    );
    return;
  }
  await git("add", ...complete.map((bump) => recipePath(bump.recipe)));
  await git(
    "commit",
    "--message",
    `feat(recipes): ${
      complete.map((bump) => `${bump.name} ${bump.version}`).join(", ")
    }`,
  );
  await git("pull", "--rebase", "origin", branch);
  await git("push", "origin", `HEAD:${branch}`);
  console.log(`committed ${complete.map((bump) => bump.name).join(", ")}`);
}

await main();
