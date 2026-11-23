# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bloomsX/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/bloomsX/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit that an AI model wrote to a tree of text files. Models write edits in four formats,
and `mend` reads each one the way `SPEC.md` says: a unified diff (often with wrong line numbers), SEARCH/REPLACE
blocks, the V4A patch format, and text-editor tool calls as JSON. Every file is changed or nothing is.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- The working directory is the root of the tree. Every path in a patch is relative to it.
- `PATCH` is the path of the patch file, relative to the working directory. When `PATCH` is absent or is `-`,
  the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`, `search-replace`, `v4a` or `json`; `auto`, the
  default, detects it.
- `--check` does everything but write: the same output and exit code as without it, and no file is created,
  changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

## Output and exit codes

- Exit 0: the tree is written. One line for each path whose state changed (`A`, `D`, `M`, or `R <old> -> <new>`
  for a move), in byte order, then `ok: <n> files`.
- Exit 1: nothing is written. One line `error: <code> <path>` for each edit that failed, in the patch's order,
  then `failed: <k> of <n> edits`.
- Exit 2: nothing is written. Exactly one line: `error: usage`, `error: no-patch`, `error: format`, or
  `error: parse <N>`.

## Matching

Old lines are found at the first of three tiers at which they occur at least once: tier 0, every line equal;
tier 1, every line equal once trailing spaces and tabs are removed from both; tier 2, every line equal once
leading and trailing spaces and tabs are removed from both. Context lines are written as the file's own matched
lines, and at tier 2 new lines are re-indented to the file's indentation. `--strict` tries tier 0 only.

## The files

- `main.ts`: the CLI, Node 22 and its standard library alone, run as `node main.ts [options] [PATCH]`.
- `runner.ts`: the kit's runner. In a trial it reads the checks from the environment, runs `node main.ts` on
  each one in a fresh directory, and posts what it did.
- `check.ts`: the practice set on your own machine. The kit carries it at
  `program/generator/practice.json`:

      node check.ts <practice.json>
      node check.ts <practice.json> u-offset s-basic

  It prints every check `main.ts` gets wrong, with what differed, and the practice score.
- `SPEC.md`: the specification. It is the whole contract.
- `LICENSE`: MIT.

## License

MIT — see LICENSE.
