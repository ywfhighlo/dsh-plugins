// @local/dsh-misra-checker — Host half.
// Runs a MISRA C check over a project directory:
//  - cppcheck with the MISRA addon when cppcheck is available, otherwise
//  - a built-in line-based heuristic scan over a small subset of MISRA C:2012 rules.
// The same operation is exposed on the plugin's own RPC channel (`/misra`,
// used by the composer button) and as the `/misra` slash command.
import Schema from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "@local/dsh-misra-checker";
export const inject = ["commands", "connection", "agents", "sessions", "workingDirectory"];

// This package's own directory. `new URL(".", import.meta.url)` already
// resolves to it (with a trailing separator), so it must not be passed
// through path.dirname again.
const PKG_DIR = fileURLToPath(new URL(".", import.meta.url));

export const Config = Schema.object({
  root: Schema.string().default("").description("Default directory to check when the caller passes none (absolute path)"),
  subdir: Schema.string().default("").description("Directory below the project root that actually holds the code (e.g. 'components/Mcal/Eth'); the project root is used when it does not exist"),
  cppcheck: Schema.string().default("vendor/cppcheck/cppcheck.exe").description("cppcheck executable: absolute path, or a path relative to this plugin folder (default bundles it in vendor/), or a bare command name found on PATH"),
  cppcheckArgs: Schema.string().default("").description("Extra cppcheck arguments (e.g. --std=c11 --platform=arm32)"),
  enable: Schema.string().default("warning,style").description("cppcheck --enable categories"),
  inlineSuppressions: Schema.boolean().default(true).description("Honour inline 'cppcheck-suppress' comments in the code"),
  suppressionsFile: Schema.string().default("").description("cppcheck suppressions list, absolute or relative to the project root (e.g. tools/misra/suppressions.txt); empty for none"),
  maxConfigs: Schema.number().default(1).description("cppcheck --max-configs (1 = default configuration only, fast)"),
  ctuDepth: Schema.number().default(0).description("cppcheck --max-ctu-depth (cross-translation-unit analysis; 0 disables it)"),
  timeoutMs: Schema.number().default(900000).description("cppcheck run timeout in milliseconds"),
  ruleTexts: Schema.boolean().default(true).description("Report the MISRA C:2012 rule text with every finding"),
  tempDir: Schema.string().default("").description("Directory for intermediate files (file list, addon config, cppcheck cache); empty means the system temp directory"),
  defines: Schema.array(Schema.string()).default([]).description("Preprocessor defines passed to cppcheck (e.g. DISABLE_MCAL_INTERMODULE_ASR_CHECK)"),
  includes: Schema.array(Schema.string()).default([]).description("Include directories for cppcheck, absolute or relative to the project root (e.g. components/Mcal/Common)"),
  exclude: Schema.array(Schema.string()).default([".git", "node_modules", "build", "dist", "out", ".dsh", ".agents"]).description("Directory names skipped by the built-in scanner"),
  excludeGenerated: Schema.boolean().default(true).description("Skip auto-generated files (configuration and register-definition artifacts)"),
  generatedPatterns: Schema.array(Schema.string()).default(["*_PBcfg.*", "*_regdef.h", "*_reg.h"]).description("File name patterns treated as auto-generated"),
  maxFindings: Schema.number().default(500).description("Cap on reported findings per run"),
});

const MAX_FILES = 2000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

