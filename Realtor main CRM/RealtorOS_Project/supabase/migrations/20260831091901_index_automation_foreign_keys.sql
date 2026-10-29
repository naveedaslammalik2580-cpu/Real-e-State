-- Cover every composite foreign key added by the automation foundation.

create index automation_enrollments_source_batch_fkey_idx
  on public.automation_enrollments (user_id, source_batch_id)
  where source_batch_id is not null;

create index automation_failures_job_fkey_idx
  on public.automation_failures (user_id, job_id)
  where job_id is not null;

create index automation_failures_run_fkey_idx
  on public.automation_failures (user_id, run_id)
  where run_id is not null;

create index automation_jobs_contact_fkey_idx
  on public.automation_jobs (user_id, contact_id)
  where contact_id is not null;

create index automation_jobs_rule_fkey_idx
  on public.automation_jobs (user_id, rule_id)
  where rule_id is not null;

create index automation_jobs_step_fkey_idx
  on public.automation_jobs (user_id, step_id)
  where step_id is not null;

create index automation_runs_enrollment_fkey_idx
  on public.automation_runs (user_id, enrollment_id)
  where enrollment_id is not null;

create index automation_steps_template_fkey_idx
  on public.automation_steps (user_id, template_id)
  where template_id is not null;

create index outbound_messages_job_fkey_idx
  on public.outbound_messages (user_id, job_id)
  where job_id is not null;

create index outbound_messages_template_fkey_idx
  on public.outbound_messages (user_id, template_id)
  where template_id is not null;
