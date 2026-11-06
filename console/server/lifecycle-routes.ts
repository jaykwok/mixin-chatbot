// The recovery preview of an unfinished deployment, read from the persisted transaction.
import { recoveryView } from "../../ops/core/recovery-plan.ts";
import { ApiProblem, type Route } from "./routes.ts";

export function lifecycleRoutes(project: string): Record<string, Route> {
  return { "GET /api/lifecycle": { run: async () => {
    try { return { pending: recoveryView(project) }; }
    catch (error) { throw new ApiProblem(409, "input", (error as Error).message); }
  } } };
}
