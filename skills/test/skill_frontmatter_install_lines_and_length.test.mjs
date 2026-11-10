/**
 * Pins the ag-skill brief: SKILL.md frontmatter parses, install lines match
 * the shipped package READMEs, every policy JSON block uses only the SPEC §2.9
 * keys, no "coming" marks remain, and the length budgets hold.
 *
 * Run (from the agent-email-guard root): node --test skills/test/skill_frontmatter_install_lines_and_length.test.mjs
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const here = dirname(fileURLToPath(import.meta.url));
const skillsRoot = resolve(here, "..");
// The agent-email-guard tree root: oss/agent-guard in the monorepo, the repo root in the public mirror.
const guardRoot = resolve(here, "../..");
const repoRoot = guardRoot;

const BANNED = [
  "stops prompt injection",
  "ai guardrails",
  "supercharge",
  "unleash",
  "unlock",
  "effortless",
  "seamless",
  "revolutionize",
  "revolutionary",
  "game-changing",
  "next-level",
  "blazingly",
  "lightning fast",
  "10x your",
  "in today's fast-paced world",
  "look no further",
  "we've got you covered",
  "magical",
  "delve",
  "robust",
  "cutting-edge",
  "state-of-the-art",
  "empower",
];

function contentLines(text) {
  const trimmed = text.endsWith("\n") ? text.slice(0, -1) : text;
  return trimmed === "" ? [] : trimmed.split("\n");
}

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (name === "test") continue;
      out.push(...walk(path));
    } else if (/\.(md|mdc|snippet)$/.test(name)) {
      out.push(path);
    }
  }
  return out;
}

function parseFrontmatter(text) {
  assert.ok(text.startsWith("---\n"), "SKILL.md must open with frontmatter");
  const end = text.indexOf("\n---\n", 4);
  assert.ok(end > 0, "SKILL.md frontmatter must close");
  const raw = text.slice(4, end);
  const body = text.slice(end + "\n---\n".length);
  const nameLine = raw.match(/^name:\s*([A-Za-z0-9-]+)\s*$/m);
  const descriptionLine = raw.match(/^description:\s*"(.*)"\s*$/m);
  assert.ok(nameLine, "name must be a single plain scalar");
  assert.ok(descriptionLine, "description must be one double-quoted line (a colon breaks unquoted YAML)");
  return { name: nameLine[1], description: descriptionLine[1], body, raw };
}

function fences(text) {
  const blocks = [];
  const re = /```[^\n]*\n([\s\S]*?)```/g;
  let match = re.exec(text);
  while (match) {
    blocks.push(match[1]);
    match = re.exec(text);
  }
  return blocks;
}

function installTokens(block) {
  const tokens = [];
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || trimmed.startsWith("//")) continue;
    const patterns = [
      /^(?:npm install|npm i|pnpm add|yarn add)\s+(\S+)/,
      /^(?:pip3? install|uv add|uv pip install)\s+(\S+)/,
      /^composer require\s+(\S+)/,
      /^go get\s+(\S+)/,
      /^npx skills add\s+(\S+)/,
      /^npx\s+(?!skills\b)(\S+)/,
    ];
    for (const pattern of patterns) {
      const found = trimmed.match(pattern);
      if (found) {
        tokens.push(found[1].replace(/^['"]|['"]$/g, ""));
        break;
      }
    }
  }
  return tokens;
}

function packageSources() {
  const readmePaths = [
    "node/README.md",
    "python/README.md",
    "php/README.md",
    "go/README.md",
    "mcp/README.md",
    "redteam/README.md",
  ].map((path) => join(guardRoot, path));
  for (const path of readmePaths) assert.ok(existsSync(path), `${path} is missing`);
  return { kind: "the package READMEs", text: readmePaths.map((path) => readFileSync(path, "utf8")).join("\n") };
}

/** SPEC §2.9: the only keys a policy file may carry. */
const POLICY_KEYS = {
  $schema: null,
  $comment: null,
  version: null,
  key: null,
  namespace: null,
  budgets: ["per_hour", "per_day", "per_month"],
  rate: ["per_minute"],
  loop: [
    "mode",
    "window_ms",
    "similarity_threshold",
    "max_identical_sends",
    "min_window_for_entropy",
    "recipient_perplexity_floor",
  ],
  approval: ["new_recipients", "recipients"],
  suppress: null,
};

function jsonFences(text) {
  return [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);
}

