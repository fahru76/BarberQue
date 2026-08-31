-- Local/preview seed data. Not applied to production by the GitHub integration.
--
-- Seats are created inactive with no barber: seats_active_requires_barber means
-- a chair cannot be opened until a real staff row is assigned to it, so there is
-- no way to seed a shop into an invalid state.
insert into public.seats (seat_no, active, barber_id)
select generate_series(1, 3), false, null
on conflict (seat_no) do nothing;
