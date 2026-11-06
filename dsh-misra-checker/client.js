// @local/dsh-misra-checker — browser half. Adds a "MISRA C check" panel in the
// composer dock: a directory input (prefilled with the last used path), a run
// button, and an expandable findings list. Calls the Host remote misraCheck/*
// through the generic connection RPC.
window.__ModuleLoader__.load({
  id: "@local/dsh-misra-checker",
  factory: (require) => {
    "use strict";
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    const React = require("react");
    const h = React.createElement;
    const { useState, useEffect } = React;

    const PLUGIN_ID = "@local/dsh-misra-checker";
    const NS = "misraCheck";
    const LS_KEY = "dsh-misra-checker:path";

    const zh = {
      run: "MISRA C 检查",
      running: "检查中…",
      dir: "项目目录",
      dirPlaceholder: "要检查的 C 项目目录（绝对路径）",
      engineCppcheck: "引擎：cppcheck（MISRA 插件）",
      engineBuiltin: "引擎：内置启发式规则（MISRA C:2012 子集）",
      errors: "个错误",
      warnings: "个警告",
      findings: "条发现",
      filesScanned: "已扫描文件",
      noFindings: "未发现问题。",
      empty: "没有可显示的发现。",
      browse: "浏览…",
      failed: "检查失败",
      open: "展开",
      collapsed: "收起",
    };
    const en = {
      run: "MISRA C check",
      running: "Checking…",
      dir: "Project directory",
      dirPlaceholder: "C project directory to check (absolute path)",
      engineCppcheck: "Engine: cppcheck (MISRA addon)",
      engineBuiltin: "Engine: built-in heuristic rules (MISRA C:2012 subset)",
      errors: "errors",
      warnings: "warnings",
      findings: "findings",
      filesScanned: "files scanned",
      noFindings: "No findings.",
      empty: "Nothing to show.",
      browse: "Browse…",
      failed: "Check failed",
      open: "Show",
      collapsed: "Hide",
    };

    const CSS = [
      ".msr{display:flex;flex-direction:column;gap:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);max-width:720px}",
      ".msr-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}",
      ".msr-title{font-size:12px;font-weight:600;line-height:18px;white-space:nowrap}",
      ".msr-input{font:inherit;font-size:12px;line-height:18px;padding:4px 8px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);min-width:220px;flex:1;outline:none}",
      ".msr-input:focus{border-color:var(--dsw-alias-brand-primary)}",
      ".msr-btn{font:inherit;font-size:12px;line-height:18px;padding:4px 12px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-button-floating-fill);color:var(--dsw-alias-label-primary);cursor:pointer;white-space:nowrap}",
      ".msr-btn:hover{background:var(--dsw-alias-button-floating-hover)}",
      ".msr-btn:disabled{opacity:.55;cursor:default}",
      ".msr-meta{font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary)}",
      ".msr-err{font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary)}",
      ".msr-list{display:flex;flex-direction:column;gap:4px;max-height:240px;overflow:auto;border-top:1px dashed var(--dsw-alias-border-l2);padding-top:6px}",
      ".msr-item{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;display:flex;gap:8px;align-items:baseline}",
      ".msr-item .msr-loc{color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".msr-item .msr-rule{color:var(--dsw-alias-brand-primary);white-space:nowrap}",
      ".msr-item .msr-msg{color:var(--dsw-alias-label-secondary);word-break:break-word}",
      ".msr-item--err .msr-rule{color:var(--dsw-alias-state-error-primary)}",
      ".msr-item--warn .msr-rule{color:var(--dsw-alias-state-warn-label)}",
      ".msr-toggle{font:inherit;font-size:11.5px;padding:2px 8px;border:none;background:none;color:var(--dsw-alias-brand-primary);cursor:pointer}",
    ].join("\n");

    function installStyles(ctx) {
      if (typeof document === "undefined") return;
      ctx.effect(() => {
        const tag = document.createElement("style");
        tag.dataset.plugin = PLUGIN_ID;
        tag.textContent = CSS;
        document.head.appendChild(tag);
        return () => tag.remove();
      }, "@local/dsh-misra-checker: styles");
    }

    function MisraPanel({ callRpc, t, pickDirectory }) {
      const [dir, setDir] = useState(() => { try { return window.localStorage.getItem(LS_KEY) || ""; } catch { return ""; } });
      const [running, setRunning] = useState(false);
      const [result, setResult] = useState(null);
      const [error, setError] = useState(null);
      const [open, setOpen] = useState(true);

      const run = async () => {
        const target = dir.trim();
        try { window.localStorage.setItem(LS_KEY, target); } catch {}
        setRunning(true);
        setError(null);
        try {
          const r = await callRpc("check", { path: target });
          setResult(r);
          setOpen(true);
        } catch (e) {
          setError(String((e && e.message) || e));
          setResult(null);
        } finally {
          setRunning(false);
        }
      };

      const browse = async () => {
        try {
          const picked = await pickDirectory();
          if (typeof picked === "string" && picked) setDir(picked);
        } catch (e) {
          setError(String((e && e.message) || e));
        }
      };

      const findings = (result && result.findings) || [];
      return h("div", { className: "msr" },
        h("div", { className: "msr-row" },
          h("span", { className: "msr-title" }, t("run")),
          h("input", {
            className: "msr-input", value: dir, placeholder: t("dirPlaceholder"), spellCheck: false,
            onChange: (e) => setDir(e.target.value),
            onKeyDown: (e) => { if (e.key === "Enter" && !running) run(); },
          }),
          pickDirectory ? h("button", { className: "msr-btn", disabled: running, onClick: browse, title: t("browse") }, t("browse")) : null,
          h("button", { className: "msr-btn", disabled: running, onClick: run }, running ? t("running") : t("run"))),
        result ? h("div", { className: "msr-meta" },
          (result.engine === "cppcheck" ? t("engineCppcheck") : t("engineBuiltin")) +
          " · " + result.total + " " + t("findings") + " (" + result.errors + " " + t("errors") + ", " + result.warnings + " " + t("warnings") + ")" +
          (result.filesScanned ? " · " + result.filesScanned + " " + t("filesScanned") : ""),
          result.note ? h("div", { className: "msr-meta" }, result.note) : null,
          findings.length === 0 ? h("div", { className: "msr-meta" }, t("noFindings")) : null) : null,
        error ? h("div", { className: "msr-err" }, t("failed") + ": " + error) : null,
        findings.length > 0 ? h("div", { className: "msr-row" },
          h("button", { className: "msr-toggle", onClick: () => setOpen((v) => !v) }, open ? t("collapsed") + " ▴" : t("open") + " ▾")) : null,
        open && findings.length > 0 ? h("div", { className: "msr-list" },
          findings.map((f, i) => h("div", { className: "msr-item msr-item--" + (f.severity === "error" ? "err" : "warn"), key: i },
            h("span", { className: "msr-loc" }, f.file + ":" + f.line),
            h("span", { className: "msr-rule" }, "[" + f.rule + "]"),
            h("span", { className: "msr-msg" }, f.message)))) : null);
    }

    const inject = ["slots", "locale", "connection"];
    function apply(ctx) {
      installStyles(ctx);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "@local/dsh-misra-checker: dictionaries");
      const t = ctx.locale.bind(NS);
      const callRpc = async (method, args) => {
        const r = await ctx.connection.rpc.call("/api", "misraCheck/" + method, { args: args || {} });
        if (r && r.ok) return r.value;
        const e = r && r.error;
        throw new Error(e ? e.code + ": " + e.message : "rpc failed");
      };
      // Host directory picker: prefer the uiWorkspace client service, fall back
      // to the directoryPicker remote through the generic connection RPC.
      const pickDirectory = async () => {
        try {
          const uiWorkspace = ctx.get("uiWorkspace");
          if (uiWorkspace && typeof uiWorkspace.pickDirectory === "function") {
            return await uiWorkspace.pickDirectory();
          }
        } catch {}
        const r = await ctx.connection.rpc.call("/api", "directoryPicker/pick", { args: {} });
        if (r && r.ok) return r.value;
        throw new Error("directory picker unavailable");
      };
      ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
        name: "conversation.composer.dock",
        id: "@local/dsh-misra-checker",
        order: 20,
        inject: () => ({ callRpc, t: (k) => t(k), pickDirectory }),
      }, MisraPanel));
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
