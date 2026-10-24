# RealtorOS UX — U0 navigation and route audit

Date: 2026-10-16 (Asia/Karachi). Source baseline: HEAD `23ce58b0131d31e3313a1a7044b0eb732d17dff0` plus the existing working tree.

## Scope and verification limits

Read CLAUDE.md and AGENTS.md. This is a local source audit, not a live deployment inspection. No repository files changed; no tests, installs, live SQL, network requests or deployments performed. Existing uncommitted test changes were left intact. Only this report was created, outside the repository. Historical comments about deployment state are not evidence of current deployment state.

Source evidence below includes exact navigation/route tables and file/line inventories. Static inventories include comments, historical migrations and dynamic consumers deliberately. They enumerate repository link sites, not unknown external bookmarks or arbitrary URLs already stored in a live database. Existing URL contracts must remain accepted for those cases.

## 0. Settings prerequisite — PASS

Commit **23ce58b — Fix: settings save filter, retry cap, Settings nav** is committed and is HEAD, dated 2026-10-16 15:28:22 +0500. Inspected git log and git show, including the actual diff.

- `data/data-service.js`: requireWorkspaceId_ rejects unfiltered writes; four workspace_settings write paths filter by workspace_id. SETTINGS_MAX_ATTEMPTS is 3; permanent errors stop retrying. Personal notification user_id filters and scoped workspace_state deletion are restored.
- `app.js`: Settings no longer has needsSettings gating. The pinned sidebar gear, System > Settings, and avatar > Settings all navigate to `/settings`. Mobile More opens the same drawer containing the gear. Category routes remain registered.
- The commit includes settings-nav and settings-save regression tests. No uncommitted app.js/data-service.js changes were present at audit start.

Settings is reachable according to current code; no live browser click was performed. The prerequisite passes and permits this audit.

## 1. Exact current navigation

The source-derived navigation table below records every item, order, icon key, route, module ID and additional shell gate. Group rail order/icons: Workspace/grid; CRM/users; Transactions/map; Automation/zap; Operations/check; Business/wallet; System/cog.

The current desktop sidebar has a group icon rail plus one selected submenu panel. Empty groups disappear. The selected group follows the active route. Visibility combines module flags with navItemAllowed:

- Referrals, Commission and Income & Expenses require finance.view != none; Goals requires goals.view != none.
- Team requires customization.teamMode AND effective team_manage permission.
- Other items have no additional shell permission gate. Data access still uses RLS and backend permissions. Settings must remain reachable even when settings permission is absent.
- App.workspace uses realtoros_my_permissions, effective scopes/booleans and explicit owner checks. Role labels are not a substitute for these permissions. If App.workspace is absent the shell tolerates it; loaded accessors fail closed on missing permission values.

Header DOM order: mobile menu, RealtorOS brand/breadcrumbs, theme toggle, injected contact quick-add `+`, per-page topActions, notifications bell, avatar. **No global header search exists.** Current `+` means Add a contact, not a multi-entity New menu.

Mobile 3A order: Today/sun → `/daily` (daily flag); Contacts/users → `/contacts`; Add/plus → quickAdd; Pipeline/columns → `/pipeline`; More/menu → existing sidebar drawer. Module filters apply to route tabs, not Add/More. Prefix matching highlights detail routes. Bottom bar appears <=767px; drawer begins <=900px. Between 768–900px the floating quick-add button remains. Proposed Deals is initially a label change from Pipeline.

Avatar menu: signed-in identity, Edit account (modal), Settings (`/settings`), Business profile (`/settings/business-profile`), Sign out. Auth identity and workspace business identity are separate stores.

Settings groups, exact order and icon keys (each category path is `/settings/<id>`):

| Group | Label | ID | Icon | Visibility |
|---|---|---|---|---|
| SETUP | Business Profile | business-profile | cog | normal |
| SETUP | Pipeline | pipeline | columns | normal |
| SETUP | Google Sheets | google-sheets | grid | normal |
| SETUP | Import History | sheet-imports | activity | normal |
| SETUP | Email Sending | email-sending | chart | normal |
| SETUP | Notifications | notifications | bell | normal |
| SETUP | Data & Safety | data-safety | save | normal |
| CUSTOMIZE | Modules | modules | spark | normal |
| CUSTOMIZE | Dashboard | dashboard | chart | normal |
| CUSTOMIZE | Custom Fields | custom-fields | edit | normal |
| TEAM | Team & Access | team-access | users | normal; pane enforces permissions |
| TEAM | What people can do | team-permissions | lock | category nav requires team mode |

`/settings` opens Overview; Overview is not another category item. Unknown category falls back to Overview. Business Profile has dirty-form leave confirmation. Setup guide/install entry points exist inside Settings. Team panes enforce team_manage and owner/grant ceilings; category visibility is not authorization to write.

## 2. Every registered route

The generated route table below lists every top-level page, detail pattern and compatibility branch. All are hash routes handled in `app/assets/js/app.js`, principally navigate/parseHash/route around lines 915–1030. Empty hash and `/` land on Dashboard. Unknown paths render Coming Soon, not a registered hidden page.

Module guards resolve exact path then base segment through NAV. Permission guards compare exact NAV paths. If NAV is reduced to hub entries without independent route metadata, old module/permission behavior can be lost. Preserve the registry separately from presentation.

There is **no generic query parser**. `/contacts?type=Buyer` is not currently a valid filtered-list contract. Detail regexes capture one non-slash segment unchanged; do not double-decode IDs. Only Settings category handling and Join explicitly parse queries.

Settings dispatch is `release.renderSettings(container, category)` → `renderSettingsCategory` in pages/release.js:

| Category | Actual handler | File under app/assets/js/ | Further behavior |
|---|---|---|---|
| overview / missing / unknown | renderSettingsOverview | pages/release.js | landing cards |
| business-profile | renderBusinessProfileCategory | pages/release.js | validation, dirty state |
| pipeline | renderPipelineCategory | pages/release.js | loads deals, edits stages |
| modules | renderModulesCategory | pages/release.js | stable module IDs |
| dashboard | renderDashboardCategory | pages/release.js | widget order/visibility |
| custom-fields | customFieldsSettings.render | pages/custom-fields-settings.js | existing CRUD |
| team-access | teamManagement.render | pages/team-management.js | team_manage; owner danger actions; nonmanager leave flow |
| team-permissions?member=<id> | teamPermissions.render(pane, member) | pages/team-permissions.js | decoded member; teamMode + team_manage + grant ceilings |
| google-sheets | googleSheetsSettings.render | pages/google-sheets-settings.js | integration/backend checks |
| sheet-imports | googleSheetsImportHistory.render | pages/google-sheets-import-history.js | scoped import history |
| email-sending | emailSendingSettings.render | pages/email-sending-settings.js | sender settings and test flow |
| notifications | pushSettings.render | pages/push-settings.js | browser push permission/subscription |
| data-safety | renderDataSafetyCategory | pages/release.js | backup/restore confirmations |

Non-SPA entry points: app/index.html hosts the auth gate and shell; app/unsubscribe.html is a separate public confirmation page. There is no app/login.html. Supabase auth redirects use origin + pathname in data/supabase-client.js. Auth/recovery must not be treated as hub routes. Onboarding, quick add, file import and shared editors are modal flows, not independent route registrations.

## 3. Inbound links and compatibility

Appendix A inventories app JS/HTML/manifest navigation sites, dynamic consumers, Edge URL producers and documentation references. Appendix B records SQL route lines with their enclosing function; later CREATE OR REPLACE definitions supersede historical ones.

- `/contacts/:id`: Today/dashboard, buyer/seller summaries, related entities, notifications and SQL reminders. Buyer/seller deal cards currently link to the CONTACT, not necessarily deal detail.
- `/pipeline/:id`: pipeline, calendar closing/milestone events and dashboard/related records. `/properties/:id`: property cards and showings. Preserve every ID.
- Today/dashboard data-go links and route guards depend on module metadata; hidden modules must not create dead links.
- Team invite links use `#/join?token=<encoded token>`; team permissions uses `/settings/team-permissions?member=<id>`. Preserve token/query through auth and redirects.
- SQL notification CHECK and browser ALLOWED_ROUTE permit only `/contacts`, `/contacts/<safe-id>`, `/settings/sheet-imports`, `/automation`, `/notifications`. Contact events/reminders target contacts; imports target sheet-imports; failed follow-ups target automation; overdue summaries target contacts. T2c adds workspace fan-out; Phase 2C/2D update reminders. Do not change recipient scope.
- Phase 3B push claim payload copies notification.link_route into url. `_shared/push.ts` formats internal route payloads. `app/sw.js` validates slash paths and falls back to `/dashboard`, then focuses/navigates a same-origin window to `./#<route>` or opens one. Its fallback emits `NAVIGATE` via postMessage; repository search found no app-side NAVIGATE listener. This is an existing fallback gap, not fixed in U0.
- Manifest start_url and Today shortcut are `./#/daily`; Contacts shortcut is `./#/contacts`. Explicit service-worker shell list must track any added frontend scripts and cache version.
- Email unsubscribe is NOT a SPA route: `_shared/unsubscribe-token.ts` builds `/functions/v1/email-unsubscribe?t=<token>`; configured UNSUBSCRIBE_PAGE_URL receives a token fragment. GET confirms only; POST records consent change. app/unsubscribe.html posts the token. Preserve privacy and scanner-safe behavior.
- tel/sms/mailto/WhatsApp, OAuth callbacks, provider/API URLs and deployment examples are not hub redirects.

**Recommendation:** keep current URL contracts and render the appropriate hub/tab at those URLs first. Future canonical aliases must preserve ID/query/token, history and gate behavior. Changing notification URLs themselves would require SQL/browser allowlist changes and approval; none is needed for presentation-only reuse.

## 4. Buyer and Seller workspace behavior

Both aggregate contacts/deals/properties/showings/tasks; neither is a separate workspace database.

Buyer (`pages/buyer.js`): Buyer OR Investor contacts; active excludes Past Client/Lost; hot count. Buyer-side deals with nonterminal active subset. Counts, pipeline sale-price sum and expected net commission. Buyer-interest properties link to buyer contact IDs and exclude Sold. Scheduled showings through 14 days match CONTACT IDs. Active-buyer follow-ups through seven days include overdue. Tasks linked to either buyer contact or buyer-side deal, excluding Completed. Six cards: active buyers (first 10), active buyer deals, buyer-interest properties (first 10), upcoming showings, follow-ups, tasks (due-date sort, first 10). Add Buyer/Add Property/Schedule Showing use shared modals; Add Buyer passes null, not a Buyer-prefilled form.

Seller (`pages/seller.js`): Seller contacts, active excludes Past Client/Lost; hot count. Seller-side deals and nonterminal active subset. Listings linked to seller contacts in Active/Under Contract/Coming Soon; listing count/value and expected net. Scheduled showings through 14 days match active listing PROPERTY IDs. Seven-day follow-ups and open contact/deal-linked tasks. Six corresponding cards: active sellers, seller deals, listings, showings, follow-ups, tasks. Add Seller/Add Listing/Schedule Showing use shared modals, without specialized prefill.

No unique matching engine, saved buyer criteria workflow, MLS publishing, CMA or separate listing editor is implemented in these two modules. They display shared budget/preferred-area/property attributes. **Plain contact-type/deal-side filters still are not equivalent:** related showings, tasks, listing summaries and financial totals would disappear. Preserve these as overview sections inside Buyers/Sellers tabs or explicitly relocate each. Buyer tab must preserve Investor inclusion unless owner changes scope.

## 5. Overlaps and safe merges

| Overlap | Shared data | Unique behavior | Safe approach |
|---|---|---|---|
| Dashboard / Today | contacts/tasks and attention links | Dashboard business widgets, pipeline/commission/goals/activity and response card; Today actionable due/overdue, untouched, replied, celebrations, tasks, one-tap follow-up and onboarding nudges | Today operational; Dashboard reused as Reports Overview with widget settings intact |
| Tasks / Calendar / Scheduler / Activities | contact/deal relations and dates | Tasks CRUD/status; Calendar month+agenda combines showings/tasks/closings/milestones, NOT scheduledItems; Scheduler manual reminders from legacy scripts/template snapshots; Activities historical logs | Calendar tabs reuse separate stores; no record conversion or claim of automatic Scheduler sending; activity log goes to Reports |
| Pipeline / Commission / Finances | deals and monetary summaries | Pipeline drag/drop/detail; Commission math/forecast and legacy Staff masking; Finances income/expense CRUD | Deals Pipeline/Commission; Reports Income & expenses; finance gates remain per tab |
| Templates / Content / Prompts / Scripts | reusable content | Templates messageTemplates CRUD/preview/status; Content template+prompt previews; Prompts aiPrompts CRUD/copy; Scripts legacy data used by Scheduler; /scripts redirects already | Templates tab plus optional resources; keep legacy scripts and errors; no content migration |
| Reports / Goals / Team dashboard | deals/contacts/tasks/finance/response | Reports seven cards + CSV/print; Goals targets CRUD; Team per-assignee workload and manager response table | Report sections/tabs; separate Team gate; shared response-stats computation |
| Notifications page / bell | same personal store and row renderer | Bell latest 20 + badge/polling; page 25/page with All/Unread/Replies/Hot/Imports/Problems and mark-all | Keep bell plus View all route; Settings notifications remains push preferences |
| Milestones page / deal detail | milestones, calendar projections | No standalone /milestones route or page in current router; deal detail owns completion confirmation/action | Keep deal section; Calendar links there; do not remove only completion control |

Existing Reports cards are Pipeline, Commission, Contacts, Activity, Tasks, Referrals, Financial. Proposed tabs do not explicitly locate Contacts/Tasks reports: retain as Overview/Pipeline sections or obtain placement decision. CSV exports rendered headline values, not every breakdown/raw record; JSON workspace export remains separate.

## 6. Modules, flags and defaulting

Locked keys, always enabled: **dashboard, contacts, properties, pipeline, commission, settings**.

Optional registry keys, all default visible and disabled only by explicit false: **daily, buyer, seller, referrals, activities, tasks, calendar, finances, goals, reports, content, scripts, prompts, automation**. scripts is intentionally the stable Email Templates module key.

