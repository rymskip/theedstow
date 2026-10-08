// Plans builds for the recipes a push changed since BASE_SHA. Without a usable
// base, such as the first push of a branch, every recipe counts.
import {
  builds,
  git,
  maxMatrixJobs,
  platforms,
  recipeNames,
  recipePath,
  recipesDir,
  renderPlatforms,
  setOutput,
} from "./workspace.ts";

async function commitExists(sha: string): Promise<boolean> {
  try {
    await git("cat-file", "-e", `${sha}^{commit}`);
    return true;
  } catch (error) {
    console.log(`${sha} is not in this checkout: ${error}`);
    return false;
  }
}

async function changedRecipes(all: string[]): Promise<string[]> {
  const base = Deno.env.get("BASE_SHA") ?? "";
  if (/^0*$/.test(base) || !await commitExists(base)) {
    console.log("no base commit to compare against, every recipe counts");
    return all;
  }
  const diff = await git("diff", "--name-only", base, "HEAD", "--", recipesDir);
  const touched = new Set(
    diff.split("\n").filter((line) => line !== "").map((line) =>
      line.split("/")[1]
    ),
  );
  return all.filter((recipe) => touched.has(recipe));
}

async function main(): Promise<void> {
  const changed = await changedRecipes(await recipeNames());
  console.log(`changed recipes: ${changed.join(", ") || "none"}`);
  const targetPlatforms = await platforms();
  const planned = [];
  for (const recipe of changed) {
    planned.push(
      ...builds(
        recipe,
        await renderPlatforms(recipePath(recipe), targetPlatforms),
      ),
    );
  }
  if (planned.length > maxMatrixJobs) {
    throw new Error(
      `${planned.length} builds planned, one build matrix holds ${maxMatrixJobs}: split the change`,
    );
  }
  await setOutput("builds", planned);
}

await main();
