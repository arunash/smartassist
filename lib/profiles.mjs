/**
 * Conversation profiles.
 *
 * The questions differ by call, but the thing that actually differs by DOMAIN is
 * how a call fails you. An advisor evades; a doctor is simply out of time; an
 * insurer buries the reference number you'll need later. Encoding that is what
 * makes this work outside the domain it was built in.
 */
export const PROFILES = {
  advisor: {
    label: "Financial / tax / legal advisor",
    failureMode:
      "Evasion and scope. A question gets addressed without being answered, a promise to send something later stands in for a figure, and confident advice arrives from someone unqualified to give it.",
    watchFor: [
      "A question addressed but not answered — especially a promise to send it later.",
      "Arithmetic that doesn't survive checking against their own records.",
      "Advice given from the wrong chair — outside the professional's actual scope.",
      "The headline number presented as the benefit, with fees and downside unstated.",
    ],
    answerBar:
      "A promise to send something later is not an answer. Restating the question is not an answer. An answer to a narrower question than the one asked is not an answer.",
    interjectWhen:
      "a decision is being made on a wrong premise, a concession just landed and needs locking onto the record, or they are closing a topic with a question inside it unanswered",
  },
  doctor: {
    label: "Doctor / clinician",
    failureMode:
      "Time, not evasion. The appointment is shorter than the list, and the visit ends with the plan half-stated. They are not hiding anything — they are behind.",
    watchFor: [
      "Time running out with high-priority questions unasked — say which one to ask NOW.",
      "A plan stated incompletely: dose, frequency, duration, what to watch for, when to call, and what happens if it doesn't work.",
      "A referral, order, test, or prescription mentioned but never actually confirmed as placed.",
      "A previous visit's follow-up that silently never happened.",
      "Something said that conflicts with the record — a medication, an allergy, a prior result.",
    ],
    answerBar:
      "A plan is answered only when it is actionable without further guessing: what to do, how much, how long, and what would make you call sooner.",
    interjectWhen:
      "the visit is visibly wrapping up with a priority question unasked, the plan is ambiguous in a way that affects what happens at home, or something contradicts the record",
  },
  insurance: {
    label: "Insurance / benefits / billing",
    failureMode:
      "Facts slipping past. The call is winnable later only if you leave with the reference number, the exact denial code, the deadline, and the name of the person who said it.",
    watchFor: [
      "A reference or claim number said once, in passing — capture it immediately.",
      "A denial reason given in plain words rather than the code it maps to.",
      "An appeal deadline stated vaguely, or not at all.",
      "A commitment with no name attached to it.",
      "A policy claim that conflicts with the plan documents.",
    ],
    answerBar:
      "An answer is complete only with the identifier attached: the code, the reference, the date, and who said it.",
    interjectWhen:
      "a number or deadline goes by without being pinned down, or the call is ending without a reference number and a name",
  },
  school: {
    label: "School / IEP / services",
    failureMode:
      "What is said in the room differs from what ends up in the document, and only the document is enforceable.",
    watchFor: [
      "A verbal commitment with no corresponding written goal, service, minutes, or accommodation.",
      "Goals that aren't measurable, so progress can't be disputed later.",
      "Services described in vague frequency — 'as needed', 'when available'.",
      "A prior commitment from the last plan that quietly lapsed.",
    ],
    answerBar:
      "Answered means it will appear in the written document, with a number attached to it.",
    interjectWhen:
      "a commitment is made that nobody is writing down, or a goal is stated in a form that could not be measured",
  },
  vendor: {
    label: "Contractor / vendor / sales",
    failureMode:
      "Scope and price drift, and the commitment lives in conversation rather than in writing.",
    watchFor: [
      "Scope stated without what is excluded.",
      "A price without what would change it.",
      "A timeline without what it depends on.",
      "Terms that differ from the written proposal.",
    ],
    answerBar: "Answered means specific enough to appear in a contract.",
    interjectWhen: "scope or price shifts from what was quoted, or a commitment is made that isn't written anywhere",
  },
  general: {
    label: "General",
    failureMode:
      "The conversation ends without the thing you came for, because it drifted and nobody noticed.",
    watchFor: [
      "A question addressed but not answered.",
      "A claim that conflicts with the context provided.",
      "A commitment made with no owner or date.",
      "The conversation closing with a priority item untouched.",
    ],
    answerBar: "Answered means the question asked was the question answered, specifically.",
    interjectWhen: "something is about to be decided on a wrong premise, or the call is closing with a priority item untouched",
  },
};

export const profileOf = (id) => PROFILES[id] ?? PROFILES.general;
export const profileList = () =>
  Object.entries(PROFILES).map(([id, p]) => ({ id, label: p.label, failureMode: p.failureMode }));
