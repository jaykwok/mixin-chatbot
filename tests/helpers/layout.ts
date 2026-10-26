// Test shorthands over src/core/layout.ts. `root` is a data directory (appLayout's `data`); a space is a group id, or
// "direct" for the direct space (as tests/helpers/recording-outbound.ts names it).
import { appLayout, DIRECT_SCOPE, groupScope, spaceDatabase, userTmp, type Scope } from "../../src/core/layout.ts";

export const scopeOf = (space: string | Scope): Scope => typeof space !== "string" ? space : space === "direct" ? DIRECT_SCOPE : groupScope(space);
/** The space's conversation database below the data directory `root`. */
export const databaseOf = (root: string, space: string | Scope): string => spaceDatabase(appLayout(root), scopeOf(space));
/** A member's tmp below the data directory `root`. */
export const tmpOf = (root: string, space: string | Scope, phone: string): string => userTmp(appLayout(root), scopeOf(space), phone);
/** The statistics ledger below the data directory `root`. */
export const statsOf = (root: string): string => appLayout(root).stats;
