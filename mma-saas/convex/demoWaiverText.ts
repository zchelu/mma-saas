// What makes a FABRICATED signature record identifiable as one.
//
// convex/seedDemoGym.ts stands up a demo gym with a handful of already-signed
// waivers, so a member's Documents tab isn't empty on a sales call. A
// signedDocuments row asserts that a named person accepted a liability
// release — so a seeded one has to say, in the DATA, that nobody did:
//
//   - its frozen text is topped and tailed with DEMO_WAIVER_MARKER;
//   - its signature images (below) literally read "DEMO" when rendered.
//
// A row that somehow escapes into a real gym is then recognisable by reading
// it, not by finding this comment.
//
// HISTORY. Until 2026-10-03 this file also held the demo gym's entire waiver
// text, under a header saying no text may ever be offered to a real gym. That
// rule was replaced by the starter library in lib/documentStarters.ts — read
// its header for the decision and its limits. The demo gym's templates now
// come from that same library, so a demo shows exactly what a new gym gets,
// and only the marker and the signature images remain here. The live demo
// gym's four seeded signatures still carry the older text, frozen, which is
// what a signed record is supposed to do when its template is edited.

export const DEMO_WAIVER_MARKER =
  "*** DEMO DOCUMENT — SAMPLE TEXT FOR PRODUCT DEMONSTRATION ONLY. NOT A VALID LEGAL AGREEMENT. ***";

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
