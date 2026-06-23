import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  members: defineTable({
    name: v.string(),
    plan: v.string(),
    status: v.union(v.literal("active"), v.literal("inactive")),
    email: v.optional(v.string()),
    phone: v.optional(v.string()),
    beltRank: v.optional(v.string()),
    lastVisit: v.optional(v.string()),
  }),
  classes: defineTable({
    name: v.string(),
    instructor: v.string(),
    dayOfWeek: v.string(),
    time: v.string(),
  }),
  invoices: defineTable({
    memberId: v.id("members"),
    amount: v.number(),
    status: v.union(v.literal("paid"), v.literal("unpaid")),
    dueDate: v.string(),
  }),
  enrollments: defineTable({
    memberId: v.id("members"),
    classId: v.id("classes"),
  })
    .index("by_class", ["classId"])
    .index("by_member", ["memberId"]),
  attendance: defineTable({
    classId: v.id("classes"),
    memberId: v.id("members"),
    date: v.string(),
    checkedInAt: v.string(),
  })
    .index("by_class_date", ["classId", "date"])
    .index("by_class", ["classId"])
    .index("by_member", ["memberId"]),
});
