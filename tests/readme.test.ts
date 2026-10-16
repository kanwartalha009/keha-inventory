/**
 * README env table = .env.example (playbook §7 / mistake #17: docs must never name env vars
 * the code doesn't read). tests/config.test.ts already holds .env.example = process.env reads.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string) => readFileSync(join(__dirname, "..", p), "utf8");

describe("README", () => {
  it("documents exactly the env vars in .env.example", () => {
    const readme = read("README.md");
    const section = readme.slice(readme.indexOf("## Environment variables"), readme.indexOf("\n## Config"));
    const documented = [...section.matchAll(/^\| `([A-Z0-9_]+)` \|/gm)].map((m) => m[1]).sort();
    const env = [...read(".env.example").matchAll(/^([A-Z0-9_]+)=/gm)].map((m) => m[1]).sort();
    expect(documented).toEqual(env);
  });
});
