# 24/7 AI Assitant inspired by the movie Her

Our missiion is to create a proactive 24/7 AI assistant that feels like a real teammate, able to remember across projects and tasks, with persistent task management and memory. 

As a CEO/Founder my day is very busy with work and life, I need an assistant that can;
- Manage coding lifecycle from start to finish (initiation to PR)
- Research online and create presentations
- Communicate across every channel e.g. Whatsapp, Slack, Voice, Linear, Email

As technology advances tools, resources will change, our workflow and operating system is the thing that is set, with everything else being modular. 

"The method is the constant. Everything else is a variable."

# Operator

The Operator is a single intelligent orchestrator that dynamically composes everything it needs per task from a unified registry. Not just tools — but tools, resources, skills, context, and predefined agents. 
- A tool is an executable function. 
- A resource is an LLM paired with a harness e.g. codex, claude code, manus
- A skill is a reusable instruction set: a prompt template, guardrails, and expected output shape that encodes how to approach a class of problem. 

Context is injected dynamically; codebase knowledge, tenant data, conversation history, prior outputs so the agent reasons with the right information, not everything. And when a particular composition of tool + resource + skill + context gets used repeatedly — say, "review this PR against our quality standards" — it gets saved as a predefined agent: a named, versioned, reusable flow that the Operator can invoke as a single unit rather than recomposing from scratch every time.

The power is in the composition, not the components. The Operator receives a task, reasons about what's needed, pulls the right pieces from the registry, and assembles them on the fly. 
- Simple tasks get a tool call and a fast model. 
- Complex tasks get a skilled agent with heavy context and a reasoning-class LLM. 
- Repeated workflows become predefined agents that execute predictably without re-discovery overhead. 

Nothing is hardcoded — the registry is the architecture. 
- New capability = register it. 
- New workflow pattern emerging = save it as a predefined agent. 

The Operator never changes; the registry grows. 

One agent to rule them all, infinite composability, zero orchestration framework tax.

# The Engine

A universal reasoning loop with a pluggable capability layer. Here's the breakdown:

The Engine is the immutable method — it never changes regardless of domain.

**The core insight:** Most frameworks are tool-dependent. Xena is tool-agnostic. The method is the constant; everything else is a swappable module.

The flow is: Understand the problem → Prove your understanding (not assume) → Plan the approach → hit the Confidence Gate. If confidence is high enough, you proceed to Execute → Validate (with weighted validation, so not all checks are equal) → Learn from the outcome → Adapt for next time. 

If confidence is not high enough at the gate, you loop back into Discovery — gather more info, re-understand, re-prove, re-plan. The whole thing iterates. No premature execution.

**Three layers:**

**1. The Engine (immutable)**
Understand → Prove → Plan → Execute → Validate → Learn → Adapt

This never changes. This is the OS.

**2. The Confidence Gate (the inner loop)**
Before you ever hit "Plan," you're running a pre-flight check:

*"Do I have enough confidence to proceed?"*
- **YES** → move to Plan
- **NO** → *"What needs to be true for me to have confidence?"* → Discovery → loop back to Understand/Prove

This is the bit most people skip entirely. They jump from "I think I understand" straight to hammering.

**3. The Registry (modular, hot-swappable)**
- **Tools** — the things you use to act (ChatGPT, Google, a consultant, a book, a colleague)
- **Resources** — the things you draw from (websites, studies, memories, experience)
- **Library** — accumulated skills, knowledge, patterns from previous loops

Tools and resources are versioned. Encyclopaedia v1 → Google v2 → ChatGPT v3. The registry updates. The engine doesn't.

**The weighted scoring** threads through everything:
- Confidence rating at the gate (am I ready to plan?)
- Validation scoring post-execution (did it actually work?)
- Learning weight (how much did this loop teach me?)
- Each feeds back into the Library, making the next loop faster and sharper


**NOTHING HARDCODED**

For ANY problem from coding to booking a table at the restaurant via email. The Engine framework is the same.

# Universal Tool System

A registry of tools;
    - for Xena to use for communication and management
    - that agents can use

Xena tools might be create_task, task_status, search_memory etc
Agent tool might be fetch_web, write, bash etc

Xena can create new tools, not directly, but would create a task for an agent to create the tools, agents can be dynamic OR if used repeatedly become specific agents with memory, skills, tools. 

# Universal Skill System

1 registry
- Xena has skills for Whatsapp, Coding, etc
- Agents have skills for coding, review etc

Xena can create new skills for agents or for her.

# Agents

1 registry
- Repeated use cases and/or "out of the box" e.g. Codex, Claude, Manus etc
