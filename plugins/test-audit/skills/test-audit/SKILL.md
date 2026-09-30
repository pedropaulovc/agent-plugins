---
name: test-audit
description: Draft procedure for evidence-based test-value reviews, exhaustive report-only campaigns, and explicitly approved cleanup batches. Invoke when asked to audit or improve a test suite, not automatically during ordinary development.
disable-model-invocation: true
---

# Test audit — draft

This is a draft, original synthesis of the pinned OpenClaw and gstack sources in [the plugin README](../../README.md). It is not their runtime and needs no gstack installation. Repository policy, user scope, tool policy, and host safety override this procedure. In particular, a repository prohibition on source-text/implementation-coupled tests overrides the static-contract retention guidance below.

## 1. Establish authority and mode

Default to **report-only**. Explicit invocation does not authorize edits, deletions, process kills, cloud changes, or a suite run.

Choose and record one mode:

- **Authoring gate:** apply the four questions below to a proposed test and its production contract. No campaign-completion claim.
- **Focused report-only:** inspect the explicitly named scope, with out-of-scope paths recorded. Never present this as a full sweep.
- **Full report-only campaign:** inventory and inspect every first-party test and owned QA/proof case. No file/time quota, sample-only conclusion, or implicit changed-files fallback.
- **Approved cutover:** only after explicit authorization of named production-owner boundaries and the proposed changes. Approval of a report is not approval to delete. Audit agents remain read-only; a separately authorized implementer owns each cutover batch.

Identify the checkout, authority commit, branch/base if relevant, dirty-tree changes, repository instructions, platform, runner versions/configuration, CI workflows, and available discovery/analysis tools. Use native capabilities; do not assume Unix shell syntax or upstream OpenClaw commands. Preserve user changes. Record whether the authority is the commit alone or commit plus identified working-tree content. Obtain an external report directory from the request or select a sibling directory outside the checkout and record it. Do not put audit artifacts or caches in the audited checkout.

Keep skill publication separate from source cleanup: a draft plugin can be published under its repository's policy without authorizing changes to the audited product.

## 2. Safety gate — before import, collection, or execution

Read test configuration, setup/teardown, fixtures (including conftest), imported modules' initialization, and real collaborator defaults before any collection or execution. Review subprocesses, environment/path selection, process and service control, reboot/shutdown, cloud resources, filesystem writes, network calls, and COM/license/GUI actions. Collection itself can act on the host.

Discovery must be source-derived: tracked-file enumeration plus syntax-aware declarations and generated-case definitions, never importing tests to discover them. A safe parser must not execute the parsed source.

For host-acting paths, require a contained scratch environment, intercepted collaborators, and mocked/sandboxed positive controls demonstrating both that the dangerous boundary cannot reach the host and that the intended guarded path is actually exercised. A patched name is not proof if imports, constructors, reflection, defaults, or subprocesses bypass it. If containment cannot be established, do not run; record a hazard and `not-run` with the reason. Report-only modes never acquire SOLIDWORKS COM. Approved cutover may route COM proof through explicitly authorized repository-specific real-seat rules; otherwise keep that proof unresolved. Host-specific restrictions remain binding: for example, do not run SolidworksMCP-python tests on amet. Do not rerun a user-reported destructive failure to confirm it.

A full-suite baseline is optional when unsafe or unavailable. Static audit completion and runtime proof are separate statuses. `not-run`, timeout, environment failure, and skipped are not pass; a retained failing test may expose a product bug, not a reason to delete it to make the suite green.

All executions, including baselines and collection, must use owned scratch or demonstrably redirect every cache, bytecode, coverage and other write outside the audited checkout. Record the write-containment evidence. Read-only audit workers are parse-only: they never import, collect, or execute tests, even when a runner appears safe.

## 3. Build an exhaustive inventory

