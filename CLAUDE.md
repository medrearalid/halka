## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

Rules:
- When graphify-out/graph.json exists, run `graphify query "<question>"` before your first grep, search or source-file read for a codebase question, and put this rule in every subagent prompt that explores code. Read raw files only for lines the graph or an earlier read already located. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- The graph auto-rebuilds after every Edit/Write (async PostToolUse hook) and on commit/checkout/merge (git hooks); run `graphify update .` manually only after changes made outside those paths.
- A committed graphify-out/graph.json is rewritten whole on every build, so a large diff to it in a pull request is expected. Do not flag it as churn or suggest skipping the graph rebuild or its hooks.

## Collaboration

Owner, Claude and ChatGPT work in the same checkout; ChatGPT commits its own work. Follow the "Birlikte çalışma" rules in AGENTS.md:
- Stage only files you changed, by path; never `git add -A`, `git add .` or `git commit -a`. Leave other agents' uncommitted changes alone.
- A commit is the owner's approval (ChatGPT commits only when the owner asks). Releases (version bump, tag, push) are Claude's job: everything committed on main may ship, uncommitted work never does. No need to ask before tagging.
