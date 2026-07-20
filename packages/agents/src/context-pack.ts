/** Context-pack builder — renders labeled evidence blocks for the request. */
import type { ContextBlock } from "./types.js";

/**
 * Render evidence blocks as labeled, tagged sections. Labeled blocks let the
 * agent cite which evidence a conclusion came from — the context pack is the
 * differentiator (architecture §3.0).
 */
export function contextPack(blocks: ContextBlock[]): string {
  return blocks
    .map((b) => {
      const label = b.label.replace(/"/g, "'");
      return `<evidence label="${label}">\n${b.content}\n</evidence>`;
    })
    .join("\n\n");
}
