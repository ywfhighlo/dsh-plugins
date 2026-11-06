// @local/dsh-misra-checker — Host half.
// Runs a MISRA C check over a project directory:
//  - cppcheck with the MISRA addon when cppcheck is available, otherwise
//  - a built-in line-based heuristic scan over a small subset of MISRA C:2012 rules.
// The same operation is exposed as the RPC remote `misraCheck/check` (used by the
// composer button) and as the `/misra` slash command.
import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import Schema from "@deepseek-ai/schemastery";
import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";

export const name = "@local/dsh-misra-checker";
export const inject = ["commands"];

export const Config = Schema.object({
  root: Schema.string().default("").description("Default directory to check when the caller passes none (absolute path)"),
  cppcheck: Schema.string().default("vendor/cppcheck/cppcheck.exe").description("cppcheck executable: absolute path, or a path relative to this plugin folder (default bundles it in vendor/), or a bare command name found on PATH"),
  cppcheckArgs: Schema.string().default("").description("Extra cppcheck arguments (e.g. --std=c11 --platform=arm32)"),
  exclude: Schema.array(Schema.string()).default([".git", "node_modules", "build", "dist", "out", ".dsh", ".agents"]).description("Directory names skipped by the built-in scanner"),
  maxFindings: Schema.number().default(500).description("Cap on reported findings per run"),
});

const NAMESPACE = "misraCheck";
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
const PKG_DIR = path.dirname(new URL(".", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
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

async function cppcheckScan(root, cfg, signal) {
  const extra = cfg.cppcheckArgs ? cfg.cppcheckArgs.split(/\s+/).filter(Boolean) : [];
  const args = [
    "--quiet", "--enable=style",
    "--addon=misra",
    "--template={file}:{line}:{id}:{message}",
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

class MisraCheckService extends TypertRemoteService {
  static inject = ["commands"];
  constructor(ctx, config = {}) {
    super(ctx, NAMESPACE);
    this.config = config;
    const disposeCommand = ctx.commands.register({
      name: "misra",
      description: "Run a MISRA C check (cppcheck + MISRA addon, or the built-in fallback rules)",
      handler: async (invocation) => {
        const agent = invocation?.agent;
        const cwd = agent?.session?.header?.cwd ?? process.cwd();
        const line = String(invocation?.line ?? "");
        const target = line.replace(/^\s*\/?misra\s*/i, "").trim();
        const result = await this.runCheck(target || cwd);
        return { kind: "success", text: this.formatText(result) };
      },
    });
    ctx.effect(() => { disposeCommand(); }, "@local/dsh-misra-checker: /misra command");
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
    let root = String(targetDir || cfg.root || "").trim();
    if (!root) throw new Error("no directory to check: pass a path or set the plugin config 'root'");
    root = path.resolve(root);
    const stat = await fsp.stat(root).catch(() => undefined);
    if (!stat || !stat.isDirectory()) throw new Error(`not a directory: ${root}`);

    const cpp = await cppcheckScan(root, cfg);
    if (!cpp.unavailable) {
      return { root, engine: cpp.engine, filesScanned: undefined, findings: cpp.findings, ...summarize(cpp) };
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

  async check(a) {
    const req = typeof a === "string" ? { path: a } : (a || {});
    return this.runCheck(req.path || req.cwd || req.root);
  }
}

// Expose methods to the Typert Gateway without decorator syntax (plain JS).
// `Remote(<name>)` returns a standard method decorator. TS-compiled classes run
// the decorator's initializer with `this` = the instance, so the marker lands on
// `MisraCheckService.prototype`; we emulate the same call.
function exposeMethod(cls, method, exportName) {
  Remote(exportName ?? method)(undefined, {
    name: method,
    private: false,
    static: false,
    addInitializer(fn) { fn.call(Object.create(cls.prototype)); },
  });
}
exposeMethod(MisraCheckService, "check");
exposeMethod(MisraCheckService, "probe");

export default MisraCheckService;
