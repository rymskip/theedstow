// Lists the recipes a push changed since BASE_SHA. Without a usable base,
// such as the first push of a branch, every recipe counts.
import {
  git,
  maxRecipesPerRun,
  platforms,
  recipeNames,
  recipesDir,
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
  const limit = maxRecipesPerRun((await platforms()).length);
  if (changed.length > limit) {
    throw new Error(
      `${changed.length} recipes changed, one build matrix holds ${limit}: split the change`,
    );
  }
  console.log(`changed recipes: ${changed.join(", ") || "none"}`);
  await setOutput("recipes", changed);
}

await main();
