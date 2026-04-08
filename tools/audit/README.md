# External audit archive

`make-audit-archive.sh` builds a **`.tar.gz`** suitable for third-party security or code review: dependencies, build output, local secrets, and most machine-local tooling paths are **excluded**, while **`.env.example`** and **`test/benchmark/agent/results/baseline.json`** stay included when present.

## Requirements

- `rsync`, `tar`
- `shasum -a 256` (macOS) or `sha256sum` (Linux) for the checksum line at the end

## Usage

From the **repository root**:

```bash
bash tools/audit/make-audit-archive.sh
```

Default output: **`../wine-search-engine-audit-YYYYMMDD-HHMMSS.tgz`** (sibling of the repo folder, UTC timestamp).

```bash
# Custom path
bash tools/audit/make-audit-archive.sh -o ~/Desktop/wine-audit.tgz

# Drop web/ (backend-only bundle)
bash tools/audit/make-audit-archive.sh --backend-only -o ./audit-backend.tgz

# Include Git history (larger; agree with auditors first)
bash tools/audit/make-audit-archive.sh --with-git -o ./audit-with-git.tgz

# See what would be copied (no tarball)
bash tools/audit/make-audit-archive.sh --dry-run
```

## What the filter does

Rules live in **`rsync-audit.filter`** and match the intent of root **`.gitignore`**, plus:

- **No** `node_modules/`, `dist/`, `coverage/`, `.next/`, `.turbo/`, typical caches and logs
- **No** `.git/` unless you pass **`--with-git`**
- **No** `.env` / `.env.*` except **`.env.example`**
- **Benchmark results**: keeps **`baseline.json`** and **`.gitkeep`**; drops other `*.json` / `*.log` / `*.txt` under `test/benchmark/agent/results/`

## After generating the archive

1. Copy **`AUDIT_PACKAGE.template.md`** to a non-committed file (or email body), fill in scope, build/test commands, contacts, and paste the printed **SHA-256**.
2. Send the tarball over your org’s approved channel; **do not** put real secrets in the template or email.

## Limitations

- **macOS / Linux** oriented (`bash` + `rsync`). On Windows, use WSL or Git Bash if `rsync` is available.
- The tool does not scan for **accidentally committed secrets**; run a separate secret scan on the tree before shipping if policy requires it.
