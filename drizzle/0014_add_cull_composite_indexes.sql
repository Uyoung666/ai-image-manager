DROP INDEX IF EXISTS `idx_cal_session_id`;
--> statement-breakpoint
CREATE INDEX `idx_cal_session_created` ON `cull_action_logs` (`session_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `idx_csp_session_status` ON `cull_session_photos` (`session_id`, `status`);
