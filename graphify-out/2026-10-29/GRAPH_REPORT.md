# Graph Report - AGENTMANAGER  (2026-10-29)

## Corpus Check
- 4 files · ~7,562 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 77 nodes · 118 edges · 9 communities (8 shown, 1 thin omitted)
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 6 edges (avg confidence: 0.5)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- server.js
- getTranscriptDiff
- AgentManager context handoff
- buildClaudeAgent
- finalizeAgent
- listClaudeAgents
- ADAPTERS
- parseClaudeContent
- parseCodexContent

## God Nodes (most connected - your core abstractions)
1. `buildClaudeAgent()` - 7 edges
2. `buildCodexAgent()` - 7 edges
3. `finalizeAgent()` - 6 edges
4. `AgentManager context handoff` - 6 edges
5. `main()` - 5 edges
6. `getTranscriptDiff()` - 5 edges
7. `classifyTool()` - 4 edges
8. `getListContent()` - 4 edges
9. `getAgents()` - 4 edges
10. `extractCodexEdits()` - 4 edges

## Surprising Connections (you probably didn't know these)
- `buildClaudeAgent()` --indirect_call--> `parseClaudeContent()`  [INFERRED]
  server.js → server.js  _Bridges community 7 → community 3_

## Import Cycles
- None detected.

## Communities (9 total, 1 thin omitted)

### Community 0 - "server.js"
Cohesion: 0.11
Nodes (16): AGENT_MODES_PATH, agentModes, APPROVAL_HOOK_PATH, CLAUDE_PROJECTS_DIR, CODEX_SESSIONS_DIR, crypto, { execFileSync, spawn }, fs (+8 more)

### Community 1 - "getTranscriptDiff"
Cohesion: 0.22
Nodes (9): buildSyntheticDiffText(), extractClaudeEdits(), extractCodexEdits(), getDiff(), getTranscriptDiff(), linesOf(), parseApplyPatchBody(), runGit() (+1 more)

### Community 2 - "AgentManager context handoff"
Cohesion: 0.29
Nodes (6): AgentManager context handoff, Current design direction, Current implementation, Product goal, Project selection and idle behavior, Working conventions

### Community 3 - "buildClaudeAgent"
Cohesion: 0.21
Nodes (13): buildClaudeAgent(), buildCodexAgent(), escapeHtml(), finalizeAgent(), getListContent(), listClaudeAgents(), listCodexAgents(), readBoundedText() (+5 more)

### Community 4 - "finalizeAgent"
Cohesion: 0.25
Nodes (10): fs, http, httpJson(), main(), os, passThroughToVibeIsland(), path, readStdin() (+2 more)

### Community 5 - "listClaudeAgents"
Cohesion: 0.50
Nodes (4): autoDecide(), classifyTool(), EDIT_TOOL_NAMES, READONLY_TOOL_NAMES

### Community 6 - "ADAPTERS"
Cohesion: 0.50
Nodes (4): ADAPTERS, findPendingApproval(), getAgentMode(), getAgents()

### Community 7 - "parseClaudeContent"
Cohesion: 0.25
Nodes (8): extractClaudeMessages(), extractClaudeText(), extractCodexMessages(), extractCodexText(), getTranscriptMessages(), parseClaudeContent(), parseCodexContent(), readTranscriptTail()

## Knowledge Gaps
- **26 isolated node(s):** `http`, `fs`, `os`, `path`, `{ spawnSync }` (+21 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **1 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `buildClaudeAgent()` connect `buildClaudeAgent` to `server.js`, `parseClaudeContent`?**
  _High betweenness centrality (0.002) - this node is a cross-community bridge._
- **Why does `buildCodexAgent()` connect `buildClaudeAgent` to `server.js`, `parseClaudeContent`?**
  _High betweenness centrality (0.002) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `buildClaudeAgent()` (e.g. with `parseClaudeContent()` and `listClaudeAgents()`) actually correct?**
  _`buildClaudeAgent()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `buildCodexAgent()` (e.g. with `parseCodexContent()` and `listCodexAgents()`) actually correct?**
  _`buildCodexAgent()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `http`, `fs`, `os` to the rest of the system?**
  _26 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.10526315789473684 - nodes in this community are weakly interconnected._