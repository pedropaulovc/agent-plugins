---
name: developing-solidworks
description: Write, modify, and debug code that drives the SolidWorks desktop application via its COM API — primarily C# / .NET (SolidWorks.Interop.sldworks, swconst, swcommands), but also any other COM-capable language (C++, VBA, Python via pywin32/comtypes, PowerShell, VB.NET). Use whenever the user is working on .cs/.csproj files that reference the SolidWorks SDK, writing a VBA macro or pywin32 script that drives SolidWorks, mentions SolidWorks automation or add-ins, asks how to call a SolidWorks API like ISldWorks/IModelDoc2/IFeatureManager, or hits errors involving sw* enums, COM interfaces, STA threading, or .NET Framework / Interop assemblies. The skill bundles the full API reference (types, enums), code examples, and a learnings log under its directory and tells Claude how to navigate them. Do NOT use for SolidWorks end-user UI questions, licensing, or non-API CAD work.
paths: ["**/*.cs", "**/*.csproj", "**/*.sln"]
---

# Developing SolidWorks C# Code

## Why this skill exists

The SolidWorks COM API is large, inconsistently named, weakly typed, and poorly covered by LLM training data. Guessing method names, parameter orders, or return types almost always produces code that compiles but fails at runtime. This skill ships the official API reference, working examples, and accumulated debugging notes alongside it. **Consult them before writing code, not after a failure.**

## Before anything: anchor to this skill directory

Every `ls`/`grep`/`cat` recipe below uses paths relative to this skill's own directory (the folder containing this `SKILL.md`). Those paths only resolve if your shell's working directory **is** that folder — and it usually isn't by default.

`CLAUDE_PLUGIN_ROOT` does **not** help here: Claude Code exports it only to hook/MCP/LSP subprocesses, never to the shell you run tool calls in. So resolve the directory yourself, from the absolute path of this `SKILL.md` that you were given when the skill loaded, and `cd` into it before running any recipe:

```bash
cd "<absolute path of the directory containing this SKILL.md>"
```

After that, every `./types/`, `./enums/`, `./examples/`, etc. path below is correct. If a recipe ever comes up empty, first confirm you're still in this directory before concluding the docs are missing.

## First-time setup: download the API docs

**Before doing anything else, check whether `./types/` and `./enums/` are populated.** If either is empty or missing, the reference material this skill depends on has not been downloaded yet and every code suggestion below will be a guess.

```bash
ls ./types/ ./enums/ 2>/dev/null | head
```

**If empty or missing, you (the agent) MUST invoke the bundled download skill yourself before doing anything else. Do not hand this off to the user. Do not ask for permission. Do not skip it and continue with guessed API calls.**

Invoke the bundled **download-solidworks-docs** skill, passing the absolute path of **this** skill directory (the folder containing this `SKILL.md`) so the download script knows where to unpack. How you invoke it depends on the harness:

- **Claude Code** — call the Skill tool:

  ```
  Skill(skill="developing-solidworks:download-solidworks-docs", args="<absolute path to this skill directory>")
  ```

- **Codex** — there is no `Skill` tool, and the skill is named just `download-solidworks-docs` (not namespaced). Either invoke it with a `$download-solidworks-docs` mention, or simply open its `SKILL.md` (the sibling `skills/download-solidworks-docs/` directory) and run the PowerShell block it documents directly, with `$targetDir` set to **this** skill directory.

Pass the path explicitly because `CLAUDE_PLUGIN_ROOT` / `PLUGIN_ROOT` is **not** exported into tool-spawned shells — the download script cannot discover its own location on its own. If you omit it, the script falls back to searching the plugins install tree (`~/.claude/plugins` and `~/.codex/plugins`), which is slower and may pick the wrong copy if multiple are installed.

The corresponding slash command `/download-solidworks-docs` is for *humans* to run manually when working without an agent — pass the skill path as an argument there too, or let the fallback search find it.

After invocation, re-check `./types/` and `./enums/`. If they're still empty, the download failed: surface the failure to the user with the exact error message and **stop**. Do not fall back to API calls reasoned from memory — the SolidWorks API surface is ~9,000 methods with weak naming conventions and many silent-failure modes, and "I'll figure it out from nearby code" is the documented failure mode this skill exists to prevent.

Only continue to the workflow below once `./types/` and `./enums/` contain content.

## Already downloaded? Check for a newer bundle

