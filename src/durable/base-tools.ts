import { Type } from "@earendil-works/pi-ai";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { createBashTool, createEditTool, createReadTool, createWriteTool } from "@earendil-works/pi-durable/tools";
import { createNodePhotonImages } from "@earendil-works/pi-durable/images/node";
import { BASH_DEFAULT_TIMEOUT } from "../core/config.ts";
import { configuredRootlessTasks } from "../core/task-backend.ts";

const images = await createNodePhotonImages();
export function bashToolNote(isolated = configuredRootlessTasks() !== undefined): string {
  return ` Default timeout is ${BASH_DEFAULT_TIMEOUT} seconds, maximum 3600. The workspace is reference material: only write to your own temp directory. All child processes are stopped when this command completes or is cancelled.`
    + (isolated ? " Each command runs isolated with a fresh PI_USER_TMP. List existing temp files or directories in input_paths to read them at their original paths; no temp history is copied by default. Workspace and materials remain readable without input_paths." : "");
}

/** The only base tool implementation: official Durable factories, with host policy in ExecutionEnv. */
export function nativeBaseTools(): ToolRegistration[] {
  const bash = createBashTool();
  const parameters = configuredRootlessTasks() ? Type.Object({ ...bash.parameters.properties,
    input_paths: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 128,
      description: "Existing inputs under your own tmp. Only these inputs are copied into an isolated command." })) }) : bash.parameters;
  return [createReadTool({ images }), { ...bash, parameters, description: bash.description + bashToolNote(),
    execute: (args, api, context) => {
      const input = args as { command: string; timeout?: number };
      return bash.execute({ ...input, timeout: input.timeout ?? BASH_DEFAULT_TIMEOUT }, api, context);
    },
  }, createEditTool(), createWriteTool()] as ToolRegistration[];
}
