-- Rollback-safe BEHAVIOURAL verification of the capability hard gate in
-- public.call_next_customer().
--
-- WHY THIS FILE EXISTS
-- The 2026-09-16 bug hunt found that the capability "hard gate" read
-- `service_ids && v_capability` -- array OVERLAP, "at least one of this
-- ticket's services is in the barber's capability set". The column's documented
-- contract is a SUBSET gate: every service on the ticket must be one the barber
-- may perform, "never called for it, no fallback". Overlap and subset agree for
-- a single-service ticket and disagree for every multi-service one -- and
-- multi-service is the normal UI path, since index.html renders one checkbox
-- per service and collects them all.
--
-- That fix is a static reading of SQL. `tests/sql-consistency.mjs` checks
-- structure, not predicate semantics, so it cannot catch this class of bug; it
-- stayed green through every migration that shipped the wrong operator. This
-- file is the execution that closes the gap.
--
-- SAFETY
-- Everything below runs inside the Management API request's own transaction and
-- ends in `raise exception 'PASSED'`, so the transaction aborts and NO fixture
-- row is ever committed. The workflow issues a follow-up read-only count of
-- rows with id like 'VR-%' to verify that, rather than taking it on trust.
--
-- HOW TO READ THE RESULT
-- The check PASSES when the API returns an error whose message contains
-- 'PASSED'. That is the deliberate abort. Any other error message is a real
-- failure and names the scenario that broke. An HTTP 2xx response is also a
-- failure: it means the block never reached its raise.
--
-- TWO CONSTRAINTS THE FIRST LIVE RUN TAUGHT THIS FILE (both invisible to every
-- static check, because none of them execute SQL):
--
--   1. A BEFORE INSERT trigger on public.queues,
--      recompute_walkin_price_from_services(), rejects any source='walkin' row
--      whose service_ids do not resolve to at least one ACTIVE
--      public.services row. Invented ids therefore cannot be used -- the
--      fixture creates its own catalog entries.
--   2. That same trigger requires service_ids to be non-null for a walkin
--      insert, so scenario C (NULL service_ids) CANNOT be fabricated as a
--      walk-in at all. It is built as source='booking' instead -- the path
--      checkin_appointment() takes, which legitimately produces a NULL
--      service_ids row when the appointment predates the snapshot column.
--
-- The fixture inserts into auth.users because public.staff.id has a foreign key
-- to it. That is the only part of this file coupled to Supabase's own auth
-- schema -- see README.md.

do $verify$
declare
    -- Random per-run suffix: fixtures must never collide with live rows, and a
    -- re-run must never trip over a leftover from a previous attempt.
    v_run  text := substr(replace(gen_random_uuid()::text, '-', ''), 1, 10);

    v_barber_a uuid := gen_random_uuid();   -- capability [fade]
    v_barber_b uuid := gen_random_uuid();   -- capability [fade]
    v_barber_c uuid := gen_random_uuid();   -- capability [perm]
    v_barber_d uuid := gen_random_uuid();   -- capability NULL (unrestricted)

    v_t_a  text := 'VR-' || v_run || '-A';
    v_t_b  text := 'VR-' || v_run || '-B';
    v_t_c  text := 'VR-' || v_run || '-C';
    v_t_d  text := 'VR-' || v_run || '-D';

    -- Real service ids. See constraint 1 in the header: the walk-in trigger
    -- rejects service_ids that do not resolve to an ACTIVE public.services row,
    -- so these must exist before any ticket is inserted.
    v_svc_fade text := 'VR-' || v_run || '-SVC-FADE';
    v_svc_perm text := 'VR-' || v_run || '-SVC-PERM';

    v_row      public.queues;
    v_uid      uuid;
    v_failures text := '';
