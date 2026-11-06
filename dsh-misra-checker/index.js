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
import path from "node:path";
import { fileURLToPath } from "node:url";

export const name = "@local/dsh-misra-checker";
export const inject = ["commands", "connection", "agents", "sessions", "workingDirectory"];

export const Config = Schema.object({
  root: Schema.string().default("").description("Default directory to check when the caller passes none (absolute path)"),
  subdir: Schema.string().default("").description("Directory below the project root that actually holds the code (e.g. 'components/Mcal/Eth'); the project root is used when it does not exist"),
  cppcheck: Schema.string().default("vendor/cppcheck/cppcheck.exe").description("cppcheck executable: absolute path, or a path relative to this plugin folder (default bundles it in vendor/), or a bare command name found on PATH"),
  cppcheckArgs: Schema.string().default("").description("Extra cppcheck arguments (e.g. --std=c11 --platform=arm32)"),
  defines: Schema.array(Schema.string()).default([]).description("Preprocessor defines passed to cppcheck (e.g. DISABLE_MCAL_INTERMODULE_ASR_CHECK)"),
  includes: Schema.array(Schema.string()).default([]).description("Include directories for cppcheck, absolute or relative to the project root (e.g. components/Mcal/Common)"),
  exclude: Schema.array(Schema.string()).default([".git", "node_modules", "build", "dist", "out", ".dsh", ".agents"]).description("Directory names skipped by the built-in scanner"),
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

function stripCommentsLine(line) {
  // good-enough for heuristics: drop // tails; block comments are approximated per line
  return line.replace(/\/\/.*$/, "").replace(/\/\*.*?\*\//g, "");
}

async function builtinScan(root, cfg, signal) {
  const files = [];
  await walk(root, cfg.exclude, files, root);
  const findings = [];
  for (const file of files) {
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
          if (findings.length >= cfg.maxFindings) return { engine: "builtin", filesScanned: files.length, findings };
        }
      }
    }
  }
  return { engine: "builtin", filesScanned: files.length, findings };
}

function runCommand(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
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
const PKG_DIR = path.dirname(fileURLToPath(new URL(".", import.meta.url)));
function resolveCppcheck(configured) {
  const value = String(configured || "").trim();
  if (!value) return { cmd: "cppcheck" };
  if (path.isAbsolute(value)) return { cmd: value };
  const candidates = [path.join(PKG_DIR, value), path.resolve(value)];
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return { cmd: c }; } catch {}
  }
  return { cmd: value };
}

async function cppcheckScan(root, cfg, projectRoot, signal) {
  const extra = cfg.cppcheckArgs ? cfg.cppcheckArgs.split(/\s+/).filter(Boolean) : [];
  const defines = (cfg.defines ?? []).map((d) => `-D${d}`);
  const includes = (cfg.includes ?? []).map((dir) => {
    const value = String(dir);
    return `-I${path.isAbsolute(value) ? value : path.resolve(projectRoot ?? root, value)}`;
  });
  const args = [
    "--quiet", "--enable=style",
    "--addon=misra",
    "--template={file}:{line}:{id}:{message}",
    ...defines, ...includes,
    ...extra, root,
  ];
  const r = await runCommand(resolveCppcheck(cfg.cppcheck).cmd, args, { timeoutMs: 300000 });
  if (r.error) return { unavailable: true, reason: r.error };
  const text = (r.out || "") + "\n" + (r.err || "");
  if (/[Cc]ould ?n[o']t find.*addon|addon.*not found|--addon/.test(text) && !/misra-c2012/.test(text)) {
    return { unavailable: true, reason: "cppcheck MISRA addon not installed" };
  }
  const findings = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^(.+?):(\d+):([^:]*):(.*)$/);
    if (!m) continue;
    const [, file, lineno, id, message] = m;
    if (!/misra-c2012/i.test(id)) continue;
    findings.push({
      file: path.relative(root, file).replace(/\\/g, "/") || file,
      line: Number(lineno) || 1,
      rule: id.trim().replace(/^\[|\]$/g, ""),
      severity: /\bstyle\b|\bperformance\b/i.test(id) ? "warning" : "error",
      message: message.trim(),
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

  async runCheck(targetDir) {
    const cfg = this.config;
    const project = this.resolveProjectRoot();
    let root = String(targetDir || cfg.root || "").trim();
    if (!root) root = this.resolveDefaultDir().dir;
    root = path.resolve(root);
    const stat = await fsp.stat(root).catch(() => undefined);
    if (!stat || !stat.isDirectory()) throw new Error(`not a directory: ${root}`);

    const cpp = await cppcheckScan(root, cfg, project.dir);
    if (!cpp.unavailable) {
      const capped = cpp.findings.length >= cfg.maxFindings;
      return {
        root,
        engine: cpp.engine,
        filesScanned: undefined,
        findings: cpp.findings,
        note: capped ? `showing the first ${cfg.maxFindings} findings (raise the 'maxFindings' config for more)` : cpp.note,
        ...summarize(cpp),
      };
    }
    const builtin = await builtinScan(root, cfg);
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
   * RPC endpoint: the client sends `{ path: "<dir>" }`; an empty path falls
   * back to the resolved default directory (the current project).
   */
  async check(dir) {
    const target = typeof dir === "string" ? dir.trim() : "";
    return this.runCheck(target || this.resolveDefaultDir().dir);
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
  const service = new MisraCheckService(ctx, config);

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
          if (action === "defaults") {
            return Response.json({ ok: true, value: await service.defaults() });
          }
          const value = await service.check(typeof body?.path === "string" ? body.path : "");
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

export default MisraCheckService;
