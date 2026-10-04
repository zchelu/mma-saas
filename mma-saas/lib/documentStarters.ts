// Starter documents — the pre-made library behind /settings/documents.
//
// DECISION, 2026-10-03 (Zain): KombatDesk now OFFERS starter text. Until today
// the rule was "the gym pastes its own waiver and we never supply legal
// language"; that left an owner with no digital waiver unable to use the
// signing rail at all, which is most of the gyms being sold to. The rule that
// replaces it:
//
//   - A starter is a STARTING POINT the owner loads into the editor, reads,
//     edits if they want, and saves as THEIR document. Nothing here is ever
//     written into a gym without the owner pressing Save on it.
//   - Every surface that offers one says it is not legal advice and that
//     waiver and membership rules vary by state (STARTER_NOTICE below).
//   - The text is ORIGINAL to this repo. Do not paste in another company's
//     template, an attorney's form found online, or a customer's own waiver:
//     those are someone else's copyrighted work, and this repo is public. A
//     gym's own waiver goes into THAT gym's account through the editor — it
//     does not become a template for everyone else.
//
// WHAT A STARTER MAY NOT DO
//
//   - Name a state. Governing law is written as "the state where the Academy
//     is located", so the text isn't wrong for a gym outside Colorado.
//   - Use {{member_address}}. The kiosk signup form makes address REQUIRED the
//     moment any template prints it (documents.ts:getKioskGym), and a longer
//     form at the front desk is a real cost. An owner who wants it can add it.
//   - Invent the gym's commercial terms. Anything only the owner can know
//     (notice period, freeze rules, how to cancel) is a [FILL IN: ...] blank,
//     and a document with a blank left in it cannot be saved — see
//     unfilledBlanks, enforced in the editor AND in convex/documents.ts.
//
// Pure and dependency-free, like lib/documents.ts, so the settings screen, the
// Convex functions and the tests all read the same text.

export type StarterKey =
  | "membership_contract"
  | "liability_waiver"
  | "membership_agreement"
  | "code_of_conduct"
  | "media_release";

export type StarterDocument = {
  key: StarterKey;
  title: string;
  /** One line for the library card. */
  summary: string;
  /** Loads as the gym's waiver — the one document that gates check-in. */
  isWaiver: boolean;
  requiresGuardianForMinors: boolean;
  /** Default for the "must sign before check-in" box. Always true for the waiver. */
  requiredAtSignup: boolean;
  /** What the owner should look at before members sign. Shown in the editor. */
  reviewNotes: string[];
  content: string;
};

/**
 * Shown wherever a starter is offered. One constant so the library card and
 * the editor cannot drift into saying different things about the same text.
 */
export const STARTER_NOTICE =
  "Starter templates are a starting point, not legal advice. Waiver and membership rules vary by state, so have your attorney review the text before members sign it. Once you save it, it's your document.";

// ---------------------------------------------------------------------------
// Blanks
// ---------------------------------------------------------------------------

// [FILL IN: label]. Square brackets and capitals so it cannot be confused with
// a {{placeholder}} (which resolves per member at signing) — a blank is
// resolved ONCE, by the owner, before the document can be saved at all.
const BLANK_RE = /\[FILL IN:\s*([^\]]+?)\s*\]/g;

/**
 * Labels of every blank still in the text, in order of first appearance.
 *
 * A member must never be shown "[FILL IN: how to cancel]" on the tablet, and a
 * signed record frozen with one in it is evidence of nothing. Both the editor
 * and convex/documents.ts:validateTemplateFields refuse to save while this is
 * non-empty.
 */
export function unfilledBlanks(content: string): string[] {
  const labels: string[] = [];
  for (const m of content.matchAll(BLANK_RE)) {
    if (!labels.includes(m[1])) labels.push(m[1]);
  }
  return labels;
}

/** Where the first remaining blank sits, so the editor can jump the cursor to it. */
export function firstBlankRange(content: string): { start: number; end: number } | null {
  const re = new RegExp(BLANK_RE.source);
  const m = re.exec(content);
  if (!m) return null;
  return { start: m.index, end: m.index + m[0].length };
}

