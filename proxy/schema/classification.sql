-- Classification reference and derived results. No classifier executes here.
CREATE TABLE classification_versions (
 id TEXT NOT NULL PRIMARY KEY,
 catalog_version TEXT NOT NULL,
 classifier_version TEXT NOT NULL,
 content_sha256 TEXT NOT NULL CHECK (length(content_sha256)=64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'),
 created_at_ms INTEGER NOT NULL CHECK (typeof(created_at_ms)='integer'),
 description TEXT NOT NULL
);
CREATE TABLE classification_impact_levels (
 level INTEGER NOT NULL PRIMARY KEY CHECK (typeof(level)='integer' AND level BETWEEN 0 AND 3),
 label TEXT NOT NULL,
 description TEXT NOT NULL
);
CREATE TABLE classification_categories (
 id TEXT NOT NULL PRIMARY KEY,
 label TEXT NOT NULL,
 description TEXT NOT NULL
);
CREATE TABLE classification_syscall_rules (
 version_id TEXT NOT NULL REFERENCES classification_versions(id),
 syscall_name TEXT NOT NULL,
 description TEXT NOT NULL,
 category_id TEXT NOT NULL REFERENCES classification_categories(id),
 default_impact_level INTEGER REFERENCES classification_impact_levels(level),
 rule_identifier TEXT NOT NULL,
 required_evidence_json TEXT NOT NULL CHECK (json_valid(required_evidence_json) AND json_type(required_evidence_json)='array'),
 interpretation_notes TEXT NOT NULL,
 PRIMARY KEY(version_id, syscall_name)
);
CREATE TABLE classification_results (
 id TEXT NOT NULL PRIMARY KEY,
 syscall_call_id TEXT NOT NULL REFERENCES runtime_syscall_calls(id),
 version_id TEXT NOT NULL REFERENCES classification_versions(id),
 input_sha256 TEXT NOT NULL CHECK (length(input_sha256)=64 AND input_sha256 NOT GLOB '*[^0-9a-f]*'),
 category_id TEXT REFERENCES classification_categories(id),
 operation_level INTEGER REFERENCES classification_impact_levels(level),
 confirmed_effect_level INTEGER REFERENCES classification_impact_levels(level),
 effect_status TEXT NOT NULL CHECK (effect_status IN ('confirmed','no_effect','unknown','not_applicable')),
 reason TEXT NOT NULL,
 classified_at_ms INTEGER NOT NULL CHECK (typeof(classified_at_ms)='integer'),
 UNIQUE(syscall_call_id, version_id, input_sha256),
 CHECK (effect_status='confirmed' OR confirmed_effect_level IS NULL),
 CHECK (effect_status!='confirmed' OR confirmed_effect_level IS NOT NULL)
);
CREATE INDEX classification_rules_category ON classification_syscall_rules(category_id, version_id);
CREATE INDEX classification_results_version ON classification_results(version_id, classified_at_ms);
CREATE INDEX classification_results_category ON classification_results(category_id, operation_level);
CREATE TRIGGER classification_confirmed_success BEFORE INSERT ON classification_results
WHEN NEW.effect_status='confirmed' AND NOT EXISTS (
 SELECT 1 FROM runtime_syscall_calls WHERE id=NEW.syscall_call_id AND outcome='succeeded'
)
BEGIN SELECT RAISE(ABORT, 'confirmed effect requires a successful syscall'); END;
CREATE TRIGGER classification_versions_no_update BEFORE UPDATE ON classification_versions
BEGIN SELECT RAISE(ABORT, 'classification_versions is append-only'); END;
CREATE TRIGGER classification_versions_no_delete BEFORE DELETE ON classification_versions
BEGIN SELECT RAISE(ABORT, 'classification_versions is append-only'); END;
CREATE TRIGGER classification_versions_no_replace BEFORE INSERT ON classification_versions
WHEN EXISTS (SELECT 1 FROM classification_versions WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'classification_versions existing key cannot be replaced'); END;
CREATE TRIGGER classification_impact_levels_no_update BEFORE UPDATE ON classification_impact_levels
BEGIN SELECT RAISE(ABORT, 'classification_impact_levels is append-only'); END;
CREATE TRIGGER classification_impact_levels_no_delete BEFORE DELETE ON classification_impact_levels
BEGIN SELECT RAISE(ABORT, 'classification_impact_levels is append-only'); END;
CREATE TRIGGER classification_impact_levels_no_replace BEFORE INSERT ON classification_impact_levels
WHEN EXISTS (SELECT 1 FROM classification_impact_levels WHERE level=NEW.level)
BEGIN SELECT RAISE(ABORT, 'classification_impact_levels existing key cannot be replaced'); END;
CREATE TRIGGER classification_categories_no_update BEFORE UPDATE ON classification_categories
BEGIN SELECT RAISE(ABORT, 'classification_categories is append-only'); END;
CREATE TRIGGER classification_categories_no_delete BEFORE DELETE ON classification_categories
BEGIN SELECT RAISE(ABORT, 'classification_categories is append-only'); END;
CREATE TRIGGER classification_categories_no_replace BEFORE INSERT ON classification_categories
WHEN EXISTS (SELECT 1 FROM classification_categories WHERE id=NEW.id)
BEGIN SELECT RAISE(ABORT, 'classification_categories existing key cannot be replaced'); END;
CREATE TRIGGER classification_syscall_rules_no_update BEFORE UPDATE ON classification_syscall_rules
BEGIN SELECT RAISE(ABORT, 'classification_syscall_rules is append-only'); END;
CREATE TRIGGER classification_syscall_rules_no_delete BEFORE DELETE ON classification_syscall_rules
BEGIN SELECT RAISE(ABORT, 'classification_syscall_rules is append-only'); END;
CREATE TRIGGER classification_syscall_rules_no_replace BEFORE INSERT ON classification_syscall_rules
WHEN EXISTS (SELECT 1 FROM classification_syscall_rules WHERE version_id=NEW.version_id AND syscall_name=NEW.syscall_name)
BEGIN SELECT RAISE(ABORT, 'classification_syscall_rules existing key cannot be replaced'); END;
CREATE TRIGGER classification_results_no_update BEFORE UPDATE ON classification_results
BEGIN SELECT RAISE(ABORT, 'classification_results is append-only'); END;
CREATE TRIGGER classification_results_no_delete BEFORE DELETE ON classification_results
BEGIN SELECT RAISE(ABORT, 'classification_results is append-only'); END;
CREATE TRIGGER classification_results_no_replace BEFORE INSERT ON classification_results
WHEN EXISTS (SELECT 1 FROM classification_results WHERE id=NEW.id OR
 (syscall_call_id=NEW.syscall_call_id AND version_id=NEW.version_id AND input_sha256=NEW.input_sha256))
BEGIN SELECT RAISE(ABORT, 'classification_results existing key cannot be replaced'); END;
