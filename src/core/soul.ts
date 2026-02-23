import fs from 'fs';
import path from 'path';

export interface SoulMemory {
    cycle: number;
    time: string;
    event: string;
}

export interface SoulLesson {
    cycle: number;
    time: string;
    lesson: string;
}

export interface SoulGoal {
    id: string;
    goal: string;
    addedAt: string;
}

export interface SoulData {
    identity: Record<string, unknown>;
    state: {
        cycle: number;
        survivalLevel: string;
        currentModel: string;
    };
    memory: SoulMemory[];
    lessons: SoulLesson[];
    goals: { short: SoulGoal[]; mid: SoulGoal[]; long: SoulGoal[] };
    evolutionLog: Array<{ cycle: number; time: string; action: string; result: string }>;
}

/**
 * Soul — Persistent Agent Memory
 * FishbigAgent remembers everything across cycles:
 * memories, lessons, goals, and evolution history.
 */
export class Soul {
    public readonly path: string;
    public data: SoulData;

    constructor(soulPath: string, identity: Record<string, unknown> = {}) {
        this.path = soulPath;
        this.data = {
            identity,
            state: { cycle: 0, survivalLevel: 'ACTIVE', currentModel: 'gemini' },
            memory: [],
            lessons: [],
            goals: { short: [], mid: [], long: [] },
            evolutionLog: [],
        };
        this._load();
        // Merge identity if first run
        if (!this.data.identity['name']) {
            this.data.identity = { ...identity };
        }
    }

    private _load(): void {
        if (fs.existsSync(this.path)) {
            try {
                const raw = fs.readFileSync(this.path, 'utf-8');
                this.data = JSON.parse(raw) as SoulData;
            } catch {
                console.warn(`[SOUL] Could not parse ${this.path}, starting fresh`);
            }
        }
    }

    save(): void {
        const dir = path.dirname(this.path);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf-8');
    }

    get cycle(): number { return this.data.state.cycle; }
    set cycle(v: number) { this.data.state.cycle = v; }

    get currentModel(): string { return this.data.state.currentModel; }
    set currentModel(model: string) { this.data.state.currentModel = model; }

    remember(event: string): void {
        this.data.memory.push({ cycle: this.cycle, time: new Date().toISOString(), event });
    }

    learnLesson(lesson: string): void {
        this.data.lessons.push({ cycle: this.cycle, time: new Date().toISOString(), lesson });
    }

    logEvolution(action: string, result: string): void {
        this.data.evolutionLog.push({ cycle: this.cycle, time: new Date().toISOString(), action, result });
    }

    getRecentMemories(n = 10): SoulMemory[] {
        return this.data.memory.slice(-n);
    }

    toContext(): Record<string, unknown> {
        return {
            identity: this.data.identity,
            cycle: this.cycle,
            survivalLevel: this.data.state.survivalLevel,
            currentModel: this.currentModel,
            recentMemories: this.getRecentMemories(5),
            lessons: this.data.lessons.slice(-5),
            goals: this.data.goals,
        };
    }
}
