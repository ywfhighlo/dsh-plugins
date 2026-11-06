# dsh-plugins

Plugins for [DeepSeek Harness](https://github.com/deepseek-ai/DeepSeek-Harness) (DSH).

Each plugin lives in its own folder and is installed as a bundle. Copy any plugin
folder to another machine and install it there — no path or config edits needed.

## Plugins

| Plugin | Description |
| --- | --- |
| [`dsh-misra-checker`](dsh-misra-checker/) | MISRA C checker. A panel under the conversation composer lets you pick a project directory and run a check with the bundled cppcheck (MISRA addon). Adds the `/misra [path]` slash command. |

## Install a plugin

Copy the plugin folder, then in DeepSeek Harness use **Settings → Plugins →
Install bundle** and select the folder, or ask the agent to install it:

```
plugin_manager install_bundle  <absolute path to the plugin folder>
```

Refresh the page afterwards; the plugin's UI appears in the composer area.

## Notes

- Node dependencies are not committed; a plugin folder that carries `node_modules`
  (or a `pnpm install` run in it) is ready to use.
- `dsh-misra-checker/vendor/cppcheck` holds a slimmed cppcheck CLI (v2.22, with
  `addons/misra.py`); the MISRA addon needs Python 3 on PATH.
