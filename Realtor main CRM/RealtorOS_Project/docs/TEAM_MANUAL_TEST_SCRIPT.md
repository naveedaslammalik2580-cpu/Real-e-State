# Teams: 10-step manual test script

Covers what is live on `yanasorwmaybnabfuepn` as of 2026-10-06: T2a
(workspace foundation), T2b-1 (permissions), T2b-2 (RLS cutover),
T2c-pre (workspace-scoped foreign keys) and T2c (team-aware backend).

There is no Team UI yet (T4), so steps that need a second person use SQL
to create the membership. Everything a *user* does is done in the app.

**Before you start.** Note the two ids you will need:

```sql
select w.id as workspace_id, w.owner_user_id
  from public.workspaces w
  join public.contacts c on c.workspace_id = w.id
 group by w.id, w.owner_user_id
 order by count(c.id) desc
 limit 1;
```

Nothing below deletes data. Step 10 removes only the test agent created
in step 2.

---

### 1. The owner's app is unchanged

Sign in as the owner and open Contacts, Deals, Tasks, Properties,
Finance and Goals in turn.

**Expect:** everything looks exactly as it did before the teams work —
same counts, same rows, nothing missing and no errors in the console.
This is the single most important check: the owner's scope is `all`
everywhere, so every new policy should reduce to "my workspace".

### 2. Add an agent

```sql
-- Replace both ids with yours.
with ws as (select '<workspace_id>'::uuid as id, '<owner_user_id>'::uuid as owner)
insert into public.team_members (id, user_id, workspace_id, name, role, email, active)
select 'tm_test_agent', ws.owner, ws.id, 'Test Agent', 'Agent', '', true from ws;
```

Then create a real login for them (Supabase dashboard → Authentication →
Add user, e.g. `agent.test@yourdomain`), note the new user's id, and
link it:

```sql
with ws as (select '<workspace_id>'::uuid as id)
update public.workspace_members set status = 'removed'
 where user_id = '<agent_user_id>' and status = 'active';
insert into public.workspace_members (workspace_id, user_id, team_member_id, role, status)
select ws.id, '<agent_user_id>', 'tm_test_agent', 'agent', 'active' from ws;
update public.team_members set auth_user_id = '<agent_user_id>' where id = 'tm_test_agent';
```

**Expect:** both statements succeed. The `update ... set status='removed'`
is needed because signup now provisions every new user their own personal
workspace; one person may hold only one active membership.

### 3. The agent sees nothing yet

Sign in as the agent (a private window, so both sessions stay live) and
open Contacts.

**Expect:** an empty list. Every existing lead is unassigned, and the
agent preset has `unassigned_view = false`. This is the headline teams
behaviour: a new agent starts with no access to the book.

### 4. Assign one lead, and only that one appears

As the owner, pick a contact and assign it to Test Agent (or by SQL:
`update public.contacts set assigned_to_id = 'tm_test_agent' where id = '<contact_id>';`).

Refresh the agent's Contacts.

**Expect:** exactly one contact — the one just assigned. Not two, not
all of them.

### 5. The agent cannot reassign or delete

As the agent, open that contact and try to change the assigned agent,
then try to delete the contact.

**Expect:** the reassign is refused with a message about needing
permission (SQLSTATE 42501 from the assignment trigger), and the delete
does nothing — the agent preset has `contacts.delete = none`. Editing any
other field on that contact **should** work.

### 6. Finance is invisible to the agent

As the agent, open Finance.

**Expect:** empty, and creating a finance record is refused. The agent
preset has `finance` view/edit/delete `none` and `create false`.

### 7. A teammate can work on the owner's lead

This is what T2c-pre fixed. As the agent, on the lead from step 4, add a
task and log an activity.

**Expect:** both save. Before T2c-pre this failed with a foreign-key
error (23503), because the child row's creator had to match the parent
row's creator.

### 8. One person is one contact, team-wide

As the owner, import a small CSV with one row — say
`Jane Test, jane.test@example.com`. Then, as the agent, import a CSV
containing the same person.

**Expect:** the owner's import reports 1 added. The agent's import
reports 0 added (and 1 matched/updated). Contacts shows one Jane Test,
not two. Check the shared allowance while you are there — both people
should see the same "used" and "remaining" in the import dialog, because
the 200/day allowance is the workspace's, not each member's.

> If a five-person team sharing 200 new contacts a day is too tight, it
> is one line: `automation_internal.file_import_daily_limit()`.

### 9. Imported leads arrive unassigned

Look at Jane Test from step 8.

**Expect:** no assigned agent. Imports deliberately land unassigned so a
manager distributes them, rather than silently belonging to whoever
uploaded the file.

### 10. Clean up the test agent

```sql
update public.workspace_members set status = 'removed'
 where team_member_id = 'tm_test_agent';
update public.contacts set assigned_to_id = null where assigned_to_id = 'tm_test_agent';
delete from public.team_members where id = 'tm_test_agent';
```

Then delete the test login in the dashboard, and delete Jane Test in the
app if you do not want her.

**Expect:** the owner's Contacts is back to what step 1 showed. The
`update contacts` line is belt-and-braces — the foreign key would null
`assigned_to_id` by itself, and would leave `workspace_id` intact.

---

## Known gaps (do not test these yet)

* ~~Replies, unsubscribes and bounces on a teammate's lead are silently
  not recorded.~~ **Fixed** by T2c-post (`20261007033030`): 21 functions
  now resolve rows by workspace, including the worker claim query, which
  previously never picked up a job whose rule belonged to a teammate. If
  you want to exercise it, a reply or unsubscribe on a lead another member
  created should now set the lifecycle marker, suppress the address, stop
  the matching automations and notify the right people.
* No Team UI, no invitation flow, no ownership transfer (T3, T4).
* The frontend is not workspace-aware yet (T2d): it still filters by
  `user_id`, which is harmless for the owner but means an agent's views
  are narrower than their permissions allow.
