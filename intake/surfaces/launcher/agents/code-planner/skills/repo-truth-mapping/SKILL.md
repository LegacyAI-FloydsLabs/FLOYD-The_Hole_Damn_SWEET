---
name: repo-truth-mapping
description: Build the live-evidence map of a repository (entry points, build/test commands, boundaries, state) that a plan must stand on. Use before writing any plan.
---

# Repo-Truth Mapping

A plan built on README claims is fiction. Build the map from live state:

1. Skeleton — top-2-level directory map; identify workspace/monorepo
   structure from actual manifest files (package.json workspaces, go.work,
   pyproject, Cargo.toml members).
2. Commands — build/test/lint/run commands from the manifests' script
   sections and CI workflow files, NOT from docs. Record the exact string and
   its source path. If practical, dry-run the cheapest one to confirm the
   toolchain resolves.
3. Entry points — trace mains/servers/CLIs from the manifest fields (main,
   bin, scripts) to real files; note ports and config sources they read.
4. Boundaries — which directories are generated, vendored, donor/immutable,
   or runtime-data. These are no-edit zones; list them in the plan.
5. State — current branch, dirty files, ahead/behind; running processes and
   listeners relevant to the project (`lsof -i` on its ports). A plan that
   ignores a dirty worktree or a live service plans a collision.
6. Contradiction log — every place where docs disagree with observed reality,
   recorded as "doc says X / code does Y (path)". These become either plan
   steps or explicit warnings, never silent choices.

Every fact in the map carries its source (path or command). Facts without
sources are labeled ASSUMPTION and counted — more than five means more
discovery before planning.