/**
 * Replace blanks by label. A label with no value is left in place, so the
 * caller can tell (via unfilledBlanks) that something is still missing rather
 * than getting a document with a hole in it. Used by the demo seeder.
 */
export function fillBlanks(content: string, values: Record<string, string>): string {
  return content.replace(BLANK_RE, (whole, label: string) => {
    const value = values[label]?.trim();
    return value ? value : whole;
  });
}

/**
 * The example a blank's own label suggests ("... - e.g. <example>"), or null
 * if it has none. Every blank in the starter library carries one (tested), so
 * the owner sees what a typical answer looks like — and convex/seedDemoGym.ts
 * fills the demo gym's copies with exactly these, rather than keeping a second
 * list of answers that could drift from the labels.
 */
export function blankExample(label: string): string | null {
  const marker = "e.g. ";
  const at = label.indexOf(marker);
  if (at === -1) return null;
  const example = label.slice(at + marker.length).trim();
  return example.length > 0 ? example : null;
}

// ---------------------------------------------------------------------------
// The documents
// ---------------------------------------------------------------------------
//
// One paragraph per line, NOT hard-wrapped at 80 columns. The signing screen
// renders this as plain text with `pre-wrap`, so a hard-wrapped paragraph
// shows as ragged half-lines on a tablet held in portrait.

const LIABILITY_WAIVER = `ASSUMPTION OF RISK, RELEASE OF LIABILITY AND INDEMNITY AGREEMENT

PLEASE READ CAREFULLY. THIS IS A LEGAL DOCUMENT. BY SIGNING IT YOU GIVE UP LEGAL RIGHTS, INCLUDING THE RIGHT TO SUE.

Participant: {{member_name}}
Date of birth: {{member_dob}}
Academy: {{gym_name}}
Date: {{today}}

1. WHAT THIS COVERS. This agreement covers everything I do at or with {{gym_name}} (the "Academy"), including classes, private lessons, open mats, drilling, sparring, strength and conditioning, seminars, belt testing and in-house competitions, and my use of the Academy's premises and equipment, whether on or off the Academy's premises (the "Activities").

2. THE RISKS. Brazilian Jiu-Jitsu, grappling, wrestling, Muay Thai, kickboxing, boxing, mixed martial arts and the conditioning that goes with them are contact activities. They involve strikes, throws, takedowns, joint locks and chokes, and they carry a real risk of injury. That risk includes, among other things: bruises, cuts and abrasions; muscle strains and tears; sprained, dislocated or hyperextended joints; broken bones; damage to teeth and eyes; cauliflower ear; skin infections passed on by mat or partner contact; concussion and other head, neck and spinal injuries; loss of consciousness; heat illness; cardiac events; permanent disability; and death. These risks exist even when instruction, supervision, matting and equipment are all appropriate, and they come in part from the actions of the other people training with me.

3. I ACCEPT THE RISKS. I am taking part voluntarily. I understand the risks above, I understand there are others I cannot foresee, and I accept and assume all of them.

4. MY HEALTH. I am physically able to take part. I know of no medical condition, injury, medication or pregnancy that makes the Activities unsafe for me, and I understand I should talk to a doctor before starting if I am unsure. If that changes, I will tell the Academy before I train again. I will not train while I am ill, while I have an open wound, rash or contagious skin condition, or while I am under the influence of alcohol or any drug that affects my judgment or coordination.

5. SAFETY RULES. I will follow the instructions of the Academy's instructors and staff and the Academy's rules. I will tap early, release a submission the moment my partner taps or says stop, use the protective equipment I am told to use, use only techniques I have been taught and am permitted to use, and tell an instructor right away if I or anyone else is hurt.

6. RELEASE. In exchange for being allowed to take part, and to the fullest extent permitted by law, I release and agree not to sue the Academy and its owners, officers, instructors, employees, volunteers, landlords and other members (the "Released Parties") for any claim, loss, damage or injury, including death, arising out of or related to the Activities or my presence on the Academy's premises, INCLUDING CLAIMS BASED ON THE ORDINARY NEGLIGENCE OF THE RELEASED PARTIES. This release does not apply to gross negligence, to reckless or intentional misconduct, or to any claim that cannot be released under applicable law.

7. INDEMNITY. If I, or anyone acting for me, bring a claim that this agreement releases, or if someone else brings a claim against the Released Parties because of something I did, I will reimburse the Released Parties for their resulting losses and costs, including reasonable attorney's fees, to the fullest extent permitted by law.

8. EMERGENCY CARE. If I am hurt and cannot give consent, I authorize the Academy's staff to give first aid and to call emergency medical services for me. I am responsible for the cost of any treatment or transport.

9. PERSONAL PROPERTY. I am responsible for my own belongings. The Academy is not responsible for property that is lost, stolen or damaged on its premises.

10. HOW LONG THIS LASTS. This agreement applies every time I take part in the Activities, for as long as I train at the Academy. It binds me, my spouse, my heirs, my estate and anyone else who could bring a claim on my behalf.

11. GENERAL. This agreement is governed by the laws of the state where the Academy is located. If any part of it is found unenforceable, that part is to be enforced as far as the law allows and the rest stays in effect.

12. ACKNOWLEDGMENT. I have read this agreement and I understand it. I know I am giving up legal rights by signing it. I am signing freely, and nobody has promised me anything to get me to sign.

PARENT OR GUARDIAN (if the Participant is under the age of majority). I am the Participant's parent or legal guardian and I have the legal authority to sign for them. I have read this agreement, I have explained the risks to the Participant, and I consent to the Participant taking part. I agree to every term of this agreement on the Participant's behalf and on my own behalf, including the release in section 6, the indemnity in section 7 and the emergency care authorization in section 8, to the fullest extent permitted by law.`;

