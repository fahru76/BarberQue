-- Migration: a barber can be tied to at most ONE seat, period -- active or not.
--
-- Fahru's follow-up after the earlier fix (20260908135754_one_barber_per_active_seat.sql):
-- that migration only protected ACTIVE seats (`where active and barber_id is not
-- null`), so an INACTIVE seat could still hold a barber as a "placeholder" while
-- the admin UI let that same barber also be selected and activated on a
-- different seat -- exactly the confusing scenario Fahru reported (Kerusi 3
-- keeps a placeholder name; Kerusi 1 is then activated with the same name).
--
-- The simpler rule replacing it: a registered barber can only ever be assigned
-- to ONE seat slot at a time, whatever that seat's active/inactive state is.
-- The client (index.html's refreshBarberAssignmentDropdownOptions()) now
-- enforces this at the UI level too -- each seat's dropdown hides any staff
-- member already picked on a different seat -- so this constraint should
-- rarely if ever actually reject a write; it exists as the same defense-in-depth
-- backstop the previous partial index was.
drop index if exists seats_one_active_seat_per_barber_uidx;

create unique index seats_one_seat_per_barber_uidx
    on public.seats (barber_id)
    where barber_id is not null;
