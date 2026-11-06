// Builds the MISRA C:2012 rule-text data shipped with the plugin.
//
//   node tools/build-rule-texts.mjs <path-to-source.txt>
//
// The source is the public "MISRA C:2012 标准中文详解" summary page
// (https://www.cnblogs.com/xywml/p/18742061), which lists every rule with its
// official English title and a Chinese requirement line. Rules the page does
// not cover are taken from ADDITIONAL below and cross-checked against the
// checks implemented by cppcheck's own MISRA addon (vendor/cppcheck/addons/misra.py).
//
// Outputs:
//   rules/misra-c2012.json      rule -> { severity, text, zh }
//   vendor/cppcheck/misra-rules.txt   cppcheck "--rule-texts" input (Appendix A format)

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PKG_DIR = fileURLToPath(new URL("..", import.meta.url));

// Rules the public summary page does not list (it stops at Rule 20.8).
// The wording follows what cppcheck's misra addon actually checks.
const ADDITIONAL = {
  "20.1": ["Mandatory", "All #include directives shall precede any other content in the translation unit.", "#include 必须位于文件最前面，不能出现在语句之后。"],
  "20.9": ["Mandatory", "The controlling expression of a #if or #elif directive shall only contain identifiers that are defined macros or C keywords.", "#if/#elif 的控制表达式只能使用已定义的宏或 C 关键字。"],
  "20.10": ["Mandatory", "The # operator shall not be used.", "不得使用 # 运算符。"],
  "20.11": ["Mandatory", "A macro parameter shall not be used with both the # and ## operators.", "宏参数不得同时与 # 和 ## 运算符一起使用。"],
  "20.12": ["Mandatory", "The ## operator shall not be used with a macro parameter that is also used in another macro invocation.", "## 运算符不得用于在其他宏调用中同样出现的宏参数。"],
  "20.13": ["Mandatory", "Preprocessor directives that are not defined shall not be used.", "不得使用未定义的预处理指令。"],
  "20.14": ["Mandatory", "All #if, #ifdef and #ifndef directives shall have a matching #endif directive in the same file.", "#if/#ifdef/#ifndef 必须在同一文件内与 #endif 正确配对。"],
  "21.1": ["Mandatory", "Reserved identifiers, keywords and macro names shall not be used.", "不得使用保留标识符、关键字与宏名。"],
  "21.2": ["Mandatory", "A reserved identifier shall not be declared or defined.", "不得声明或定义保留标识符。"],
  "21.3": ["Mandatory", "The memory allocation and deallocation functions of <stdlib.h> shall not be used.", "不得使用 <stdlib.h> 的内存分配与释放函数。"],
  "21.4": ["Mandatory", "The <setjmp.h> header shall not be included.", "不得包含 <setjmp.h> 头文件。"],
  "21.5": ["Mandatory", "The <signal.h> header shall not be included.", "不得包含 <signal.h> 头文件。"],
  "21.6": ["Mandatory", "The standard library input/output functions shall not be used.", "不得使用标准库输入/输出函数。"],
  "21.7": ["Mandatory", "The atof, atoi, atol and atoll functions of <stdlib.h> shall not be used.", "不得使用 <stdlib.h> 的 atof/atoi/atol/atoll 函数。"],
  "21.8": ["Mandatory", "The abort, exit and getenv functions of <stdlib.h> shall not be used.", "不得使用 <stdlib.h> 的 abort/exit/getenv 函数。"],
  "21.9": ["Mandatory", "The bsearch and qsort functions of <stdlib.h> shall not be used.", "不得使用 <stdlib.h> 的 bsearch/qsort 函数。"],
  "21.10": ["Mandatory", "The <time.h> header shall not be included.", "不得包含 <time.h> 头文件。"],
  "21.11": ["Mandatory", "The <tgmath.h> header shall not be included.", "不得包含 <tgmath.h> 头文件。"],
  "21.12": ["Mandatory", "The fenv facilities of <fenv.h> shall not be used.", "不得使用 <fenv.h> 的浮点环境设施。"],
};