1. Enumerate tracked files and gitlinks at the authority revision using the version-control tooling. Inspect each gitlink separately; record its revision, first-/third-party ownership, and explicit exclusion or inclusion. Do not silently recurse into vendor suites or omit owned nested suites.
2. Combine test-runner configuration and naming patterns with root scripts, CI job matrices, release gates, smoke/QA/proof scripts, architecture checks, and documentation-defined validation. Patterns are leads, not the inventory definition. Save this raw candidate universe and discovery methods before exclusions, then record ownership and exact excluded paths. Full mode cannot exclude any first-party candidate and still claim complete coverage.
3. Parse every test declaration, subtest/case factory, and parameter definition from source, independent of its eventual verdict. Give each declaration a stable ID from authority path, qualified declaration and source location. Separately enumerate every statically expandable parameter row and record its definition/identity; unknown dynamic/generated expansion gets an unresolved ID and unknown count, never a guessed total. Ledger groups may cover multiple rows only with an explicit list of source row IDs and evidence that all share the verdict. Never change the source inventory granularity to match the verdict.
4. Assign each file exactly once to a production-owner lane, with its declarations, relevant owners, caller/callee and sibling tests, shared fixtures, history, and CI routes. Cross-boundary dependencies are references, not duplicate assignments. Serialize shared-harness edits in cutover mode.
5. Save the complete inventory before dispatch. Read-only workers return declaration-level evidence and explicit gaps; they may not modify source, import/collect/execute tests, narrow their lane, or label unfinished lanes complete. Tool limitations change the evidence method or produce an unresolved state, not a reduced scope.

Read every complete test body and its relevant fixture/setup/teardown, production owner, callers, callees, sibling coverage, history, and CI routing. Read dependency types/source when the assertion depends on their contract. Follow actual assertions, not test names. Mechanical matches only nominate review candidates; absent assertion keywords do not prove no assertions. Whitespace-normalized checksums prove only exact normalized copies, not semantic duplication.

## 4. Apply the value gate per declaration

Answer all four with source locations and an independent oracle:

1. **Contract:** what observable behavior or independent contract is protected, and for whom?
2. **Regression:** what credible production change would violate it, and which assertion would detect that change?
3. **Unique coverage:** why does stronger existing coverage not already detect that regression? Identify the other proof by exact test/node, not intuition.
4. **Seam:** is the seam a real production boundary or a test-only accommodation? What production/test-support code exists solely to keep this test alive?

For a bug regression, show failing-before/passing-after at the intended assertion when safe and feasible. A meaningful base-control run is optional supporting evidence, not a universal requirement that every useful test pass on the base. If unsafe or unavailable, label proof unperformed. A timeout, import failure, or missing dependency is not regression detection.

Examine the upstream weak-test categories:

- Vacuous truth, self-comparison, circular expected values derived from the same implementation, fixture/source inventories, and redundant helper replays.
- Private call-shape assertions, test-only seams/dead support, mocks that implement the desired result, or receipts/order/persistence supplied in advance instead of produced by the system.
- A declared capability instead of its exercised consequence, negative tests failing for the wrong reason, and names promising more than assertions establish.

None of these patterns alone is a deletion verdict. A mock at a real external boundary can be appropriate; verify the actual consumer-visible transition, result, error, or invariant.

Retain independent public/API, security, storage, migration, protocol, platform, release, architecture, and byte-level contracts, including observable ordering. Static form, slow runtime, and a keep-marker are neither proof of value nor reasons for deletion. Review keep-marker rationale like other evidence.

A static guard can be meaningful only if repository policy allows it and it protects an independent contract rather than today's implementation spelling. Require reach controls, nonempty matched populations, per-source checks, and consideration of behavior-preserving renames. If policy forbids such tests, propose an allowed behavior-level replacement or record a gap; do not use this skill to overrule the prohibition.

Record one verdict per declaration/parameter unit: **R** retain, **F** fix, **C** consolidate, **D** delete candidate, or **U** unresolved. `D` is a proposal in report-only mode, never permission. `F` identifies the missing/wrong oracle; `C` names a keeper and any coverage that must migrate first. Unsupported certainty becomes `U`.

## 5. Review coverage by contract, not only by file

Perform a second pass across each owner boundary. Build a contract-to-test map, name the keeper for each credible regression, and compare layers (unit, integration, end-to-end, static, release). Explain which oracle and failure sensitivity make one stronger; higher layer alone is not stronger. Preserve unique error, boundary, ordering, platform, and transition cases before removing duplicate paths. Record migration-before-deletion steps and all unresolved preservation gaps.