// ── built-in heuristic rules (MISRA C:2012 subset, line-based) ──────────────
const BUILTIN_RULES = [
  {
    rule: "misra-c2012-15.1", severity: "error",
    message: "Use of the goto statement is prohibited (Rule 15.1)",
    test: (line) => /\bgoto\s+\w+\s*;/.test(line),
  },
  {
    rule: "misra-c2012-7.1", severity: "error",
    message: "Octal constants shall not be used (Rule 7.1)",
    test: (line) => /(^|[^\w.'"\\])0[0-7]+[uUlL]*([^\w.]|$)/.test(line.replace(/\/\/.*$/, "")),
  },
  {
    rule: "misra-c2012-13.4", severity: "error",
    message: "Assignment operator used inside a condition (Rule 13.4 / 14.4 heuristic)",
    test: (line) => {
      const m = line.match(/(?:if|while|for|do)\s*\(([^;]*)\)/);
      if (!m) return false;
      return /[^=!<>+\-*/%&|^,]=(?!=)/.test(m[1]);
    },
  },
  {
    rule: "misra-c2012-21.3", severity: "error",
    message: "Memory allocation functions of <stdlib.h> shall not be used (Rule 21.3)",
    test: (line) => /\b(?:malloc|calloc|realloc|aligned_alloc|free)\s*\(/.test(line),
  },
  {
    rule: "misra-c2012-20.10", severity: "warning",
    message: "The ## operator shall not be used (Rule 20.10)",
    test: (line) => /^#\s*define\b.*##/.test(line),
  },
  {
    rule: "misra-c2012-19.2", severity: "warning",
    message: "The union keyword shall not be used (Rule 19.2)",
    test: (line) => /\bunion\b/.test(line.replace(/^#\s.*$/, "")),
  },
];

async function walk(dir, exclude, out, rootDir) {
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!exclude.includes(e.name)) await walk(full, exclude, out, rootDir);
    } else if (/\.(c|h)$/i.test(e.name)) {
      out.push(full);
    }
  }
}

// ── auto-generated code detection ────────────────────────────────────────────
// MISRA compliance normally exempts generated code, and in an AUTOSAR/MCAL
// tree the generated artifacts (configuration and register definitions) make
// up most of the findings. A file counts as generated when its name matches a
// configured pattern or its header carries a generator marker.
const GENERATED_MARKERS = [
  /@implements\s+\S*_Artifact/i,
  /VendorSpecifc File Header/i,
  /<#>/,                    // ARK generator doc comments ("<#>brief", "<#>file")
  /<#\s*file\s/i,
  /code generated by/i,
  /automatically generated/i,
  /do not edit/i,
  /generated by\b/i,
];
const GENERATED_HEADER_LINES = 40;

// ── MISRA C:2012 rule texts ──────────────────────────────────────────────────
// rules/misra-c2012.json carries the rule title (English), the requirement
// (Chinese) and the Mandatory/Advisory level for every rule. It is handed to
// cppcheck's MISRA addon through "--rule-texts", so the tool itself reports
// the rule text instead of a placeholder.
const RULE_TEXTS_FILE = path.join(PKG_DIR, "rules", "misra-c2012.json");
let ruleTablePromise = null;

async function loadRuleTable() {
  if (!ruleTablePromise) {
    ruleTablePromise = fsp.readFile(RULE_TEXTS_FILE, "utf8")
      .then((raw) => JSON.parse(raw).rules ?? {})
      .catch(() => ({}));
  }
  return ruleTablePromise;
}

function ruleNumber(ruleId) {
  const match = /misra-c2012-([0-9]+(?:\.[0-9]+)?)/i.exec(String(ruleId || ""));
  return match ? match[1] : undefined;
}

function globToRegExp(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/\\\\]*").replace(/\u0000/g, ".*");
  return new RegExp("^" + escaped + "$", "i");
}

async function isGeneratedFile(file, patterns) {
  const name = path.basename(file);
  for (const pattern of patterns ?? []) {
    try { if (globToRegExp(pattern).test(name)) return true; } catch {}
  }
  let head = "";
  try {
    const handle = await fsp.open(file, "r");
    try {
      const buffer = Buffer.alloc(16 * 1024);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      head = buffer.subarray(0, bytesRead).toString("utf8");
    } finally { await handle.close(); }
  } catch { return false; }
  const lines = head.split(/\r?\n/).slice(0, GENERATED_HEADER_LINES).join("\n");
  return GENERATED_MARKERS.some((marker) => marker.test(lines));
}

function stripCommentsLine(line) {
  // good-enough for heuristics: drop // tails; block comments are approximated per line
  return line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
}

async function builtinScan(root, cfg, files, signal) {
  const targets = Array.isArray(files) && files.length > 0 ? [...files] : [];
  if (targets.length === 0) await walk(root, cfg.exclude, targets, root);
  const findings = [];
  for (const file of targets) {
    if (signal?.aborted) throw new Error("aborted");
    let stat;
    try { stat = await fsp.stat(file); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) continue;
    const text = await fsp.readFile(file, "utf8");
    const lines = text.split(/\r?\n/);
    let inBlockComment = false;
    for (let i = 0; i < lines.length; i++) {
      let raw = lines[i];
      if (inBlockComment) {
        const end = raw.indexOf("*/");
        if (end === -1) continue;
        raw = raw.slice(end + 2);
        inBlockComment = false;
      }
      let line = raw;
      const open = line.lastIndexOf("/*");
      if (open !== -1 && line.indexOf("*/", open) === -1) {
        line = line.slice(0, open);
        inBlockComment = true;
      }
      line = stripCommentsLine(line);
      for (const r of BUILTIN_RULES) {
        if (r.test(line)) {
          findings.push({
            file: path.relative(root, file).replace(/\\/g, "/"),
            line: i + 1,
            rule: r.rule,
            severity: r.severity,
            message: r.message,
          });
          if (findings.length >= cfg.maxFindings) return { engine: "builtin", filesScanned: targets.length, findings };
        }
      }
    }
  }
  return { engine: "builtin", filesScanned: targets.length, findings };
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, cwd: opts.cwd });
    } catch (e) {
      resolve({ error: String(e && e.message || e) });
      return;
    }
    let out = "", err = "", settled = false;
    const timer = setTimeout(() => { try { child.kill(); } catch {} }, opts.timeoutMs ?? 120000);
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve(r); } };
    child.on("error", (e) => finish({ error: String(e && e.code || e.message || e) }));
    child.stdout?.on("data", (d) => { out += d; if (out.length > 4e6) out = out.slice(-2e6); });
    child.stderr?.on("data", (d) => { err += d; if (err.length > 4e6) err = err.slice(-2e6); });
    child.on("close", (code) => finish({ code, out, err }));
  });
}