const MEMBERSHIP_AGREEMENT = `MEMBERSHIP AND BILLING AGREEMENT

Member: {{member_name}}
Academy: {{gym_name}}
Date: {{today}}

1. MY MEMBERSHIP. This agreement sets the terms of my membership at {{gym_name}} (the "Academy"). The plan I chose, its price, how often I am billed and any minimum commitment were shown to me when I signed up, and they are part of this agreement.

2. RECURRING PAYMENTS. My membership renews automatically at the end of each billing period. I authorize the Academy to charge the payment method I have on file for my membership dues on each billing date, at the price of my plan, until my membership is cancelled as described in section 6. It is my job to keep my payment method up to date.

3. PRICE CHANGES. The Academy may change the price of my plan. It will tell me before a new price applies to me, and the new price will not apply to a period I have already paid for.

4. FAILED PAYMENTS. If a payment fails, the Academy may try the charge again and will ask me to update my payment method. The Academy may pause my access to classes until my account is paid up. I still owe any dues that came due before my membership was cancelled.

5. FREEZING MY MEMBERSHIP. I may freeze my membership [FILL IN: freeze terms - e.g. for up to 3 months in any 12-month period for injury, travel or military duty]. To freeze, I will ask the Academy before my next billing date. Dues already charged are not refunded for a freeze requested after the billing date.

6. CANCELLING. I may cancel my membership by [FILL IN: how to cancel - e.g. telling the front desk in writing or emailing the Academy]. My cancellation takes effect [FILL IN: when cancellation takes effect - e.g. at the end of the billing period in which I give notice]. I will not be charged after that date. Not showing up to class does not cancel my membership.

7. REFUNDS. Dues are not refunded for classes I do not attend or for the unused part of a billing period, unless the law requires it.

8. SCHEDULE AND CLOSURES. The Academy may change its class schedule, instructors and hours, and may close for holidays, events and maintenance. Short closures do not change my dues.

9. ENDING MY MEMBERSHIP FOR CONDUCT. The Academy may suspend or end my membership if I break its rules, put other members at risk or leave my account unpaid. If the Academy ends my membership, I will not be charged for any billing period that starts after that.

10. MINORS. If the member is under the age of majority, the parent or legal guardian who signs below agrees to this agreement and is responsible for paying the member's dues.

11. MY LEGAL RIGHTS. Nothing in this agreement takes away any right to cancel or to a refund that the consumer protection laws of my state give me.

12. ACKNOWLEDGMENT. I have read this agreement, I understand that my membership renews and is billed automatically until I cancel, and I agree to these terms.`;

