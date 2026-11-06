# @local/dsh-misra-checker

MISRA C checker plugin for DeepSeek Harness — **portable, self-contained folder**.

- Adds a "MISRA C check" panel under the conversation composer: pick (Browse…) or
  enter a project directory and click the button to run a check.
- Engine: the bundled `vendor/cppcheck/cppcheck.exe` (v2.22, `--addon=misra`,
  `--enable=style`) runs out of the box; on machines without it the plugin falls
  back to a built-in heuristic scan over a small subset of MISRA C:2012 rules
  (7.1, 13.4, 15.1, 19.2, 20.10, 21.3).
- Also registers the `/misra [path]` slash command, which defaults to the session cwd.
- The misra addon needs **Python 3** on PATH for some rules to be reported.

## Take it with you

The whole folder is relocatable — cppcheck, the MISRA addon, and all Node
dependencies (`node_modules/`) live inside it, and the cppcheck path is resolved
**relative to this folder**, so no config edits are needed after moving it:

1. Copy the `dsh-misra-checker` folder anywhere (any drive, any machine).
2. In DeepSeek Harness: Settings → Plugins → Install bundle → select the folder
   (or ask the agent to run `plugin_manager install_bundle` with its path).
3. Restart/refresh; the panel appears under the composer.

## Default target

The panel prefills the directory with **the current project** — the working
directory of the live session — narrowed by the `subdir` config, so a whole
project tree is never scanned. The `Browse…` button overrides it for one run.

## Config

| key | default | meaning |
| --- | --- | --- |
| `root` | `""` | explicit project root; overrides the session directory |
| `subdir` | `""` | folder below the project root that holds the code (e.g. `components/Mcal/Eth`) |
| `cppcheck` | `"vendor/cppcheck/cppcheck.exe"` | absolute path, path relative to this plugin folder, or a bare command name on PATH |
| `cppcheckArgs` | `""` | extra cppcheck arguments (e.g. `--std=c11`) |
| `defines` | `[]` | preprocessor defines for cppcheck (e.g. `DISABLE_MCAL_INTERMODULE_ASR_CHECK`) |
| `includes` | `[]` | include directories, absolute or relative to the project root |
| `exclude` | `.git, node_modules, build, dist, out, .dsh, .agents` | dirs skipped by the built-in scanner |
| `maxFindings` | `500` | cap on reported findings |

### AUTOSAR / MCAL projects

Generated headers abort preprocessing when the inter-module version check
fails, which makes cppcheck report nothing. Define
`DISABLE_MCAL_INTERMODULE_ASR_CHECK` and add the shared header folder to
`includes` (for example `components/Mcal/Common`, where `Eth_GeneralTypes.h`
lives) — the shipped `cordis.patch.yml` shows this for the Eth module.

The built-in scanner is only a fallback: it approximates a few textually
detectable rules. Real coverage comes from the bundled cppcheck.
