// ⚠️ DEMO TEXT ONLY. NOT LEGAL ADVICE. NOT FOR A REAL GYM. ⚠️
//
// READ THIS BEFORE USING ANYTHING IN THIS FILE.
//
// The entire premise of the Documents & Waivers feature is that the GYM OWNER
// supplies their own waiver, reviewed by their own attorney, and that
// KombatDesk builds the signing rail and never the legal language. This file
// exists solely so a demo gym's Documents tab isn't empty on a sales call. It
// is:
//
//   - seeded ONLY by convex/seedDemoGym.ts, which refuses to run against a gym
//     that already has members;
//   - never created for a real signup, never suggested in the product, and
//     never offered as a starting point in the /settings/documents editor —
//     that screen ships with an empty textarea and says so;
//   - deliberately topped and tailed with an unmistakable marker, so that a
//     row that somehow escapes into a production database is identifiable by
//     reading the DATA, not by finding this comment.
//
// If anyone ever proposes shipping this as a default template for real gyms:
// no. That is practising law, it varies by state, and the product's one
// promise here is that we don't do it.

export const DEMO_WAIVER_MARKER =
  "*** DEMO DOCUMENT — SAMPLE TEXT FOR PRODUCT DEMONSTRATION ONLY. NOT A VALID LEGAL AGREEMENT. ***";

export const DEMO_WAIVER_TITLE = "Liability Waiver (DEMO)";

export const DEMO_WAIVER_CONTENT = `${DEMO_WAIVER_MARKER}

ASSUMPTION OF RISK, RELEASE OF LIABILITY, AND INDEMNITY AGREEMENT

Participant: {{member_name}}
Date of birth: {{member_dob}}
Address: {{member_address}}
Academy: {{gym_name}}
Date: {{today}}

1. ACKNOWLEDGMENT OF RISK. I understand that Brazilian Jiu-Jitsu, submission
grappling, Muay Thai, kickboxing, wrestling, mixed martial arts and all related
conditioning activities are physically demanding contact activities that carry
an inherent risk of injury. Those risks include, without limitation: muscle
strains and tears; joint sprains, dislocations and hyperextension; broken bones
and fractures; cuts, bruises and abrasions; damage to teeth and eyes;
cauliflower ear; skin infections transmitted by mat contact; concussion and
other head injury; heat exhaustion; cardiac events; permanent disability; and
death. I understand these risks are present even when instruction, supervision,
equipment, matting and facilities are entirely appropriate, and that they arise
in part from the conduct of other participants training alongside me.

2. SPARRING AND LIVE TRAINING. I understand that live sparring, positional
rolling and clinch work involve deliberate physical contact with training
partners who differ from me in size, strength, skill and experience, and that
injury can occur during such training even where every participant is acting in
good faith and following instruction.

3. FITNESS TO PARTICIPATE. I affirm that I am in sufficient physical condition
to participate, that I know of no medical condition, injury, medication or
pregnancy that would make participation unsafe for me, and that I have been
advised to consult a physician before beginning any new physical activity. I
will notify {{gym_name}} in writing before returning to training if my condition
changes in any way that affects the truth of this paragraph.

4. AGREEMENT TO FOLLOW SAFETY RULES. I agree to follow all instructions,
academy rules and safety directions given by the instructors and staff of
{{gym_name}} at all times. This includes tapping early and without hesitation,
releasing a submission the instant my partner taps or says stop, using the
protective equipment I am told to use, not applying techniques I have not been
taught, not training while injured or ill, keeping my fingernails and toenails
trimmed, training in clean attire, and staying off the mats with any open wound,
rash or contagious skin condition.

5. RELEASE AND HOLD HARMLESS. In consideration of being permitted to train at
{{gym_name}}, I release, waive, discharge and covenant not to sue {{gym_name}},
its owners, officers, instructors, employees, volunteers, landlords and other
members from any and all liability, claims, demands and causes of action arising
out of or related to any loss, damage or injury, including death, that I may
sustain while participating in academy activities or while on academy premises,
whether caused by the ordinary negligence of the released parties or otherwise,
to the fullest extent permitted by law. I further agree to indemnify and hold
the released parties harmless from any claim brought by a third party arising
out of my own conduct. I intend this release to bind me, my spouse, my heirs,
my executors, my administrators and my assigns.

6. AUTHORIZATION FOR MEDICAL TREATMENT. I authorize {{gym_name}} and its staff
to arrange or administer first aid and to summon emergency medical services on
my behalf if I am injured and unable to give consent at the time, and I accept
financial responsibility for any medical treatment or transport so arranged.

7. GOVERNING LAW AND SEVERABILITY. This agreement is governed by the laws of
the State of Colorado, without regard to its conflict-of-laws provisions. If any
provision of this agreement is held invalid or unenforceable, that provision
shall be severed and the remainder shall continue in full force and effect.

8. ENTIRE AGREEMENT AND ACKNOWLEDGMENT. I have read this document in full. I
understand that it is a release of legal rights and a binding contract, that I
am giving up substantial rights by signing it, and that I sign it freely and
voluntarily without inducement.

Participant signature: ______________________

If the participant named above has not reached the age of majority, a parent or
legal guardian must also sign below. By signing, that parent or guardian agrees
to every term of this agreement on the participant's behalf and personally, and
represents that they have the legal authority to do so.

Parent / guardian printed name: ______________________

Parent / guardian signature: ______________________

${DEMO_WAIVER_MARKER}`;