begin

    ------------------------------------------------------------------
    -- Fixtures: a services catalog, four staff rows, four open seats.
    ------------------------------------------------------------------

    -- The shop's own catalog, which the walk-in trigger reads. `name_key` is
    -- generated and unique, so the per-run suffix keeps re-runs from colliding.
    insert into public.services
        (id, name, price_sen, duration_minutes, active, category, target, type, sort_order)
    values
        (v_svc_fade, 'VR Fade ' || v_run, 2500, 20, true, 'asas',    'semua', 'gunting', 0),
        (v_svc_perm, 'VR Perm ' || v_run, 5000, 40, true, 'fashion', 'semua', 'lain',    0);

    -- Inserting into auth.users fires public.handle_new_staff_user(), which
    -- creates the public.staff row with active = false. That is the real
    -- production path, so the fixture exercises it rather than bypassing it.
    insert into auth.users (
        instance_id, id, aud, role, email, encrypted_password,
        email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
        created_at, updated_at
    )
    select
        '00000000-0000-0000-0000-000000000000', b.id, 'authenticated', 'authenticated',
        'verify-' || b.id || '@queuecut.invalid', crypt('verify', gen_salt('bf')),
        now(), '{"provider":"email","providers":["email"]}'::jsonb, '{}'::jsonb,
        now(), now()
      from (values (v_barber_a), (v_barber_b), (v_barber_c), (v_barber_d)) as b(id);

    update public.staff
       set active = true,
           capability_service_ids = case id
                                        when v_barber_a then array[v_svc_fade]
                                        when v_barber_b then array[v_svc_fade]
                                        when v_barber_c then array[v_svc_perm]
                                        else null
                                    end,
           specialty_service_ids  = null
     where id in (v_barber_a, v_barber_b, v_barber_c, v_barber_d);

    -- One open seat per barber. seats_active_requires_barber means an active
    -- seat must carry a barber, so both are set in the same insert.
    insert into public.seats (seat_no, active, barber_id) values
        (1, true, v_barber_a),
        (2, true, v_barber_b),
        (3, true, v_barber_c),
        (4, true, v_barber_d)
    on conflict (seat_no) do update
        set active = excluded.active, barber_id = excluded.barber_id;

    -- Park every pre-existing row that could be selected instead of a fixture.
    --
    -- call_next_customer() reads ALL waiting rows, not just this
    -- transaction's, and it also refuses a seat that is already serving. A
    -- real waiting ticket (or a serving one at one of these seats) would
    -- therefore be picked ahead of the fixture and every assertion below
    -- would report a false failure -- a test that is only correct on an empty
    -- queue is not a test. Parking them here is a visibility change inside a
    -- transaction that always rolls back; the workflow's closing
    -- read-only count of 'VR-%' rows proves nothing persisted.
    update public.queues
       set status = 'done', completed_at = now()
     where status = 'waiting'
       and id not like 'VR-%';

    update public.queues
       set status = 'done', completed_at = now()
     where status = 'serving'
       and seat_no in (1, 2, 3, 4);

    -- Sanity: if auth.uid() does not resolve, every scenario below would fail
    -- with 42501 and the real reason would be buried. Check it explicitly.
    perform set_config('request.jwt.claims',
                       json_build_object('sub', v_barber_a::text)::text,
                       true);
    v_uid := auth.uid();
    if v_uid is distinct from v_barber_a then
        raise exception 'VERIFY SETUP FAILED: set_config did not drive auth.uid() (got %, wanted %). The GUC name or the Supabase auth shim has changed.',
            v_uid, v_barber_a;
    end if;

    ------------------------------------------------------------------
    -- Scenario A -- THE REGRESSION TEST.
    --
    -- Barber A may perform fade only. The single waiting ticket needs
    -- fade AND perm. Under the old overlap predicate this returns the
    -- ticket and marks it serving; under the subset gate it must raise P0002.
    ------------------------------------------------------------------

    insert into public.queues (id, ticket_no, name, claim_token, service,
                               duration_minutes, price_sen, source, service_ids)
    values (v_t_a, v_t_a, 'Verify A', gen_random_uuid(), 'VR Fade + Perm',
            1, 1, 'walkin', array[v_svc_fade, v_svc_perm]);

    perform set_config('request.jwt.claims',
                       json_build_object('sub', v_barber_a::text)::text, true);

    begin
        v_row := public.call_next_customer(1);
        v_failures := v_failures ||
            format('A: call_next_customer(1) returned %s, but the only waiting ticket (%s) needs a service outside this barber''s capability. Expected P0002. ',
                   v_row.id, v_t_a);
    exception
        when sqlstate 'P0002' then
            null;   -- correct: nothing this barber may do
        when others then
            v_failures := v_failures ||
                format('A: expected P0002, got %s (%s). ', sqlstate, sqlerrm);
    end;

    -- Clear the ticket so the next scenario sees exactly one waiting row.
    update public.queues
       set status = 'cancelled', cancelled_at = now(),
           cancel_reason = 'verification fixture'
     where id = v_t_a;

    ------------------------------------------------------------------
    -- Scenario B -- single-service ticket, inside capability. Must still work.
    ------------------------------------------------------------------

    insert into public.queues (id, ticket_no, name, claim_token, service,
                               duration_minutes, price_sen, source, service_ids)
    values (v_t_b, v_t_b, 'Verify B', gen_random_uuid(), 'VR Fade',
            1, 1, 'walkin', array[v_svc_fade]);

    perform set_config('request.jwt.claims',
                       json_build_object('sub', v_barber_b::text)::text, true);

    begin
        v_row := public.call_next_customer(2);
        if v_row.id is distinct from v_t_b then
            v_failures := v_failures ||
                format('B: expected %s, got %s. ', v_t_b, v_row.id);
        end if;
        if v_row.status is distinct from 'serving' then
            v_failures := v_failures ||
                format('B: ticket status is %s, expected serving. ', v_row.status);
        end if;
        if v_row.seat_no is distinct from 2 then
            v_failures := v_failures ||
                format('B: seat_no is %s, expected 2. ', v_row.seat_no);
        end if;
        if v_row.barber_id is distinct from v_barber_b then
            v_failures := v_failures ||
                format('B: barber_id is %s, expected the seat''s barber %s. ',
                       v_row.barber_id, v_barber_b);
        end if;
    exception
        when others then
            v_failures := v_failures ||
                format('B: call_next_customer(2) raised %s (%s) but should have succeeded. ',
                       sqlstate, sqlerrm);
    end;

    update public.queues
       set status = 'done', completed_at = now()
     where id = v_t_b;

    ------------------------------------------------------------------
    -- Scenario C -- NULL service_ids stays "unknown, compatible".
    --
    -- This is documented, deliberate behaviour: a ticket created before the
    -- snapshot column existed, or by a path that predates it, must not be
    -- stranded just because its service set is unknown. A fix that tightened
    -- this to "exclude NULL" would fail here.
    --
    -- Built as source='booking', NOT 'walkin'. The walk-in trigger requires a
    -- non-null service_ids and rejects this row outright -- see constraint 2 in
    -- the header. source='booking' is the path checkin_appointment() uses, and
    -- it legitimately yields a NULL service_ids row for an appointment that
    -- predates the snapshot column.
    ------------------------------------------------------------------

    insert into public.queues (id, ticket_no, name, claim_token, service,
                               duration_minutes, price_sen, source, service_ids)
    values (v_t_c, v_t_c, 'Verify C', gen_random_uuid(), 'Unknown Service',
            25, 3000, 'booking', null);

    perform set_config('request.jwt.claims',
                       json_build_object('sub', v_barber_c::text)::text, true);

    begin
        v_row := public.call_next_customer(3);
        if v_row.id is distinct from v_t_c then
            v_failures := v_failures ||
                format('C: expected the NULL-service_ids ticket %s to be treated as compatible, got %s. ',
                       v_t_c, v_row.id);
        end if;
    exception
        when others then
            v_failures := v_failures ||
                format('C: call_next_customer(3) raised %s (%s); a NULL service_ids ticket must not be excluded. ',
                       sqlstate, sqlerrm);
    end;

    update public.queues
       set status = 'done', completed_at = now()
     where id = v_t_c;

    ------------------------------------------------------------------
    -- Scenario D -- unrestricted barber (capability IS NULL) is unaffected.
    ------------------------------------------------------------------

    insert into public.queues (id, ticket_no, name, claim_token, service,
                               duration_minutes, price_sen, source, service_ids)
    values (v_t_d, v_t_d, 'Verify D', gen_random_uuid(), 'VR Fade + Perm',
            1, 1, 'walkin', array[v_svc_fade, v_svc_perm]);

    perform set_config('request.jwt.claims',
                       json_build_object('sub', v_barber_d::text)::text, true);

    begin
        v_row := public.call_next_customer(4);
        if v_row.id is distinct from v_t_d then
            v_failures := v_failures ||
                format('D: expected %s for an unrestricted barber, got %s. ',
                       v_t_d, v_row.id);
        end if;
    exception
        when others then
            v_failures := v_failures ||
                format('D: call_next_customer(4) raised %s (%s) for a barber with capability_service_ids IS NULL, who is unrestricted. ',
                       sqlstate, sqlerrm);
    end;

    ------------------------------------------------------------------
    -- Verdict. Raising here aborts the whole transaction, fixtures included.
    ------------------------------------------------------------------

    if v_failures <> '' then
        raise exception 'VERIFICATION FAILED: %', v_failures;
    end if;

    raise exception 'PASSED: capability gate holds. A (multi-service outside capability) raised P0002; B (single-service inside capability) served with the correct id/status/seat/barber; C (NULL service_ids, source=booking) served as compatible; D (unrestricted barber) served. Transaction rolled back, no fixture committed.'
        using errcode = 'P0001';
end
$verify$;