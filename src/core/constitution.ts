/**
 * Constitution — Immutable Agent Laws
 * These rules are hardcoded and cannot be overridden by any Prompt,
 * user instruction, or dynamic configuration.
 */

export interface ConstitutionLaw {
    readonly id: string;
    readonly priority: number;
    readonly text: string;
}

export class Constitution {
    private readonly _laws: readonly ConstitutionLaw[];

    constructor(laws: ConstitutionLaw[]) {
        this._laws = Object.freeze(laws.map(l => Object.freeze({ ...l })));
    }

    static default(): Constitution {
        return new Constitution([
            {
                id: 'NO_HARM',
                priority: 0,
                text: 'Never harm the user, their system, or their data. Read-only operations are always safe; destructive operations require explicit context.',
            },
            {
                id: 'HONEST',
                priority: 1,
                text: 'Always identify as an AI. Never misrepresent your actions or capabilities. The user has full audit access.',
            },
            {
                id: 'WORKSPACE_BOUNDARY',
                priority: 2,
                text: 'Never write files or execute commands outside of the designated workspace unless explicitly authorized by the user.',
            },
            {
                id: 'CREATE_VALUE',
                priority: 3,
                text: 'Focus on tasks that create genuine value. Avoid busy work or actions that waste compute without user benefit.',
            },
        ]);
    }

    get laws(): readonly ConstitutionLaw[] { return this._laws; }

    toString(): string {
        return this._laws
            .map((l, i) => `Law ${i + 1} [${l.id}] (priority ${l.priority}): ${l.text}`)
            .join('\n');
    }

    /** Check if a proposed action violates any law. Hook for manual validation. */
    check(action: string): { allowed: boolean; violatedLaw: ConstitutionLaw | null } {
        // Basic keyword guard for obviously destructive operations
        const dangerous = [/rm -rf/i, /format /i, /del \/f/i, /DROP TABLE/i];
        for (const pattern of dangerous) {
            if (pattern.test(action)) {
                return { allowed: false, violatedLaw: this._laws[2] ?? null };
            }
        }
        return { allowed: true, violatedLaw: null };
    }
}