const CODE_OF_CONDUCT = `ACADEMY RULES AND CODE OF CONDUCT

Member: {{member_name}}
Academy: {{gym_name}}
Date: {{today}}

These rules keep everyone at {{gym_name}} safe, healthy and able to train tomorrow. By signing, I agree to follow them.

1. HYGIENE.
- I will come to class clean, in a clean uniform or clean training clothes, every session.
- I will keep my fingernails and toenails short.
- I will not wear shoes on the mats, and I will not walk barefoot off the mats, especially in the bathroom.
- I will take off jewelry, watches and piercings before training, or cover them as an instructor directs.
- I will clean up after myself and wipe down any equipment I use.

2. STAY HOME WHEN IT COULD SPREAD.
- I will not train with ringworm, staph, impetigo, herpes or any other rash or skin condition until it has cleared.
- I will not train with an open or bleeding wound unless it is fully covered and an instructor says it is fine.
- I will not train while I am sick with anything contagious.
- If I find a skin infection after training, I will tell an instructor so my training partners can be told.

3. TRAINING SAFELY.
- I will tap early and tap clearly, and I will let go the moment my partner taps or says stop.
- I will apply submissions with control and give my partner time to tap.
- I will match my intensity to my partner, especially when they are smaller, newer, older or coming back from injury.
- I will use only the techniques an instructor has cleared for my level and for that session. No slams, and nothing an instructor has told me is not allowed.
- I will spar only when an instructor says I can, and I will wear the protective equipment required for that session.
- I will tell an instructor about any injury, mine or a partner's, right away.

4. RESPECT.
- I will treat every member, guest, instructor and staff member with respect, on and off the mats.
- Harassment, bullying, discrimination, threats and unwanted contact outside of training are not tolerated.
- I will follow instructors' directions. On safety, their decision is final.
- I will ask before I photograph or film anyone, and before I post it.
- I will not train under the influence of alcohol or drugs.

5. OUTSIDE THE ACADEMY. What I learn here is for training, competition and self-defense. I will not use it to start fights or to hurt or intimidate anyone.

6. CHILDREN. Parents and guardians are responsible for children who are not in a class. Children may not be on the mats or use equipment without an instructor present.

7. IF I BREAK THESE RULES. The Academy may ask me to sit out, send me home, suspend my membership or end it.

I have read these rules and I agree to follow them.`;

const MEDIA_RELEASE = `PHOTO AND VIDEO RELEASE

Name: {{member_name}}
Academy: {{gym_name}}
Date: {{today}}

1. PERMISSION. {{gym_name}} (the "Academy") photographs and films classes, belt promotions, seminars and events. I give the Academy permission to photograph and record me during these activities, and to use those photos and recordings, including my image, my voice, my first name and my rank, to promote the Academy.

2. WHERE IT MAY APPEAR. The Academy may use these photos and recordings on its website, on its social media accounts, in advertising, and in emails and printed materials. It may edit and crop them.

3. NO PAYMENT. I will not be paid for any of this use. The photos and recordings belong to the Academy, and I do not need to approve them before they are used.

4. CHANGING MY MIND. I can withdraw this permission at any time by telling the Academy in writing. The Academy will stop making new use of my image within a reasonable time. It is not required to take back materials that are already printed or published, but it will remove a post from its own website or social media accounts if I ask.

5. RELEASE. I release the Academy and its owners, instructors and staff from any claim arising from a use of my image that this release allows.

6. MINORS. If the person named above is under the age of majority, I am their parent or legal guardian and I give this permission on their behalf.

I have read this release and I agree to it.`;