// Resolve the cppcheck executable: an absolute path is used as-is; a relative
// value is first tried against this package's directory (so the bundled
// `vendor/cppcheck/cppcheck.exe` travels with the plugin folder), then against
// the process working directory, and finally as a bare command name on PATH.
// `new URL(".", import.meta.url)` already resolves to this package's directory
// (with a trailing separator), so it must not be passed through dirname again.
const DEFAULT_CPPCHECK = "vendor/cppcheck/cppcheck.exe";
function resolveCppcheck(configured) {
  const value = String(configured || "").trim() || DEFAULT_CPPCHECK;
  if (path.isAbsolute(value)) return { cmd: value };
  const candidates = [path.join(PKG_DIR, value), path.resolve(value)];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return { cmd: c }; } catch {}
  }
  return { cmd: value };
}

async function cppcheckScan(root, cfg, projectRoot, files, suppressFiles, scope, signal) {
  const extra = cfg.cppcheckArgs ? cfg.cppcheckArgs.split(/\s+/).filter(Boolean) : [];
  const defines = (cfg.defines ?? []).map((d) => `-D${d}`);
  const includes = (cfg.includes ?? []).map((dir) => {
    const value = String(dir);
    return `-I${path.isAbsolute(value) ? value : path.resolve(projectRoot ?? root, value)}`;
  });
  // Every intermediate file stays in the system temp directory: the source
  // tree is read-only for this plugin, nothing is written next to the code.
  const tempRoot = path.resolve(String(cfg.tempDir || "").trim() || os.tmpdir());
  const runId = `dsh-misra-${process.pid}-${Date.now()}`;
  const tempFiles = [];
  let buildDir = null;
  const args = [
    "--quiet",
    `--enable=${cfg.enable || "warning,style,performance,portability"}`,
    "--template={file}:{line}:{id}:{message}",
    ...defines, ...includes,
    ...extra,
  ];
  if (cfg.inlineSuppressions !== false) args.push("--inline-suppr");
  if (cfg.maxConfigs) args.push(`--max-configs=${cfg.maxConfigs}`);
  if (cfg.ctuDepth) args.push(`--max-ctu-depth=${cfg.ctuDepth}`);  // cppcheck caches compiled headers as .a files; without a build directory it
  // drops them into the current working directory.
  try {
    buildDir = path.join(tempRoot, `${runId}-build`);
    await fsp.mkdir(buildDir, { recursive: true });
    args.push(`--cppcheck-build-dir=${buildDir}`);
  } catch {}
  // The MISRA addon is configured through a JSON descriptor: that is the only
  // way to hand it the rule texts and the severity label.
  const addonScript = path.join(PKG_DIR, "vendor", "cppcheck", "addons", "misra.py");
  const ruleTextsFile = path.join(PKG_DIR, "vendor", "cppcheck", "misra-rules.txt");
  const addonArgs = ["--severity=warning", "--no-summary"];
  if (cfg.ruleTexts !== false) addonArgs.push(`--rule-texts=${ruleTextsFile}`);
  const addonJson = path.join(tempRoot, `${runId}-addon.json`);
  try {
    await fsp.writeFile(addonJson, JSON.stringify({ script: addonScript, args: addonArgs }), "utf8");
    tempFiles.push(addonJson);
    args.push(`--addon=${addonJson}`);
  } catch {
    args.push("--addon=misra");
  }
  // A project may keep its own suppression list (e.g. tools/misra/suppressions.txt).
  const suppressions = String(cfg.suppressionsFile || "").trim();
  if (suppressions) {
    const list = path.isAbsolute(suppressions) ? suppressions : path.resolve(projectRoot ?? root, suppressions);
    if (fs.existsSync(list)) args.push(`--suppressions-list=${list}`);
  }
  // Generated code is still read for context, but its violations are not
  // reported: cppcheck analyzes included headers as part of the translation
  // unit, so the file list alone cannot keep them out of the report.
  for (const file of suppressFiles ?? []) {
    args.push(`--suppress=misra-c2012-*:${file}`);
  }
  // A file list keeps the command line short and lets the caller pick exactly
  // which sources are analyzed.
  let listFile;
  const list = Array.isArray(files) && files.length > 0 ? files : null;
  if (list) {
    listFile = path.join(tempRoot, `${runId}-files.txt`);
    await fsp.writeFile(listFile, list.join("\n"), "utf8");
    tempFiles.push(listFile);
    args.push(`--file-list=${listFile}`);
  } else {
    args.push(root);
  }
  const { cmd } = resolveCppcheck(cfg.cppcheck);
  const r = await runCommand(cmd, args, { timeoutMs: cfg.timeoutMs ?? 900000, cwd: tempRoot });
  for (const file of tempFiles) await fsp.rm(file, { force: true }).catch(() => {});
  if (buildDir) await fsp.rm(buildDir, { recursive: true, force: true }).catch(() => {});
  if (r.error) return { unavailable: true, reason: `${r.error} (tried: ${cmd})` };
  const text = (r.out || "") + "\n" + (r.err || "");
  if (/[Cc]ould ?n[o']t find.*addon|addon.*not found|--addon/.test(text) && !/misra-c2012/.test(text)) {
    return { unavailable: true, reason: "cppcheck MISRA addon not installed" };
  }
  const ruleTable = await loadRuleTable();
  const findings = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(.+?):(\d+):([^:]*):(.*)$/);
    if (!m) continue;
    const [, file, lineno, id, message] = m;
    if (!/misra-c2012/i.test(id)) continue;
    const absolute = path.resolve(root, file);
    // Only report what the caller asked for: the selected files, or the whole
    // scanned directory. Included headers from outside the scope (shared BSW
    // stack headers, for instance) never enter the report.
    if (scope && !scope.has(absolute)) continue;
    const rule = id.trim().replace(/^\[|\]$/g, "");
    const entry = ruleTable[ruleNumber(rule)] ?? {};
    const rawMessage = message.trim();
    const official = entry.text;
    findings.push({
      file: path.relative(root, file).replace(/\\/g, "/") || file,
      line: Number(lineno) || 1,
      rule,
      level: entry.severity ?? "Mandatory",
      severity: entry.severity === "Advisory" ? "warning" : "error",
      message: official && /misra violation/i.test(rawMessage) ? official : rawMessage,
      zh: entry.zh || undefined,
    });
    if (findings.length >= cfg.maxFindings) break;
  }
  return { engine: "cppcheck", findings, note: signal?.aborted ? "aborted" : undefined };
}

