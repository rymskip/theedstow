// Commits each bumped recipe's staged releases oldest first, one commit per
// release that built on every planned platform. A recipe stops at its first
// release that failed anywhere, so the next run retries from there.
import { join } from "@std/path";
import { z } from "zod";
import { Build, git, recipePath, stagedRecipePath } from "./workspace.ts";

const Bumped = z.array(
  z.object({
    recipe: z.string(),
    name: z.string(),
    versions: z.array(z.string()).nonempty(),
  }),
);

const Builds = z.array(Build);

async function built(
  recipe: string,
  version: string,
  platform: string,
): Promise<boolean> {
  try {
    for await (
      const entry of Deno.readDir(
        join("output", `package-${recipe}-${version}-${platform}`),
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

  const committed = [];
  for (const bump of bumped) {
    for (const version of bump.versions) {
      const platforms = planned.filter((build) =>
        build.recipe === bump.recipe && build.version === version
      ).map((build) => build.platform);
      if (platforms.length === 0) {
        throw new Error(`no builds were planned for ${bump.name} ${version}`);
      }
      const missing = [];
      for (const platform of platforms) {
        if (!await built(bump.recipe, version, platform)) {
          missing.push(platform);
        }
      }
      if (missing.length > 0) {
        console.log(
          `not committing ${bump.name} ${version} or later: no package for ${
            missing.join(", ")
          }`,
        );
        break;
      }
      await Deno.writeTextFile(
        recipePath(bump.recipe),
        await Deno.readTextFile(stagedRecipePath(bump.recipe, version)),
      );
      await git("add", recipePath(bump.recipe));
      await git(
        "commit",
        "--message",
        `feat(recipes): ${bump.name} ${version}`,
      );
      committed.push(`${bump.name} ${version}`);
    }
  }

  if (committed.length === 0) {
    console.log(
      "no bumped release built on all its platforms, nothing to commit",
    );
    return;
  }
  await git("pull", "--rebase", "origin", branch);
  await git("push", "origin", `HEAD:${branch}`);
  console.log(`committed ${committed.join(", ")}`);
}

await main();