// The all-in-one. Some gyms run on ONE contract a new member signs once —
// membership terms, payment authorization, waiver and photo permission in a
// single document — rather than three or four separate ones. This is that
// shape, written from the same original text as the separate starters above.
//
// It loads as the gym's WAIVER (isWaiver), because it contains the release and
// so has to be the document that gates check-in. A gym uses EITHER this OR the
// separate Liability Waiver + Membership and Billing Agreement + Photo and
// Video Release, never both — the review notes say so.
//
// NOT derived from any customer's contract. A gym that already has its own
// all-in-one contract pastes that into its own account; see the header.
const MEMBERSHIP_CONTRACT = `MEMBERSHIP CONTRACT, WAIVER AND RELEASE

PLEASE READ CAREFULLY. THIS IS A LEGAL DOCUMENT. BY SIGNING IT YOU AGREE TO RECURRING PAYMENTS AND YOU GIVE UP LEGAL RIGHTS, INCLUDING THE RIGHT TO SUE.

Member: {{member_name}}
Date of birth: {{member_dob}}
Academy: {{gym_name}}
Date: {{today}}

PART 1. MEMBERSHIP AND PAYMENT

1. MY MEMBERSHIP. This contract sets the terms of my membership at {{gym_name}} (the "Academy"). The plan I chose, its price, how often I am billed and any minimum commitment were shown to me when I signed up, and they are part of this contract.

2. RECURRING PAYMENTS. My membership renews automatically at the end of each billing period. I authorize the Academy to charge the payment method I have on file for my membership dues on each billing date, at the price of my plan, until my membership is cancelled as described in section 7. It is my job to keep my payment method up to date.

3. PRICE CHANGES. The Academy may change the price of my plan. It will tell me before a new price applies to me, and the new price will not apply to a period I have already paid for.

4. FAILED PAYMENTS. If a payment fails, the Academy may try the charge again and will ask me to update my payment method. The Academy may pause my access to classes until my account is paid up. I still owe any dues that came due before my membership was cancelled.

5. WHAT MY DUES DO NOT COVER. Unless my plan says otherwise, uniforms, protective equipment, seminars, competitions and rank promotion fees are not included in my dues. The Academy will tell me the price before I am charged for any of them.

6. FREEZING MY MEMBERSHIP. I may freeze my membership [FILL IN: freeze terms - e.g. for up to 3 months in any 12-month period for injury, travel or military duty]. To freeze, I will ask the Academy before my next billing date. Dues already charged are not refunded for a freeze requested after the billing date.

7. CANCELLING. I may cancel my membership by [FILL IN: how to cancel - e.g. telling the front desk in writing or emailing the Academy]. My cancellation takes effect [FILL IN: when cancellation takes effect - e.g. at the end of the billing period in which I give notice]. I will not be charged after that date. Not showing up to class does not cancel my membership.

8. REFUNDS. Dues are not refunded for classes I do not attend or for the unused part of a billing period, unless the law requires it.

9. SCHEDULE AND CLOSURES. The Academy may change its class schedule, instructors and hours, and may close for holidays, events and maintenance. Short closures do not change my dues.

10. ENDING MY MEMBERSHIP FOR CONDUCT. The Academy may suspend or end my membership if I break its rules, put other members at risk or leave my account unpaid. If the Academy ends my membership, I will not be charged for any billing period that starts after that.

PART 2. ASSUMPTION OF RISK AND RELEASE

11. WHAT THIS PART COVERS. This part covers everything I do at or with the Academy, including classes, private lessons, open mats, drilling, sparring, strength and conditioning, seminars, belt testing and in-house competitions, and my use of the Academy's premises and equipment, whether on or off the Academy's premises (the "Activities").

12. THE RISKS. Brazilian Jiu-Jitsu, grappling, wrestling, Muay Thai, kickboxing, boxing, mixed martial arts and the conditioning that goes with them are contact activities. They involve strikes, throws, takedowns, joint locks and chokes, and they carry a real risk of injury. That risk includes, among other things: bruises, cuts and abrasions; muscle strains and tears; sprained, dislocated or hyperextended joints; broken bones; damage to teeth and eyes; cauliflower ear; skin infections passed on by mat or partner contact; concussion and other head, neck and spinal injuries; loss of consciousness; heat illness; cardiac events; permanent disability; and death. These risks exist even when instruction, supervision, matting and equipment are all appropriate, and they come in part from the actions of the other people training with me.

13. I ACCEPT THE RISKS. I am taking part voluntarily. I understand the risks above, I understand there are others I cannot foresee, and I accept and assume all of them.

14. MY HEALTH. I am physically able to take part. I know of no medical condition, injury, medication or pregnancy that makes the Activities unsafe for me, and I understand I should talk to a doctor before starting if I am unsure. If that changes, I will tell the Academy before I train again. I will not train while I am ill, while I have an open wound, rash or contagious skin condition, or while I am under the influence of alcohol or any drug that affects my judgment or coordination.

15. SAFETY RULES. I will follow the instructions of the Academy's instructors and staff and the Academy's rules. I will tap early, release a submission the moment my partner taps or says stop, use the protective equipment I am told to use, use only techniques I have been taught and am permitted to use, and tell an instructor right away if I or anyone else is hurt.

16. RELEASE. In exchange for being allowed to take part, and to the fullest extent permitted by law, I release and agree not to sue the Academy and its owners, officers, instructors, employees, volunteers, landlords and other members (the "Released Parties") for any claim, loss, damage or injury, including death, arising out of or related to the Activities or my presence on the Academy's premises, INCLUDING CLAIMS BASED ON THE ORDINARY NEGLIGENCE OF THE RELEASED PARTIES. This release does not apply to gross negligence, to reckless or intentional misconduct, or to any claim that cannot be released under applicable law.

17. INDEMNITY. If I, or anyone acting for me, bring a claim that this contract releases, or if someone else brings a claim against the Released Parties because of something I did, I will reimburse the Released Parties for their resulting losses and costs, including reasonable attorney's fees, to the fullest extent permitted by law.

18. EMERGENCY CARE. If I am hurt and cannot give consent, I authorize the Academy's staff to give first aid and to call emergency medical services for me. I am responsible for the cost of any treatment or transport.

19. PERSONAL PROPERTY. I am responsible for my own belongings. The Academy is not responsible for property that is lost, stolen or damaged on its premises.

PART 3. PHOTOS AND VIDEO

20. PERMISSION. The Academy photographs and films classes, belt promotions, seminars and events. I give the Academy permission to photograph and record me during these activities and to use those photos and recordings, including my image, my voice, my first name and my rank, to promote the Academy on its website, on its social media accounts, in advertising, and in emails and printed materials. I will not be paid for this use.

21. CHANGING MY MIND. I can withdraw the permission in section 20 at any time by telling the Academy in writing, and doing so does not affect my membership. The Academy will stop making new use of my image within a reasonable time and will remove a post from its own website or social media accounts if I ask.

PART 4. GENERAL

22. MINORS. If the member is under the age of majority, the parent or legal guardian who signs below has the legal authority to sign for them, has explained the risks in Part 2 to them, consents to their taking part, agrees to every term of this contract on the member's behalf and on their own behalf, and is responsible for paying the member's dues.

23. MY LEGAL RIGHTS. Nothing in this contract takes away any right to cancel or to a refund that the consumer protection laws of my state give me.

24. HOW LONG THIS LASTS. Part 2 applies every time I take part in the Activities, for as long as I train at the Academy. It binds me, my spouse, my heirs, my estate and anyone else who could bring a claim on my behalf.

25. GOVERNING LAW. This contract is governed by the laws of the state where the Academy is located. If any part of it is found unenforceable, that part is to be enforced as far as the law allows and the rest stays in effect.

26. ACKNOWLEDGMENT. I have read this contract and I understand it. I understand that my membership renews and is billed automatically until I cancel, and that I am giving up legal rights by signing. I am signing freely, and nobody has promised me anything to get me to sign.`;

