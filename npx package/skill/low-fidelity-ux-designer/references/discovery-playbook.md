# Discovery Playbook

## Contents

- Conversation rhythm
- Decision gates
- Question bank
- Assumption handling
- Existing-wireframe critique

## Conversation rhythm

Use this loop:

1. Reflect the latest answer in one sentence.
2. Record the decision or assumption silently in the working brief.
3. Name a tradeoff only when it matters.
4. Ask the single highest-information question.
5. At a gate, summarize decisions and show the next artifact.

Avoid survey-like interviews. If the answer unlocks useful work, draft immediately and let the artifact provoke better feedback.

## Decision gates

### Outcome gate

Required:

- primary user, not “everyone”;
- situation or trigger;
- critical job;
- observable success.

Useful question: “Who must succeed first, and what should they be able to finish in this experience?”

If unclear, offer role-and-task combinations based on known context rather than abstract personas.

### Scope gate

Required:

- must-have capability;
- explicit later/out-of-scope list;
- platform and key constraints;
- risk-bearing states.

Useful question: “For the first test, which outcome is essential: A, B, or C? I recommend A because it directly tests the critical task.”

### Flow gate

Required:

- entry;
- happy path;
- meaningful decisions;
- recovery/back/cancel;
- success confirmation.

Useful question: “At this decision point, should the product guide users to one recommended choice or let them compare freely?”

### Structure gate

Required:

- one job per screen/state;
- one obvious primary action;
- essential content;
- system feedback;
- route to next and previous states.

Useful question: “What does the user need to know before they can confidently take the primary action?”

### Validation gate

Required:

- realistic scenario walkthrough;
- blocking findings resolved;
- assumptions clearly separated from facts;
- remaining questions assigned to later validation.

Useful question: “Using this scenario, where would the user hesitate or lack the information to continue?”

## Question bank

Select, do not exhaust, these questions.

### Problem and user

- What event makes the user open this product now?
- What are they doing today instead?
- What makes the current approach costly, slow, or risky?
- Who is the primary actor? Who only reviews, approves, or receives the result?

### Success

- What must be true when the user leaves?
- What observable event would show the design worked?
- Is speed, confidence, accuracy, learning, or conversion the priority?

### Content and data

- Which information is required to decide?
- What information may be missing, stale, sensitive, or uncertain?
- Is content user-created, system-generated, or curated?

### Interaction

- Which actions are irreversible or costly?
- What must happen when the system is slow, empty, offline, or fails?
- Can the user safely leave and resume?
- Which permissions, roles, or authentication boundaries change the flow?

### Platform and inclusion

- What is the primary device and usage context?
- Must keyboard, screen reader, zoom, touch, or one-handed use shape the structure?
- Are there language, reading-level, privacy, or regulatory constraints?

## Assumption handling

Use three labels:

- **Confirmed**: explicitly supplied or approved by the user.
- **Assumed for draft**: reversible choice made to keep moving.
- **Needs evidence**: claim requiring research, analytics, or user testing.

Never transform an assumption into a confirmed fact through repetition. When multiple assumptions interact, surface them before detailed wireframing.

## Existing-wireframe critique

Request the artifact or inspect local files when available. Ask for the intended critical task if it cannot be inferred. Then:

1. trace the critical path without judging aesthetics;
2. inventory screens and states;
3. identify competing actions and missing information;
4. check feedback, prevention, recovery, accessibility, and responsive behavior;
5. rank findings by effect on task completion;
6. propose the smallest structural revision;
7. rerun the same scenario on the revision.

Do not rewrite the design solely to express personal taste.
