---
title: pywin32 late binding drops SAFEARRAY args — wrap in VARIANT(VT_ARRAY|VT_*)
category: COM Marshalling (Python)
tags: [pywin32, late-binding, SAFEARRAY, VARIANT, DISP_E_BADPARAMCOUNT, CreateSpline2, CreateBsplineSurface, marshalling]
date: 2026-05-15
---

# pywin32 late binding drops SAFEARRAY args — wrap in VARIANT(VT_ARRAY|VT_*)

## Problem

Calling a SolidWorks COM method that expects a SAFEARRAY input from **late-bound** pywin32 with a plain Python list fails at runtime — typically with `DISP_E_BADPARAMCOUNT`, sometimes with a silent `None` return, occasionally with `"server threw an exception"`.

Concrete repro (from the SolidworksMCP-python adapter):

```python
sm = swApp.ActiveDoc.SketchManager
points = [0.0, 0.0, 0.0, 0.025, 0.015, 0.0, 0.05, 0.0, 0.0]  # 3 points, flat XYZ in metres
spline = sm.CreateSpline2(points, False)   # raises DISP_E_BADPARAMCOUNT
```

C#/VBA with the same payload works because the .NET/VBA marshallers auto-promote a `double[]` or `Variant()` array to a SAFEARRAY of doubles. **pywin32 does not.**

## Root cause

The SolidWorks IDL declares `CreateSpline2(PointData, SimulateNaturalEnds)` as `((12, 1), (11, 1))` in the gen_py wrapper — that's `(VT_VARIANT input, VT_BOOL input)`. The IDL doesn't say "SAFEARRAY of doubles"; it just says "VARIANT" and the convention is that callers put a SAFEARRAY inside that VARIANT.

When you hand pywin32 a bare Python list, its late-binding marshaller in `_oleobj_.InvokeTypes` treats the list as iterable positional VARIANT args and **unpacks it** — so SW receives `3*N+1` arguments instead of 2, and IDispatch rejects with `DISP_E_BADPARAMCOUNT`.

The fix is to make the SAFEARRAY explicit by wrapping the doubles in a VARIANT yourself before the call.

## Solution

Use `win32com.client.VARIANT(pythoncom.VT_ARRAY | pythoncom.VT_R8, [doubles])`:

```python
import pythoncom
from win32com.client import VARIANT

points = [0.0, 0.0, 0.0, 0.025, 0.015, 0.0, 0.05, 0.0, 0.0]
points_arg = VARIANT(pythoncom.VT_ARRAY | pythoncom.VT_R8, points)
spline = sm.CreateSpline2(points_arg, False)   # works
```

Type-code reference:

| Element type | VT code | Use for |
| --- | --- | --- |
| `VT_ARRAY \| VT_R8` (`8197`) | doubles | point/knot/coord arrays, transformation matrices |
| `VT_ARRAY \| VT_I4` (`8195`) | int32 | mark arrays, sw*_e enum arrays |
| `VT_ARRAY \| VT_BSTR` (`8200`) | strings | file path lists, configuration name lists |
| `VT_ARRAY \| VT_DISPATCH` (`8201`) | interface pointers | entity arrays (AddRelation, patterns, mirror) |

## Scope — this hits ~63 methods in the SW TLB

Grepping the SW 2026 gen_py wrapper for methods that declare a `(12, 1)` VT_VARIANT input with array-shaped names (`PointData`, `Points`, `Knots`, `Vertices`, `CtrlPtCoords`, `Coords`, `Weights`, `ArrayData`):

```bash
SW=$LOCALAPPDATA/Temp/gen_py/3.14/83A33D31-27C5-11CE-BFD4-00400513BB57x0x34x0.py
grep -E "def [A-Z][A-Za-z0-9]*\([^)]*(PointData|Points|Knots|Vertices|CtrlPtCoords|Coords|Weights|ArrayData)[^)]*\)" "$SW" | wc -l
# → 63
```

High-traffic examples that all need this fix when called from pywin32:

- `ISketchManager.CreateSpline2(PointData, SimulateNaturalEnds)`
- `ISketchManager.CreateSpline3(PointData, Surfs, Direction, SimulateNaturalEnds, Status)`
- `IBody2.CreateBsplineSurface(Props, UKnots, VKnots, CtrlPtCoords)` — **three** SAFEARRAY args
- `IBody2.CreatePlanarTrimSurfaceDLL(Points, Normal)`
- `IBody2.AddProfileBspline(Props, Knots, CtrlPtCoords)`
- `IBody2.AddProfileBsplineByPts(NumPoints, PointArray)`
- `IModelDoc2.ConvertToMultiJog(LeaderNumber, NumberOfPoints, PointsData)`

The companion `I*`-prefixed variants (`ICreateSpline2`, `ICreateBsplineSurface`) declare the array as `(16389, 1)` = `VT_BYREF|VT_R8` instead — those need a different shape: pass `array.array('d', [doubles])` directly (no VARIANT wrapping). Don't confuse the two.

## Why early binding (and C#/VBA) hides this

Two reasons the bug doesn't show up everywhere:

1. **C# / VBA marshallers** see the IDL `VARIANT` declaration and auto-promote a typed array (`double[]`, `Variant()`) to the right `VARIANT(VT_ARRAY|VT_R8, …)` shape transparently. Most published SolidWorks API examples are in C#/VBA, so the issue is invisible in the docs.
2. **Early-bound pywin32** (`gencache.EnsureDispatch(...)` or imports from `win32com.gen_py.<TLB-GUID>`) generates Python wrappers that *also* know the IDL declares `VT_VARIANT` and pre-wrap the list. Late binding (`win32com.client.dynamic.Dispatch(...)`, or plain `win32com.client.Dispatch(...)` when no makepy wrapper is loaded) does not — and many SW projects pin to dynamic dispatch on purpose, because the makepy wrappers mishandle pass-by-ref `[out]` VARIANT parameters (e.g. `OpenDoc6`'s `errors`/`warnings`).

So projects that use `dynamic.Dispatch` for the `OpenDoc6` reason are the ones most exposed to the SAFEARRAY pitfall on the other side.

## Detection signal

If you're calling a `Create*` / `Add*` / `Set*` method whose name mentions points/coords/knots/array and you see any of these:

- `pywintypes.com_error: (-2147352562, 'Invalid number of parameters.', None, None)`  — that's `DISP_E_BADPARAMCOUNT` (`0x8002000E`)
- The call returns `None` silently and SW shows no new geometry
- `"server threw an exception"` with no SW-side trace

…wrap the array argument(s) in `VARIANT(VT_ARRAY|VT_R8, …)` (or the relevant VT_ARRAY|VT_* for non-double types) and retry. If it now works, you've hit this exact bug.

## Counter-example: when NOT to wrap

Not every array-named parameter is a SAFEARRAY. Methods using `(16389, 1)` are pass-by-ref doubles (`out` params or single-buffer doubles), and `(9, 1)` is a single `IDispatch` — these need different handling. Always check the type code in the gen_py wrapper before applying the fix:

```bash
grep -A 2 "def CreateSpline2" "$SW"
# def CreateSpline2(self, PointData=..., SimulateNaturalEnds=...):
#   ret = self._oleobj_.InvokeTypes(69, LCID, 1, (9, 0), ((12, 1), (11, 1)), ...)
#                                                         ^^^^^^^ VT_VARIANT input — wrap as SAFEARRAY VARIANT
```