Other keys:

- scheduler:true appears in store defaults but **not OPTIONAL_MODULES**. Unknown IDs always return enabled, so a saved scheduler:false currently does nothing. Registering it is necessary for the requested future hide behavior.
- team-dir:true is legacy storage with no current nav route. team is a nav ID but not an optional registry key; teamMode + team_manage decides visibility.
- teamMode defaults false; backend prevents disabling it while other members remain.
- Dashboard widgets initially visible: statOverview, pipelineSnapshot, needsAttention, upcomingClosings, goalsProgress, recentActivity. Initially hidden: activeDealsWidget, newLeadsWidget, monthlyCommission, propertiesWidget, conversionRate, teamPerformance, revenueWidget. Preserve dependencies/order.
- theme default light; ui.onboardingStatus is legacy. onboardingDone/onboardingStep and timezoneConfirmed are first-run settings, not proof of workspace creation date.

Storage: `customization.enabledModules` maps to **workspace_settings.module_toggles JSONB**, not settings_data. Widget config/branding/teamMode map to settings_data; theme/UI to ui_preferences. settingsToRow/rowToSettings in data-service.js own the translation. A new initialization/version marker can use settings_data without schema work.

loadSettings reads the RLS-visible workspace row; absence causes defaults upsert onConflict workspace_id (compat trigger supplies workspace). Existing row uses module_toggles or {}; missing optional keys mean enabled. Onboarding maybeOpen checks only onboardingDone: older incomplete workspaces can enter the wizard too.

**No migration is required for new-solo-only hidden defaults, but absence alone is insufficient.** At a verified new-workspace setup boundary, set prompts:false/scheduler:false only if each key is absent, only for solo, and persist initialization marker. Register scheduler as optional with missing-key fallback TRUE. Do not change global fallback defaults or infer “new” from a missing newly introduced marker. Existing workspaces may lack both keys and markers, or even settings rows. Define a reliable creation-context/date boundary before U6; preserve legacy cases conservatively. Resume/setup retries/team switches must not overwrite explicit preferences. Shared settings updates must retain workspace filters and retry cap. This requires frontend design, not RLS or table changes; current module API does not itself provide a trustworthy newness signal.

## 7. Layout/theme

Shell functions in app.js: renderShell, renderNav, setActiveNavGroup, markActive, refreshNav. CSS: app/assets/css/realtoros.css. Scripts: app/index.html. Sidebar width 236px = 56px rail + 180px panel. #app grid uses --sidebar-w; #sidebarNav has .nav-rail/.nav-panels; footer and Settings span full width. Current tablist/tab/tabpanel roles and arrow/Home/End handling must be replaced coherently when flattening.

Breakpoints: desktop >900; drawer/scrim <=900; compact desktop 901–1150; bottom bar <=767 with safe-area padding; FAB 768–900. Other component thresholds: 1050,860,780/779,760,640,560,480; max-height 700; reduced-motion/print/standalone rules. Test 767/768/900/901 boundaries.

Light :root tokens: bg #F6F5F0, text #0B1F33, accent #0F766E. Dark :root[data-theme=dark]: bg #0A1523, text #E8ECF2, accent #34D399. Card/surface/border/text/status/event/sidebar tokens and local sidebar overrides also matter. applyThemeFromSettings/setTheme persists ui.theme. Preserve focus rings, contrast, safe areas and reduced motion.

One-level sidebar has no backend blocker. Frontend risks: NAV doubles as route registry; mobile More reuses sidebar; active prefix/breadcrumb logic; pinned Settings accessibility; global DOM IDs in page renderers (mount one tab at a time); async rendering; cached shell scripts; header search/New crowding at narrow widths.

## 8. Tests

No tests run in U0, so no new pass-count claim. Appendix D lists source references.

Likely presentation updates: settings-nav (rail/group selectors, drawer, avatar), pwa (Pipeline label/order/active tab), workspace-permissions and Team fixture selectors, today-screen/onboarding-and-presets/response-tracking/quick-add links and containers, load-all-scripts and PWA shell-list if new scripts are added. CRM mounting fixtures may change, not their business assertions.

Must remain semantically green: unconditional Settings reachability; settings-save filters/retry cap; notification personal scoping/safe route; push validation; SQL RLS/FKs/workspace isolation; Edge auth/import/idempotency/delivery/unsubscribe; CRM CRUD, commission math, milestone completion/calendar dedupe; automation/template lifecycle and stops; backup shape; existing module preferences. Do not weaken permission tests to make hubs pass.

Future targeted command from tests/: `node --import ./helpers/register.mjs --test --test-concurrency=1 --test-timeout=30000 <one-file>` with an overall watchdog. None executed here. Owner-only full-suite command, not run: `npm run test:quiet`.

## 9. Every-page mapping (proposed only)

Retain legacy URL contracts as entry points; proposed locations are IA, not new registered paths.

| Current page | Proposed location | How | Risk | Notes |
|---|---|---|---|---|
| /daily | Today | reuse | low | preserve optional daily choice/actions |
| /dashboard | Reports / Overview | tab reuse | med | widget config/response card; legacy default |
| /contacts | Contacts / All | tab reuse | med | existing filters/assign/imports |
| /contacts/:id | Contacts detail | detail reuse | high | SQL/push/user links retain IDs |
| /buyer | Contacts / Buyers | tab + overview sections | med | Investors and linked summaries retained |
| /seller | Contacts / Sellers | tab + overview sections | med | listing/showing semantics |
| Past Client filter (no route) | Contacts / Past clients | filter tab | med | lifecycle/programmes retained |
| /pipeline | Deals / Pipeline | tab reuse | med | stage drag/drop, stable pipeline key |
| /pipeline/:id | Deals detail | detail reuse | high | milestone actions, financial controls |
| /properties | Deals / Properties | tab reuse | low | independent CRUD |
| /properties/:id | Deals property detail | detail reuse | med | showings/contact links |
| /commission | Deals / Commission | tab reuse | med | finance.view + legacy Staff figure mask |
| /calendar | Calendar / Agenda | tab reuse | med | preserve month view too |
| /tasks | Calendar / Tasks | tab reuse | low | same records/actions |
| /scheduler | Calendar / Scheduled | tab + flag | med | existing manual reminders; new-solo policy only |
| /automation | Follow-up Plans / Plans and Activity | sections/tabs | high | draft/active safety/history; notification alias |
| /email-templates | Follow-up Plans / Templates | tab reuse | med | scripts module ID; permissions |
| /scripts | Follow-up Plans / Templates | existing redirect | low | do not delete legacy script records |
| /content | Follow-up Plans / Templates resources | section/compatibility view | med | retain prompt previews; placement decision |
| /prompts | optional Follow-up Plans resources | flag + compatibility view | med | existing users keep access |
| /reports | Reports / Pipeline and report sections | tab/section reuse | med | retain seven card types + CSV/print |
| personal response card | Reports / Response time | reuse | med | manager table remains restricted |
| /finances | Reports / Income & expenses | tab reuse | med | finance.view, CRUD retained |
| /goals | Reports / Goals | tab reuse | med | goals.view, target CRUD |
| /referrals | Reports / Referrals | tab reuse | med | finance.view |
| /activities | Reports / Activity log | tab reuse | med | communication log, not security audit |
| /team | Team | page reuse | med | teamMode AND team_manage |
| /notifications | bell > View all | page reuse | low | pagination/filters preserved |
| /settings | pinned Settings | page reuse | low | always reachable |
| /settings/business-profile | Settings / Business Profile | section reuse | low | dirty form/validation |
| /settings/pipeline | Settings / Pipeline | section reuse | med | existing deal-stage dependencies |
| /settings/google-sheets | Settings / Google Sheets | section reuse | low | integration checks |
| /settings/sheet-imports | Settings / Import History | section reuse | high | SQL notification destination |
| /settings/email-sending | Settings / Email Sending | section reuse | med | sender safety/test flow |
| /settings/notifications | Settings / Notifications | section reuse | low | push preferences |
| /settings/data-safety | Settings / Data & Safety | section reuse | med | backup shape/confirmations |
| /settings/modules | Settings / Modules | section reuse | med | labels may change, keys preserved |
| /settings/dashboard | Settings / Overview customization | label/section reuse | med | widget IDs/storage preserved |
| /settings/custom-fields | Settings / Custom Fields | section reuse | low | definitions unchanged |
| /settings/team-access | Settings / Team & Access | section reuse | med | manager/owner operations |
| /settings/team-permissions?member=:id | Settings / What people can do | section reuse | high | query and grant ceilings |
| /join?token=:token | invite flow outside hubs | unchanged | high | auth continuation/token |
| / or empty hash | Today? | boot alias decision | med | currently Dashboard; preserve deep links |
| unknown paths | fallback | explicit handling | low | not real pages |
| index.html auth gate / Edit account | auth flow / avatar | unchanged | high | no token rewriting |
| unsubscribe.html / Edge unsubscribe | public confirmation | unchanged | high | never redirect to authenticated hub |
| onboarding/import/showing/editor modals | existing hub launch points | reuse | med | no standalone routes |
| milestones section | Deals detail | existing section | low | no standalone page |

No DB/permission change is required for this route-preserving mapping. Changing SQL notification destinations/allowlists, broadening Team access, converting Scheduler/scripts records into automation or altering RLS would require separate approval and is outside U0's recommendation.

## 10. Risks/questions and staged plan

Owner decisions:

1. Keep existing hash URLs while presenting hubs? Recommended yes, initially.
2. Buyers continues to include Investors and linked summaries? Recommended yes.
3. Where are Content/Prompts reachable inside a three-tab Follow-up Plans hub? Recommend optional resource sections, not lost access.
4. Confirm Plans Activity = automation history, Reports Activity log = communication log.
5. Where do old Contacts/Tasks report cards and exports live? Recommend Overview/Pipeline sections.
6. Team remains manager-only? “Team mode only” must not silently remove team_manage.
7. What reliably identifies a newly created workspace after rollout? Missing keys/unfinished onboarding alone cannot.
8. Default entry Today when daily was explicitly disabled? Preserve choice and decide fallback.
9. Global search scope and + New choices: these are new functionality. Use existing RLS-backed entities and create permissions.
10. SW NAVIGATE receiver fallback gap: separately scoped fix or approved U7 work; no claim it works today.

| Stage | Deliverable / likely files | Acceptance |
|---|---|---|
| U1 | Separate route/module metadata from visual NAV in app.js; define hub state/parser and compatibility fixtures | old paths, IDs, join/member queries, guards and fallback preserved |
| U2 | Flat desktop sidebar: app.js, realtoros.css, settings-nav/workspace-permissions tests | keyboard/active/focus behavior, pinned Settings, gates |
| U3 | Header search/+ New: app.js, core/quick-add.js, CSS and UI tests | contact quick-add unchanged; scoped new actions; narrow header |
| U4 | Contacts/Deals: contacts.js, buyer.js, seller.js, deals.js, properties.js, commission.js, shell/CSS | no aggregate or detail behavior lost; money gates |
| U5 | Calendar/Plans: calendar.js, tasks.js, scheduler.js, automation.js, email-templates.js, release.js | manual vs automated distinction, lifecycle checks, content retained |
| U6 | Reports/Team and new-solo defaults: reports.js, release.js, team-dashboard.js, customization.js, store.js, onboarding.js; data-service only with scoped authorization if needed | old reports/widgets; register scheduler; reliable newness policy; explicit saved preferences preserved |
| U7 | Mobile/PWA links: core/mobile-nav.js, CSS, manifest, sw.js, core/pwa.js, index.html as needed | More/drawer/safe areas, cold push/start links, cache upgrade tests |
| U8 | Sequential targeted regressions, visual/accessibility review, alias docs | security/SQL/Edge invariants; one file at a time; full suite only by explicit approval |

Stop after U0. U1 requires owner approval. No deployment or production migration is implied by this file plan.

## Exact navigation table (source-derived)

| Group (rail icon) | Order | Item | Icon | Route | Module ID | Additional shell gate |
|---|---:|---|---|---|---|---|
| Workspace (grid) | 1 | Dashboard | grid | /dashboard | dashboard | none |
| Workspace (grid) | 2 | Today | sun | /daily | daily | none |
| CRM (users) | 1 | Contacts | users | /contacts | contacts | none |
| CRM (users) | 2 | Buyer Workspace | home | /buyer | buyer | none |
| CRM (users) | 3 | Seller Workspace | tag | /seller | seller | none |
| CRM (users) | 4 | Referrals | share | /referrals | referrals | finance.view != none |
| Transactions (map) | 1 | Properties | map | /properties | properties | none |
| Transactions (map) | 2 | Deals Pipeline | columns | /pipeline | pipeline | none |
| Transactions (map) | 3 | Commission | dollar | /commission | commission | finance.view != none |
| Automation (zap) | 1 | Automation | zap | /automation | automation | none |
| Automation (zap) | 2 | Email Templates | quote | /email-templates | scripts | none |
| Automation (zap) | 3 | Scheduler | clock | /scheduler | scheduler | none |
| Automation (zap) | 4 | Content Library | book | /content | content | none |
| Automation (zap) | 5 | AI Prompts | spark | /prompts | prompts | none |
| Operations (check) | 1 | Activities | activity | /activities | activities | none |
| Operations (check) | 2 | Tasks | check | /tasks | tasks | none |
| Operations (check) | 3 | Calendar | cal | /calendar | calendar | none |
| Business (wallet) | 1 | Income & Expenses | wallet | /finances | finances | finance.view != none |
| Business (wallet) | 2 | Goals | target | /goals | goals | goals.view != none |
| Business (wallet) | 3 | Reports | chart | /reports | reports | none |
| System (cog) | 1 | Settings | cog | /settings | settings | none |
| System (cog) | 2 | Team | users | /team | team | teamMode AND team_manage |

## Complete registered route table