// THE SEEDED SET. convex/seedDemoGym.ts inserts every entry of this array into
// a new demo gym, so it must contain exactly one waiver (a gym can only have
// one) — tested. The all-in-one contract is therefore NOT in here; it is added
// in STARTER_LIBRARY below, which is what the settings screen offers.
export const STARTER_DOCUMENTS: readonly StarterDocument[] = [
  {
    key: "liability_waiver",
    title: "Liability Waiver",
    summary:
      "Assumption of risk, release and indemnity written for grappling and striking gyms, with a parent or guardian section for minors.",
    isWaiver: true,
    requiresGuardianForMinors: true,
    requiredAtSignup: true,
    reviewNotes: [
      "How far a release of negligence claims is enforced differs by state. Some states limit or refuse it.",
      "Whether a parent can sign away a child's claims differs by state too. If you run a kids program, ask your attorney about that section specifically.",
      "Check the list of activities in section 1 against what you actually offer.",
    ],
    content: LIABILITY_WAIVER,
  },
  {
    key: "membership_agreement",
    title: "Membership and Billing Agreement",
    summary:
      "Recurring billing authorization, failed payments, freezes and cancellation. Three blanks for your own terms.",
    isWaiver: false,
    requiresGuardianForMinors: true,
    requiredAtSignup: false,
    reviewNotes: [
      "Fill in the three blanks with your own freeze and cancellation terms. The document can't be saved until you do.",
      "Many states have automatic-renewal and health-club laws that set how you must disclose renewals and how members can cancel. Have your attorney check your terms against yours.",
      "Plan names and prices are not in this text on purpose. It points at the plan the member chose at signup.",
    ],
    content: MEMBERSHIP_AGREEMENT,
  },
  {
    key: "code_of_conduct",
    title: "Academy Rules and Code of Conduct",
    summary:
      "Hygiene, skin infections, tapping and sparring conduct, respect, and what happens when the rules are broken.",
    isWaiver: false,
    requiresGuardianForMinors: false,
    requiredAtSignup: false,
    reviewNotes: [
      "Change the rules to match your room: banned techniques, required sparring gear, uniform policy.",
    ],
    content: CODE_OF_CONDUCT,
  },
  {
    key: "media_release",
    title: "Photo and Video Release",
    summary:
      "Permission to use training and event photos and video in your marketing, with a way for the member to withdraw it.",
    isWaiver: false,
    requiresGuardianForMinors: true,
    requiredAtSignup: false,
    reviewNotes: [
      "New members are asked to sign every document at signup, including this one. If someone doesn't want to be photographed, keep a note and honor it.",
      "Rules on using a minor's image are stricter in some states. Check with your attorney if you post kids classes.",
    ],
    content: MEDIA_RELEASE,
  },
];

