# Graph Report - AGENTMANAGER  (2026-11-04)

## Corpus Check
- 5 files · ~16,971 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 100 nodes · 160 edges · 12 communities (10 shown, 2 thin omitted)
- Extraction: 96% EXTRACTED · 4% INFERRED · 0% AMBIGUOUS · INFERRED: 7 edges (avg confidence: 0.5)
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
- readTranscriptPage
- getAgents
- drainPromptQueue

## God Nodes (most connected - your core abstractions)
1. `canonicalPath()` - 7 edges
2. `finalizeAgent()` - 7 edges
3. `buildClaudeAgent()` - 7 edges
4. `buildCodexAgent()` - 7 edges
5. `parseCodexContent()` - 6 edges
6. `AgentManager context handoff` - 6 edges
7. `main()` - 5 edges
8. `parseClaudeContent()` - 5 edges
9. `getAgents()` - 5 edges
10. `extractCodexEdits()` - 5 edges

## Surprising Connections (you probably didn't know these)
- `buildClaudeAgent()` --indirect_call--> `parseClaudeContent()`  [INFERRED]
  server.js → server.js  _Bridges community 7 → community 3_
- `buildCodexAgent()` --indirect_call--> `parseCodexContent()`  [INFERRED]
  server.js → server.js  _Bridges community 6 → community 3_
- `parseClaudeContent()` --calls--> `canonicalPath()`  [EXTRACTED]
  server.js → server.js  _Bridges community 6 → community 7_

## Import Cycles
- None detected.

## Communities (12 total, 2 thin omitted)

### Community 0 - "server.js"
Cohesion: 0.07
Nodes (22): AGENT_MODES_PATH, agentModes, APPROVAL_HOOK_PATH, changedFilesCache, changedFilesInFlight, CLAUDE_PROJECTS_DIR, CODEX_SESSIONS_DIR, crypto (+14 more)

### Community 1 - "getTranscriptDiff"
Cohesion: 0.29
Nodes (8): extractClaudeEdits(), extractCodexEdits(), getChangedFiles(), parseApplyPatchBody(), scanChangedFiles(), shellOutputPaths(), { StringDecoder }, unescapeJsString()

### Community 2 - "AgentManager context handoff"
Cohesion: 0.29
Nodes (6): AgentManager context handoff, Chat discovery and filtering, Current design direction, Current implementation, Product goal, Working conventions

### Community 3 - "buildClaudeAgent"
Cohesion: 0.20
Nodes (14): buildClaudeAgent(), buildCodexAgent(), escapeHtml(), finalizeAgent(), getListContent(), listClaudeAgents(), listCodexAgents(), readBoundedText() (+6 more)

### Community 4 - "finalizeAgent"
Cohesion: 0.25
Nodes (10): fs, http, httpJson(), main(), os, passThroughToVibeIsland(), path, readStdin() (+2 more)

### Community 5 - "listClaudeAgents"
Cohesion: 0.50
Nodes (4): autoDecide(), classifyTool(), EDIT_TOOL_NAMES, READONLY_TOOL_NAMES

### Community 6 - "ADAPTERS"
Cohesion: 0.16
Nodes (15): ADAPTERS, canonicalPath(), codexPolicyToDetected(), collectToolWorkdirs(), displayToolName(), extractClaudeMessages(), extractCodexMessages(), extractCodexText() (+7 more)

### Community 7 - "parseClaudeContent"
Cohesion: 0.67
Nodes (3): claudeModeToDetected(), extractClaudeText(), parseClaudeContent()

### Community 9 - "readTranscriptPage"
Cohesion: 0.67
Nodes (3): agentTypeForFile(), getTranscriptMessages(), readTranscriptPage()

### Community 11 - "drainPromptQueue"
Cohesion: 0.50
Nodes (4): codexPermissionArgs(), drainPromptQueue(), enqueuePromptForAgent(), sendPromptToAgent()

## Knowledge Gaps
- **32 isolated node(s):** `http`, `fs`, `os`, `path`, `{ spawnSync }` (+27 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **2 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `finalizeAgent()` connect `buildClaudeAgent` to `server.js`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **Why does `canonicalPath()` connect `ADAPTERS` to `server.js`, `parseClaudeContent`?**
  _High betweenness centrality (0.001) - this node is a cross-community bridge._
- **Are the 2 inferred relationships involving `buildClaudeAgent()` (e.g. with `parseClaudeContent()` and `listClaudeAgents()`) actually correct?**
  _`buildClaudeAgent()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **Are the 2 inferred relationships involving `buildCodexAgent()` (e.g. with `parseCodexContent()` and `listCodexAgents()`) actually correct?**
  _`buildCodexAgent()` has 2 INFERRED edges - model-reasoned connections that need verification._
- **What connects `http`, `fs`, `os` to the rest of the system?**
  _32 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `server.js` be split into smaller, more focused modules?**
  _Cohesion score 0.07407407407407407 - nodes in this community are weakly interconnected._