import { query, mutation } from "./_generated/server";
import { v } from "convex/values";
import { requireGym, requireOwnClass, requireWriteAccess, tryGetGym, tryGetReadableGym } from "./gyms";
import { assertMaxLength } from "./validate";

const classFields = {
  name: v.string(),
  instructor: v.string(),
  dayOfWeek: v.string(),
  time: v.string(),
};

function validateClassFields(fields: { name: string; instructor: string; dayOfWeek: string; time: string }) {
  assertMaxLength(fields.name, 200, "Name");
  assertMaxLength(fields.instructor, 200, "Instructor");
  assertMaxLength(fields.dayOfWeek, 20, "Day of week");
  assertMaxLength(fields.time, 20, "Time");
}

export const getAll = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return [];
    return await ctx.db
      .query("classes")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
  },
});

// PUBLIC AND UNAUTHENTICATED — the check-in kiosk is a tablet at the front
// door with no login, the same trust model as members.getActiveForGym, which
// already exposes the full active roster for a gymId. Class names, instructor
// names and times are strictly less sensitive than that, so this widens
// nothing that isn't already open.
//
// Returns EVERY class for the gym, not just today's, and deliberately does no
// day filtering server-side. Convex runs in UTC: after 6pm in Denver it is
// already tomorrow in UTC, so a server-side "today" would show the wrong day's
// classes during exactly the evening hours a gym is busiest. The kiosk tablet
// is physically in the gym, so its own local day is the correct one — the
// client filters. That also means this needs no timezone field on gyms.
//
// dayOfWeek and time are free-text strings the owner typed (see classFields
// above). No parsing is attempted here; the kiosk matches loosely on the
// three-letter day prefix, which handles "Monday", "Mon", "Mon/Wed" and
// "Monday & Wednesday" alike. Structuring the schedule properly is what
// automatic current-class detection would require, and is deliberately not
// part of this change.
export const listForKiosk = query({
  args: { gymId: v.id("gyms") },
  handler: async (ctx, { gymId }) => {
    const classes = await ctx.db
      .query("classes")
      .withIndex("by_gym", (q) => q.eq("gymId", gymId))
      .collect();
    return classes.map((c) => ({
      _id: c._id,
      name: c.name,
      instructor: c.instructor,
      dayOfWeek: c.dayOfWeek,
      time: c.time,
    }));
  },
});

export const getById = query({
  args: { id: v.id("classes") },
  handler: async (ctx, { id }) => {
    const gym = await tryGetReadableGym(ctx);
    if (!gym) return null;
    const cls = await ctx.db.get(id);
    if (!cls || cls.gymId !== gym._id) return null;
    return cls;
  },
});

export const getCount = query({
  args: {},
  handler: async (ctx) => {
    const gym = await tryGetGym(ctx);
    if (!gym) return 0;
    const classes = await ctx.db
      .query("classes")
      .withIndex("by_gym", (q) => q.eq("gymId", gym._id))
      .collect();
    return classes.length;
  },
});

export const add = mutation({
  args: classFields,
  handler: async (ctx, args) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    validateClassFields(args);
    return ctx.db.insert("classes", { ...args, gymId: gym._id });
  },
});

export const update = mutation({
  args: { id: v.id("classes"), ...classFields },
  handler: async (ctx, { id, ...fields }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    await requireOwnClass(ctx, gym._id, id);
    validateClassFields(fields);
    return ctx.db.patch(id, fields);
  },
});

export const remove = mutation({
  args: { id: v.id("classes") },
  handler: async (ctx, { id }) => {
    const gym = await requireGym(ctx);
    requireWriteAccess(gym);
    await requireOwnClass(ctx, gym._id, id);
    const enrollments = await ctx.db.query("enrollments").withIndex("by_class", (q) => q.eq("classId", id)).collect();
    for (const e of enrollments) await ctx.db.delete(e._id);
    const attendance = await ctx.db.query("attendance").withIndex("by_class", (q) => q.eq("classId", id)).collect();
    for (const a of attendance) await ctx.db.delete(a._id);
    await ctx.db.delete(id);
  },
});
