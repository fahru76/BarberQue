-- Read-only assertion that the capability-gate migration is APPLIED, not just
-- present in the source tree.
--
-- Sent with `read_only: true`, so this must remain a single SELECT. Returns one
-- row: `ok`, `problem_count`, and a `problems` array naming every failed check.
-- The workflow fails the job when `ok` is not true.
--
-- Why this exists separately from tests/sql-consistency.mjs: that script parses
-- migration TEXT. It cannot see the deployed function body, so it stayed green
-- through three migrations that shipped `service_ids && v_capability` where the
-- documented contract required a subset check. `pg_get_functiondef()` reads
-- what is actually running.

with problems as (

    select 'staff.capability_service_ids is missing' as problem
     where not exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'staff'
           and column_name = 'capability_service_ids'
     )

    union all

    select 'staff.specialty_service_ids is missing'
     where not exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'staff'
           and column_name = 'specialty_service_ids'
     )

    union all

    select 'queues.service_ids is missing'
     where not exists (
        select 1 from information_schema.columns
         where table_schema = 'public' and table_name = 'queues'
           and column_name = 'service_ids'
     )

    union all

    select 'constraint staff_specialty_subset_of_capability is missing'
     where not exists (
        select 1
          from pg_constraint c
          join pg_class     t on t.oid = c.conrelid
          join pg_namespace n on n.oid = t.relnamespace
         where n.nspname = 'public'
           and t.relname = 'staff'
           and c.conname = 'staff_specialty_subset_of_capability'
     )

    -- The operator check. This is the assertion the whole file exists for.
    union all

    select 'call_next_customer() deployed body does not contain the subset form "service_ids <@ v_capability"'
     where not exists (
        select 1
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'call_next_customer'
           and pg_get_functiondef(p.oid) like '%service_ids <@ v_capability%'
     )

    union all

    select 'call_next_customer() deployed body still contains the overlap form "service_ids && v_capability"'
     where exists (
        select 1
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'call_next_customer'
           and pg_get_functiondef(p.oid) like '%service_ids && v_capability%'
     )

    -- list_today_queues_full(): return type must be an explicit column list,
    -- must not name claim_token, and must still carry every column the client
    -- mapper reads. `SETOF public.queues` would satisfy the second check
    -- vacuously, so the TABLE( check is what catches an un-applied migration.
    union all

    select 'list_today_queues_full() still returns SETOF <table> rather than an explicit TABLE(...) column list'
     where exists (
        select 1
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'list_today_queues_full'
           and position('TABLE(' in pg_get_function_result(p.oid)) = 0
     )

    union all

    select 'list_today_queues_full() return type names claim_token'
     where exists (
        select 1
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'list_today_queues_full'
           and position('claim_token' in pg_get_function_result(p.oid)) > 0
     )

    union all

    select 'list_today_queues_full() return type omits barber_name (queueRepository.js mapQueueRowFull reads it)'
     where not exists (
        select 1
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'list_today_queues_full'
           and position('barber_name' in pg_get_function_result(p.oid)) > 0
     )

    -- list_active_appointments(): same shape of assertion, against the columns
    -- appointmentRepository.js listActiveAppointments() actually maps.
    union all

    select 'list_active_appointments() still returns SETOF <table> rather than an explicit TABLE(...) column list'
     where exists (
        select 1
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'list_active_appointments'
           and position('TABLE(' in pg_get_function_result(p.oid)) = 0
     )

    union all

    select 'list_active_appointments() return type names claim_token'
     where exists (
        select 1
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'list_active_appointments'
           and position('claim_token' in pg_get_function_result(p.oid)) > 0
     )

    union all

    select 'list_active_appointments() return type omits appt_date (appointmentRepository.js maps it)'
     where not exists (
        select 1
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'list_active_appointments'
           and position('appt_date' in pg_get_function_result(p.oid)) > 0
     )

    union all

    select 'list_active_appointments() return type omits revoked_reason (appointmentRepository.js maps it)'
     where not exists (
        select 1
          from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public'
           and p.proname = 'list_active_appointments'
           and position('revoked_reason' in pg_get_function_result(p.oid)) > 0
     )

)
select
    (select count(*) from problems) = 0                            as ok,
    (select count(*) from problems)                                as problem_count,
    (select coalesce(json_agg(problem order by problem), '[]'::json)) as problems;