// Fixed, deterministic signature images for seeded records.
//
// These deliberately READ "DEMO" when rendered — a seeded signature must be
// identifiable as fake by looking at it, not only by checking which gym it
// belongs to. convex/seedDemoGym.ts is the only writer.
//
// 600x200 PNGs, matching the export size of app/components/signature-pad.tsx,
// so the demo rows render at the same scale as real ones on the member's
// Documents tab. Both pass lib/documents.ts:isValidSignatureData.
export const DEMO_SIGNATURE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAlgAAADIAQMAAAAOUQ31AAAABlBMVEUAAAARERGB6nNqAAAAAnRSTlMA/bWfQ5kAAAJgSURBVHja7ZhNjtswDIWfXQPxLjnBKAcpZoKeq2h5lB7FHfQAPYLbVZfOzhgIYReRHdlx/CNy0R9+QBBAsF8eKZKWAxiGYRiGYRiGYRiGYRiGYfwN7LgFHHPtaoABd0lRyTs1ilfrjAS+uLn6agDGO+Y63dfXQwlk2RFABhTn8iCI8VxEi+X3t1KghQ/XLwJqHCouJFo/giXkAAgk0Wqiux3wKtFqTwCACqjw3NtM0woUKJIrq9fy0aIHGpGv422RwkcY488klZFW380l0AKtQu4l3LSuHXgGIwOAk4avg4IvgJmUYgzlTxc1rUGdbSTumAxwmjH6QTOlaoUOPJ0U8wWwVCvvWil0T6Xg60hACZR/Sj8WdchVkzx18ql2LICDZBaWVV+w4hi78UA18JrWAHm8f2GspnrrtV6ihRp4Fmhln7qVCmiq7KNA66lr6W8A2mMueHa81L8A5tDf/um96Fn7JVq8ZFWdXBnd2bdxcHDAZ9brrF0DwzAMw/gnIT0plr51DaS41ZHaM0HLGBOAvYqxoKJiLIhoGNu1Q00JjoaxSvDjYFVOdXupmIvulxasn9hSlYOrLEpHo84kpRBlE+P+bJ4u5mhyAFHK3PTT42y2NppNrx/zxvzqEJdr48FND/8mmotyOph9szTUNiSZlobt5N5NBTm7XYPf2dNCkPO7NYh/dKUf1+NSffuJMX4fJK+Rim8YJ+imvU4qNuMfJXN18/aX3ec61PL6MdBnf3IA0LaJ4mdqc1Wa7rM/3R0b59wuZIU0jn/cKjzoUrMyf8rTO3xCUcowDMMwDOM/4TeDPAgETIvyFwAAAABJRU5ErkJggg==";

