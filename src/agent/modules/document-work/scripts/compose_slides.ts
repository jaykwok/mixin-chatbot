import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import Automizer from "pptx-automizer";

// Module inputs are private snapshots whose archives, dimensions and page order have
// already been inspected by document_ops.py. Run under the process supervisor.
const request = JSON.parse(await readFile(process.argv[2]!, "utf8")) as {
  output: string; items: { source: string; slideFiles: number[] }[];
};
const presentation = new Automizer({
  outputDir: dirname(request.output), removeExistingSlides: true,
  // The library's cleanup can remove charts still referenced by retained parts.
  // document_ops.py prunes unreachable package parts after assembly instead.
  autoImportSlideMasters: true, cleanup: false, cleanupPlaceholders: false,
  assertRelatedContents: true, verbosity: 0,
});
presentation.loadRoot(await readFile(request.items[0]!.source));
for (const [index, item] of request.items.entries()) {
  const name = `source-${index}`;
  presentation.load(await readFile(item.source), name);
  for (const page of item.slideFiles) presentation.addSlide(name, page);
}
await presentation.write(basename(request.output));