The reference is published as versioned GitHub releases, so a populated `./types/`/`./enums/` may still be stale. **Once per session, before relying on the docs, check whether a newer bundle exists.** The download skill records the installed version in `./.bundle-version`; compare it against the latest release tag:

```bash
cat ./.bundle-version 2>/dev/null   # e.g. v3.2.0 — missing/empty means an older bundle predating version tracking; treat as stale
curl -s https://api.github.com/repos/pedropaulovc/offline-solidworks-api-docs/releases/latest | grep '"tag_name"'
```

If the latest `tag_name` differs from `./.bundle-version` (or the file is missing), a newer bundle is available — re-invoke the download skill to refresh in place (Skill tool under Claude Code; a `$download-solidworks-docs` mention or its PowerShell block directly under Codex — see "First-time setup" above). It overwrites the doc folders and rewrites `./.bundle-version`:

```
Skill(skill="developing-solidworks:download-solidworks-docs")
```

This check is best-effort, not a gate: if it fails (offline, GitHub rate-limited, `curl` unavailable), **proceed with the bundle you have** — a slightly stale reference is still far better than guessing API calls from memory. Only treat a confirmed newer version as a reason to re-download.

## The non-negotiable rule: run, don't just build

`dotnet build` only proves the code compiles against the Interop assemblies. It does not prove the COM calls succeed, that selections resolved, that the active document is the right type, or that a feature was actually created. The API frequently returns `null` or `false` on failure rather than throwing.

**You MUST execute `dotnet run` (or equivalent runner) and confirm the SolidWorks side-effect occurred before claiming a task is done.** A clean build is not success.

## Bundled reference material

All paths below are relative to this `SKILL.md` (the skill directory). They are real and load-bearing — do not invent alternatives.

| Folder            | What's in it                                                              | When to read                                                  |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `./types/`        | Per-interface folders (e.g. `IModelDoc2/`) with one `.md` per method/prop | Looking up a method signature, parameters, or return type     |
| `./enums/`        | Per-enum folders with `_overview.md` and one `.md` per value             | Resolving `sw*_e` values to pass as `int` parameters          |
| `./docs/`         | Programming Guide topics                                                  | Conceptual questions, patterns, end-to-end workflows          |
| `./examples/`     | Proven, runnable code snippets                                            | Need a working template to adapt                              |
| `./learnings/`    | Postmortems on real failures (symptom -> root cause -> fix)               | **First stop when something breaks unexpectedly**             |
| `./index/`        | `by_category.md`, `statistics.md` cross-cuts                              | Browsing by category, or you don't know which interface to use |
| `./scripts/`      | Helper utilities                                                          | See "Locating SDK assemblies" below                           |

If `./types/` or `./enums/` ever looks empty mid-session, jump back to **First-time setup** above.

## How to navigate the docs — use the Bash tool, NOT the Glob/Grep tools

