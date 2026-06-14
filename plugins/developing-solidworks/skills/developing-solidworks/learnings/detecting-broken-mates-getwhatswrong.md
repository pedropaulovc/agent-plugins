---
title: Detecting Broken Mates / Rebuild Errors with GetWhatsWrong (and the pywin32 byref trap)
category: Assembly Validation
tags: [validation, mates, assembly, GetWhatsWrong, swFeatureError_e, pywin32, byref, flexible-subassembly]
date: 2026-06-13
---

# Detecting Broken Mates / Rebuild Errors with GetWhatsWrong

## Problem

An assembly can be saved to disk with **broken mates** that no obvious gate
catches. Symptom: a component shows a red circle-X in the tree, but:

- `IComponent2.GetConstrainedStatus` still reports the component fully defined /
  fixed (a grounded component is "fixed" regardless of whether its mates solve),
  so a "fully defined" DOF check passes.
- Interference detection does not look at mate state.
- The bad file loads and even renders fine; the breakage only bites later (e.g.
  when the subassembly is made flexible and the mechanism produces garbage motion).

Real case: a gear train's 40 mates (`GearMate*` + paired `Coincident*`) all
carried error code **48 = `swFeatureErrorMateBroken`** ("one or more mate
entities were suppressed") — the assembly had gone stale when a referenced part
was rebuilt (a reference axis the mates pointed at shifted). The DOF + interference
gates were green the whole time.

## Solution: IModelDocExtension.GetWhatsWrong

`GetWhatsWrong(out Features, out ErrorCodes, out Warnings)` returns the What's
Wrong dialog contents — one entry per erroring/​warning feature, with a
`swFeatureError_e` code and a per-entry warning flag. Treat any entry whose
warning flag is **False** as a hard fault.

### The pywin32 byref trap

The three `out object` params do NOT round-trip as a bare call — `ext.GetWhatsWrong()`
**raises** at the COM boundary, and passing `None` mis-types. You must pass
`VT_BYREF | VT_VARIANT` VARIANTs and read `.value` back (same pattern as the
required byref `Errors`/`Warnings` on `SaveAs`):

```python
import pythoncom
from win32com.client import VARIANT

def _byref_variant():
    return VARIANT(pythoncom.VT_BYREF | pythoncom.VT_VARIANT, None)

f, e, w = _byref_variant(), _byref_variant(), _byref_variant()
ext.GetWhatsWrong(f, e, w)          # retval is a bool; the data is in the byrefs
features, codes, warns = f.value, e.value, w.value   # tuples, parallel arrays
for feat, code, warn in zip(features or [], codes or [], warns or []):
    if not warn:                     # warning flag False -> hard error
        print(feat.Name, code)       # e.g. "GearMate2" 48
```

Quietly catching the raised bare call and reporting "no errors found" is the
trap that hides the corruption — verify the call actually returns data.

## Flexible subassemblies: check the sub's OWN document

A flexible subassembly's internal mate errors do **not** appear in the parent
assembly's `GetWhatsWrong` — the parent shows only a component-level *warning*
(code 1, warning flag True). To see the real errors, walk the top-level
components and call `GetWhatsWrong` on each component's own
`IComponent2.GetModelDoc2()`. The same is true of a broken-on-disk subassembly
inserted rigid: its errors live in its own document, not the parent's.

## Fail-fast gate

`ForceRebuild3(False)` returns False on a rebuild error — a cheap coarse signal.
Combine: force-rebuild, then `GetWhatsWrong` on the model and (deep) on each
top-level component's document; raise on any non-warning entry. Run it before
every `Save` so a broken assembly is never written.

## Related

- Body/geometry faults (degenerate edges, sub-tolerance faces) are a different
  failure mode — use `IBody2.Check3` -> `IFaultEntity` (see
  detecting-faulty-geometry.md). `GetWhatsWrong` is for feature/mate state.
- `swFeatureError_e` 48 = `swFeatureErrorMateBroken`; 2 = rebuild error; 3/4 =
  dangling; 5/6 = sketch over-defined / no-solution.