function summarize(result) {
  const errors = result.findings.filter((f) => f.severity === "error").length;
  return { total: result.findings.length, errors, warnings: result.findings.length - errors };
}

class MisraCheckService {
  constructor(ctx, config = {}) {
    this.ctx = ctx;
    this.config = config;
  }

  /**
   * Resolve the project root: an explicit `root` config wins, then the working
   * directory of a live session (newest first, which is the project the user is
   * working in), then the newest known session, then the Host's default.
   */
  resolveProjectRoot() {
    const configured = String(this.config.root || "").trim();
    if (configured) return { dir: path.resolve(configured), source: "config" };
    const agents = this.ctx.agents?.list?.() ?? [];
    const sessions = this.ctx.sessions?.list?.() ?? [];
    const newest = (a, b) => (b?.session?.header?.createdAt ?? b?.header?.createdAt ?? 0)
      - (a?.session?.header?.createdAt ?? a?.header?.createdAt ?? 0);
    const agentDirs = [...agents].sort(newest)
      .map((a) => a?.session?.header?.cwd)
      .filter((dir) => typeof dir === "string" && dir !== "");
    if (agentDirs.length > 0) return { dir: agentDirs[0], source: "session" };
    const sessionDirs = [...sessions].sort((a, b) => (b?.header?.createdAt ?? 0) - (a?.header?.createdAt ?? 0))
      .map((s) => s?.header?.cwd)
      .filter((dir) => typeof dir === "string" && dir !== "");
    if (sessionDirs.length > 0) return { dir: sessionDirs[0], source: "session" };
    const fallback = this.ctx.workingDirectory?.defaultDirectory;
    return { dir: fallback ? String(fallback) : process.cwd(), source: "host" };
  }

