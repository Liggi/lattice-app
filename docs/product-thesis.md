# Lattice Orchestrator — Product Thesis

## The Problem

AI assistants are stateless and general-purpose. Every session starts from zero. Complex domains — with rich state, specialized tools, and accumulated context — get shallow treatment because the assistant has no persistent understanding of the domain it's operating in.

## The Thesis

Lattice is a local-first platform for creating, running, and orchestrating persistent AI agents. A workspace is a long-lived, domain-specialized context with its own knowledge, memory, defaults, and analytical capabilities. It is not a filesystem boundary: sessions start in one directory and may work across the user's environment. Integrations and external accounts are installed globally, while workspaces bind useful resource defaults such as a Linear team, Slack channel, or repository set. The platform handles process lifecycle, session persistence, permission delivery, real-time insights, and streaming UI so that creating a new domain agent is a configuration task rather than an engineering project.

The bet: as agents gain autonomy and accumulate context over time, a network of specialized agents becomes more valuable than any single general-purpose assistant.

## What Makes It Distinct

- **Local-first** — your agents run on your machine, against your files, your tools, your MCP servers. State never leaves unless you choose cloud access.
- **Orchestration, not just chat** — process supervision for long-running work, real-time insights, activity receipts, and cross-session coordination.
- **The factory** — workspace + plugin system means a new domain agent inherits permissions, streaming, visualization, persistence, and global integrations, then defines what is unique: domain knowledge, behavior, and resource bindings.
- **Progressive autonomy** — agents start collaborative, can be given scheduled autonomous modes, and eventually act proactively within their permission boundaries.

## Roadmap

### Phase 1 — Lower the Factory Floor
Creating a new workspace currently requires plugin code. Goal: define a CLAUDE.md + tool config + optional visualization templates, and Lattice does the rest. A "create workspace" flow in the UI. This is the unlock that makes Lattice a platform rather than a framework.

### Phase 2 — Autonomous Mode as a Platform Capability
Generalize scheduled runs, autonomous preambles, and the collaborative/autonomous toggle as platform-level features. Any workspace should be able to run on a schedule and report findings, with cross-referencing discipline built in.

### Phase 3 — Workspace Memory That Compounds
Session reviews and recommendations already exist. Close the loop: insights from past sessions feed into workspace configuration. An agent that's been running for three months should be measurably better than a fresh instance of the same workspace.

### Phase 4 — Cross-session orchestration
Route work to the right workspace, start agents on the user's behalf, and surface patterns across sessions without coupling that capability to a named legacy component.

### Phase 5 — Distributable Workspaces
A workspace definition (CLAUDE.md + tool config + templates) becomes a shareable package. Someone installs a "Stellaris analyst" workspace and gets the domain model without building it. Plugin registry or marketplace.
