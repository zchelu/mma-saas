// Pure unit tests for the shared send-eligibility predicate — no Convex, no
// network. sendRetentionTexts.ts:getAtRiskMembers, members.ts:getTextableCount,
// and app/members/page.tsx:textState all delegate their "would this member
// actually get texted" logic here; these lock in the five gates so a future
// edit to any one of them can't silently drift from the other two call sites.
import { describe, expect, test } from "vitest";
import { isTextEligibleMember, type TextEligibilityFields } from "./memberEligibility";

const base: TextEligibilityFields = {
  status: "active",
  phone: "7205550100",
  smsConsentConfirmed: true,
};

test("eligible: active, phone, confirmed consent, not opted out, not archived", () => {
  expect(isTextEligibleMember(base)).toBe(true);
});

test("archived member is excluded even if otherwise eligible", () => {
  expect(isTextEligibleMember({ ...base, archived: true })).toBe(false);
});

test("inactive status is excluded", () => {
  expect(isTextEligibleMember({ ...base, status: "inactive" })).toBe(false);
});

test("no phone number is excluded", () => {
  expect(isTextEligibleMember({ ...base, phone: undefined })).toBe(false);
});

test("unconfirmed consent is excluded", () => {
  expect(isTextEligibleMember({ ...base, smsConsentConfirmed: false })).toBe(false);
  expect(isTextEligibleMember({ ...base, smsConsentConfirmed: undefined })).toBe(false);
});

test("opted-out member is excluded even with confirmed consent", () => {
  expect(isTextEligibleMember({ ...base, smsOptedOut: true })).toBe(false);
});
