/**
 * techdetect — STUB. Real tech-stack detection wraps `wappalyzergo`
 * (github.com/projectdiscovery/wappalyzergo, Go, the maintained OSS fork carrying
 * forward the fingerprint DB after Wappalyzer proper went closed-source in 2023 —
 * research/tools/B-enrichment-data.md §2) as a local, keyless subprocess/binary call.
 * Spawning the Go binary, parsing its JSON, and handling "binary not installed" is real
 * plumbing deliberately left for a follow-up wave — this module is the stable seam
 * placeholder so callers have a `detectTech` function to call today. It ALWAYS returns
 * an empty tech list; it never fabricates a guess.
 */
export interface TechDetectResult {
  url: string;
  tech: string[];
  note: string;
}

export async function detectTech(url: string): Promise<TechDetectResult> {
  return {
    url,
    tech: [],
    note:
      "stub: wraps wappalyzergo (github.com/projectdiscovery/wappalyzergo) as an opt-in " +
      "local binary in a later wave; always returns [] today.",
  };
}