| Path | Params | Handler | File under app/assets/js/ | Module guard | Shell permission gate | In NAV |
|---|---|---|---|---|---|---|---|
| /dashboard | none | App.pages.release.renderDashboard | pages/release.js | dashboard | none | yes |
| /daily | none | App.pages.release.renderDaily | pages/release.js | daily | none | yes |
| /contacts | none | App.pages.contacts.renderList | pages/contacts.js | contacts | none | yes |
| /properties | none | App.pages.properties.renderList | pages/properties.js | properties | none | yes |
| /buyer | none | App.pages.buyer.render | pages/buyer.js | buyer | none | yes |
| /seller | none | App.pages.seller.render | pages/seller.js | seller | none | yes |
| /pipeline | none | App.pages.deals.renderPipeline | pages/deals.js | pipeline | none | yes |
| /commission | none | App.pages.commission.render | pages/commission.js | commission | finance.view | yes |
| /activities | none | App.pages.activities.render | pages/activities.js | activities | none | yes |
| /tasks | none | App.pages.tasks.render | pages/tasks.js | tasks | none | yes |
| /team | none | App.pages.teamDashboard.render | pages/team-dashboard.js | team | teamMode + team_manage | yes |
| /scheduler | none | App.pages.scheduler.render | pages/scheduler.js | scheduler | none | yes |
| /calendar | none | App.pages.calendar.render | pages/calendar.js | calendar | none | yes |
| /referrals | none | App.pages.referrals.render | pages/referrals.js | referrals | finance.view | yes |
| /goals | none | App.pages.goals.render | pages/goals.js | goals | goals.view | yes |
| /finances | none | App.pages.finances.render | pages/finances.js | finances | finance.view | yes |
| /reports | none | App.pages.reports.render | pages/reports.js | reports | none | yes |
| /content | none | App.pages.release.renderContent | pages/release.js | content | none | yes |
| /email-templates | none | App.pages.emailTemplates.render | pages/email-templates.js | scripts | none | yes |
| /prompts | none | App.pages.release.renderPrompts | pages/release.js | prompts | none | yes |
| /automation | none | App.pages.automation.render | pages/automation.js | automation | none | yes |
| /notifications | none | App.pages.notifications.render | pages/notifications.js | none | none | no; bell View all |
| /settings | none | App.pages.release.renderSettings | pages/release.js | settings | none | yes |
| /contacts/:id | id | contacts.renderDetail | pages/contacts.js | contacts locked | no extra shell gate; RLS | Contacts prefix |
| /properties/:id | id | properties.renderDetail | pages/properties.js | properties locked | no extra shell gate; RLS | Properties prefix |
| /pipeline/:id | id | deals.renderDealDetail | pages/deals.js | pipeline locked | no extra shell gate; RLS | Pipeline prefix |
| /settings/:category | category; member query | release.renderSettings | pages/release.js | settings locked | pane gates above | Settings prefix |
| /scripts | none | navigate(/email-templates) | app.js | target uses scripts | none extra | no |
| /join or /join?token=... | token | teamJoin.render + tokenFromPath | pages/team-join.js | none | invitation/auth backend | no |
| / or empty hash | none | redirect/default /dashboard | app.js | dashboard locked | none | no |
| unmatched path | raw path | renderComingSoon | app.js | known base module first | exact NAV gate only | no |

## Appendix A1 ? app link sites and dynamic consumers


### app/assets/js/app.js