export const DEMO_GUARDIAN_SIGNATURE_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAlgAAADIAQMAAAAOUQ31AAAABlBMVEUAAAARERGB6nNqAAAAAnRSTlMA/bWfQ5kAAAPuSURBVHja7Zg9btxGGIaf4RIQi8DkAQKTvoUCKBKRk+QIKVKkEOyR4ULHSG5CCwbS6gahlcZVwO0mAbNfCv4Nd8nhrCAECDJvocVHDl++3++MCAEBAQEBAQEBAQEBAQEBAQEBAQEB/wVciIFcpM5rEMgPAEoqcrgel6XSDGZekx+zRAObtq/WSgOvuOztG8jlAKSDuYSBix+6nwxgB98DGXF/s9SA0kA9mqtcH7MElCoABfE+yYBCvZ+tLbkrssHI1nXtY+ti8vhXAnzLL9ZFlRTwlDiiPvr4XfejoSarJAZuaXpnfiyBNgP5MJj3Dq7PvSQiQKNBGYy99ADw4KOrseKZwwNEDZTWUrFeCZ8cXKZ7rIKK6+GZtg/VH0WnuXtlb65z9YjHOiCuoVh16MnB1VoXW2iAqgvRDMYnXrYEDWim9Ee/ZVaRdeZ+28enjulZiGYZ7yNsOl80Uhz7N4bC6E1di4irxGEucHUh2SOoPi7MI6imsGpoSw9dq90bNb7xAkRWwp7ouK+3yTwUm7qMPiyxVcBlNTMXwnpypfh9WZxIlNpm5uRSHM3wXfv5BiDdz+Qfmas+trNmmkHNzXsHV5+l8jTXvJEKVKbpBv4bqbx0jYMKGv6ObU2mnEn8tM4VDa1krFQd5u4v5sqhq9CQdHNvrLZv1Cxpnfl0Zj9GsyY6mkrrq/uqFpqllWZwOKkGc7+tK+uCkuku1s2CCr3lRVItVFE8pmPIYabpzdMBFh1PBV3DA+TQ9uOltEdgcbI5LHAVehyrg7asH/m21JvRPB1gkbVovFDDNRzgFabklmbK4dsuhoVLl3przZOmUrcgX1FAocaizWDXjpvD6QAbuF631t5uisgA77mizSITTa11ZRwl2d+4qb+ASN/f7eurBvj4q+aQft1QD6l5Vz12IcjGrl2K18/2iUZVNVBfGoS6xnqwtLt/hevPoVpqDdIVwhceoaSMp51zb7W355580YxJ2zUEBAQEBAT837Bz3hVVvRSXUHqR9a+MnFTwzmOnl+0zecqdUvzkTeVco6e/zm9629Kl+2cm3Tqb5NtU6fC6dmNh6+vh9ns3dY8eTmexzXeur7CWOJ24MOdQuZ3cirzMP1Q4nWy3mI5i4FjvPs2eUrn8SLW/f1tOXvsG3cNJ41Hsnk5e1GcX3qqTrkiaMzPfPqMf8jP1uvph5SGHi45b7bkutme2ncvF5sxx8DwXl9PSPrPlF8rFMVFTv/k5CXRM1I1hm4poRKYxIub5w1YsaMeHXa9tbmIREReVzzY3fkXYoPLY5ryD63Eo8EVqXoAk7o89dy8mS15C1nCWuw8n94CAgICAgICAfwf/AC9XdyLqnnH/AAAAAElFTkSuQmCC";