function hasPackage(sourceText, token) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^A-Za-z0-9./_-])${escaped}(?=$|[^A-Za-z0-9./_-])`, "m").test(sourceText);
}

function withoutFences(text) {
  return text.replace(/```[\s\S]*?```/g, "");
}

test("SKILL.md frontmatter parses and matches the directory name", () => {
  const skillPath = join(skillsRoot, "agent-email-safety/SKILL.md");
  const text = readFileSync(skillPath, "utf8");
  const front = parseFrontmatter(text);
  assert.equal(front.name, "agent-email-safety");
  assert.match(front.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(front.name.length <= 64);
  assert.ok(!front.name.includes("--"));
  assert.ok(front.description.length >= 1 && front.description.length <= 1024);
  assert.match(front.description, /agent-email-guard/);
  assert.match(front.description, /when/i);
  const prose = withoutFences(text);
  const mentions = prose.match(/AgentiSend/g) ?? [];
  assert.equal(mentions.length, 1, "AgentiSend is the server-side option, named once outside code fences");
  assert.match(text, /npx agent-email-guard hook install/);
  assert.match(text, /npx agent-email-guard mcp --wrap/);
  assert.match(text, /npx agent-email-guard test --demo/);
});

test("install lines match the shipped package READMEs", () => {
  const source = packageSources();
  const files = walk(skillsRoot);
  const seen = [];
  for (const path of files) {
    const text = readFileSync(path, "utf8");
    for (const block of fences(text)) {
      for (const token of installTokens(block)) {
        seen.push({ path: relative(repoRoot, path), token });
        assert.ok(
          hasPackage(source.text, token),
          `${relative(repoRoot, path)} install "${token}" is not in ${source.kind}`,
        );
      }
    }
  }
  const tokens = new Set(seen.map((row) => row.token));
  for (const required of [
    "agent-email-guard",
    "agentisend/agent-email-guard",
    "github.com/agentisend/agent-email-guard/go",
  ]) {
    assert.ok(tokens.has(required), `missing install line for ${required}`);
  }
  assert.ok(seen.length >= 4, "expected Node, Python, PHP, and Go install lines");
});

test("policy blocks use only SPEC §2.9 keys and nothing is marked coming", () => {
  for (const path of walk(skillsRoot)) {
    const text = readFileSync(path, "utf8");
    assert.doesNotMatch(text, /marked coming|not published yet/i, `${relative(repoRoot, path)} still says coming`);
    assert.doesNotMatch(text, /\bper(Day|Hour)\b|newRecipientDomains/, `${relative(repoRoot, path)} uses a camelCase policy key`);
    for (const block of jsonFences(text)) {
      const policy = JSON.parse(block);
      for (const [key, value] of Object.entries(policy)) {
        assert.ok(key in POLICY_KEYS, `${relative(repoRoot, path)} policy key "${key}" is not in SPEC §2.9`);
        const allowed = POLICY_KEYS[key];
        if (Array.isArray(allowed)) {
          for (const sub of Object.keys(value)) {
            assert.ok(allowed.includes(sub), `${relative(repoRoot, path)} policy key "${key}.${sub}" is not in SPEC §2.9`);
          }
        }
      }
    }
  }
});

test("length budgets and the banned claim phrases hold", () => {
  const skill = readFileSync(join(skillsRoot, "agent-email-safety/SKILL.md"), "utf8");
  assert.ok(contentLines(skill).length < 400, "SKILL.md must stay under 400 lines");
  for (const name of ["AGENTS.md.snippet", "CLAUDE.md.snippet"]) {
    const count = contentLines(readFileSync(join(skillsRoot, name), "utf8")).length;
    assert.ok(count >= 10 && count <= 15, `${name} is ${count} lines; budget is 10–15`);
  }
  const files = walk(skillsRoot);
  for (const path of files) {
    const lower = readFileSync(path, "utf8").toLowerCase();
    for (const phrase of BANNED) {
      assert.ok(!lower.includes(phrase), `${relative(repoRoot, path)} contains "${phrase}"`);
    }
  }
  assert.equal(existsSync(join(skillsRoot, "codex")), false);
});

test("the Cursor Directory rule at rules/ is a copy of skills/cursor", () => {
  const rule = join(guardRoot, "rules/agent-email-safety.mdc");
  assert.equal(readFileSync(rule, "utf8"), readFileSync(join(skillsRoot, "cursor/agent-email-safety.mdc"), "utf8"));
});
