# Audit artifact contract

Use a Windows-safe UTC filename stem such as `20260930T174712Z-test-audit.md` and `20260930T174712Z-test-audit.json` in the selected external directory; keep the ISO 8601 timestamp inside JSON, not as a literal filename. UTF-8 JSON must contain the fields below; use empty arrays for observed empty sets and `null` for unknown values. Never omit unknown evidence to imply success. Reconciled paths are authority-relative, git-style forward-slash and case-exact as tracked at the authority commit; never case-fold them. External execution/artifact paths are explicitly marked external. Evidence references identify path, revision, line/node, or captured command artifact. This is a report format, not executable discovery code.

## JSON structure (schema version 1)

| Field | Type and contents |
|---|---|
| `schema_version` | Integer `1` |
| `maturity` | String `draft` |
| `timestamp` | ISO 8601 string with timezone |
| `authority` | Object: `checkout`, `commit`, `branch`, `base`, `working_tree_changes` (array of path/content identities), `policies` (evidence array) |
| `scope` | Object: `mode` (`authoring-gate`, `focused-report-only`, `full-report-only`, `approved-cutover`), `included_roots` (array), `report_directory`, `authorization` (evidence or null) |
| `runner` | Object: `platform`, `tools` (name/version/config evidence array), `ci_routes` (evidence array) |
| `baseline` | Execution IDs array referencing `executions`; if none executed, reference one explicit `not-run` record with reason |
| `candidates` | Raw pre-exclusion file records array: `path`, `ownership`, `discovery_evidence`; discovery method combines tracked paths, runner config, naming leads, CI/root/gate routes and separately inspected gitlinks |
| `source_declarations` | Fixed source-derived array: `id`, `path`, `qualified_name`, `location`, `parameter_definitions`, `known_row_ids`, `unknown_expansion_ids`, `discovery_evidence`; independent of verdict/grouping |
| `source_rows` | Statically expanded rows array: `id`, `declaration_id`, `definition_location`, `source_identity`, `expansion_evidence` |
| `inventory` | File records array: `path`, `kind` (test/QA/proof/gate), `owner_boundary`, `lane`, `declaration_ids`, `discovery_evidence`, `read_evidence`, `ci_routes` |
| `gitlinks` | Array: `path`, `revision`, `ownership`, `disposition`, `evidence` |
| `exclusions` | Array: `path_or_scope`, `expanded_paths` (exact candidate paths), `ownership`, `reason`, `evidence`; full mode with any excluded first-party candidate cannot be coverage-complete |
| `ledger` | Declaration records described below |
| `contracts` | Array: `id`, `owner_boundary`, `observable_contract`, `independent_oracle`, `regression`, `test_ids`, `keeper_ids`, `layer_comparison`, `migration_plan`, `evidence`, `gaps` |
| `retirement_cards` | Cards described below; includes fix/consolidate proposals, not just deletions |
| `retained` | Retained declaration IDs; details remain in ledger |
| `static_contracts` | Array: `declaration_id`, `contract_id`, `policy_permission`, `reach_control`, `nonempty_control`, `per_source_control`, `rename_analysis`, `evidence` |
| `hazards` | Array: `boundary`, `action`, `import_or_runtime`, `containment`, `positive_control`, `authorization`, `status`, `evidence` |
| `unresolved` | Array: `id`, `affected_files_or_declarations`, `question`, `attempts`, `missing_evidence`, `next_safe_action` |
| `executions` | Execution records array |
| `mutation_proofs` | Objects linking separate red and restored-green executions as specified below |
| `proposed_loc` | Object: `test`, `production`, `test_support` (each nonnegative integer or null), `measurement_method`, `evidence`; label proposed, never realized in report-only mode |
| `reconciliation` | Object described below |
| `sources` | Array: repository URL, pinned commit and source paths, as attributed in the plugin README |

### Declaration record

Required fields: `id`, `source_declaration_id`, `covered_row_ids`, `path`, `qualified_name`, `location` (source line range), `parameter_unit` (group/row definition, row count or null, expansion evidence), `owner_boundary`, `verdict` (`R`, `F`, `C`, `D`, `U`), `contract_ids`, `value_gate` (nonempty answers/evidence for contract, regression, unique coverage, seam or explicit U links), `assertion_analysis`, `related_tests`, `owner_caller_callee_evidence`, `history_evidence`, `ci_evidence`, `execution_ids`, `execution_status` (derived from the linked executions using their status enum), `card_id` (null only for R/U), and `unresolved_ids`.

For a nonparameterized test set `parameter_unit` to null and `covered_row_ids` to an empty array. Stable source IDs include the authority path, qualified declaration and source location; row IDs add the source-derived row identity. The fixed declaration/row definitions cannot change with grouping or verdict. Ledger groups explicitly list all covered row IDs and explain why the same verdict applies to each; every known row must be covered exactly once. Unknown generated expansion must link to an unresolved item. Execution status is `not-run` when there are no execution IDs; pass/fail claims need observed records covering that unit/its rows, not an inferred aggregate success. If referenced results differ, preserve all individual statuses. An observed assertion `fail` takes summary precedence over `not-run` or `skipped`; retain `environment-failure` and `timeout` separately as execution hazards, never as assertion failures. Without an assertion failure, summarize environment-failure, timeout, not-run, skipped, pass in descending precedence. Any incomplete execution still blocks runtime-proof completion regardless of the summary.

