# Code audit archive

`make-code-audit-archive.sh` builds a **`.tar.gz`** suitable for third-party code or security review: dependencies, build output, local secrets, and most machine-local tooling paths are **excluded**, while **`.env.example`** and **`test/benchmark/agent/results/baseline.json`** stay included when present.

## Requirements

- `rsync`, `tar`
- `shasum -a 256` (macOS) or `sha256sum` (Linux) for the checksum line at the end

## Usage

From the **repository root**:

```bash
bash tools/code_audit/make-code-audit-archive.sh
```

Default output: **`../wine-search-engine-code-audit-YYYYMMDD-HHMMSS.tgz`** (sibling of the repo folder, UTC timestamp).

```bash
# Custom path
bash tools/code_audit/make-code-audit-archive.sh -o ~/Desktop/wine-code-audit.tgz

# Drop web/ (backend-only bundle)
bash tools/code_audit/make-code-audit-archive.sh --backend-only -o ./code-audit-backend.tgz

# Include Git history (larger; agree with auditors first)
bash tools/code_audit/make-code-audit-archive.sh --with-git -o ./code-audit-with-git.tgz

# See what would be copied (no tarball)
bash tools/code_audit/make-code-audit-archive.sh --dry-run
```

## What the filter does

Rules live in **`rsync-code-audit.filter`** and match the intent of root **`.gitignore`**, plus:

- **No** `node_modules/`, `dist/`, `coverage/`, `.next/`, `.turbo/`, typical caches and logs
- **No** `.git/` unless you pass **`--with-git`**
- **No** `.env` / `.env.*` except **`.env.example`**
- **Benchmark results**: keeps **`baseline.json`** and **`.gitkeep`**; drops other `*.json` / `*.log` / `*.txt` under `test/benchmark/agent/results/`

## After generating the archive

1. Copy **`CODE_AUDIT_PACKAGE.template.md`** to a non-committed file (or email body), fill in scope, build/test commands, contacts, and paste the printed **SHA-256**.
2. Send the tarball over your org’s approved channel; **do not** put real secrets in the template or email.

## Limitations

- **macOS / Linux** oriented (`bash` + `rsync`). On Windows, use WSL or Git Bash if `rsync` is available.
- The tool does not scan for **accidentally committed secrets**; run a separate secret scan on the tree before shipping if policy requires it.
