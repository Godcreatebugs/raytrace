-- File identity and contextual labels; no automatic identity resolution or scanning.
CREATE TABLE file_objects (
 id TEXT NOT NULL PRIMARY KEY,
 sandbox_id TEXT NOT NULL REFERENCES runtime_sandboxes(id),
 object_type TEXT NOT NULL CHECK (object_type IN ('regular','directory','symlink','pipe','socket','device','unknown')),
 filesystem_identity TEXT,
 inode_number TEXT,
 generation TEXT,
 identity_basis TEXT NOT NULL,
 first_seen_ns TEXT NOT NULL CHECK (first_seen_ns='0' OR (first_seen_ns GLOB '[1-9]*' AND first_seen_ns NOT GLOB '*[^0-9]*')),
 last_seen_ns TEXT NOT NULL CHECK (last_seen_ns='0' OR (last_seen_ns GLOB '[1-9]*' AND last_seen_ns NOT GLOB '*[^0-9]*')),
 UNIQUE(id, sandbox_id),
 CHECK (length(last_seen_ns)>length(first_seen_ns) OR (length(last_seen_ns)=length(first_seen_ns) AND last_seen_ns COLLATE BINARY >= first_seen_ns COLLATE BINARY))
);
CREATE TABLE file_operation_targets (
 id TEXT NOT NULL PRIMARY KEY,
 syscall_call_id TEXT NOT NULL,
 sandbox_id TEXT NOT NULL REFERENCES runtime_sandboxes(id),
 file_object_id TEXT,
 target_role TEXT NOT NULL CHECK (target_role IN ('target','source','destination','replaced_destination')),
 supplied_path TEXT,
 observed_path TEXT,
 dirfd INTEGER CHECK (dirfd IS NULL OR typeof(dirfd)='integer'),
 fd INTEGER CHECK (fd IS NULL OR (typeof(fd)='integer' AND fd>=0)),
 base_path TEXT,
 resolution_status TEXT NOT NULL CHECK (resolution_status IN ('unresolved','supplied_only','lexical','runtime_resolved')),
 identity_basis_json TEXT CHECK (identity_basis_json IS NULL OR json_valid(identity_basis_json)),
 FOREIGN KEY(syscall_call_id, sandbox_id) REFERENCES runtime_syscall_calls(id, sandbox_id),
 FOREIGN KEY(file_object_id, sandbox_id) REFERENCES file_objects(id, sandbox_id),
 CHECK (resolution_status!='supplied_only' OR supplied_path IS NOT NULL),
 CHECK (resolution_status NOT IN ('lexical','runtime_resolved') OR observed_path IS NOT NULL)
);
CREATE TABLE file_labels (
 id TEXT NOT NULL PRIMARY KEY,
 label TEXT NOT NULL,
 description TEXT NOT NULL
);
CREATE TABLE file_label_assignments (
 id TEXT NOT NULL PRIMARY KEY,
 target_id TEXT NOT NULL REFERENCES file_operation_targets(id),
 label_id TEXT NOT NULL REFERENCES file_labels(id),
 basis TEXT NOT NULL,
 confidence TEXT NOT NULL CHECK (confidence IN ('exact','corroborated','inferred')),
 rule_version TEXT NOT NULL,
 reason TEXT NOT NULL,
 assigned_at_ms INTEGER NOT NULL CHECK (typeof(assigned_at_ms)='integer')
);
CREATE INDEX file_objects_sandbox ON file_objects(sandbox_id, filesystem_identity, inode_number);
CREATE INDEX file_targets_call ON file_operation_targets(syscall_call_id);
CREATE INDEX file_targets_object ON file_operation_targets(file_object_id);
CREATE INDEX file_targets_path ON file_operation_targets(sandbox_id, observed_path);
CREATE INDEX file_assignments_target ON file_label_assignments(target_id);
CREATE INDEX file_assignments_label ON file_label_assignments(label_id, assigned_at_ms);
