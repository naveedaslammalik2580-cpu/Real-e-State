# U1c header search and creation menu

The header provides Search (Ctrl/Cmd+K) and + New. Search uses the existing
Contacts, Deals, Properties and Tasks store facades. New opens the existing
contact Quick Add, Deal, Task, Showing and Activity forms; Log a Call prefills
Activity type Call. The mobile Add button and FAB remain contact-only.

## Search coverage

Search matches names/titles and the context fields shown in each result. It
requires two characters, debounces for 200ms, and shows at most eight matches
per entity type. Tasks open /tasks because there is no task detail route.

The existing list API reads the rows returned by the authenticated table API;
it has no pagination interface or server-side text-search endpoint. Search
therefore covers only those returned rows, subject to the server's configured
response limit. It does not guarantee exhaustive results in large workspaces.
The search dialog displays this limitation. Adding complete paginated or
server-side search is separate work; no endpoint, RPC or SQL was added here.

## Isolation and lifecycle

Module visibility and effective view permission are checked before requesting
an entity. Requests use the existing authenticated client and RLS policies;
there are no service-role calls or client-side substitutes for row authorization.
The opt-in list option cache:false bypasses both reads and writes of the shared
entity cache. Other callers retain their existing caching behavior.

Results are held only in the open search instance. User, workspace, permission
and module context changes invalidate the instance. Query generations discard
outdated responses. Auth/workspace events and the shell's module refresh close
search and clear its visible contents. A new user cannot reuse the previous
identity's effective permissions before workspace context refreshes. Search
queries and results are never saved to localStorage or sessionStorage.

## Verification limits

Frontend tests use local fixtures, including actual canonical forms and the
real data-service cache path. They do not query live Supabase or revalidate
production RLS. The U1c browser tool failed initialization; desktop/narrow
layout, light/dark visual contrast, native keyboard behavior and screen-reader
checks still need a browser pass before visual sign-off.
