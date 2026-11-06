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
      dirPlaceholder: "要检查的 C 源码目录（绝对路径）",
      engineCppcheck: "引擎：cppcheck（MISRA 插件）",
      engineBuiltin: "引擎：内置启发式规则（MISRA C:2012 子集）",
      errors: "个错误",
      warnings: "个警告",
      findings: "条发现",
      filesScanned: "已扫描文件",
      noFindings: "未发现问题。",
      empty: "没有可显示的发现。",
      browse: "浏览…",
      defaultHint: "默认目录：",
      fromSession: "当前项目",
      failed: "检查失败",
      open: "展开",
      collapsed: "收起",
      files: "文件",
      listFiles: "列出文件",
      refresh: "刷新",
      selectAll: "全选",
      selectNone: "清空",
      selectManual: "仅选非生成",
      skipGenerated: "跳过自动生成代码",
      generated: "生成",
      selected: "已选",
      ofFiles: "/",
      noFiles: "该目录没有 C 源码文件。",
      listing: "正在列出文件…",
      mandatory: "强制",
      advisory: "建议",
      report: "报告文件",
      openReport: "打开报告",
      sendToChat: "发给 AI 分析",
      reportMissing: "本次检查没有生成报告文件。",
      needSession: "找不到当前会话，无法打开报告。",
      sent: "报告摘要已发送到聊天。",
      sendFailed: "发送失败",
      copied: "摘要已复制到剪贴板，请粘贴到聊天框。",
      duration: "用时",
      showFindings: "查看明细",
      hideFindings: "收起明细",
    };
    const en = {
      run: "MISRA C check",
      running: "Checking…",
      dir: "Source directory",
      dirPlaceholder: "C source directory to check (absolute path)",
      engineCppcheck: "Engine: cppcheck (MISRA addon)",
      engineBuiltin: "Engine: built-in heuristic rules (MISRA C:2012 subset)",
      errors: "errors",
      warnings: "warnings",
      findings: "findings",
      filesScanned: "files scanned",
      noFindings: "No findings.",
      empty: "Nothing to show.",
      browse: "Browse…",
      defaultHint: "Default directory:",
      fromSession: "current project",
      failed: "Check failed",
      open: "Show",
      collapsed: "Hide",
      files: "Files",
      listFiles: "List files",
      refresh: "Refresh",
      selectAll: "Select all",
      selectNone: "Clear",
      selectManual: "Hand-written only",
      skipGenerated: "Skip auto-generated code",
      generated: "gen",
      selected: "selected",
      ofFiles: "/",
      noFiles: "No C sources in this directory.",
      listing: "Listing files…",
      mandatory: "Mandatory",
      advisory: "Advisory",
      report: "Report",
      openReport: "Open report",
      sendToChat: "Send to AI",
      reportMissing: "This run produced no report file.",
      needSession: "No current session found; the report cannot be opened.",
      sent: "The report summary was sent to the chat.",
      sendFailed: "Send failed",
      copied: "The summary was copied to the clipboard; paste it into the chat.",
      duration: "took",
      showFindings: "Show findings",
      hideFindings: "Hide findings",
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
      ".msr-item{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}",
      ".msr-item .msr-loc{color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".msr-item .msr-rule{color:var(--dsw-alias-brand-primary);white-space:nowrap}",
      ".msr-item .msr-lvl{font-size:10px;line-height:14px;padding:0 5px;border-radius:6px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".msr-item .msr-msg{color:var(--dsw-alias-label-secondary);word-break:break-word;flex:1;min-width:220px}",
      ".msr-item .msr-zh{flex-basis:100%;padding-left:4px;color:var(--dsw-alias-label-tertiary);word-break:break-word}",
      ".msr-item--err .msr-rule{color:var(--dsw-alias-state-error-primary)}",
      ".msr-item--warn .msr-rule{color:var(--dsw-alias-state-warn-label)}",
      ".msr-toggle{font:inherit;font-size:11.5px;padding:2px 8px;border:none;background:none;color:var(--dsw-alias-brand-primary);cursor:pointer}",
      ".msr-files{display:flex;flex-direction:column;gap:2px;max-height:220px;overflow:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;padding:6px;background:var(--dsw-alias-bg-layer-1)}",
      ".msr-file{display:flex;gap:8px;align-items:baseline;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px;line-height:17px;cursor:pointer}",
      ".msr-file input{margin:0;accent-color:var(--dsw-alias-brand-primary)}",
      ".msr-file .msr-fname{color:var(--dsw-alias-label-secondary);word-break:break-all}",
      ".msr-file--gen .msr-fname{color:var(--dsw-alias-label-tertiary)}",
      ".msr-tag{font-size:10px;line-height:14px;padding:0 6px;border-radius:6px;background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-tertiary);white-space:nowrap}",
      ".msr-check{display:flex;gap:6px;align-items:center;font-size:11.5px;color:var(--dsw-alias-label-secondary);white-space:nowrap}",
      ".msr-check input{margin:0;accent-color:var(--dsw-alias-brand-primary)}",
      ".msr-result{display:flex;flex-direction:column;gap:6px;padding-top:6px;border-top:1px dashed var(--dsw-alias-border-l2)}",
      ".msr-report{display:flex;gap:6px;align-items:baseline;flex-wrap:wrap}",
      ".msr-link{font:inherit;font-size:11.5px;line-height:17px;padding:0;border:none;background:none;color:var(--dsw-alias-brand-primary);cursor:pointer;text-decoration:underline;text-underline-offset:2px;word-break:break-all;text-align:left}",
      ".msr-btn--primary{background:var(--dsw-alias-state-business-primary);border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}",
      ".msr-ok{font-size:12px;line-height:18px;color:var(--dsw-alias-state-success-primary)}",
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

    function MisraPanel({ callRpc, t, pickDirectory, sessionId, openReport, sendToChat }) {
      const [dir, setDir] = useState(() => { try { return window.localStorage.getItem(LS_KEY) || ""; } catch { return ""; } });
      const [running, setRunning] = useState(false);
      const [result, setResult] = useState(null);
      const [error, setError] = useState(null);
      const [notice, setNotice] = useState(null);
      const [open, setOpen] = useState(false);
      const [defaultDir, setDefaultDir] = useState(null);
      const [files, setFiles] = useState([]);
      const [listing, setListing] = useState(false);
      const [selected, setSelected] = useState(() => new Set());
      const [skipGenerated, setSkipGenerated] = useState(true);
      const [showFiles, setShowFiles] = useState(false);

      // Ask the Host which directory the current project uses, and prefill it.
      useEffect(() => {
        let alive = true;
        callRpc("defaults", {}).then((d) => {
          if (!alive || !d || typeof d.dir !== "string" || d.dir === "") return;
          setDefaultDir(d);
          setDir((current) => (current && current.trim() !== "" ? current : d.dir));
        }).catch(() => {});
        return () => { alive = false; };
      }, []);

      const loadFiles = async (target) => {
        setListing(true);
        try {
          const listingResult = await callRpc("list", { dir: target });
          const rows = Array.isArray(listingResult?.files) ? listingResult.files : [];
          setFiles(rows);
          // Default: hand-written files only, so generated artifacts do not
          // drown the report.
          setSelected(new Set(rows.filter((f) => !f.generated).map((f) => f.path)));
        } catch (e) {
          setError(String((e && e.message) || e));
          setFiles([]);
          setSelected(new Set());
        } finally {
          setListing(false);
        }
      };

      useEffect(() => {
        if (!showFiles) return;
        let alive = true;
        loadFiles(dir.trim()).catch(() => {});
        return () => { alive = false; };
      }, [showFiles, dir]);

      const toggleFile = (filePath) => {
        setSelected((current) => {
          const next = new Set(current);
          if (next.has(filePath)) next.delete(filePath);
          else next.add(filePath);
          return next;
        });
      };

      const selectAll = () => setSelected(new Set(files.map((f) => f.path)));
      const selectNone = () => setSelected(new Set());
      const selectManual = () => setSelected(new Set(files.filter((f) => !f.generated).map((f) => f.path)));

      const run = async () => {
        const target = dir.trim();
        try { window.localStorage.setItem(LS_KEY, target); } catch {}
        setRunning(true);
        setError(null);
        setNotice(null);
        try {
          const chosen = Array.from(selected);
          const r = await callRpc("check", {
            dir: target,
            files: chosen,
            excludeGenerated: skipGenerated,
          });
          setResult(r);
          setOpen(false);
        } catch (e) {
          setError(String((e && e.message) || e));
          setResult(null);
        } finally {
          setRunning(false);
        }
      };

      // Open the written report in the right-hand document preview.
      const openTheReport = async () => {
        setError(null);
        setNotice(null);
        try {
          const report = result && result.report;
          if (!report || !report.path) throw new Error(t("reportMissing"));
          await openReport(report, { sessionId: result.sessionId || sessionId, cwd: result.cwd });
        } catch (e) {
          setError(String((e && e.message) || e));
        }
      };

      // Hand the report summary to the agent, so it can analyse the findings.
      const sendTheReport = async () => {
        setError(null);
        setNotice(null);
        try {
          const target = (result && result.sessionId) || sessionId;
          const text = await sendToChat({ sessionId: target, result });
          setNotice(text || t("sent"));
        } catch (e) {
          setError(t("sendFailed") + ": " + String((e && e.message) || e));
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
          h("button", {
            className: "msr-btn", disabled: running,
            onClick: () => { setShowFiles((v) => !v); },
          }, t("files")),
          h("button", { className: "msr-btn", disabled: running, onClick: run }, running ? t("running") : t("run"))),
        defaultDir ? h("div", { className: "msr-meta" },
          t("defaultHint") + " " + defaultDir.dir + (defaultDir.source === "session" ? " (" + t("fromSession") + ")" : "")) : null,
        showFiles ? h("div", { className: "msr-row" },
          h("label", { className: "msr-check" },
            h("input", {
              type: "checkbox", checked: skipGenerated,
              onChange: (e) => setSkipGenerated(e.target.checked),
            }),
            t("skipGenerated")),
          h("button", { className: "msr-btn", onClick: selectAll }, t("selectAll")),
          h("button", { className: "msr-btn", onClick: selectManual }, t("selectManual")),
          h("button", { className: "msr-btn", onClick: selectNone }, t("selectNone")),
          h("span", { className: "msr-meta" },
            selected.size + " " + t("selected") + " " + t("ofFiles") + " " + files.length)) : null,
        showFiles ? h("div", { className: "msr-files" },
          listing ? h("div", { className: "msr-meta" }, t("listing")) : null,
          !listing && files.length === 0 ? h("div", { className: "msr-meta" }, t("noFiles")) : null,
          files.map((f) => h("label", {
            className: "msr-file" + (f.generated ? " msr-file--gen" : ""),
            key: f.path,
            title: f.path,
          },
            h("input", {
              type: "checkbox", checked: selected.has(f.path),
              onChange: () => toggleFile(f.path),
            }),
            h("span", { className: "msr-fname" }, f.name),
            f.generated ? h("span", { className: "msr-tag" }, t("generated")) : null))) : null,
        result ? h("div", { className: "msr-result" },
          h("div", { className: "msr-meta" },
            (result.engine === "cppcheck" ? t("engineCppcheck") : t("engineBuiltin")) +
            " · " + result.total + " " + t("findings") + " (" + result.errors + " " + t("errors") + ", " + result.warnings + " " + t("warnings") + ")" +
            (result.filesScanned ? " · " + result.filesScanned + " " + t("filesScanned") : "") +
            (result.durationMs !== undefined ? " · " + t("duration") + " " + (result.durationMs / 1000).toFixed(1) + "s" : "")),
          result.note ? h("div", { className: "msr-meta" }, result.note) : null,
          findings.length === 0 ? h("div", { className: "msr-meta" }, t("noFindings")) : null,
          result.report ? h("div", { className: "msr-meta msr-report" },
            t("report") + ": ",
            h("button", {
              className: "msr-link", title: result.report.path,
              onClick: openTheReport,
            }, result.report.relativePath || result.report.name)) : null,
          h("div", { className: "msr-row" },
            result.report ? h("button", { className: "msr-btn msr-btn--primary", onClick: openTheReport }, t("openReport")) : null,
            result.report ? h("button", { className: "msr-btn", onClick: sendTheReport }, t("sendToChat")) : null,
            findings.length > 0 ? h("button", { className: "msr-toggle", onClick: () => setOpen((v) => !v) }, open ? t("hideFindings") + " ▴" : t("showFindings") + " (" + findings.length + ") ▾") : null)) : null,
        notice ? h("div", { className: "msr-ok" }, notice) : null,
        error ? h("div", { className: "msr-err" }, t("failed") + ": " + error) : null,
        open && findings.length > 0 ? h("div", { className: "msr-list" },
          findings.map((f, i) => h("div", { className: "msr-item msr-item--" + (f.severity === "error" ? "err" : "warn"), key: i },
            h("span", { className: "msr-loc" }, f.file + ":" + f.line),
            h("span", { className: "msr-rule" }, "[" + f.rule + "]"),
            f.level ? h("span", { className: "msr-lvl" }, f.level === "Advisory" ? t("advisory") : t("mandatory")) : null,
            h("span", { className: "msr-msg" }, f.message),
            f.zh ? h("span", { className: "msr-zh" }, f.zh) : null))) : null);
    }

    const inject = ["slots", "locale", "connection", "sidebarRight", "remote"];

    // `dsh-resource://file/session/<sessionId>/<path>` addresses are what the
    // right-hand document preview reads. The path is workspace-relative when it
    // lives under the session's working directory, absolute otherwise.
    const encodeSegment = (segment) => encodeURIComponent(segment).replace(/%3A/gi, ":");
    const encodePath = (value) => String(value).split("/").map(encodeSegment).join("/");
    function fileAddress(sessionId, filePath, cwd) {
      const normalized = String(filePath).replace(/\\/g, "/");
      let target = normalized;
      const root = String(cwd || "").replace(/\\/g, "/").replace(/\/+$/, "");
      if (root && normalized.startsWith(root + "/")) target = normalized.slice(root.length + 1);
      return `dsh-resource://file/session/${encodeSegment(String(sessionId))}/${encodePath(target)}`;
    }

    function apply(ctx) {
      installStyles(ctx);
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "@local/dsh-misra-checker: dictionaries");
      const t = ctx.locale.bind(NS);
      const callRpc = async (method, args) => {
        // The Host half registers the exact Fetch route `/api/misra/check`;
        // the browser session cookie authenticates the request.
        const response = await globalThis.fetch("/api/misra/check", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: method, ...(args || {}) }),
        });
        if (!response.ok) throw new Error("misra request failed: HTTP " + response.status);
        const payload = await response.json();
        if (payload && payload.ok) return payload.value;
        const e = payload && payload.error;
        throw new Error(e ? e.code + ": " + e.message : "misra request failed");
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
      // Open the report in the right-hand document preview.
      const openReport = async (report, { sessionId, cwd } = {}) => {
        const target = sessionId || (await currentSessionId());
        if (!target) throw new Error(t("needSession"));
        const sidebarRight = ctx.get("sidebarRight");
        if (!sidebarRight || typeof sidebarRight.openResource !== "function") {
          throw new Error("document preview unavailable");
        }
        sidebarRight.openResource(fileAddress(target, report.path, cwd));
      };

      // The session the panel belongs to; the Host knows it as well.
      const currentSessionId = async () => {
        try {
          const d = await callRpc("defaults", {});
          return d && typeof d.sessionId === "string" ? d.sessionId : undefined;
        } catch {
          return undefined;
        }
      };

      // Hand the report to the agent: the Host command turns the previous run
      // into a short summary and the agent reads the report file itself.
      const sendToChat = async ({ sessionId } = {}) => {
        const target = sessionId || (await currentSessionId());
        if (!target) throw new Error(t("needSession"));
        const commands = ctx.get("remote")?.commands;
        if (!commands || typeof commands.execute !== "function") {
          // No command channel: fall back to the clipboard.
          const summary = await callRpc("summary", {});
          if (summary && summary.text && navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(summary.text);
            return t("copied");
          }
          throw new Error("command channel unavailable");
        }
        const outcome = await commands.execute(target, "/misra report", []);
        if (!outcome || outcome.ok === false) {
          const error = outcome && outcome.error;
          throw new Error(error ? `${error.code}: ${error.message}` : "command failed");
        }
        return t("sent");
      };

      ctx.slots.inject("conversation.composer.dock", () => ctx.slots.register({
        name: "conversation.composer.dock",
        id: "@local/dsh-misra-checker",
        order: 20,
        inject: (sessionId) => ({ callRpc, t: (k) => t(k), pickDirectory, sessionId, openReport, sendToChat }),
      }, MisraPanel));
    }
    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