> **The `Glob` and `Grep` tools do not work on this bundle. Do not use them.** They silently return "No files found" / "No matches found" even though the files exist — regardless of the path you pass them.
>
> These docs live in the plugin cache (`~/.claude/plugins/cache/...`), **outside the project workspace**. `Glob` and `Grep` only search registered *working roots* (the project directory plus any `--add-dir` paths), so they cannot reach the bundle. This is structural — not a `.gitignore` issue, and no plugin setting can change it. (The `cd` from the anchor section above does **not** fix it either: the working-root gate is independent of the shell's cwd.)
>
> What works on the bundle with zero configuration:
> - **Search / discover files → the `Bash` tool** (`grep`, `ls`, `find`). The shell is not restricted to working roots — every recipe below uses it.
> - **Read a file's content → the `Read` tool** on the file's absolute path (preferred; `cat` in `Bash` also works).

The doc layout is grep-optimised. Drive it with `Bash` grep instead of reading whole folders.

```bash
# Find a method on a specific interface
grep -rl "CreateArc" ./types/IModelDoc2/
cat  ./types/IModelDoc2/CreateArc2.md   # or: Read tool on the absolute path

# List all members of an interface (excluding the overview file)
ls ./types/IModelDoc2/*.md | grep -v "_overview"

# Pull every method signature
grep "^\*\*Signature\*\*:" ./types/IModelDoc2/*.md

# Search by frontmatter metadata
grep -r "category: Application Interfaces" ./types/
grep -r "kind: method"                       ./types/

# Resolve an enum value
ls ./enums/ | grep -i "endconditions"
cat ./enums/swEndConditions_e/_overview.md
grep -r "swEndCondBlind" ./enums/
cat ./enums/swEndConditions_e/swEndCondBlind.md

# See where an enum is actually used
grep -r "swEndConditions_e" ./examples/

# Browse by category, or check coverage stats
cat ./index/by_category.md
cat ./index/statistics.md
```

## Required workflow

1. **Identify the interfaces and methods involved.** Use `./index/by_category.md` if unsure where to start, then `grep` inside `./types/`.
2. **Read the per-method `.md` file.** Confirm parameter names, types, return type, and whether `null`/`false` indicates failure.
3. **Check `./examples/` for a similar pattern** before writing from scratch.
4. **Write the code** following the patterns in the next section.
5. **Run it with `dotnet run`** and verify the SolidWorks side effect actually happened.
6. **If anything is off, check `./learnings/` before debugging from first principles.** Add a new learning file there if you solve something that wasn't documented.

## Locating SDK assemblies (.NET only)

The SolidWorks SDK only targets .NET Framework. The Interop assemblies live next to a SolidWorks install, not in NuGet. Run [`./scripts/find_api_redist.py`](./scripts/find_api_redist.py) to locate the folder containing `SolidWorks.Interop.*.dll` for the installed version.

Skip this section if you're calling SolidWorks from a non-.NET language — see below.

## Bindings other than C#

The SolidWorks API is a COM server, callable from any COM-capable language (C++, VBA, Python via `pywin32`/`comtypes`, PowerShell, VB.NET, etc.). The bundled `./types/` and `./enums/` docs come from the .NET Interop type library, but interface, method, parameter, and enum names match the underlying COM IDL one-to-one — so everything in this skill applies. Only the boilerplate around the calls changes.

### Instantiating the application

Use a COM ProgID instead of `new SldWorks.SldWorks()`. Plain ProgID picks whatever version is registered; suffix with the version code to pin (`SldWorks.Application.31` = SW 2023).

| Language    | Code                                                              |
| ----------- | ----------------------------------------------------------------- |
| Python      | `swApp = win32com.client.Dispatch("SldWorks.Application")`        |
| VBA         | `Set swApp = CreateObject("SldWorks.Application")`                |
| PowerShell  | `$swApp = New-Object -ComObject SldWorks.Application`             |
| C++         | `CoCreateInstance(CLSID_SldWorks, …)` after `#import` the typelib |

### Apartment threading

SolidWorks is an STA COM server. Threads that call it must be initialised STA, or calls will appear to work for a moment then deadlock or throw cryptic `RPC_E_*` errors.

- C++: `CoInitializeEx(NULL, COINIT_APARTMENTTHREADED)`.
- Python: `pythoncom.CoInitialize()` per thread; avoid worker threads where possible.
- .NET: WinForms/WPF main thread is STA by default; console apps need `[STAThread]` on `Main`.

### Reference counting

- Raw C++: standard COM — `Release()` every interface pointer you receive.
- .NET Interop: GC handles most cases; use `Marshal.ReleaseComObject` only when SolidWorks visibly holds onto an object you've dropped (e.g. before re-opening the same document).
- `pywin32`: automatic; assign `None` for deterministic release.

### Early vs late binding

Early binding (`#import` in C++, `makepy` in Python, References dialog in VBA) gives you IntelliSense and named enum constants (`swEndConditions_e.swEndCondBlind`). Late binding via `IDispatch` (the default with `CreateObject`/`Dispatch`) works without setup but loses constant names — you'll pass magic numbers. Look the value up in `./enums/` and leave a comment.

### Verifying success

The "run, don't just build" rule generalises: parser/compiler success is never runtime success. Whatever your loop is — `python script.py`, F5 in VBA, build+launch a C++ exe — execute it and confirm the SolidWorks side effect actually happened.

## Code patterns to follow

These exist because the API design forces them. The "why" comes after each rule.

### Use named parameters

Many SolidWorks methods take 10-30 positional parameters of `bool`/`int`/`double`. Positional calls are unreadable and bug-prone — a flipped `bool` silently changes behaviour.

```csharp
// Good - intent is obvious, mistakes are visible at the call site
IFeature extrude = swFeatureMgr.FeatureExtrusion3(
    Sd:   true,                                       // single direction
    Flip: false,                                      // don't flip cut side
    Dir:  false,                                      // don't flip extrusion direction
    Dir1: (int)swEndConditions_e.swEndCondBlind,
    D1:   0.1,                                        // metres
    // ...
);

// Avoid - what does the 7th `false` mean?
IFeature extrude = swFeatureMgr.FeatureExtrusion3(
    true, false, false, (int)swEndConditions_e.swEndCondBlind,
    (int)swEndConditions_e.swEndCondBlind, 0.1, 0, false, false, false,
    false, 0, 0, false, false, false, false, false, false, true,
    (int)swStartConditions_e.swStartSketchPlane, 0, false);
```

### Null-check returned interfaces

Most accessors return `null` on failure (no active doc, wrong doc type, selection lost, etc.) rather than throwing.

```csharp
IModelDoc2 doc = swApp.ActiveDoc as IModelDoc2;
if (doc == null)
    throw new InvalidOperationException("No active document");
```

### Check `bool` return values

Many mutating methods return `bool` for success. Ignoring it is the most common source of "the script ran but nothing happened".

```csharp
bool ok = doc.Extension.SelectByID2(
    Name: "Face1", Type: "FACE",
    X: 0, Y: 0, Z: 0,
    Append: false, Mark: 0,
    Callout: null, SelectOption: 0);

if (!ok) throw new Exception("Selection failed");
```

### Cast deliberately

`int` <-> enum casts and COM interface casts are unavoidable. Check the doc for the exact return type before casting; chained casts are normal.

```csharp
// int <-> enum
Dir1: (int)swEndConditions_e.swEndCondBlind;                  // input
var status = (swSketchCheckFeatureStatus_e)sketch.CheckFeatureUse(); // output

// Chained interface casts — confirm each return type in ./types/
ISketch sketch = (ISketch)((IFeature)doc.SelectionManager
                              .GetSelectedObject6(1, -1))
                              .GetSpecificFeature2();
```

### Don't hardcode template paths

Templates differ per machine and locale. Ask SolidWorks for the user's configured default.

```csharp
swModel = (ModelDoc2)swApp.NewDocument(
    TemplateName: swApp.GetUserPreferenceStringValue(
        (int)swUserPreferenceStringValue_e.swDefaultTemplatePart),
    PaperSize: 0, Width: 0, Height: 0);
```

### Validate document state before operating on it

```csharp
if (doc.GetType() != (int)swDocumentTypes_e.swDocPART)
    throw new InvalidOperationException("Operation requires a part document");
```

## When to stop and ask

- The requested operation may not exist in the API (check `./index/` and `./types/` first).
- Two genuinely different approaches exist and the choice changes the design.
- The behaviour depends on a SolidWorks version, configuration, or add-in the user hasn't specified.
- `./types/` and `./docs/` contradict each other on a load-bearing detail.

## End-to-end example: create a part with an extrusion

A reference for the shape of a typical script — connect, create a doc, sketch, select, extrude, verify.

```csharp
using SolidWorks.Interop.sldworks;
using SolidWorks.Interop.swconst;

ISldWorks swApp = new SldWorks.SldWorks();

IModelDoc2 doc = swApp.NewDocument(
    TemplateName: swApp.GetUserPreferenceStringValue(
        (int)swUserPreferenceStringValue_e.swDefaultTemplatePart),
    PaperSize: 0, Width: 0, Height: 0);
if (doc == null) throw new Exception("Failed to create document");

// Sketch a 50 mm x 50 mm centred rectangle on the front plane
doc.Extension.SelectByID2(
    Name: "Front Plane", Type: "PLANE",
    X: 0, Y: 0, Z: 0,
    Append: false, Mark: 0,
    Callout: null, SelectOption: 0);
doc.SketchManager.InsertSketch(true);
doc.SketchManager.CreateCenterRectangle(0, 0, 0, 0.05, 0.05, 0);
doc.SketchManager.InsertSketch(true);

// Extrude 100 mm in one direction
doc.Extension.SelectByID2(
    Name: "Sketch1", Type: "SKETCH",
    X: 0, Y: 0, Z: 0,
    Append: false, Mark: 0,
    Callout: null, SelectOption: 0);

IFeature feature = doc.FeatureManager.FeatureExtrusion2(
    Sd:        true,
    Flip:      false,
    Dir:       false,
    Dir2:      (int)swEndConditions_e.swEndCondBlind,
    Dir1:      (int)swEndConditions_e.swEndCondBlind,
    D1:        0.1,    // metres
    D2:        0,
    Dchk1:     false,
    Dchk2:     false,
    Ddir1:     false,
    Ddir2:     false,
    Dang1:     0,
    Dang2:     0,
    Offstatus: false);

if (feature == null) throw new Exception("Extrusion failed");
```
