# Filesystem syscall catalog

`syscall_catalog.sql` is a standalone, version-controlled SQLite classification
reference (catalog version **1**). It contains 84 Linux syscall names across 13
categories. Loading it **does not enable tracing**, change gVisor, or change the
dashboard. Runtime and decoded-field support must be verified separately for
each pinned gVisor release and architecture.

## Import and query

From the repository root, create a disposable database:

```sh
catalog_dir=$(mktemp -d)
sqlite3 "$catalog_dir/catalog.db" < worker/gvisor/syscall_catalog.sql
sqlite3 -header -column "$catalog_dir/catalog.db" \
  "SELECT syscall_name, category, default_impact_level FROM syscall_catalog_readable WHERE syscall_name = 'unlinkat';"
```

Expected result:

```text
syscall_name  category  default_impact_level
------------  --------  --------------------
unlinkat      Delete    3
```

Browse the complete table:

```sh
sqlite3 -header -column "$catalog_dir/catalog.db" \
  'SELECT syscall_name, description, category, default_impact_level, classification_rule FROM syscall_catalog_readable ORDER BY category_id, syscall_name;'
```

The import is transactional and idempotent. Re-importing restores catalog-owned
seed rows using upserts and preserves unrelated rows. It does not delete removed
entries or upgrade an incompatible future schema; future structural versions
need an explicit migration. Use a dedicated database, not the application or
runtime evidence database. The script does not modify `PRAGMA user_version`.

## Data model

| Table/view | Purpose |
| --- | --- |
| `syscall_impact_levels` | Four impact levels and their meanings. |
| `syscall_categories` | Stable operation identifiers, labels, and descriptions. |
| `syscall_catalog` | One row per syscall name, description, category, nullable default level, rule identifier, required evidence, interpretation notes, and catalog version. |
| `syscall_catalog_readable` | Joined view with category and impact labels for inspection or export. |

| Level | Label | Meaning |
| --- | --- | --- |
| 0 | Observe | Read or inspect; sensitive reads and incidental access-time updates remain possible. |
| 1 | Create | Add an entry without replacing existing data. |
| 2 | Modify | Change contents, metadata, layout, or location. |
| 3 | Remove/replace | Remove an entry or replace an existing destination. |

Levels describe filesystem impact, **not maliciousness**. A level-0 secret read
can be concerning; a level-3 temporary-file deletion can be expected. Null means
conditional or not applicable, never level 0. Unknown syscall names have no row
and must remain unclassified. A recognized syscall with missing evidence may
still have a known operation category, but its actual effect stays unknown.

Names are not architecture-specific syscall numbers. For example, `newfstatat`
is a syscall name while `fstatat` is a common library interface. A listed name
need not exist on every architecture. Resolve numbers against the execution
architecture before lookup; do not infer them from the collector host.

## Classification contract

The rule identifiers below are specifications for a future deterministic
classifier, not executable SQL functions. Consumers can load the catalog once
into memory and use a parameterized lookup or map; no per-event network request
is needed. Keep the raw observation, attempted operation, outcome, and confirmed
effect separate. Preserve the catalog version when persisting classifications.

Every event needs sandbox/process identity, timestamp, syscall identity, and
outcome. A missing exit result is unknown, not success. Apply the row-specific
`required_evidence` and rules only after decoding signed results and errno.

