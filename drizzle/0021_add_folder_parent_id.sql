ALTER TABLE folders ADD COLUMN parent_id INTEGER REFERENCES folders(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX idx_folders_parent_id ON folders(parent_id);
