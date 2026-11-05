// Push notes in a member's conversation (push-plan-20261103.md section 7): passive entries the model sees as a user
// message starting with a bracketed 「[推送…]」 label. The console shows them as 推送备注 and searches them as their own kind
// (src/durable/read/queries.ts).

/** The entry kind of a push note. */
export const PUSH_NOTE_KIND = "mixin.push-note";
