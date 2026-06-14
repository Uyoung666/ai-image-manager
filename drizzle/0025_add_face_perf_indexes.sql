CREATE INDEX idx_face_vectors_photo_id ON face_vectors(photo_id);
--> statement-breakpoint
CREATE INDEX idx_face_id_member_fv_id ON face_identity_members(face_vector_id);
--> statement-breakpoint
CREATE INDEX idx_face_identities_rep_photo ON face_identities(representative_photo_id);
