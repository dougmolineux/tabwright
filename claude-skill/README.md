# Tabwright skill for Claude Code

[`SKILL.md`](SKILL.md) teaches Claude Code how to use Tabwright's `browser_*` tools well: the snapshot → ref → act → verify loop, filling forms (comboboxes, uploads, multi-page flows), the approval gate, and what to do with each error code. The MCP server's built-in instructions are a few lines; this fills in the rest.

It's optional. The tools work without it, but Claude makes fewer mistakes with it.

## Install

Link this directory into your personal skills folder, so it stays up to date with the repo:

```sh
mkdir -p ~/.claude/skills
ln -s "$(pwd)/claude-skill" ~/.claude/skills/tabwright
```

Or copy it if you'd rather pin a version:

```sh
cp -R claude-skill ~/.claude/skills/tabwright
```

Restart Claude Code (or start a new session). The skill loads by itself when you ask Claude to do something in your Firefox, or you can invoke it with `/tabwright`.

To remove it: `rm ~/.claude/skills/tabwright`.
