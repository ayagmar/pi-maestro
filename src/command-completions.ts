import { loadBoard } from "./board.js";
import { loadRecipeListings } from "./recipes.js";
import { type Board } from "./types.js";

const CACHE_MS = 2_000;

type RecipeListings = ReturnType<typeof loadRecipeListings>;

export class MaestroCommandCompletions {
  /** Unknown until session_start or the first command supplies the session cwd. */
  private cwd: string | undefined;
  private boardCache: { cwd: string; expiresAt: number; board: Board } | undefined;
  private recipeCache: { cwd: string; expiresAt: number; recipes: RecipeListings } | undefined;

  setCwd(cwd: string): void {
    this.cwd = cwd;
  }

  complete(prefix: string) {
    const cwd = this.cwd;
    if (cwd === undefined) return [];
    const normalized = prefix.toLowerCase();
    const taskCommand = ["retry", "open", "drive", "discover", "timeline"].find((command) =>
      normalized.startsWith(`${command} `)
    );
    if (taskCommand) {
      const trailingSeparator = /[\s,]$/.test(prefix);
      const parts = prefix.split(/[\s,]+/).filter((part) => part.length > 0);
      const query = trailingSeparator ? "" : (parts.at(-1)?.toLowerCase() ?? "");
      const idParts = trailingSeparator ? parts.slice(1) : parts.slice(1, -1);
      const precedingIds = taskCommand === "drive" ? idParts : [];
      const precedingIdsLower = new Set(precedingIds.map((id) => id.toLowerCase()));
      return this.board(cwd)
        .tasks.filter(
          (task) =>
            task.id.toLowerCase().startsWith(query) && !precedingIdsLower.has(task.id.toLowerCase())
        )
        .map((task) => ({
          value: `${taskCommand} ${[...precedingIds, task.id].join(" ")}`,
          label: task.id,
          description: task.title,
        }));
    }

    const recipeMatch = prefix.match(/^recipe\s+(run|inspect|preview|remove)\s+(.*)$/i);
    if (!recipeMatch) return [];
    const action = recipeMatch[1]?.toLowerCase();
    const query = recipeMatch[2]?.toLowerCase() ?? "";
    return this.recipes(cwd)
      .filter((recipe) => recipe.name.toLowerCase().startsWith(query))
      .map((recipe) => ({
        value: `recipe ${action} ${recipe.name}`,
        label: recipe.name,
        description: recipe.scope,
      }));
  }

  private board(cwd: string): Board {
    const now = Date.now();
    if (!this.boardCache || this.boardCache.cwd !== cwd || this.boardCache.expiresAt <= now) {
      this.boardCache = {
        cwd,
        expiresAt: now + CACHE_MS,
        board: loadBoard(cwd),
      };
    }
    return this.boardCache.board;
  }

  private recipes(cwd: string): RecipeListings {
    const now = Date.now();
    if (!this.recipeCache || this.recipeCache.cwd !== cwd || this.recipeCache.expiresAt <= now) {
      this.recipeCache = {
        cwd,
        expiresAt: now + CACHE_MS,
        recipes: loadRecipeListings(cwd),
      };
    }
    return this.recipeCache.recipes;
  }
}