~~~~text
31:       { id: "dashboard", label: "Dashboard",       icon: "grid",  route: "/dashboard", phase: "here" },
32:       { id: "daily",     label: "Today",           icon: "sun",   route: "/daily",     phase: "here" }
35:       { id: "contacts", label: "Contacts",        icon: "users", route: "/contacts",  phase: "here" },
36:       { id: "buyer",    label: "Buyer Workspace", icon: "home",  route: "/buyer",     phase: "here" },
37:       { id: "seller",   label: "Seller Workspace",icon: "tag",   route: "/seller",    phase: "here" },
38:       { id: "referrals",label: "Referrals",       icon: "share", route: "/referrals", phase: "here", area: "finance" }
41:       { id: "properties", label: "Properties",     icon: "map",     route: "/properties",   phase: "here" },
42:       { id: "pipeline",   label: "Deals Pipeline", icon: "columns", route: "/pipeline",     phase: "here" },
43:       { id: "commission", label: "Commission",     icon: "dollar",  route: "/commission",   phase: "here", area: "finance" }
51:       { id: "automation", label: "Automation",       icon: "zap",    route: "/automation",      phase: "here" },
56:       { id: "scripts",    label: "Email Templates", icon: "quote",  route: "/email-templates", phase: "here" },
57:       { id: "scheduler",  label: "Scheduler",       icon: "clock",  route: "/scheduler",       phase: "here" },
58:       { id: "content",    label: "Content Library", icon: "book",   route: "/content",         phase: "here" },
59:       { id: "prompts",    label: "AI Prompts",      icon: "spark",  route: "/prompts",         phase: "here" }
62:       { id: "activities", label: "Activities",      icon: "activity", route: "/activities", phase: "here" },
63:       { id: "tasks",      label: "Tasks",           icon: "check",    route: "/tasks",      phase: "here" },
64:       { id: "calendar",   label: "Calendar",        icon: "cal",      route: "/calendar",   phase: "here" }
67:       { id: "finances", label: "Income & Expenses", icon: "wallet", route: "/finances", phase: "here", area: "finance" },
68:       { id: "goals",    label: "Goals",             icon: "target", route: "/goals",    phase: "here", area: "goals" },
69:       { id: "reports",  label: "Reports",           icon: "chart",  route: "/reports",  phase: "here" }
80:       { id: "settings", label: "Settings",       icon: "cog",      route: "/settings", phase: "here" },
81:       { id: "team", label: "Team", icon: "users", route: "/team", phase: "here", needsTeam: true, needsTeamManage: true }
147:     return `<a class="back-link" href="#${escapeHtml(route)}">${arrow}<span>Back to ${escapeHtml(label || "list")}</span></a>`;
179:               data-nav="/settings" aria-label="Settings">
254:       sidebarSettings.addEventListener("click", () => { navigate("/settings"); closeSidebar(); });
275:       const a = e.target.closest("[data-nav]");
278:         const route = a.getAttribute("data-nav");
279:         navigate(route);
345:         if (it.route === path) return navItemAllowed(it);
402:           <a class="nav-item" data-nav="${item.route}" href="#${item.route}" role="link">
454:     const raw = (location.hash || "").replace(/^#/, "");
462:       const item = el.getAttribute("data-nav");
463:       const isMatch = route === item || (item !== "/" && route.startsWith(item + "/"));
670:       App.cloud.getAvatarSignedUrl(avatarPath).then(url => {
705:     if (settingsBtn) settingsBtn.addEventListener("click", () => { closeMenu(); navigate("/settings"); });
706:     if (bizBtn) bizBtn.addEventListener("click", () => { closeMenu(); navigate("/settings/business-profile"); });
782:           App.cloud.getAvatarSignedUrl(currentAvatarPath).then(url => { if (url) paintAvatarEl(avatarPreview, fallbackName, url); });
903:         ? `<a href="#${escapeHtml(it.route)}" class="link">${label}</a>`
915:   async function navigate(path) {
925:     if (location.hash === "#" + path) {
933:       location.hash = path;
938:     let hash = location.hash || "#/dashboard";
957:       navigate("/dashboard");
999:       else if (path === "/scripts") { navigate("/email-templates"); return; }
1005:       else if (path === "/") { navigate("/dashboard"); return; }
1080:     if (btn) btn.addEventListener("click", () => navigate("/dashboard"));
~~~~

### app/assets/js/config.js

~~~~text
6:   url: "https://yanasorwmaybnabfuepn.supabase.co",
~~~~

### app/assets/js/core/follow-up.js

~~~~text
261:       window.location.href = url;
315:           const url = isEmail
~~~~

### app/assets/js/core/mobile-nav.js

~~~~text
41:     { id: "today",    label: "Today",    icon: "today",    route: "/daily",     module: "daily" },
42:     { id: "contacts", label: "Contacts", icon: "contacts", route: "/contacts",  module: "contacts" },
44:     { id: "pipeline", label: "Pipeline", icon: "pipeline", route: "/pipeline",  module: "pipeline" },
57:     const raw = String(((win || window).location.hash) || "").replace(/^#/, "");
68:       const route = btn.getAttribute("data-tab-route");
88:         ? `data-tab-route="${t.route}"`
100:       const route = btn.getAttribute("data-tab-route");
101:       if (route) { App.app.navigate(route); return; }
~~~~

### app/assets/js/core/quick-add.js

~~~~text
432:         App.app.navigate("/contacts/" + existing.id);
491:         { label: "Open", onClick: () => App.app.navigate("/contacts/" + contact.id) },
~~~~

### app/assets/js/data/backup.js

~~~~text
54:         const url = window.URL.createObjectURL(blob);
56:         a.href = url;
~~~~

### app/assets/js/data/data-service.js

~~~~text
87:         if ("url" in m) row.url = m.url || "";
103:           id: r.id, address: r.address, mls: r.mls, url: r.url, status: r.status,
~~~~

### app/assets/js/data/supabase-client.js

~~~~text
264:           redirectTo: window.location.origin + window.location.pathname
295:           options: { redirectTo: window.location.origin + window.location.pathname }
~~~~

### app/assets/js/pages/activities.js

~~~~text
124:               ${c ? ' · <a class="link" href="#/contacts/'+c.id+'" onclick="event.stopPropagation()">'+U().esc(c.name)+'</a>' : ""}
125:               ${d ? ' · <a class="link" href="#/pipeline/'+d.id+'" onclick="event.stopPropagation()">'+U().esc(d.name)+'</a>' : ""}
~~~~

### app/assets/js/pages/buyer.js

~~~~text
135:               <div class="item-row clickable" onclick="location.hash='#/contacts/${c.id}'">
164:                 <div class="item-row clickable" onclick="location.hash='#/contacts/${d.contactId}'">
194:                 <div class="item-row clickable" onclick="location.hash='#/properties/${p.id}'">
251:                 <div class="item-row clickable" onclick="location.hash='#/contacts/${c.id}'">
~~~~

### app/assets/js/pages/calendar.js

~~~~text
38:         link: p ? "#/properties/" + p.id : (c ? "#/contacts/" + c.id : null)
68:         link: "#/pipeline/" + d.id
87:         link: deal ? "#/pipeline/" + deal.id : null
196:             <div class="cal-event" style="border-left-color:${e.color}" ${e.link ? `onclick="location.hash='${e.link}'" role="button" tabindex="0"` : ''} title="${U().esc(e.label)}">
243:             <div class="item-row${e.link ? ' clickable' : ''}" ${e.link ? `onclick="location.hash='${e.link}'"` : ''}>
~~~~

### app/assets/js/pages/commission.js

~~~~text
35:         <button class="btn" data-go="/settings/team-access" id="commissionHiddenSettingsBtn" style="margin-top:12px">Open Team & Access</button>`;
37:       if (btn) btn.addEventListener("click", () => App.app.navigate("/settings/team-access"));
208:         <div class="item-row clickable" onclick="location.hash='#/pipeline/${r.dealId}'">
290:       tr.addEventListener("click", () => App.app.navigate("/pipeline/" + tr.getAttribute("data-deal-id")));
~~~~

### app/assets/js/pages/contacts.js

~~~~text
434:               <button class="btn btn-ghost" onclick="App.app.navigate('/settings/google-sheets')">Import from Google Sheets</button>
473:                   <a href="#/contacts/${c.id}" class="link" data-nav-block>${U().esc(c.name || "(unnamed)")}</a>
500:         App.app.navigate("/contacts/" + tr.getAttribute("data-id"));
519:       App.app.setBreadcrumbs([{ label: "Contacts", route: "/contacts" }, { label: "Not Found" }]);
524:           <a href="#/contacts" class="btn btn-primary">Back to Contacts</a>
530:       { label: "Contacts", route: "/contacts" },
897:             <div class="item-row clickable" onclick="location.hash='#/properties/${p.id}'">
1259:           App.app.navigate("/contacts");
1489:           App.app.navigate(`/contacts/${contact.id}`);
~~~~

### app/assets/js/pages/deals.js

~~~~text
241:         App.app.navigate("/pipeline/" + card.getAttribute("data-deal-id"));
247:           App.app.navigate("/pipeline/" + card.getAttribute("data-deal-id"));
330:       tr.addEventListener("click", () => App.app.navigate("/pipeline/" + tr.getAttribute("data-deal-id")));
381:       App.app.setBreadcrumbs([{ label: "Deals Pipeline", route: "/pipeline" }, { label: "Not Found" }]);
382:       container.innerHTML = `<div class="empty"><h3>Deal not found</h3><a href="#/pipeline" class="btn btn-primary">Back to Pipeline</a></div>`;
387:       { label: "Deals Pipeline", route: "/pipeline" },
434:                 <div><div class="k">Client</div><div class="v">${contact ? `<a class="link" href="#/contacts/${contact.id}">${U().esc(contact.name)}</a>` : '<span style="color:var(--text-soft)">—</span>'}</div></div>
435:                 <div><div class="k">Property</div><div class="v">${property ? `<a class="link" href="#/properties/${property.id}">${U().esc(property.address)}</a>` : '<span style="color:var(--text-soft)">—</span>'}</div></div>
1043:           App.app.navigate("/pipeline");
~~~~

### app/assets/js/pages/finances.js

~~~~text
157:                     ${c ? `<a class="link" href="#/contacts/${c.id}">${U().esc(c.name)}</a>` : ""}
159:                     ${d ? `<a class="link" href="#/pipeline/${d.id}">${U().esc(U().truncate(d.name, 20))}</a>` : ""}
~~~~

### app/assets/js/pages/google-sheets-import-history.js

~~~~text
89:     return `<a class="link" href="#/contacts/${U().esc(contactId)}">View Contact</a>`;
252:     pane.querySelector("#gsihManageBtn").addEventListener("click", () => App.app.navigate("/settings/google-sheets"));
539:       if (btn) btn.addEventListener("click", () => App.app.navigate("/settings/google-sheets"));
~~~~

### app/assets/js/pages/google-sheets-settings.js

~~~~text
68:     try { url = new URL(value); }
76:     return { id: match[1], href: url.href };
101:       return { ok: true, id: parsed.id, url: parsed.href };
110:     return { ok: true, id: trimmed, url: "" };
430:       ? `<a href="${U().esc(conn.spreadsheet_url)}" target="_blank" rel="noopener noreferrer" class="link">Open Sheet</a> <span class="form-help" style="display:inline">(${U().esc(conn.spreadsheet_id)})</span>`
~~~~

### app/assets/js/pages/lead-file-import.js

~~~~text
123:           <a href="${U().esc(templateUrl)}" download="realtoros-leads-template.csv">Download a blank template</a> with the expected headings.</p>
409:         App.app.navigate(IMPORT_HISTORY_ROUTE);
~~~~

### app/assets/js/pages/notifications.js

~~~~text
62:     return typeof route === "string" && ALLOWED_ROUTE.test(route) ? route : null;
121:     const route = safeRoute(n.link_route);
122:     if (route) App.app.navigate(route);
284:       App.app.navigate("/notifications");
~~~~

### app/assets/js/pages/onboarding.js

~~~~text
115:         route: "/settings/business-profile" },
117:         done: contacts.length > 0, route: "/contacts" },
119:         done: rules.length > 0, route: "/automation" },
123:         done: rules.some((r) => r.status && r.status !== "draft"), route: "/automation" },
125:         done: activities.length > 0, route: "/daily" }
163:       if (go) { App.app.navigate(go.getAttribute("data-gs-go")); return; }
198:     App.app.navigate("/daily");
339:                 else if (what === "sheets") App.app.navigate("/settings/google-sheets");
340:                 else App.app.navigate("/contacts");
~~~~

### app/assets/js/pages/properties.js

~~~~text
36:     return `<a href="${U().esc(value)}" target="_blank" rel="noopener noreferrer" class="link">${U().esc(U().truncate(value, 40))}</a>`;
161:                     <a href="#/properties/${p.id}" class="link">${U().esc(p.address)}</a>
168:                   <td data-label="Client">${contact ? `<a href="#/contacts/${contact.id}" class="link">${U().esc(contact.name)}</a>` : '<span style="color:var(--text-soft)">—</span>'}</td>
184:         App.app.navigate("/properties/" + tr.getAttribute("data-id"));
203:       App.app.setBreadcrumbs([{ label: "Properties", route: "/properties" }, { label: "Not Found" }]);
204:       container.innerHTML = `<div class="empty"><h3>Property not found</h3><a href="#/properties" class="btn btn-primary">Back to Properties</a></div>`;
209:       { label: "Properties", route: "/properties" },
251:                 <div><div class="k">Client</div><div class="v">${contact ? `<a href="#/contacts/${contact.id}" class="link">${U().esc(contact.name)}</a>` : '<span style="color:var(--text-soft)">—</span>'}</div></div>
265:                 <div class="item-row clickable" onclick="location.hash='#/contacts/${deal.contactId}'">
380:       address: "", mls: "", url: "", status: "Active",
496:       url: $("#pfUrl").value.trim(),
544:           App.app.navigate("/properties");
~~~~

### app/assets/js/pages/referrals.js

~~~~text
123:               ${from ? `<a class="link" href="#/contacts/${from.id}" onclick="event.stopPropagation()">${U().esc(from.name)}</a>` : "Someone"}
124:               → ${to ? `<a class="link" href="#/contacts/${to.id}" onclick="event.stopPropagation()">${U().esc(to.name)}</a>` : "Someone"}
129:               ${deal ? ' · <a class="link" href="#/pipeline/'+deal.id+'" onclick="event.stopPropagation()">'+U().esc(deal.name)+'</a>' : ""}
~~~~

### app/assets/js/pages/release.js

~~~~text
51:           <div class="card-header"><div class="card-title">Pipeline Snapshot</div><button class="btn btn-sm" data-go="/pipeline">View pipeline</button></div>
70:         ? `<button class="btn btn-sm" data-go="/daily">Open Daily View</button>` : "";
83:         ? `<button class="btn btn-sm" data-go="/calendar">Calendar</button>` : "";
89:               <div class="item-row clickable" data-go="/pipeline/${U().esc(r.dealId)}">
103:           <div class="card-header"><div class="card-title">Goals</div><button class="btn btn-sm" data-go="/goals">View goals</button></div>
118:           <div class="card-header"><div class="card-title">Recent Activity</div><button class="btn btn-sm" data-go="/activities">View all</button></div>
148:           <div class="card-header"><div class="card-title">Properties</div><button class="btn btn-sm" data-go="/properties">View properties</button></div>
164:           <div class="card-header"><div class="card-title">Team Performance</div><button class="btn btn-sm" data-go="/settings/team-access">Manage team</button></div>
365:     return rows.map(r => `<button class="release-attention-row" data-go="${r[2]}"><span>${U().esc(r[0])}</span><strong>${r[1]}</strong></button>`).join("");
372:     for (const g of nav) for (const it of g.items) if (it.route === route) return it.id;
504:         <a class="today-row-name link" href="#/contacts/${U().esc(c.id)}">${U().esc(c.name || "Unnamed contact")}</a>
572:         <a class="today-row-name link" href="#/contacts/${U().esc(c.id)}">${U().esc(c.name || "Unnamed contact")}</a>
699:         <section class="card"><div class="card-header"><div class="card-title">Email Templates</div><button class="btn btn-sm" data-go="/email-templates">Open library</button></div><div class="card-body">${
704:         <section class="card"><div class="card-header"><div class="card-title">AI Prompts</div><button class="btn btn-sm" data-go="/prompts">Open library</button></div><div class="card-body">${prompts.slice(0,5).map(renderLibraryPreview).join("") || emptyMessage("No prompts", "Add a prompt from the AI Prompts page.")}</div></section>
821:         const attr = c.route ? `data-settings-route="${U().esc(c.route)}"` : `data-settings-cat="${U().esc(c.id)}"`;
842:           App.app.navigate("/settings/" + cat);
846:     container.querySelectorAll("[data-settings-route]").forEach(btn => {
847:       btn.addEventListener("click", () => App.app.navigate(btn.getAttribute("data-settings-route")));
1027:     pane.querySelectorAll("[data-overview-cat]").forEach(card => card.onclick = () => App.app.navigate("/settings/" + card.getAttribute("data-overview-cat")));
1548:     root.querySelectorAll("[data-deal-link]").forEach(el => el.addEventListener("click", () => App.app.navigate("/pipeline")));
1685:       if(r.ok){ App.data.resetAllCaches(); App.app.toast('Backup restored.','success'); App.app.navigate('/dashboard'); }
1696:       h.close();App.app.toast('Workspace reset.','success');App.app.navigate('/dashboard');
1700:   function wireGo(root){root.querySelectorAll('[data-go]').forEach(el=>el.addEventListener('click',()=>App.app.navigate(el.getAttribute('data-go'))));}
~~~~

### app/assets/js/pages/reports.js

~~~~text
99:     const url = window.URL.createObjectURL(blob);
101:     a.href = url;
~~~~

### app/assets/js/pages/scheduler.js

~~~~text
100:       ${(!templatesError && scripts.length === 0 && templates.length === 0) ? '<div class="release-callout" style="margin-bottom:16px">Nothing to schedule from yet. <button class="btn btn-sm" data-go="/email-templates">Add an Email Template</button></div>' : ''}
147:     container.querySelectorAll("[data-go]").forEach(el => {
148:       el.addEventListener("click", () => App.app.navigate(el.getAttribute("data-go")));
~~~~

### app/assets/js/pages/seller.js

~~~~text
136:               <div class="item-row clickable" onclick="location.hash='#/contacts/${c.id}'">
162:                 <div class="item-row clickable" onclick="location.hash='#/contacts/${d.contactId}'">
193:                 <div class="item-row clickable" onclick="location.hash='#/properties/${p.id}'">
250:                 <div class="item-row clickable" onclick="location.hash='#/contacts/${c.id}'">
~~~~

### app/assets/js/pages/tasks.js

~~~~text
155:               ${c ? ' · <a class="link" href="#/contacts/'+c.id+'" onclick="event.stopPropagation()">'+U().esc(c.name)+'</a>' : ''}
156:               ${d ? ' · <a class="link" href="#/pipeline/'+d.id+'" onclick="event.stopPropagation()">'+U().esc(d.name)+'</a>' : ''}
~~~~

### app/assets/js/pages/team-dashboard.js

~~~~text
62:       if (b) b.addEventListener("click", () => App.app.navigate("/settings/team-access"));
156:     if (manage) manage.addEventListener("click", () => App.app.navigate("/settings/team-access"));
160:       App.app.navigate("/contacts");
~~~~

### app/assets/js/pages/team-join.js

~~~~text
5:    workspace yet. The token lives in the hash (#/join?token=…), which is
54:     const hash = (typeof window !== "undefined" && window.location && window.location.hash) || "";
55:     return tokenFromPath(hash.replace(/^#/, ""));
121:       b.addEventListener("click", () => App.app.navigate("/dashboard"));
151:       App.app.navigate("/dashboard");
~~~~

### app/assets/js/pages/team-management.js

~~~~text
352:           <button class="btn btn-sm" data-go-permissions>Set what each role can do</button>
398:     const goPerms = pane.querySelector("[data-go-permissions]");
399:     if (goPerms) goPerms.addEventListener("click", () => App.app.navigate("/settings/team-permissions"));
433:         App.app.navigate("/settings/team-permissions?member=" + encodeURIComponent(btn.getAttribute("data-perms")));
661:     return base + "#/join?token=" + encodeURIComponent(token);
772:             App.app.navigate("/dashboard");
839:                 App.app.navigate("/dashboard");
~~~~

### app/assets/js/pages/team-permissions.js

~~~~text
185:       if (b) b.addEventListener("click", () => App.app.navigate("/settings/team-access"));
433:     if (back) back.addEventListener("click", () => App.app.navigate("/settings/team-access"));
445:         App.app.navigate("/settings/team-access");
462:           App.app.navigate("/settings/team-access");
496:       App.app.navigate("/settings/team-permissions?member=" + encodeURIComponent(sel.value));
~~~~

### app/index.html

~~~~text
10:   <link rel="preload" href="assets/fonts/inter-latin.woff2" as="font" type="font/woff2" crossorigin>
11:   <link rel="preload" href="assets/fonts/source-serif-4-latin.woff2" as="font" type="font/woff2" crossorigin>
12:   <link rel="preload" href="assets/fonts/manrope-latin.woff2" as="font" type="font/woff2" crossorigin>
13:   <link rel="preload" href="assets/fonts/dm-serif-display-latin.woff2" as="font" type="font/woff2" crossorigin>
16:   <link rel="manifest" href="manifest.webmanifest">
23:   <link rel="apple-touch-icon" sizes="180x180" href="assets/icons/apple-touch-icon-180.png">
24:   <link rel="icon" type="image/svg+xml" href="assets/icons/icon.svg">
25:   <link rel="icon" type="image/png" sizes="32x32" href="assets/icons/favicon-32.png">
26:   <link rel="stylesheet" href="assets/css/realtoros.css">
~~~~

### app/manifest.webmanifest

~~~~text
6:   "start_url": "./#/daily",
37:       "url": "./#/daily",
43:       "url": "./#/contacts",
~~~~

### app/sw.js

~~~~text
167:   const url = (typeof data.url === "string" && /^\/[A-Za-z0-9/_-]*$/.test(data.url))
183: self.addEventListener("notificationclick", (event) => {
196:         if ("navigate" in client) await client.navigate("./#" + target);
197:         else client.postMessage({ type: "NAVIGATE", url: target });
222:   try { url = new URL(request.url); } catch (e) { return false; }
248:   try { url = new URL(request.url); } catch (e) { return; }
~~~~

### app/unsubscribe.html

~~~~text
48:   var match = /(?:^#|&)t=([^&]+)/.exec(window.location.hash || "");
55:   var base = window.App && App.config && typeof App.config.url === "string" ? App.config.url.replace(/\/+$/, "") : "";
~~~~

Inventory: 212 matching source lines, including comments and dynamic consumers; not a count of distinct routes.

## Appendix A2 ? Edge URL producers and external contracts


### supabase/functions/_shared/push.ts

~~~~text
19:    notification's own link_route - an internal app route, never a URL -
35:   url: string | null;
224:   const url = typeof notification.url === "string" && notification.url.startsWith("/")
225:     ? notification.url
~~~~

### supabase/functions/_shared/runtime.ts

~~~~text
47:   const url = requiredEnv("SUPABASE_URL");
59:   const url = requiredEnv("SUPABASE_URL");
~~~~

### supabase/functions/_shared/unsubscribe-token.ts

~~~~text
188: // person lands on from the visible footer link. UNSUBSCRIBE_PAGE_URL is
193: export function unsubscribeLinks(
194:   env: { supabaseUrl: string; pageUrl?: string | null },
196: ): { oneClickUrl: string; pageUrl: string } {
198:   const oneClickUrl = `${base}/functions/v1/email-unsubscribe?t=${
201:   const page = env.pageUrl && /^https:\/\/[^\s#?]+$/.test(env.pageUrl)
202:     ? `${env.pageUrl}#t=${encodeURIComponent(token)}`
203:     : oneClickUrl;
204:   return { oneClickUrl, pageUrl: page };
~~~~

### supabase/functions/email-unsubscribe/index.ts

~~~~text
193:   const url = new URL(request.url);
~~~~

### supabase/functions/process-automation/index.ts

~~~~text
52:   unsubscribeLinks,
1034:   const links = unsubscribeLinks({ supabaseUrl, pageUrl: Deno.env.get("UNSUBSCRIBE_PAGE_URL") ?? null }, unsubscribeToken);
1042:     text: withUnsubscribeFooter(renderedBody, links.pageUrl),
1046:       "List-Unsubscribe": `<${links.oneClickUrl}>`,
~~~~

Inventory: 20 matching source lines, including comments and dynamic consumers; not a count of distinct routes.

## Appendix A3 ? documentation references (including historical)


### README.md

~~~~text
4: agents — contacts, properties, buyer/seller pipelines, deals, milestones,
30: - **Core CRM/pipeline modules** (each its own page module under
~~~~

### docs/README.md

~~~~text
41: │   ├── unsubscribe.html           — the static unsubscribe-confirmation page
~~~~

### docs/T4_SPEC.md

~~~~text
90: else if (path === "/join") await App.pages.teamJoin.render(page, tokenFromLocation());
340: ### 4.1 Settings → Team & Access (`/settings/team-access`)
381:    to `/dashboard` with a toast naming the new workspace.
388:    is the guard; `deleted` → reset caches, navigate to `/dashboard`, toast.
399: (`<origin>/#/join?token=<token>`, matching the app's routing style) — with:
414: ### 4.3 Join (`/join?token=...`)
425:    navigate to `/dashboard` with a toast naming the workspace and role.
433:    - `already_a_member` → "You are already in this workspace." → `/dashboard`.
446: | Team & Access | `no_workspace` from any RPC | "You are not an active member of a workspace." Link to `/dashboard`. |
~~~~

### docs/TEAM_ACCESS_ARCHITECTURE.md

~~~~text
175: 4. Every assignment (past and future) stays attached to the `team_members.id` — nothing about existing deals/tasks/scheduled items changes when login access is granted.
~~~~

### docs/archive/REALTOROS_UI_CLEANUP_REPORT.md

~~~~text
54: All empty states use `--empty-padding: 32px 20px`, including inline states in properties, buyer/seller workspaces, pipeline, deal detail, reports, and calendar.
60: * Static checks confirm semantic chart/calendar tokens, report-footer token replacement, and empty-state token use.
~~~~

### docs/deployment/environment-variables.md

~~~~text
31: | `UNSUBSCRIBE_PAGE_URL` | `process-automation` | The visible footer link points at this page (the static `app/unsubscribe.html`, wherever the frontend is hosted) with the token in the `#` fragment. Must be `https://…` with no `?` or `#`. | The footer link points at the `email-unsubscribe` function itself. Its confirmation page only renders on a **custom functions domain**; Supabase's default domain serves HTML as plain text. |
105: supabase secrets set UNSUBSCRIBE_PAGE_URL=https://<APP_HOST>/unsubscribe.html --project-ref <PROJECT_REF>
~~~~

### docs/deployment/phase-4f-deployment-playbook.md

~~~~text
402: - **Set** to the public URL of `app/unsubscribe.html` on wherever the
404:   `https://app.example.com/unsubscribe.html`. The token travels in the `#`
410: supabase secrets set UNSUBSCRIBE_PAGE_URL=https://<APP_HOST>/unsubscribe.html --project-ref <PROJECT_REF>
~~~~

Inventory: 20 matching source lines, including comments and dynamic consumers; not a count of distinct routes.

## Appendix B ? SQL route producers

Migration history, not live query output. Later definitions can supersede earlier functions.

### supabase/migrations/20260929150944_phase_4h_in_app_notifications.sql

~~~~text
63 [top-level]   link_route text
64 [top-level]     check (link_route is null
65 [top-level]            or link_route ~ '^/(contacts(/[A-Za-z0-9_-]{1,120})?|settings/sheet-imports|automation|notifications)$'),
164 [automation_internal.notification_contact_route]     when p_contact_id ~ '^[A-Za-z0-9_-]{1,120}$' then '/contacts/' || p_contact_id
165 [automation_internal.notification_contact_route]     else '/contacts'
192 [automation_internal.notify]   p_link_route text,
205 [automation_internal.notify]     user_id, type, title, body, contact_id, link_route, dedupe_key, metadata
212 [automation_internal.notify]     p_link_route,
357 [automation_internal.notify_on_import_batch]         '/settings/sheet-imports', 'import:' || new.id::text,
414 [automation_internal.notify_on_import_batch]           '/settings/sheet-imports', 'import:' || new.id::text,
472 [automation_internal.notify_on_job_failed]       new.contact_id, '/automation',
~~~~

### supabase/migrations/20261006132041_phase_t2c_workspace_backend.sql

~~~~text
1174 [automation_internal.notify]   p_link_route text,
1191 [automation_internal.notify]     user_id, workspace_id, type, title, body, contact_id, link_route,
1200 [automation_internal.notify]     p_link_route,
1317 [automation_internal.notify_many]   p_link_route text,
1332 [automation_internal.notify_many]       user_id, workspace_id, type, title, body, contact_id, link_route,
1341 [automation_internal.notify_many]       p_link_route,
1366 [automation_internal.notify_contact]   p_link_route text,
1374 [automation_internal.notify_contact]     p_workspace_id, p_type, p_title, p_body, p_contact_id, p_link_route,
1389 [automation_internal.notify_permission]   p_link_route text,
1397 [automation_internal.notify_permission]     p_workspace_id, p_type, p_title, p_body, p_contact_id, p_link_route,
1534 [automation_internal.notify_on_job_failed]       new.contact_id, '/automation',
1596 [automation_internal.notify_on_import_batch]         '/settings/sheet-imports', 'import:' || new.id::text,
1662 [automation_internal.notify_on_import_batch]             '/settings/sheet-imports', 'import:' || new.id::text,
~~~~

### supabase/migrations/20261015130000_phase_2c_response_tracking.sql

~~~~text
615 [public.realtoros_scan_follow_up_reminders]              v_row.id, '/contacts/' || v_row.id,
641 [public.realtoros_scan_follow_up_reminders]                v_row.id, '/contacts/' || v_row.id,
688 [public.realtoros_scan_follow_up_reminders]              null, '/contacts',
~~~~

### supabase/migrations/20261015140000_phase_2d_past_clients.sql

~~~~text
872 [public.realtoros_scan_follow_up_reminders]              v_row.id, '/contacts/' || v_row.id,
896 [public.realtoros_scan_follow_up_reminders]                v_row.id, '/contacts/' || v_row.id,
943 [public.realtoros_scan_follow_up_reminders]              null, '/contacts',
~~~~

### supabase/migrations/20261015170000_phase_3b_push.sql

~~~~text
477 [public.realtoros_claim_push_batch]     select n.id, n.user_id, n.workspace_id, n.type, n.title, n.body, n.link_route
564 [public.realtoros_claim_push_batch]       'url', v_row.link_route,
~~~~

## Appendix C ? route, flag, permission and layout evidence


### app/assets/css/realtoros.css

~~~~text
98:   --sidebar-w:       236px;   /* 56px icon rail + 180px submenu panel */
143: :root[data-theme="dark"] {
202: :root[data-theme="dark"] .btn:hover                  { background: var(--surface-sunk); border-color: var(--border-strong); }
203: :root[data-theme="dark"] .btn-ghost:hover            { background: var(--surface-sunk); }
204: :root[data-theme="dark"] .tbl thead th               { background: var(--surface-sunk); }
205: :root[data-theme="dark"] .tbl tbody tr:hover        { background: var(--bg-subtle); }
206: :root[data-theme="dark"] .cal-cell-empty            { background: var(--surface-sunk); }
207: :root[data-theme="dark"] .settings-nav-item:hover   { background: rgba(52, 211, 153, 0.08); color: var(--text); }
208: :root[data-theme="dark"] .settings-nav              { background: var(--bg-subtle); }
209: :root[data-theme="dark"] .modal-footer               { background: var(--surface-sunk); }
210: :root[data-theme="dark"] .kanban-col                 { background: var(--surface-sunk); }
211: :root[data-theme="dark"] .kanban-col-count           { background: var(--card); }
212: :root[data-theme="dark"] .item-row.clickable:hover  { background: var(--bg-subtle); }
213: :root[data-theme="dark"] .release-attention-row:hover { background: var(--surface-sunk); }
214: :root[data-theme="dark"] .modal-close:hover          { background: var(--surface-sunk); }
215: :root[data-theme="dark"] .agenda-date                { background: var(--surface-sunk); }
216: :root[data-theme="dark"] .cal-header                 { background: var(--surface-sunk); }
217: :root[data-theme="dark"] .release-callout            { background: var(--surface-sunk); color: var(--text-muted); border-color: var(--border-strong); }
218: :root[data-theme="dark"] .release-callout-danger    { border-color: color-mix(in srgb, var(--danger) 45%, var(--danger-soft)); background: var(--danger-soft); color: var(--danger); }
219: :root[data-theme="dark"] .release-callout-warning   { border-color: color-mix(in srgb, var(--warning) 45%, var(--warning-soft)); background: var(--warning-soft); color: var(--warning); }
220: :root[data-theme="dark"] .storage-warning            { background: var(--warning-soft); color: var(--warning); border-color: color-mix(in srgb, var(--warning) 35%, var(--warning-soft)); }
221: :root[data-theme="dark"] .storage-warning strong    { color: var(--text-strong); }
222: :root[data-theme="dark"] .badge-neutral              { background: var(--surface-sunk); color: var(--text-muted); }
223: :root[data-theme="dark"] .badge-warm                 { background: var(--warning-soft); color: var(--warning); }
224: :root[data-theme="dark"] .badge-cold                 { background: var(--info-soft); color: var(--info); }
225: :root[data-theme="dark"] .calc-sum > div            { background: var(--surface-sunk); }
226: :root[data-theme="dark"] .calc-total > div          { background: var(--accent-soft); }
227: :root[data-theme="dark"] .calc-preview               { background: var(--surface-sunk); }
228: :root[data-theme="dark"] .calc-disclaimer            { background: var(--surface-sunk); }
229: :root[data-theme="dark"] .confirm .modal-body .impact { background: var(--surface-sunk); }
230: :root[data-theme="dark"] input,
231: :root[data-theme="dark"] select,
232: :root[data-theme="dark"] textarea { background: var(--card); color: var(--text); border-color: var(--border-strong); }
233: :root[data-theme="dark"] input::placeholder,
234: :root[data-theme="dark"] textarea::placeholder { color: var(--text-soft); }
235: :root[data-theme="dark"] .progress-bar-wrap         { background: var(--border); }
236: :root[data-theme="dark"] .cal-event                  { background: rgba(255,255,255,0.04); }
237: :root[data-theme="dark"] .cal-event:hover           { background: rgba(255,255,255,0.08); }
285: @media (prefers-reduced-motion: reduce) {
297:   grid-template-columns: var(--sidebar-w) minmax(0, 1fr);
731: @media (max-width: 640px) {
1063: @media (min-width: 901px) {
1083: @media (max-width: 900px) {
1155: :root[data-theme="dark"] .stage-pill { background: var(--surface-sunk); color: var(--text); }
1372: @media (max-width: 900px) {
1448: @media (prefers-reduced-motion: reduce) {
1496: @media (min-width: 901px) {
1520: :root[data-theme="dark"] .profile-hero .avatar { background: var(--accent); color: var(--accent-text); }
1653: :root[data-theme="dark"] .coming-soon-hero .icon { background: var(--accent); color: var(--accent-text); }
1731: @media (min-width: 901px) and (max-width: 1150px) {
1740: @media (max-width: 860px) {
1773: @media (max-width: 900px) {
1831: @media (max-width: 480px) {
2155: @media (max-width: 900px) {
2171: @media (max-width: 480px) {
2267: @media (max-width: 900px) {
2272: @media (max-width: 480px) {
2333: @media (max-width: 900px) {
2442: :root[data-theme="dark"] .release-callout-danger { color: var(--danger); }
2447: :root[data-theme="dark"] .release-callout-warning { color: var(--warning); }
2465: @media (max-width: 1050px) {
2469: @media (max-width: 760px) {
2473: @media (max-width: 480px) {
2584: @media (min-width: 901px) and (max-width: 1150px) {
2591: @media (max-width: 900px) {
2665: @media (max-width: 900px) { .settings-nav-section-title { width: 100%; padding: 4px 6px; } .settings-save-bar { position: sticky; bottom: 8px; flex-direction: column; align-items: stretch; } .stage-compact-row { align-items: flex-start; } }
2703: @media (max-width: 900px) {
2708: @media (max-width: 480px) {
2770: @media (max-width: 900px) {
2776: @media (max-width: 480px) {
2806: :root[data-theme="dark"] .toggle-switch .toggle-track { background: var(--border); }
2807: :root[data-theme="dark"] .toggle-switch input:checked + .toggle-track { background: var(--accent); }
2836: :root[data-theme="dark"] .commission-preview-card { background: var(--accent-soft); }
2966: @media (prefers-reduced-motion: reduce) {
3006: @media print {
3148: @media (min-width: 780px) {
3155: @media (prefers-reduced-motion: reduce) {
3160: @media (max-width: 779px) {
3173: @media (max-height: 700px) {
3267: @media (min-width: 640px) {
3307: @media (min-width: 560px) {
3310: @media (min-width: 900px) {
3362: @media (max-width: 767px) {
3415: @media (display-mode: standalone) {
~~~~

### app/assets/js/app.js

~~~~text
26:   // visibility off item.id, and buildRouteMap()/isRouteEnabled() key the route
29:   const NAV = [
30:     { id: "workspace", group: "Workspace", groupIcon: "grid", static: true, items: [
34:     { id: "crm", group: "CRM", groupIcon: "users", items: [
40:     { id: "transactions", group: "Transactions", groupIcon: "map", items: [
45:     // Automation group: every outbound/content workflow in one place. The
50:     { id: "automation", group: "Automation", groupIcon: "zap", items: [
61:     { id: "operations", group: "Operations", groupIcon: "check", items: [
66:     { id: "business", group: "Business", groupIcon: "wallet", items: [
71:     { id: "system", group: "System", groupIcon: "cog", static: true, items: [
72:       // No needsSettings gate. It had one from 24e9417, and
81:       { id: "team", label: "Team", icon: "users", route: "/team", phase: "here", needsTeam: true, needsTeamManage: true }
162:            needsSettings gate that hid it whenever the permissions bag
332:   // an `area` or `needsSettings`. Everything else stays visible and simply
339:   // navItemAllowed, looked up by path, so typing a URL for a page that is
342:   function routeAllowed(path) {
345:         if (it.route === path) return navItemAllowed(it);
351:   function navItemAllowed(it) {
353:     if (it.needsTeam && !(App.customization && App.customization.isTeamMode())) return false;
355:     if (it.needsTeamManage && !ws.can("team_manage")) return false;
367:         (!cust || cust.isModuleEnabled(it.id)) && navItemAllowed(it));
368:       return items.length ? { group: group, items: items } : null;
418:   // Selects one group: highlights its rail button and shows only its panel.
499:     document.documentElement.setAttribute("data-theme", theme);
505:     const isDark = document.documentElement.getAttribute("data-theme") === "dark";
520:     document.documentElement.setAttribute("data-theme", t);
921:         && ((App.customization && !App.customization.isRouteEnabled(path, NAV))
922:             || !routeAllowed(path))) {
955:         && ((App.customization && !App.customization.isRouteEnabled(path, NAV))
956:             || !routeAllowed(path))) {
967:     const contactDetail  = path.match(/^\/contacts\/([^/]+)$/);
968:     const propertyDetail = path.match(/^\/properties\/([^/]+)$/);
969:     const dealDetail     = path.match(/^\/pipeline\/([^/]+)$/);
970:     const settingsDetail = path.match(/^\/settings\/([^/]+)$/);
973:       if (path === "/dashboard") await App.pages.release.renderDashboard(page);
974:       else if (path === "/daily") await App.pages.release.renderDaily(page);
975:       else if (path === "/contacts") await App.pages.contacts.renderList(page);
977:       else if (path === "/properties") await App.pages.properties.renderList(page);
979:       else if (path === "/buyer") await App.pages.buyer.render(page);
980:       else if (path === "/seller") await App.pages.seller.render(page);
981:       else if (path === "/pipeline") await App.pages.deals.renderPipeline(page);
983:       else if (path === "/commission") await App.pages.commission.render(page);
984:       else if (path === "/activities") await App.pages.activities.render(page);
985:       else if (path === "/tasks") await App.pages.tasks.render(page);
986:       else if (path === "/team") await App.pages.teamDashboard.render(page);
987:       else if (path === "/scheduler") await App.pages.scheduler.render(page);
988:       else if (path === "/calendar") await App.pages.calendar.render(page);
989:       else if (path === "/referrals") await App.pages.referrals.render(page);
990:       else if (path === "/goals") await App.pages.goals.render(page);
991:       else if (path === "/finances") await App.pages.finances.render(page);
992:       else if (path === "/reports") await App.pages.reports.render(page);
993:       else if (path === "/content") await App.pages.release.renderContent(page);
994:       else if (path === "/email-templates") await App.pages.emailTemplates.render(page);
999:       else if (path === "/scripts") { navigate("/email-templates"); return; }
1000:       else if (path === "/prompts") await App.pages.release.renderPrompts(page);
1001:       else if (path === "/automation") await App.pages.automation.render(page);
1002:       else if (path === "/notifications") await App.pages.notifications.render(page);
1003:       else if (path === "/settings" || settingsDetail) await App.pages.release.renderSettings(page, settingsDetail ? settingsDetail[1] : null);
1004:       else if (path === "/join" || path.indexOf("/join?") === 0) await App.pages.teamJoin.render(page, App.pages.teamJoin.tokenFromPath(path));
1005:       else if (path === "/") { navigate("/dashboard"); return; }
1290:     if (App.pages.onboarding && App.pages.onboarding.maybeOpen) {
1291:       App.pages.onboarding.maybeOpen();
~~~~

### app/assets/js/core/customization.js

~~~~text
14:   const LOCKED_MODULES = new Set([
24:   const OPTIONAL_MODULES = [
25:     { id: "daily",      label: "Daily View",         group: "Workspace" },
26:     { id: "buyer",      label: "Buyer Workspace",    group: "CRM" },
27:     { id: "seller",     label: "Seller Workspace",   group: "CRM" },
28:     { id: "referrals",  label: "Referrals",          group: "CRM" },
29:     { id: "activities", label: "Activities",         group: "Operations" },
30:     { id: "tasks",      label: "Tasks",              group: "Operations" },
31:     { id: "calendar",   label: "Calendar",           group: "Operations" },
32:     { id: "finances",   label: "Income & Expenses",  group: "Business" },
33:     { id: "goals",      label: "Goals",              group: "Business" },
34:     { id: "reports",    label: "Reports",            group: "Business" },
35:     { id: "content",    label: "Content Library",    group: "Marketing" },
38:     { id: "scripts",    label: "Email Templates",    group: "Marketing" },
39:     { id: "prompts",    label: "AI Prompts",         group: "Marketing" },
40:     { id: "automation", label: "Automation",         group: "Marketing" }
42:   const OPTIONAL_IDS = new Set(OPTIONAL_MODULES.map(m => m.id));
91:     return cfg.teamMode === true;
94:   function isModuleLocked(moduleId) { return LOCKED_MODULES.has(moduleId); }
95:   function isOptionalModule(moduleId) { return OPTIONAL_IDS.has(moduleId); }
97:   function isModuleEnabled(moduleId) {
98:     if (LOCKED_MODULES.has(moduleId)) return true;
99:     if (!OPTIONAL_IDS.has(moduleId)) return true; // unknown ids default to visible so we never hide new pages
101:     return cfg.enabledModules[moduleId] !== false;
111:   function isRouteEnabled(path, NAV) {
115:     if (routeMap[path]) return isModuleEnabled(routeMap[path]);
118:     if (routeMap[base]) return isModuleEnabled(routeMap[base]);
131:       .filter(x => !x.widget.requiresModule || isModuleEnabled(x.widget.requiresModule))
137:     LOCKED_MODULES, OPTIONAL_MODULES, OPTIONAL_IDS, WIDGETS, WIDGETS_BY_ID,
138:     getConfig, isTeamMode, isModuleLocked, isOptionalModule, isModuleEnabled,
139:     isRouteEnabled, buildRouteMap, visibleWidgetsInOrder
~~~~

### app/assets/js/data/data-service.js

~~~~text
617:     // above. The database watches settings_data -> 'teamMode' and refuses to
619:     bag.teamMode = !!(settings.customization && settings.customization.teamMode);
624:       module_toggles: (settings.customization && settings.customization.enabledModules) || {},
627:       settings_data: bag,
633:     const defaults = App.store && App.store._defaultCustomization ? App.store._defaultCustomization() : { enabledModules: {}, dashboardWidgets: {}, branding: {} };
634:     const bag = row.settings_data || {};
642:         enabledModules: row.module_toggles || {},
645:         teamMode: bag.teamMode === true
650:     delete settings.teamMode;
672:   async function requireWorkspaceId_() {
700:   const SETTINGS_MAX_ATTEMPTS = 3;
753:       const workspaceId = await requireWorkspaceId_();
762:       const giveUp = isPermanentWriteError_(err) || attempt >= SETTINGS_MAX_ATTEMPTS;
775:     const workspaceId = await requireWorkspaceId_();
2525:         .eq("workspace_id", await requireWorkspaceId_());
2593:       .eq("workspace_id", await requireWorkspaceId_());
2613:         .eq("workspace_id", await requireWorkspaceId_());
~~~~

### app/assets/js/data/store.js

~~~~text
26:       enabledModules: {
52:       teamMode: false
144:       const em = (src.enabledModules && typeof src.enabledModules === "object") ? src.enabledModules : {};
146:       Object.keys(dc.enabledModules).forEach(k => { mergedModules[k] = (typeof em[k] === "boolean") ? em[k] : dc.enabledModules[k]; });
154:       out.settings.customization = { enabledModules: mergedModules, dashboardWidgets: mergedWidgets, branding: (src.branding && typeof src.branding === "object") ? src.branding : {} };
587:       const dc = defaultCustomization().enabledModules;
588:       const merged = Object.assign({}, cur.enabledModules, patch || {});
590:       const s = await D().updateSettings({ customization: Object.assign({}, cur, { enabledModules: clean }) });
608:       const s = await D().updateSettings({ customization: Object.assign({}, cur, { teamMode: !!on }) });
614:       const s = await D().updateSettings({ customization: Object.assign({}, cur, { enabledModules: defaultCustomization().enabledModules }) });
~~~~

### app/assets/js/pages/onboarding.js

~~~~text
30:   const isDone = () => settings().onboardingDone === true;
192:       await S().settings.update({ onboardingDone: true, onboardingStep: LAST_STEP });
442:   function maybeOpen() {
449:     maybeOpen, open, isDone,
~~~~

### app/assets/js/pages/release.js

~~~~text
68:       const dailyEnabled = App.customization && App.customization.isModuleEnabled("daily");
81:       const calEnabled = App.customization && App.customization.isModuleEnabled("calendar");
349:     const routeEnabled = (r) => !cust || cust.isModuleEnabled(routeToModuleId(r));
780:   const SETTINGS_CATEGORIES = [
781:     { id: "business-profile", label: "Business Profile", icon: "cog", group: "SETUP" },
782:     { id: "pipeline",         label: "Pipeline",         icon: "columns", group: "SETUP" },
783:     { id: "google-sheets",    label: "Google Sheets",    icon: "grid", group: "SETUP" },
784:     { id: "sheet-imports",    label: "Import History",   icon: "activity", group: "SETUP" },
785:     { id: "email-sending",    label: "Email Sending",    icon: "chart", group: "SETUP" },
789:     { id: "notifications",    label: "Notifications",    icon: "bell", group: "SETUP" },
790:     { id: "data-safety",      label: "Data & Safety",    icon: "save", group: "SETUP" },
791:     { id: "modules",          label: "Modules",          icon: "spark", group: "CUSTOMIZE" },
792:     { id: "dashboard",        label: "Dashboard",        icon: "chart", group: "CUSTOMIZE" },
793:     { id: "custom-fields",    label: "Custom Fields",    icon: "edit", group: "CUSTOMIZE" },
794:     { id: "team-access",      label: "Team & Access",    icon: "users", group: "TEAM" },
797:     { id: "team-permissions", label: "What people can do", icon: "lock", group: "TEAM", needsTeam: true }
813:     const known = SETTINGS_CATEGORIES.some(c => c.id === catId && !c.route);
819:       const rows = SETTINGS_CATEGORIES.filter(c => c.group === group && (!c.needsTeam || teamOn)).map(c => {
869:     if (cat === "overview") renderSettingsOverview(pane);
870:     else if (cat === "modules") renderModulesCategory(pane);
871:     else if (cat === "dashboard") renderDashboardCategory(pane);
872:     else if (cat === "pipeline") { await S().ensureLoaded(["deals"]); await renderPipelineCategory(pane); }
873:     else if (cat === "custom-fields") { if (App.pages.customFieldsSettings) await App.pages.customFieldsSettings.render(pane); }
874:     else if (cat === "team-access") { if (App.pages.teamManagement) await App.pages.teamManagement.render(pane); }
875:     else if (cat === "team-permissions") { if (App.pages.teamPermissions) await App.pages.teamPermissions.render(pane, queryValue(catQuery, "member")); }
876:     else if (cat === "google-sheets") { if (App.pages.googleSheetsSettings) await App.pages.googleSheetsSettings.render(pane); }
877:     else if (cat === "sheet-imports") { if (App.pages.googleSheetsImportHistory) await App.pages.googleSheetsImportHistory.render(pane); }
878:     else if (cat === "email-sending") { if (App.pages.emailSendingSettings) await App.pages.emailSendingSettings.render(pane); }
879:     else if (cat === "notifications") { if (App.pages.pushSettings) await App.pages.pushSettings.render(pane); }
880:     else if (cat === "data-safety") renderDataSafetyCategory(pane);
1181:     const NAV = App.app.NAV;
1192:       id: it.id, label: it.label, icon: it.icon, group: g.group
1197:       const enabled = cust.isModuleEnabled(m.id);
1220:     const shown = mods.filter(m => cust.isModuleLocked(m.id) || cust.isModuleEnabled(m.id));
1221:     const hiddenMods = mods.filter(m => !cust.isModuleLocked(m.id) && !cust.isModuleEnabled(m.id));
1372:       const depMissing = w.requiresModule && !cust.isModuleEnabled(w.requiresModule);
~~~~

Inventory: 244 matching source lines, including comments and dynamic consumers; not a count of distinct routes.

## Appendix D ? tests pinning navigation/routes


### tests/edge/email-unsubscribe.test.mjs

~~~~text
7: } from "../helpers/automation-fixture.mjs";
~~~~

### tests/edge/first-attempt-at.test.mjs

~~~~text
6: import { automationScenario, mockFetch, workerRequest, WORKER_ENV } from "../helpers/automation-fixture.mjs";
~~~~

### tests/edge/hot-reply-webhook.test.mjs

~~~~text
6: import { automationScenario, mockFetch, WORKER_ENV, OWNER, CONTACT, CONTACT_EMAIL } from "../helpers/automation-fixture.mjs";
~~~~

### tests/edge/import-lead-file.test.mjs

~~~~text
7: import { WORKER_ENV } from "../helpers/automation-fixture.mjs";
~~~~

### tests/edge/inbound-reply.test.mjs

~~~~text
6: import { automationScenario, mockFetch, workerRequest, WORKER_ENV, OWNER, CONTACT, CONTACT_EMAIL } from "../helpers/automation-fixture.mjs";
~~~~

### tests/edge/manage-automation.test.mjs

~~~~text
7: import { automationScenario, WORKER_ENV, OWNER, CONTACT } from "../helpers/automation-fixture.mjs";
~~~~

### tests/edge/opt-out-reply-webhook.test.mjs

~~~~text
6: import { automationScenario, mockFetch, WORKER_ENV, OWNER, CONTACT, CONTACT_EMAIL } from "../helpers/automation-fixture.mjs";
77:   const { presendGuard } = await import("../helpers/automation-fixture.mjs");
~~~~

### tests/edge/push-sending.test.mjs

~~~~text
14: } from "../helpers/automation-fixture.mjs";
94:   const payload = { title: "A lead replied", body: "Have a look", url: "/contacts/ct_1" };
133:     url: "/contacts/ct_1",
145:   assert.ok(!json.includes("ct_1") || json.includes("/contacts/ct_1"),
150:   assert.equal(push.buildPayload({ url: "/contacts" }).url, "/contacts");
233:     url: "/contacts/ct_1",
264:     { title: "A lead replied", body: "Have a look", url: "/contacts/ct_1" });
~~~~

### tests/edge/resend-webhook.test.mjs

~~~~text
8: import { automationScenario, OWNER, CONTACT, CONTACT_EMAIL, WORKER_ENV } from "../helpers/automation-fixture.mjs";
~~~~

### tests/edge/time-trigger-wiring.test.mjs

~~~~text
14: } from "../helpers/automation-fixture.mjs";
~~~~

### tests/edge/worker-guards.test.mjs

~~~~text
10: } from "../helpers/automation-fixture.mjs";
~~~~

### tests/frontend/automation-time-triggers.test.mjs

~~~~text
18:   "assets/js/pages/automation.js",
179:   assert.match(summary(m), /daily limit/i);
188:   assert.match(text, /daily limit/i);
~~~~

### tests/frontend/crm-commission.test.mjs

~~~~text
81:   assert.deepEqual(p.navigated, ["/settings/team-access"]);
~~~~

### tests/frontend/crm-contacts.test.mjs

~~~~text
18:   "assets/js/pages/contacts.js",
~~~~

### tests/frontend/lead-file-import.test.mjs

~~~~text
272:   deq(d.calls.at(-1), { navigate: "/settings/sheet-imports" });
~~~~

### tests/frontend/notifications.test.mjs

~~~~text
1: // Phase 4H frontend: the notification bell, panel and /notifications page.
10: const SCRIPTS = ["assets/js/core/utils.js", "assets/js/app.js", "assets/js/pages/notifications.js"];
37:   { id: "00000000-0000-4000-8000-000000000001", type: "hot_reply", title: "🔥 Sarah Ahmed replied — asked about a viewing", contact_id: "ct_1", link_route: "/contacts/ct_1", created_at: minsAgo(5) },
38:   { id: "00000000-0000-4000-8000-000000000002", type: "import_finished", title: "File upload finished: 3 added", link_route: "/settings/sheet-imports", created_at: minsAgo(90) },
40:   { id: "00000000-0000-4000-8000-000000000004", type: "followup_failed", title: "<img src=x onerror=alert(1)>", body: "<script>alert(2)</script>", link_route: "/automation", created_at: minsAgo(0.2) },
124:   deq(d.nav, ["/contacts/ct_1"]);
139:   deq(["/contacts/ct_1", "/settings/sheet-imports", "/automation", "/notifications", "/contacts"].map(U.safeRoute),
140:     ["/contacts/ct_1", "/settings/sheet-imports", "/automation", "/notifications", "/contacts"]);
141:   for (const bad of ["https://x.com", "//x.com", "javascript:alert(1)", "/contacts/../settings", "/settings/team", "/automation?x", null, 42]) {
217: test("/notifications page: filters, paging, mark all as read, item actions", async (t) => {
222:     link_route: i % 3 === 0 ? `/contacts/ct_${i}` : "/settings/sheet-imports",
254:   deq(nav, ["/contacts/ct_0"]);
~~~~

### tests/frontend/past-client-programme.test.mjs

~~~~text
240:   "assets/js/pages/automation.js",
~~~~

### tests/frontend/push-settings.test.mjs

~~~~text
338:     data: { json: () => ({ id: "n1", title: "A lead replied", body: "Have a look", url: "/contacts/ct_1" }) },
343:   assert.deepEqual(scope.shown[0].options.data, { url: "/contacts/ct_1" });
350:   assert.deepEqual(scope.shown[1].options.data, { url: "/dashboard" });
365:     url: "https://app.example.test/#/dashboard",
371:   await fire(scope, "notificationclick", {
372:     notification: { close: () => { closed++; }, data: { url: "/contacts/ct_1" } },
376:   assert.deepEqual(navigated, ["./#/contacts/ct_1"]);
381:   await fire(fresh, "notificationclick", {
382:     notification: { close: () => {}, data: { url: "/contacts" } },
384:   assert.deepEqual(fresh.opened, ["./#/contacts"]);
~~~~

### tests/frontend/pwa.test.mjs

~~~~text
85:   // Hash routing: the app reads location.hash, so a start_url without
87:   assert.match(m.start_url, /#\/daily$/);
89:   // absolute "/" start_url is out of scope the moment it is served from
91:   assert.ok(m.start_url.startsWith("./"), m.start_url);
96:   assert.match(css, new RegExp("--sidebar-bg:\\s*" + m.theme_color, "i"));
243:     ["a Supabase REST read", req("https://abcd.supabase.co/rest/v1/contacts?select=*")],
446:   const bar = p.document.getElementById("mobileTabBar");
459:   bar.querySelector('[data-tab-route="/contacts"]').click();
460:   assert.deepEqual(p.navigated, ["/contacts"]);
469:   assert.equal(p.toggled.length, 1, "More opens the sidebar that already exists");
474:   const bar = () => p.document.getElementById("mobileTabBar");
478:   p.window.location.hash = "#/contacts/ct_123";
480:   assert.deepEqual(active(), ["/contacts"], "a contact's own page is still Contacts");
482:   p.window.location.hash = "#/pipeline";
484:   assert.deepEqual(active(), ["/pipeline"]);
488:   p.window.App.customization.isModuleEnabled = (id) => id !== "daily";
492:   assert.deepEqual(JSON.parse(JSON.stringify(routes)), ["/contacts", "/pipeline"]);
~~~~

### tests/frontend/quick-add.test.mjs

~~~~text
170:   assert.deepEqual(p.navigated, ["/contacts/ct_new"], "Open goes to the new contact");
201:   assert.deepEqual(p.navigated, ["/contacts/ct_1"], "and it opens the one already there");
432:   "assets/js/pages/automation.js",
~~~~

### tests/frontend/response-tracking.test.mjs

~~~~text
142:     isModuleEnabled: () => true,
213:     isModuleEnabled: () => true,
~~~~

### tests/frontend/settings-nav.test.mjs

~~~~text
8: // sidebar AND /settings stopped routing, because routeAllowed() asks
78:     renderSettings: async () => { navigated.push("/settings"); },
79:     renderDashboard: async () => { navigated.push("/dashboard"); },
105: // ---------------------------------------------------------------- the rail
107: domTest("the left rail carries a Settings gear, whatever the permissions say", async () => {
110:   const gear = p.document.getElementById("sidebarSettingsBtn");
115:   assert.ok(gear.closest(".sidebar-footer"), "at the bottom of the rail");
119:   assert.equal(p.hash(), "#/settings", "the rail gear goes to Settings");
124:   assert.deepEqual(p.navigated, ["/settings"], "and the Settings screen is what renders");
129:   const items = Array.from(p.document.querySelectorAll('#sidebarNav [data-nav]'))
131:   assert.ok(items.includes("/settings"),
138:     .find((it) => it.route === "/settings").needsSettings, undefined,
144:   assert.ok(p.document.getElementById("sidebarSettingsBtn"));
145:   const links = Array.from(p.document.querySelectorAll('#sidebarNav [data-nav="/settings"]'));
156:   const sidebar = p.document.getElementById("sidebar");
157:   assert.ok(!sidebar.classList.contains("open"), "closed to begin with");
161:   assert.ok(sidebar.classList.contains("open"), "More opens the drawer");
164:   const gear = sidebar.querySelector("#sidebarSettingsBtn");
168:   assert.equal(p.hash(), "#/settings");
170:   assert.deepEqual(p.navigated, ["/settings"]);
171:   assert.ok(!sidebar.classList.contains("open"), "and the drawer closes behind it");
191:   assert.equal(p.hash(), "#/settings");
193:   assert.deepEqual(p.navigated, ["/settings"]);
~~~~

### tests/frontend/stop-status-ui.test.mjs

~~~~text
35:   const b = await browser(["assets/js/core/utils.js", "assets/js/app.js", "assets/js/pages/contacts.js"], {
191:   const b = await browser(["assets/js/core/utils.js", "assets/js/app.js", "assets/js/pages/automation.js"], {
~~~~

### tests/frontend/team-dashboard.test.mjs

~~~~text
55:     assert.deepEqual(b.navigations, ["/settings/team-access"]);
116:     assert.deepEqual(b.navigations, ["/contacts"]);
~~~~

### tests/frontend/team-join.test.mjs

~~~~text
84:     assert.deepEqual(b.navigations, ["/dashboard"]);
145:     assert.deepEqual(b.navigations, ["/dashboard"]);
~~~~

### tests/frontend/team-leads.test.mjs

~~~~text
18:   "assets/js/pages/contacts.js"
~~~~

### tests/frontend/team-management.test.mjs

~~~~text
66:     assert.ok(b.refreshedNav > 0, "the sidebar is told to re-read itself");
173:     assert.ok(link.includes("#/join?token=" + token), "the link carries the token in the hash");
351:     assert.deepEqual(b.navigations, ["/dashboard"]);
410:     assert.deepEqual(b.navigations, ["/dashboard"]);
~~~~

### tests/frontend/team-permissions.test.mjs

~~~~text
56:     assert.deepEqual(b.navigations, ["/settings/team-access"]);
197:     assert.deepEqual(b.navigations, ["/settings/team-access"]);
234:     assert.deepEqual(b.navigations, ["/settings/team-permissions?member=wm-2"]);
~~~~

### tests/frontend/workspace-permissions.test.mjs

~~~~text
243:   // The gated items, decided by the same predicate the sidebar uses.
256:   window.location.hash = "#/finances";
258:   assert.equal(window.location.hash, "#/dashboard",
265:   window.location.hash = "#/contacts";
267:   assert.equal(window.location.hash, "#/contacts");
273:   window.location.hash = "#/finances";
275:   assert.equal(window.location.hash, "#/finances");
~~~~

### tests/security/scan.test.mjs

~~~~text
11: import { automationScenario, mockFetch, workerRequest, WORKER_ENV, OWNER, CONTACT, CONTACT_EMAIL } from "../helpers/automation-fixture.mjs";
~~~~

### tests/sql/file-import.test.mjs

~~~~text
429:     assert.match(emailPlan, /contacts_ws_email_norm_idx/, emailPlan);
430:     assert.match(phonePlan, /contacts_ws_phone_norm_idx/, phonePlan);
~~~~

### tests/sql/notifications.test.mjs

~~~~text
82:   assert.equal(n[0].link_route, `/contacts/${w.contactId}`);
142:   assert.equal(n[0].link_route, "/settings/sheet-imports");
216:   assert.equal(n[0].link_route, "/automation");
267:   assert.equal(n[0].link_route, "/contacts");
345:     await assert.rejects(db.query(`update public.notifications set link_route = '/automation'`), /permission denied/);
369:   for (const ok of ["/contacts", "/contacts/ct_abc-123", "/settings/sheet-imports", "/automation", "/notifications", null]) {
372:   for (const bad of ["https://evil.example.com", "//evil.example.com", "/contacts/../settings", "/settings/team", "javascript:alert(1)",
373:     "/automation?x=1", "/contacts/a b", "/Contacts", ""]) {
374:     await assert.rejects(ins(bad, `bad:${bad}`), /notifications_link_route_check/, bad);
383:   await assert.rejects(ins("Reply from pat@example.com"), /notifications_title_check/);
384:   await assert.rejects(ins("ok", "write to pat@example.com"), /notifications_body_check/);
385:   await assert.rejects(ins("line\nbreak"), /notifications_title_check/);
386:   await assert.rejects(ins("x".repeat(201)), /notifications_title_check/);
~~~~

### tests/sql/phase_3b_push.test.mjs

~~~~text
74:              coalesce($5::timestamptz, now()), '/contacts')`,
264:   assert.equal(row.url, "/contacts", "the app route, not a URL");
~~~~

### tests/sql/phase_t2b1_permissions.test.mjs

~~~~text
187: // ---------------------------------------------------------------- RPC guardrails
~~~~

### tests/sql/phase_t2c_pre_workspace_fks.test.mjs

~~~~text
160:   assert.ok(fks > 0, "user_id -> auth.users survives as the audit trail");
~~~~

### tests/sql/phase_t3_invitations.test.mjs

~~~~text
448:     "the label is stored, so the trail reads correctly after the row is gone");
~~~~

Inventory: 134 matching source lines, including comments and dynamic consumers; not a count of distinct routes.

## Final artifact verification

Repository git status and SHA-256 fingerprint of tracked file contents were identical before and after appendix generation. No tests were executed. Only this external report was written.

## Appendix E ? supplementary literal destinations and page-action gates

Captures bare route constants and permissions not necessarily present on the same line as a navigate call. API/non-navigation literals are included conservatively.

### app/assets/js/app.js

~~~~text
31:       { id: "dashboard", label: "Dashboard",       icon: "grid",  route: "/dashboard", phase: "here" },
32:       { id: "daily",     label: "Today",           icon: "sun",   route: "/daily",     phase: "here" }
35:       { id: "contacts", label: "Contacts",        icon: "users", route: "/contacts",  phase: "here" },
36:       { id: "buyer",    label: "Buyer Workspace", icon: "home",  route: "/buyer",     phase: "here" },
37:       { id: "seller",   label: "Seller Workspace",icon: "tag",   route: "/seller",    phase: "here" },
38:       { id: "referrals",label: "Referrals",       icon: "share", route: "/referrals", phase: "here", area: "finance" }
41:       { id: "properties", label: "Properties",     icon: "map",     route: "/properties",   phase: "here" },
42:       { id: "pipeline",   label: "Deals Pipeline", icon: "columns", route: "/pipeline",     phase: "here" },
43:       { id: "commission", label: "Commission",     icon: "dollar",  route: "/commission",   phase: "here", area: "finance" }
51:       { id: "automation", label: "Automation",       icon: "zap",    route: "/automation",      phase: "here" },
56:       { id: "scripts",    label: "Email Templates", icon: "quote",  route: "/email-templates", phase: "here" },
57:       { id: "scheduler",  label: "Scheduler",       icon: "clock",  route: "/scheduler",       phase: "here" },
58:       { id: "content",    label: "Content Library", icon: "book",   route: "/content",         phase: "here" },
59:       { id: "prompts",    label: "AI Prompts",      icon: "spark",  route: "/prompts",         phase: "here" }
62:       { id: "activities", label: "Activities",      icon: "activity", route: "/activities", phase: "here" },
63:       { id: "tasks",      label: "Tasks",           icon: "check",    route: "/tasks",      phase: "here" },
64:       { id: "calendar",   label: "Calendar",        icon: "cal",      route: "/calendar",   phase: "here" }
67:       { id: "finances", label: "Income & Expenses", icon: "wallet", route: "/finances", phase: "here", area: "finance" },
68:       { id: "goals",    label: "Goals",             icon: "target", route: "/goals",    phase: "here", area: "goals" },
69:       { id: "reports",  label: "Reports",           icon: "chart",  route: "/reports",  phase: "here" }
80:       { id: "settings", label: "Settings",       icon: "cog",      route: "/settings", phase: "here" },
179:               data-nav="/settings" aria-label="Settings">
254:       sidebarSettings.addEventListener("click", () => { navigate("/settings"); closeSidebar(); });
353:     if (it.needsTeam && !(App.customization && App.customization.isTeamMode())) return false;
355:     if (it.needsTeamManage && !ws.can("team_manage")) return false;
356:     if (it.area) return ws.canView(it.area);
455:     return raw.startsWith("/") ? raw : "/dashboard";
705:     if (settingsBtn) settingsBtn.addEventListener("click", () => { closeMenu(); navigate("/settings"); });
706:     if (bizBtn) bizBtn.addEventListener("click", () => { closeMenu(); navigate("/settings/business-profile"); });
920:     if (path !== "/dashboard"
923:       path = "/dashboard";
954:     if (path !== "/dashboard"
957:       navigate("/dashboard");
973:       if (path === "/dashboard") await App.pages.release.renderDashboard(page);
974:       else if (path === "/daily") await App.pages.release.renderDaily(page);
975:       else if (path === "/contacts") await App.pages.contacts.renderList(page);
977:       else if (path === "/properties") await App.pages.properties.renderList(page);
979:       else if (path === "/buyer") await App.pages.buyer.render(page);
980:       else if (path === "/seller") await App.pages.seller.render(page);
981:       else if (path === "/pipeline") await App.pages.deals.renderPipeline(page);
983:       else if (path === "/commission") await App.pages.commission.render(page);
984:       else if (path === "/activities") await App.pages.activities.render(page);
985:       else if (path === "/tasks") await App.pages.tasks.render(page);
987:       else if (path === "/scheduler") await App.pages.scheduler.render(page);
988:       else if (path === "/calendar") await App.pages.calendar.render(page);
989:       else if (path === "/referrals") await App.pages.referrals.render(page);
990:       else if (path === "/goals") await App.pages.goals.render(page);
991:       else if (path === "/finances") await App.pages.finances.render(page);
992:       else if (path === "/reports") await App.pages.reports.render(page);
993:       else if (path === "/content") await App.pages.release.renderContent(page);
994:       else if (path === "/email-templates") await App.pages.emailTemplates.render(page);
999:       else if (path === "/scripts") { navigate("/email-templates"); return; }
1000:       else if (path === "/prompts") await App.pages.release.renderPrompts(page);
1001:       else if (path === "/automation") await App.pages.automation.render(page);
1002:       else if (path === "/notifications") await App.pages.notifications.render(page);
1003:       else if (path === "/settings" || settingsDetail) await App.pages.release.renderSettings(page, settingsDetail ? settingsDetail[1] : null);
1004:       else if (path === "/join" || path.indexOf("/join?") === 0) await App.pages.teamJoin.render(page, App.pages.teamJoin.tokenFromPath(path));
1005:       else if (path === "/") { navigate("/dashboard"); return; }
1080:     if (btn) btn.addEventListener("click", () => navigate("/dashboard"));
~~~~

### app/assets/js/core/customization.js

~~~~text
89:   function isTeamMode() {
~~~~

### app/assets/js/core/mobile-nav.js

~~~~text
41:     { id: "today",    label: "Today",    icon: "today",    route: "/daily",     module: "daily" },
42:     { id: "contacts", label: "Contacts", icon: "contacts", route: "/contacts",  module: "contacts" },
44:     { id: "pipeline", label: "Pipeline", icon: "pipeline", route: "/pipeline",  module: "pipeline" },
58:     return raw.startsWith("/") ? raw : "/dashboard";
~~~~

### app/assets/js/core/quick-add.js

~~~~text
432:         App.app.navigate("/contacts/" + existing.id);
491:         { label: "Open", onClick: () => App.app.navigate("/contacts/" + contact.id) },
~~~~

### app/assets/js/data/workspace.js

~~~~text
85:   function isOwner() { return !!state && state.role === "owner"; }
101:   function canView(area) { return scope(area, "view") !== "none"; }
104:   function canCreate(area) {
134:   function canEditRow(area, row) {
142:   function canDeleteRow(area, row) {
~~~~

### app/assets/js/pages/commission.js

~~~~text
35:         <button class="btn" data-go="/settings/team-access" id="commissionHiddenSettingsBtn" style="margin-top:12px">Open Team & Access</button>`;
37:       if (btn) btn.addEventListener("click", () => App.app.navigate("/settings/team-access"));
290:       tr.addEventListener("click", () => App.app.navigate("/pipeline/" + tr.getAttribute("data-deal-id")));
~~~~

### app/assets/js/pages/contacts.js

~~~~text
30:     return !!(App.customization && App.customization.isTeamMode());
32:   function canAssign() { return teamOn() && App.workspace && App.workspace.can("contacts_assign"); }
33:   function canClaim() { return teamOn() && App.workspace && App.workspace.can("unassigned_claim"); }
38:     return App.workspace.can("contacts_assign") || App.workspace.seesAll("contacts") ||
39:            App.workspace.can("unassigned_view");
434:               <button class="btn btn-ghost" onclick="App.app.navigate('/settings/google-sheets')">Import from Google Sheets</button>
500:         App.app.navigate("/contacts/" + tr.getAttribute("data-id"));
519:       App.app.setBreadcrumbs([{ label: "Contacts", route: "/contacts" }, { label: "Not Found" }]);
530:       { label: "Contacts", route: "/contacts" },
559:       ${App.app.backLink("/contacts", "Contacts")}
1259:           App.app.navigate("/contacts");
1489:           App.app.navigate(`/contacts/${contact.id}`);
~~~~

### app/assets/js/pages/deals.js

~~~~text
241:         App.app.navigate("/pipeline/" + card.getAttribute("data-deal-id"));
247:           App.app.navigate("/pipeline/" + card.getAttribute("data-deal-id"));
330:       tr.addEventListener("click", () => App.app.navigate("/pipeline/" + tr.getAttribute("data-deal-id")));
381:       App.app.setBreadcrumbs([{ label: "Deals Pipeline", route: "/pipeline" }, { label: "Not Found" }]);
387:       { label: "Deals Pipeline", route: "/pipeline" },
416:       ${App.app.backLink("/pipeline", "Deals Pipeline")}
1043:           App.app.navigate("/pipeline");
~~~~

### app/assets/js/pages/google-sheets-import-history.js

~~~~text
252:     pane.querySelector("#gsihManageBtn").addEventListener("click", () => App.app.navigate("/settings/google-sheets"));
539:       if (btn) btn.addEventListener("click", () => App.app.navigate("/settings/google-sheets"));
~~~~

### app/assets/js/pages/lead-file-import.js

~~~~text
26:   const IMPORT_HISTORY_ROUTE = "/settings/sheet-imports";
~~~~

### app/assets/js/pages/notifications.js

~~~~text
284:       App.app.navigate("/notifications");
~~~~

### app/assets/js/pages/onboarding.js

~~~~text
115:         route: "/settings/business-profile" },
117:         done: contacts.length > 0, route: "/contacts" },
119:         done: rules.length > 0, route: "/automation" },
123:         done: rules.some((r) => r.status && r.status !== "draft"), route: "/automation" },
125:         done: activities.length > 0, route: "/daily" }
198:     App.app.navigate("/daily");
339:                 else if (what === "sheets") App.app.navigate("/settings/google-sheets");
340:                 else App.app.navigate("/contacts");
~~~~

### app/assets/js/pages/properties.js

~~~~text
184:         App.app.navigate("/properties/" + tr.getAttribute("data-id"));
203:       App.app.setBreadcrumbs([{ label: "Properties", route: "/properties" }, { label: "Not Found" }]);
209:       { label: "Properties", route: "/properties" },
228:       ${App.app.backLink("/properties", "Properties")}
544:           App.app.navigate("/properties");
~~~~

### app/assets/js/pages/release.js

~~~~text
51:           <div class="card-header"><div class="card-title">Pipeline Snapshot</div><button class="btn btn-sm" data-go="/pipeline">View pipeline</button></div>
70:         ? `<button class="btn btn-sm" data-go="/daily">Open Daily View</button>` : "";
83:         ? `<button class="btn btn-sm" data-go="/calendar">Calendar</button>` : "";
89:               <div class="item-row clickable" data-go="/pipeline/${U().esc(r.dealId)}">
103:           <div class="card-header"><div class="card-title">Goals</div><button class="btn btn-sm" data-go="/goals">View goals</button></div>
118:           <div class="card-header"><div class="card-title">Recent Activity</div><button class="btn btn-sm" data-go="/activities">View all</button></div>
148:           <div class="card-header"><div class="card-title">Properties</div><button class="btn btn-sm" data-go="/properties">View properties</button></div>
164:           <div class="card-header"><div class="card-title">Team Performance</div><button class="btn btn-sm" data-go="/settings/team-access">Manage team</button></div>
351:       ["Overdue follow-ups", a.overdueFollowUps.length, "/contacts"],
352:       ["Follow-ups today", a.followUpsToday.length, "/contacts"],
353:       ["Overdue tasks", a.overdueTasks.length, "/tasks"],
354:       ["Tasks today", a.tasksToday.length, "/tasks"],
355:       ["Upcoming showings", a.upcomingShowings.length, "/calendar"],
356:       ["Deal deadlines", a.dealDeadlines.length, "/calendar"],
357:       ["Upcoming closings", a.upcomingClosings.length, "/pipeline"],
358:       ["Past-due closings", a.pastDueClosings.length, "/pipeline"]
368:   // Map a top-level route (e.g. "/tasks") to its module id via the NAV table.
699:         <section class="card"><div class="card-header"><div class="card-title">Email Templates</div><button class="btn btn-sm" data-go="/email-templates">Open library</button></div><div class="card-body">${
704:         <section class="card"><div class="card-header"><div class="card-title">AI Prompts</div><button class="btn btn-sm" data-go="/prompts">Open library</button></div><div class="card-body">${prompts.slice(0,5).map(renderLibraryPreview).join("") || emptyMessage("No prompts", "Add a prompt from the AI Prompts page.")}</div></section>
817:     const teamOn = !!(App.customization && App.customization.isTeamMode());
842:           App.app.navigate("/settings/" + cat);
1027:     pane.querySelectorAll("[data-overview-cat]").forEach(card => card.onclick = () => App.app.navigate("/settings/" + card.getAttribute("data-overview-cat")));
1548:     root.querySelectorAll("[data-deal-link]").forEach(el => el.addEventListener("click", () => App.app.navigate("/pipeline")));
1685:       if(r.ok){ App.data.resetAllCaches(); App.app.toast('Backup restored.','success'); App.app.navigate('/dashboard'); }
1696:       h.close();App.app.toast('Workspace reset.','success');App.app.navigate('/dashboard');
~~~~

### app/assets/js/pages/scheduler.js

~~~~text
100:       ${(!templatesError && scripts.length === 0 && templates.length === 0) ? '<div class="release-callout" style="margin-bottom:16px">Nothing to schedule from yet. <button class="btn btn-sm" data-go="/email-templates">Add an Email Template</button></div>' : ''}
~~~~

### app/assets/js/pages/team-dashboard.js

~~~~text
52:     if (App.customization && !App.customization.isTeamMode()) {
62:       if (b) b.addEventListener("click", () => App.app.navigate("/settings/team-access"));
104:           ${W().can("team_manage") ? `<button class="btn btn-sm" id="teamManageBtn">Manage the team</button>` : ""}
156:     if (manage) manage.addEventListener("click", () => App.app.navigate("/settings/team-access"));
160:       App.app.navigate("/contacts");
194:     if (App.customization && !App.customization.isTeamMode()) return false;
195:     return !!(W() && W().can && W().can("team_manage"));
~~~~

### app/assets/js/pages/team-join.js

~~~~text
30:    * The token out of a route path like "/join?token=abc". Exported so it
121:       b.addEventListener("click", () => App.app.navigate("/dashboard"));
151:       App.app.navigate("/dashboard");
~~~~

### app/assets/js/pages/team-management.js

~~~~text
108:     if (!W().can("team_manage")) {
124:     const teamOn = App.customization ? App.customization.isTeamMode() : false;
163:     const isOwner = W().isOwner();
399:     if (goPerms) goPerms.addEventListener("click", () => App.app.navigate("/settings/team-permissions"));
433:         App.app.navigate("/settings/team-permissions?member=" + encodeURIComponent(btn.getAttribute("data-perms")));
746:     if (W().isOwner() || !W().id()) return "";
772:             App.app.navigate("/dashboard");
839:                 App.app.navigate("/dashboard");
~~~~

### app/assets/js/pages/team-permissions.js

~~~~text
141:     return W().isOwner() ? "all" : scopeOf(myPerms(), areaKey, action);
143:   function myFlag(key) { return W().isOwner() ? true : W().can(key); }
144:   function mySettings() { return W().isOwner() ? "edit" : W().settingsLevel(); }
164:     if (!W().can("team_manage")) {
175:     if (App.customization && !App.customization.isTeamMode()) {
185:       if (b) b.addEventListener("click", () => App.app.navigate("/settings/team-access"));
225:     if (W().isOwner()) return "";
252:       const createCeiling = myScope(area.key, "edit") !== "none" || W().isOwner();
433:     if (back) back.addEventListener("click", () => App.app.navigate("/settings/team-access"));
445:         App.app.navigate("/settings/team-access");
462:           App.app.navigate("/settings/team-access");
496:       App.app.navigate("/settings/team-permissions?member=" + encodeURIComponent(sel.value));
~~~~

### app/sw.js

~~~~text
169:     : "/dashboard";
185:   const target = (event.notification.data && event.notification.data.url) || "/dashboard";
~~~~