/** The all-in-one alternative to the waiver + membership agreement + photo release. */
export const STARTER_ALL_IN_ONE: StarterDocument = {
  key: "membership_contract",
  title: "Membership Contract and Waiver",
  summary:
    "One contract instead of three: membership and billing terms, liability waiver and photo permission, signed once. Three blanks for your own terms.",
  isWaiver: true,
  requiresGuardianForMinors: true,
  requiredAtSignup: true,
  reviewNotes: [
    "Use this INSTEAD of the separate Liability Waiver, Membership and Billing Agreement and Photo and Video Release, not alongside them.",
    "Fill in the three blanks with your own freeze and cancellation terms. The document can't be saved until you do.",
    "How far a release of negligence claims is enforced, and whether a parent can sign away a child's claims, differs by state.",
    "Many states have automatic-renewal and health-club laws that set how you must disclose renewals and how members can cancel. Have your attorney check your terms against yours.",
    "Photo permission is part of a contract every member must sign. Section 21 lets a member withdraw it; honor that when asked.",
  ],
  content: MEMBERSHIP_CONTRACT,
};

/**
 * Everything the settings screen offers: the seeded set plus the all-in-one.
 * UI code reads THIS; convex/seedDemoGym.ts reads STARTER_DOCUMENTS.
 */
export const STARTER_LIBRARY: readonly StarterDocument[] = [...STARTER_DOCUMENTS, STARTER_ALL_IN_ONE];

export function findStarter(key: string): StarterDocument | undefined {
  return STARTER_LIBRARY.find((s) => s.key === key);
}

/** The plain waiver — what "Start from a template" loads for a gym with no waiver yet. */
export const STARTER_WAIVER: StarterDocument = STARTER_DOCUMENTS.find((s) => s.isWaiver)!;