For apparently unused production or support code, establish complete reach beyond grep: package exports/entrypoints, registrations, dependency injection, CLI/CI routes, configuration strings, reflection, plugins, generated code, external consumers, and history. Record search scope, exclusions, hits, commands, and limitations. Python dynamic/reflection/generated paths require explicit evidence; a successful build alone cannot prove them unused. Never remove package-entrypoint/API code without explicit API-change authorization. Before any removal, run applicable build/typecheck/dead-code analysis in owned scratch after safety review; if no applicable tool exists, record the limitation and require equivalent reach evidence, not a fictional pass.

## 6. Produce artifacts and reconcile completion

Write timestamped Markdown and JSON in the external directory, using [REPORT.md](REPORT.md) as the report contract. Include the complete source-derived inventory and declaration ledger, not just candidates. Preserve partial reports for resumption with the same authority and scope; reconcile changed authority before continuing.

Mechanically reconcile these sets using source parsing and the saved ledger (no test imports):

- Raw candidate files = inventory files plus disjoint, evidenced excluded paths; full mode has no excluded first-party candidates. Inventory files = assigned files = completely read files, with no duplicate assignments. Use git-style forward-slash paths with case exactly as tracked at the authority.
- Fixed source declaration IDs = declarations represented by the ledger. Independently, every known source row ID is covered exactly once by ledger `covered_row_ids`; grouped verdicts do not collapse the source inventory. Unknown expansions stay named unresolved.
- Every ledger unit has all four nonempty, evidenced value-gate answers or explicit U linked to missing evidence. Every F/C/D points to a complete card; every retained contract and candidate links to a complete second-pass contract map. Mechanically list incomplete gates/cards, missing links, contract gaps and unsupported exclusions.
- Every lane has completed its second pass. Every execution has a unique ID, command, environment/write containment, result and artifact; ledger statuses are derived from linked execution IDs, not worker claims. Mutation proofs link separate observed intended-red and restored-green executions.

Report exact counts and set differences, including declarations, known parameter rows, grouped rows and unknown expansions. A `U` row is accounted for, not resolved. Apply the explicit completion predicates in REPORT.md: `coverage_complete` covers reconciled scope and evidence accounting, `review_complete` additionally requires complete gates/cards/contracts and no unresolved gaps, and `runtime_proof_complete` additionally requires a nonempty set of observed proofs, a passing executed baseline, and passing execution coverage of every ledger unit. Any not-run/skipped/timeout/environment-failure baseline or ledger unit makes runtime proof false. `full_sweep_complete` requires full-report-only mode plus coverage and resolved review; focused/authoring results never set it true. Give each unmet predicate a named reason. Unmeasured proposed LOC is `null`/unknown, never an estimate presented as measured; separate test and production/support LOC.

## 7. Approved cutover only

Before editing, require a complete retirement card for every candidate, explicit boundary authorization, and a migration plan. Incomplete cards are not ready. Apply one owned boundary batch; serialize shared harness changes. Migrate keeper coverage before deletion, CI inventories/routes and documentation ownership with the cutover, then remove obsolete code without compatibility shims unless separately required by policy.

Prove preservation in an owned scratch tree after the safety gate. Use a named production mutation and named keeper test: show the intended assertion fails with the mutation, restore files byte-for-byte, then show it passes. Save a mutation-proof object linking the separate red and green execution IDs, intended assertion evidence, mutation, and matching before/after restoration identities. Hangs/environment failures are not red proof. Do not mutate audited source in report-only mode. Do not retain permanent source-text/wiring/mock-echo tests that repository policy prohibits merely to demonstrate retention.

Obtain independent preservation review per boundary: the reviewer derives contracts afresh from production/callers and checks mutation-attributed keeper proof, rather than endorsing the deletion list. Reconcile a moved base using repository policy (do not mandate merge versus rebase), repeat affected evidence, and keep named gaps unresolved. Only authorized, fully evidenced batches are ready for their repository's normal publishing workflow.