// Rules whose public title is given in Chinese only: keep the official English wording.
const ENGLISH_FOR_CHINESE_TITLE = {
  "1.1": "The program shall not violate the standard C syntax and constraints, nor exceed the implementation's translation limits.",
  "1.2": "Language extensions shall not be used.",
  "1.3": "Undefined and critical unspecified behaviour shall not occur.",
  "2.1": "A project shall not contain unreachable code.",
  "2.2": "There shall be no dead code.",
  "2.3": "A project should not contain unused type declarations.",
  "2.4": "A project should not contain unused tag declarations.",
  "2.5": "A project should not contain unused macro declarations.",
  "2.6": "A function should not contain unused label declarations.",
  "2.7": "There should be no unused parameters in functions.",
};

// Chinese requirement lines the source page formats differently.
const ZH_ONLY = {
  "17.3": "函数不应被隐式声明。",
  "17.4": "非 void 返回类型函数的所有出口路径都应包含带表达式的显式 return 语句。",
  "19.1": "不得将对象赋值或复制到与其重叠的对象。",
};

const CJK = /[\u3000-\u9fff]/;

const source = process.argv[2];
if (!source) {
  console.error("usage: node tools/build-rule-texts.mjs <source.txt>");
  process.exit(1);
}
const raw = await readFile(source, "utf8");
const lines = raw.split(/\r?\n/);

const rules = new Map();
const heading = /^\s*-\s+\*\*Rule\s+(\d+)\.(\d+)\s*\((强制|建议)\)\s*[:：]\s*(.+?)\*\*\s*(.*)$/;

for (let i = 0; i < lines.length; i += 1) {
  const m = heading.exec(lines[i]);
  if (!m) continue;
  const id = `${m[1]}.${m[2]}`;
  const severity = m[3] === "强制" ? "Mandatory" : "Advisory";
  let title = m[4].trim();
  const tail = m[5].trim();
  // Chinese titles carry their requirement in the heading itself.
  let zh = "";
  if (CJK.test(title)) {
    zh = (tail || title).replace(/^[^：:]*[：:]\s*/, "").trim();
    title = ENGLISH_FOR_CHINESE_TITLE[id] ?? title;
  }
  if (!zh) {
    for (let j = i + 1; j < Math.min(i + 40, lines.length); j += 1) {
      const req = /^\s*-\s*要求\s*[:：]\s*(.+)$/.exec(lines[j]);
      if (req) {
        zh = req[1].trim();
        break;
      }
    }
  }
  rules.set(id, { severity, text: title, zh });
}

for (const [id, [severity, text, zh]] of Object.entries(ADDITIONAL)) {
  if (!rules.has(id)) rules.set(id, { severity, text, zh });
  else {
    const existing = rules.get(id);
    rules.set(id, { severity: existing.severity ?? severity, text: existing.text || text, zh: existing.zh || zh });
  }
}
for (const [id, zh] of Object.entries(ZH_ONLY)) {
  const entry = rules.get(id);
  if (entry) entry.zh = entry.zh || zh;
}

const sorted = new Map([...rules.entries()].sort((a, b) => {
  const [ax, ay] = a[0].split(".").map(Number);
  const [bx, by] = b[0].split(".").map(Number);
  return ax - bx || ay - by;
}));

const payload = {
  standard: "MISRA C:2012",
  source: "https://www.cnblogs.com/xywml/p/18742061",
  count: sorted.size,
  rules: Object.fromEntries(sorted),
};

await mkdir(path.join(PKG_DIR, "rules"), { recursive: true });
await writeFile(path.join(PKG_DIR, "rules", "misra-c2012.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

// cppcheck expects the "Appendix A / Summary of guidelines" layout:
//   Rule <n>.<m> <Severity>
//   The rule text...
const linesOut = ["Appendix A: Summary of guidelines", ""];
for (const [id, entry] of sorted) {
  linesOut.push(`Rule ${id} ${entry.severity}`);
  linesOut.push(entry.text);
  linesOut.push("");
}
await writeFile(path.join(PKG_DIR, "vendor", "cppcheck", "misra-rules.txt"), `${linesOut.join("\n")}\n`, "utf8");

console.log(`rules: ${sorted.size}`);
console.log(`with zh: ${[...sorted.values()].filter((r) => r.zh).length}`);