  /**
   * The directory the checker scans: the project root narrowed to the
   * configured `subdir` when it exists, so a whole project is never scanned.
   */
  resolveDefaultDir() {
    const root = this.resolveProjectRoot();
    return this.narrowToSubdir(root.dir, root.source);
  }

  /** Narrow a project root to the configured sub-directory when it exists. */
  narrowToSubdir(root, source) {
    const subdir = String(this.config.subdir || "").trim().replace(/[\\/]+$/, "");
    if (subdir === "") return { dir: root, source };
    const candidate = path.resolve(root, subdir);
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return { dir: candidate, source: `${source}+subdir` };
      }
    } catch {}
    return { dir: root, source };
  }

  formatText(result) {
    const s = summarize(result);
    const head = `MISRA C check (${result.engine}) on ${result.root}\n` +
      `${s.total} finding(s): ${s.errors} error, ${s.warnings} warning` +
      (result.note ? `\nnote: ${result.note}` : "") + "\n";
    const rows = result.findings.slice(0, 50).map((f) => `${f.file}:${f.line}  [${f.rule}]  ${f.message}`);
    const more = result.findings.length > 50 ? `\n… and ${result.findings.length - 50} more` : "";
    return head + rows.join("\n") + more;
  }

  /**
   * Collect the candidate source files of a directory tree, marking the
   * auto-generated ones so the Client can offer them separately.
   */
  async listFiles(dir) {
    const cfg = this.config;
    const root = path.resolve(String(dir || "").trim() || this.resolveDefaultDir().dir);
    const stat = await fsp.stat(root).catch(() => undefined);
    if (!stat || !stat.isDirectory()) throw new Error(`not a directory: ${root}`);
    const files = [];
    await walk(root, cfg.exclude, files, root);
    const rows = [];
    for (const file of files) {
      let size = 0;
      try { size = (await fsp.stat(file)).size; } catch {}
      rows.push({
        name: path.relative(root, file).replace(/\\/g, "/"),
        path: file,
        size,
        generated: await isGeneratedFile(file, cfg.generatedPatterns),
      });
    }
    return { dir: root, files: rows };
  }

  /**
   * Run the check over a directory, or over an explicit list of files inside
   * it. `selected` holds absolute paths (or paths relative to `root`).
   */
  async runCheck(targetDir, options = {}) {
    const cfg = this.config;
    const project = this.resolveProjectRoot();
    let root = String(targetDir || cfg.root || "").trim();
    if (!root) root = this.resolveDefaultDir().dir;
    root = path.resolve(root);
    const stat = await fsp.stat(root).catch(() => undefined);
    if (!stat || !stat.isDirectory()) throw new Error(`not a directory: ${root}`);

    const selected = Array.isArray(options.files) ? options.files.filter((f) => typeof f === "string" && f.trim() !== "") : [];
    const excludeGenerated = options.excludeGenerated ?? cfg.excludeGenerated ?? false;
    // Generated artifacts anywhere in the tree: they are skipped as scan
    // targets and their violations are suppressed in the report.
    const treeFiles = [];
    await walk(root, cfg.exclude, treeFiles, root);
    const generatedFiles = [];
    for (const file of treeFiles) {
      if (await isGeneratedFile(file, cfg.generatedPatterns)) generatedFiles.push(file);
    }
    let files = [];
    if (selected.length > 0) {
      files = selected.map((f) => (path.isAbsolute(f) ? f : path.resolve(root, f)));
    } else {
      files = [...treeFiles];
    }
    if (excludeGenerated) {
      files = files.filter((file) => !generatedFiles.includes(file));
    }
    const skipped = (selected.length > 0 ? selected.length : treeFiles.length) - files.length;
    // The report scope: the selected files when the caller picked some, every
    // scanned file of the directory otherwise.
    const scope = new Set(files.map((file) => path.resolve(file)));
    if (files.length === 0) {
      return {
        root,
        engine: "none",
        filesScanned: 0,
        findings: [],
        note: excludeGenerated
          ? "every selected file looks auto-generated; nothing left to check"
          : "no C sources found in this directory",
        total: 0, errors: 0, warnings: 0,
      };
    }

    const cpp = await cppcheckScan(root, cfg, project.dir, files, excludeGenerated ? generatedFiles : [], scope);
    if (!cpp.unavailable) {
      const capped = cpp.findings.length >= cfg.maxFindings;
      return {
        root,
        engine: cpp.engine,
        filesScanned: files.length,
        findings: cpp.findings,
        note: [
          capped ? `showing the first ${cfg.maxFindings} findings (raise the 'maxFindings' config for more)` : undefined,
          skipped > 0 ? `${skipped} auto-generated file(s) skipped` : undefined,
        ].filter(Boolean).join("; ") || cpp.note,
        ...summarize(cpp),
      };
    }
    const builtin = await builtinScan(root, cfg, files);
    return {
      root,
      engine: "builtin",
      filesScanned: builtin.filesScanned,
      findings: builtin.findings,
      note: `cppcheck unavailable (${cpp.reason}); used built-in heuristic rules (subset of MISRA C:2012)`,
      ...summarize(builtin),
    };
  }

  async probe() {
    const r = await runCommand(resolveCppcheck(this.config.cppcheck).cmd, ["--version"], { timeoutMs: 8000 });
    const version = (r.out || r.err || "").trim();
    return { cppcheck: r.error ? false : true, version: r.error ? undefined : version };
  }

  /**
   * RPC endpoint: the client sends `{ dir, files, excludeGenerated }`; an empty
   * directory falls back to the resolved default (the current project).
   */
  async check(request) {
    const body = typeof request === "string" ? { dir: request } : (request ?? {});
    const dir = typeof body.dir === "string" ? body.dir.trim() : "";
    const legacy = typeof body.path === "string" ? body.path.trim() : "";
    return this.runCheck(dir || legacy || this.resolveDefaultDir().dir, {
      files: body.files,
      excludeGenerated: body.excludeGenerated,
    });
  }

  /** RPC endpoint: the directory the checker defaults to, with its origin. */
  async defaults() {
    const resolved = this.resolveDefaultDir();
    return { dir: resolved.dir, source: resolved.source };
  }
}

