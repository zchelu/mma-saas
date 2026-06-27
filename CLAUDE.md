# KombatDesk — Claude Code Project Brain

## What This Project Is
KombatDesk is a gym management SaaS for independent MMA and BJJ gym owners.
Core problem it solves: silent member attrition — members quitting without warning.
Key features: member tracking, attendance, check-ins, class scheduling, billing.

---

## Tech Stack
- **Frontend**: Next.js (App Router), Tailwind CSS v4, TypeScript
- **Backend**: Convex (sole backend + database + real-time)
- **Auth**: Clerk
- **Analytics**: PostHog
- **Deployment**: Vercel
- **Domain**: kombatdesk.com

---

## File Structure

### App (Next.js)
| Path | Purpose |
|------|---------|
| `app/page.tsx` | Root / landing page |
| `app/dashboard/` | Stats cards + main dashboard |
| `app/members/` | Member list + add/edit modal |
| `app/classes/` | Class list, modal, detail page |
| `app/invoices/` | Invoice list + modal |
| `app/checkin/` | Kiosk check-in page |
| `app/setup/` | Gym onboarding/setup page |
| `app/sign-in/` | Clerk sign-in page |
| `app/sign-up/` | Clerk sign-up page |
| `app/signup/` | Custom signup/waitlist flow |

### Backend (Convex)
| File | Purpose |
|------|---------|
| `convex/schema.ts` | All data models / table definitions |
| `convex/members.ts` | Member queries + mutations |
| `convex/classes.ts` | Class queries + mutations |
| `convex/attendance.ts` | Attendance tracking logic |
| `convex/enrollments.ts` | Member-to-class enrollment logic |
| `convex/invoices.ts` | Invoice queries + mutations |
| `convex/crons.ts` | Scheduled background jobs |

---

## Brand & Design System
- **Base color**: `#0D0D0D` (black)
- **Primary CTA accent**: `#E02020` (red) — dominant, used for all primary actions
- **Secondary accent**: `#3B82F6` (blue) — sparingly, for status indicators only
- All UI should feel dark, sharp, and combat-sport appropriate

---

## Coding Conventions
1. **One concern per file** — components, hooks, and utilities each live in their own file
2. **Never put business logic in page files** — pages import and compose, they don't compute
3. **All data goes through Convex** — no local state for anything that needs to persist
4. **Tailwind only** — no inline styles, no CSS modules
5. **TypeScript strict** — no `any` types
6. **Before editing a file**, read it fully first to understand its current shape
7. **After editing**, confirm the change is isolated and won't break imports elsewhere

---

## Current Feature Status
- [x] Landing page with hero headline
- [x] Member list page (name, plan, status, last attended)
- [x] Kiosk check-in page (`/checkin`) — search name → tap → updates Convex
- [x] Class list + modal
- [x] Invoice list + modal
- [x] Admin dashboard with stat cards (currently hardcoded)
- [ ] Dashboard stat cards pulling live Convex data
- [ ] Member add/edit/delete mutations fully wired
- [ ] Automated SMS retention alerts (Twilio — not started)

---

## Decisions Log
- **Convex over Supabase/Firebase**: chosen for real-time sync and simpler mutations without REST boilerplate
- **Clerk for auth**: handles multi-tenant gym owner auth without custom session logic
- **Red as primary CTA**: positions KombatDesk as aggressive/urgent vs. generic SaaS blue
- **First-person CTA copy**: "I'm ready to get started" style (Acquisition.com pattern)
- **No pricing on signup flow**: builds trust via 24-hour callback promise instead of pushing conversion immediately
- **Name = KombatDesk**: prior names (MatOS, MatFlow) abandoned due to trademark conflicts

---

## Dev Environment
- OS: Windows, PowerShell, VS Code
- Start dev: terminal 1 → `npm run dev` | terminal 2 → `npx convex dev`
- Local: `localhost:3000`
- Repo: GitHub (git add . → git commit → git push)

---

## Claude Code Rules for This Project
- Always keep edits modular — touch the smallest number of files possible
- When adding a feature, plan the file structure before writing any code
- Update the **Current Feature Status** section above when a feature is completed
- If a decision is made about architecture or design, add it to the **Decisions Log**
- Never rewrite a working file to "clean it up" unless explicitly asked
