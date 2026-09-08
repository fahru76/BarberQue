-- Migration: a barber can only be assigned to one ACTIVE seat at a time.
--
-- Fahru's report: with 2 or 3 active seats, the admin UI let the same
-- registered barber be assigned to more than one active seat at once --
-- something no real barber can do (they can only physically stand at one
-- chair). index.html's saveBarberAssignments() now rejects this before
-- saving (client-side UX), but per this project's own security posture
-- (see CLAUDE.md: "never trust client-side validation alone"), the
-- invariant belongs in the database too -- the same way
-- seats_active_requires_barber already does for "an active seat needs a
-- barber" and staff_name_key_uidx already does for staff name uniqueness.
--
-- A PARTIAL unique index (only over active=true rows) is the right shape,
-- not a plain unique constraint on barber_id -- an INACTIVE seat's stored
-- barber_id is just a placeholder for when it reopens (findNextSeatStart()
-- and every wait-time estimate already only ever consider active seats),
-- so two inactive seats -- or one active and any number of inactive ones --
-- sharing a barber_id is not a real conflict and must stay allowed.
create unique index seats_one_active_seat_per_barber_uidx
    on public.seats (barber_id)
    where active and barber_id is not null;