/**
 * Plugin entry point.
 *
 * The Client half reaches this Host half over an exact Fetch route below the
 * shared `/api` channel: `POST /api/misra/check`. The Typert Gateway is not
 * used on purpose — its SRC fallback resolves
 * `@deepseek-ai/dsh-typert-protocol` from its own installation, so a
 * separately installed bundle can never register remote markers the Gateway
 * can see, and the endpoint would 404.
 */
export function apply(ctx, config = {}) {
  // The Host may hand over a partial config (a bundle patch only carries the
  // keys it sets); validating through the schema fills in every default.
  let resolved = config ?? {};
  try { resolved = Config(resolved); } catch { resolved = config ?? {}; }
  const service = new MisraCheckService(ctx, resolved);
  const resolvedConfig = resolved;

  const disposeCommand = ctx.commands.register({
    name: "misra",
    description: "Run a MISRA C check (cppcheck + MISRA addon, or the built-in fallback rules)",
    handler: async (invocation) => {
      const agent = invocation?.agent;
      const cwd = agent?.session?.header?.cwd ?? service.resolveDefaultDir().dir;
      const line = String(invocation?.line ?? "");
      const target = line.replace(/^\s*\/?misra\s*/i, "").trim();
      const result = await service.runCheck(target || cwd);
      return { kind: "success", text: service.formatText(result) };
    },
  });
  ctx.effect(() => { disposeCommand(); }, "@local/dsh-misra-checker: /misra command");

  ctx.effect(() => {
    const release = ctx.connection.fetch.register({
      path: "/api/misra/check",
      methods: ["POST"],
      requestBody: "buffered",
      fetch: async (request) => {
        try {
          const body = await request.json().catch(() => ({}));
          const action = typeof body?.action === "string" ? body.action : "check";
          if (action === "diag") {
            const exe = path.join(PKG_DIR, DEFAULT_CPPCHECK);
            return Response.json({
              ok: true,
              value: {
                pkgDir: PKG_DIR,
                cwd: process.cwd(),
                configured: resolvedConfig?.cppcheck,
                resolvedCmd: resolveCppcheck(resolvedConfig?.cppcheck).cmd,
                exePath: exe,
                exeExists: (() => { try { return fs.existsSync(exe); } catch (e) { return String(e); } })(),
                vendorExists: (() => { try { return fs.existsSync(path.join(PKG_DIR, "vendor")); } catch (e) { return String(e); } })(),
                indexExists: (() => { try { return fs.existsSync(path.join(PKG_DIR, "index.js")); } catch (e) { return String(e); } })(),
                config: resolvedConfig,
              },
            });
          }
          if (action === "defaults") {
            return Response.json({ ok: true, value: await service.defaults() });
          }
          if (action === "list") {
            const dir = typeof body?.dir === "string" ? body.dir : "";
            return Response.json({ ok: true, value: await service.listFiles(dir) });
          }
          const value = await service.check({
            dir: typeof body?.dir === "string" ? body.dir : "",
            path: typeof body?.path === "string" ? body.path : "",
            files: Array.isArray(body?.files) ? body.files : undefined,
            excludeGenerated: typeof body?.excludeGenerated === "boolean" ? body.excludeGenerated : undefined,
          });
          return Response.json({ ok: true, value });
        } catch (error) {
          return Response.json({
            ok: false,
            error: {
              code: "misra/check-failed",
              message: error instanceof Error ? error.message : String(error),
              details: {},
            },
          }, { status: 200 });
        }
      },
    });
    return () => { void release?.(); };
  }, "@local/dsh-misra-checker: /api/misra/check route");
}
