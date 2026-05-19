# mediocrity-detector plugin

A Rust Stop hook that detects hedging language in the current turn ("for now", "good enough", "placeholder", "TODO", etc.) and blocks the stop, asking Claude to explicitly report each assumption so the user can make a judgement call.

## Build

```
python3 hooks/build-hooks.py
```