| Rule | Interpretation |
| --- | --- |
| `open_effect` | Read-only opens without mutation flags are level 0, but do not prove bytes were read. Confirmed creation is level 1; successful truncation of an existing file is level 2. Writable access alone has no confirmed mutation level. `O_CREAT` alone does not establish creation. `creat` implies `O_WRONLY\|O_CREAT\|O_TRUNC`; `openat2` requires decoding `open_how`. Successful `O_CREAT\|O_EXCL` can establish new creation. Other ambiguous cases stay unresolved. |
| `file_write` | Level 2 applies only to file targets. Positive returned bytes establish writes, not necessarily different contents or durable storage. Record actual bytes, not just requested bytes; zero-byte and failed writes do not confirm modification. Honor append/offset flags without inventing an unavailable actual offset. |
| `remove_entry` | Level 3 is the attempted operation. A successful result confirms entry removal; failure does not. `AT_REMOVEDIR` distinguishes directory deletion. Other hard links or open descriptors may retain data. |
| `rename_effect` | Confirmed non-replacing move is level 2; confirmed replacement is level 3. Unknown destination history remains unresolved. `RENAME_NOREPLACE` success excludes replacement; `RENAME_EXCHANGE` is an exchange at level 2. Same-object operations may be no-ops. `RENAME_WHITEOUT` and unsupported flag combinations stay unresolved until specifically decoded. An earlier directory scan alone is not race-free replacement evidence. |
| `file_resize` | Level 2 operation; record requested length. Success confirms a length-setting operation, not a change from an unknown prior size. |
| `directory_create` | Level 1 operation; success confirms creation. Requested mode may differ from effective permissions because of umask or ACLs. |
| `file_read` | Level 0 for file targets; positive returned bytes establish a read. Zero bytes, failures, and an open alone do not. Do not retain buffer contents. |
| `inspect` | Level 0 inspection; metadata and accessibility checks do not prove later content access. |
| `metadata_change` | Level 2 operation; success does not prove a value differed. Keep attribute names and relevant permissions/ownership/timestamps, not attribute payloads. |
| `link_create` | Level 1 entry creation; distinguish hard links from symbolic-link target text. No claim that contents were copied or the target is safe. |
| `copy_effect` | Positive transfer to a known existing file is level 2. Creation is established separately by creation evidence. Unknown targets remain unresolved; pipes and sockets are not filesystem edits. |
| `allocation_effect` | Successful, decoded file allocation/range changes are level 2. Distinguish allocation from punch-hole, zero-range, collapse-range and insert-range; allocation does not alone establish changed content. Unknown flags remain unresolved. |
| `ioctl_effect` | Decode command-specific semantics first. Supported file clone operations and attribute changes are level 2; supported inspection is level 0. Unknown commands have no default level. |
| `mapping_effect` | Record mapping capability/lifecycle, not confirmed reads or writes. `MAP_SHARED` plus writable protection permits edits but does not prove them. `msync`/`munmap` alone do not prove changed bytes. Leave confirmed impact unresolved without additional evidence. |
| `bookkeeping` | No direct filesystem impact level. Track descriptor duplication/reuse, working directories, offsets, synchronization, and command-dependent `fcntl` behavior as context. |

For example, successful `unlinkat` can display **L3 · Delete · Succeeded**;
`EACCES` can display **L3 · Delete · Failed: permission denied**. Neither label
requires a new process or PID. A failed operation must not appear in a list of
confirmed file changes.

Store the supplied pathname and directory base independently; do not label a
lexically joined path as fully resolved through symlinks. Descriptor identities
must account for reuse and inheritance. Unresolved target types/paths must stay
explicit. Preserve both source and destination for rename/link/copy events.

## Boundaries and validation

This initial catalog covers the six requested mutation families plus related
filesystem inspection, metadata, copy, mapping, and descriptor context. It does
not inventory network or privilege operations, every historical ABI alias, or
all asynchronous I/O interfaces. `io_uring` and memory stores can perform work
without corresponding ordinary write/unlink syscall events. Membership is not
a completeness guarantee, and a default level is not evidence of success.

No buffer contents or environment values are required by these rules. This
catalog does not change existing evidence storage, retention, or redaction.

Run isolated validation, including repeat import and constraints:

```sh
python3 -B -m unittest discover -s worker/gvisor -p 'test_syscall_catalog.py'
```

Semantic references: [Linux syscall inventory](https://man7.org/linux/man-pages/man2/syscalls.2.html),
[open](https://man7.org/linux/man-pages/man2/open.2.html),
[rename](https://man7.org/linux/man-pages/man2/rename.2.html),
[memory mappings](https://man7.org/linux/man-pages/man2/mmap.2.html), and
[gVisor SecCheck](https://github.com/google/gvisor/blob/release-20260817.0/pkg/sentry/seccheck/README.md).