Derive ledger `execution_status` from ordinary validation executions only; mutation-red executions are referenced by `mutation_proofs` and do not count as ordinary failing validation or passing coverage. Restored-green execution may count as validation when it covers the same ledger unit and source rows. Distinguish execution `purpose` accordingly (`baseline`, `validation`, `mutation-red`, `restored-green`, or another explicitly explained purpose).

### Retirement/fix/consolidation card

Required fields: `id`, `declaration_ids`, `exact_nodes_and_locations`, `detects`, `owner_boundary`, `caller_search` (commands/tool query, scope, exclusions, hits, reach limitations), `stronger_proof_or_absent_contract` (named keeper/oracle or evidence of no actual contract), `history`, `unlocked_removals` (production and test-support separately), `migration_before_deletion`, `risk`, `validation_commands`, `proof_status`, `proof_artifacts`, `authorization`, and `ready` (boolean).

`ready` is false if any evidence is incomplete; in report-only mode it is not authorization even if evidence is complete. Evidence of a stronger test must identify the regression it catches, not just a passing test result.

### Execution record

Required fields: unique `id`, `covered_ledger_ids` and `covered_row_ids`, `purpose`, `command`, `cwd`, `authority`, `environment_and_containment` (including scratch location or evidence all writes/caches/bytecode/coverage are redirected outside the audited checkout), `status` (`pass`, `fail`, `not-run`, `skipped`, `timeout`, `environment-failure`), `reason`, and `artifact`. Observed pass/fail records require captured result artifacts; not-run has no observed result and states why. Only an observed intended assertion failure counts as mutation/regression detection; unrelated failures are separate.

Each mutation proof has unique `id`, `mutation`, `caught_by_test`, `intended_assertion`, `intended_assertion_failure_evidence`, `red_execution_id`, `green_execution_id`, `restoration_identity_before`, and `restoration_identity_after`. The red execution must be an observed intended assertion failure under the mutation; green must be an observed pass after restoration, with matching byte identities and separate artifacts. Both refer to the same keeper/authority and contained scratch environment. One failing record alone is not preservation proof.

### Reconciliation object

Required fields:

- `candidate_files`, `excluded_paths`, `inventory_files`, `assigned_files`, `read_files`, `source_declaration_ids`, `source_row_ids`, `represented_declaration_ids`, `covered_row_ids`: complete arrays, not just totals. Candidate universe is saved before exclusions; source declaration/row universes are fixed before verdicts.
- `candidate_accounting_gaps`, `candidate_accounting_overlap`, `excluded_first_party_paths`, `unsupported_exclusions`, `duplicate_assignments`, `duplicate_ledger_ids`, `unassigned_files`, `unread_files`, `missing_declaration_ids`, `extra_declaration_ids`, `uncovered_row_ids`, `extra_row_ids`, `multiply_covered_row_ids`: mechanically derived differences.
- `incomplete_value_gate_ids`, `unlinked_unresolved_ids`, `missing_card_ids`, `incomplete_card_ids`, `missing_contract_links`, `incomplete_contract_ids`, `contract_gap_ids`, `rows_claiming_execution_without_record`, `invalid_execution_ids`, `incomplete_execution_records`, `invalid_mutation_proof_ids`: explicit evidence/reference checks, not just missing verdict letters.
- `counts`: candidate/excluded/inventory/assigned/read files, source declarations, known source rows, grouped ledger units, grouped covered rows, unknown expansion definitions, ledger units and R/F/C/D/U counts.
- `second_pass_boundaries`, `pending_second_pass_boundaries`, `unresolved_ids`, `unknown_expansion_ids`, `unproved_required_executions`: identify all gaps; define required proof obligations by boundary and ledger unit with evidence, never an implicitly empty set.
- `method` and `artifact`: exact reconciler query/script and observed result; parser/discovery must not import tests.
- `coverage_complete`: true only if candidate files equal the disjoint union of inventory and evidenced exclusions; no full-mode first-party exclusion; inventory/assigned/read sets equal without duplicates; fixed source declarations are all represented and known rows exactly covered; second passes complete; each row has complete four-question evidence or linked explicit U; every F/C/D has a card reference; retained/candidate contract links exist; and execution claims are backed by valid records. Any listed accounting/reference failure makes it false.
- `review_complete`: requires coverage plus no U/unknown expansion/unresolved IDs, no incomplete value gates/cards/contracts or contract gaps, all exclusion evidence complete, and all necessary proof obligations identified. A card awaiting proof is incomplete, not silently ready.
- `runtime_proof_complete`: requires coverage and resolved review, a nonempty set of observed proof executions, a passing executed baseline, every ledger unit/known row covered by observed passing validation executions, and every required proof satisfied (including valid red/green mutation pairs where required). Any not-run/skipped/timeout/environment-failure baseline or ledger unit makes this false. Red mutation runs are expected failures, not substitutes for restored-green validation. Zero executions never yields true.
- `full_sweep_complete`: true only in `full-report-only` mode when coverage and review are complete; it does not imply runtime proof. Focused/authoring/cutover reports leave it false.
- `completion_reasons`: names the mode/scope and each failed predicate separately. Coverage may account for U but review cannot claim it resolved; static review is not runtime validation.

## Markdown view

Render authority/scope/policies, draft/report-only status, runner/baseline, safety hazards, completion booleans with differences and counts, inventory/ledger, R/F/C/D candidates and cards, retained/static contracts, contract-to-keeper map, proposed LOC, exclusions/gitlinks, unresolved work, and execution evidence. Large complete tables may live in separately named external companion artifacts linked by both Markdown and JSON, but the JSON arrays above remain complete. End with authorization boundaries and next safe actions, not a deletion recommendation disguised as permission.
